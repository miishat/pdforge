// Batch workflows: a named chain of steps run on many files. Workflows are saved without
// passwords (those are asked for each run).
import { engine } from "../../core/client";
import { PRESETS } from "../../core/optimize";
import { ALL_PERMISSIONS } from "../../core/protect";
import { load, save } from "../settings";
import { recognisePages } from "../ocr/ocr";

export type Step =
  | { kind: "ocr"; languages: string[]; deskew: boolean }
  | { kind: "compress"; preset: "screen" | "ebook" | "print" }
  | { kind: "watermark"; text: string; opacity: number }
  | { kind: "pageNumbers"; format: string }
  | { kind: "rotate"; by: 90 | 180 | -90 }
  | { kind: "sanitize" }
  | { kind: "flatten" }
  | { kind: "pdfa" }
  | { kind: "protect"; requireOpen: boolean };

export type StepKind = Step["kind"];

export const STEP_LABELS: Record<StepKind, string> = {
  ocr: "Recognise text",
  compress: "Compress",
  watermark: "Add a watermark",
  pageNumbers: "Add page numbers",
  rotate: "Rotate pages",
  sanitize: "Remove hidden information",
  flatten: "Flatten comments and fields",
  pdfa: "Convert to PDF/A",
  protect: "Protect with a password",
};

export function newStep(kind: StepKind): Step {
  switch (kind) {
    case "ocr":
      return { kind, languages: ["eng"], deskew: true };
    case "compress":
      return { kind, preset: "ebook" };
    case "watermark":
      return { kind, text: "CONFIDENTIAL", opacity: 0.25 };
    case "pageNumbers":
      return { kind, format: "Page {page} of {pages}" };
    case "rotate":
      return { kind, by: 90 };
    case "protect":
      return { kind, requireOpen: false };
    default:
      return { kind } as Step;
  }
}

export interface Workflow {
  id: string;
  name: string;
  steps: Step[];
  /** Appended to output names, e.g. "report (processed).pdf". Empty keeps the name. */
  suffix: string;
}

export const EXAMPLE: Workflow = {
  id: "example-scan",
  name: "Scans: recognise, compress, number pages",
  steps: [newStep("ocr"), newStep("compress"), newStep("pageNumbers")],
  suffix: " (processed)",
};

const KEY = "batch.workflows";

export function loadWorkflows(): Workflow[] {
  const v = load<Workflow[] | null>(KEY, null);
  return Array.isArray(v) ? v : [EXAMPLE];
}

export function saveWorkflows(w: Workflow[]) {
  save(KEY, w);
}

export interface RunSecrets {
  userPassword: string;
  ownerPassword: string;
}

export interface FileResult {
  name: string;
  ok: boolean;
  message: string;
  output?: string;
  before?: number;
  after?: number;
}

export function outputName(name: string, suffix: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}${suffix}.pdf`;
}

/** Runs the steps on one file's bytes; returns the result. The document is closed afterwards. */
export async function runSteps(
  bytes: Uint8Array,
  name: string,
  steps: Step[],
  secrets: RunSecrets,
  signal: AbortSignal,
  onStep: (label: string) => void,
): Promise<Uint8Array> {
  const opened = await engine().call("open", bytes.slice());
  if (opened.status !== "ok") {
    await engine().call("close", opened.docId);
    throw new Error("It's password-protected, so it was skipped.");
  }
  const docId = opened.info.docId;
  const all = () => Array.from({ length: opened.info.pageCount }, (_, i) => i);
  try {
    for (const step of steps) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      onStep(STEP_LABELS[step.kind]);
      switch (step.kind) {
        case "ocr":
          await recognisePages({ docId, pages: all(), languages: step.languages, deskew: step.deskew, force: false }, () => {}, signal);
          break;
        case "compress":
          await engine().call("compress", docId, PRESETS[step.preset]);
          break;
        case "watermark":
          await engine().call("addWatermark", docId, { text: step.text, fontSize: 64, color: [0.6, 0.6, 0.6], opacity: step.opacity, rotation: 45, scale: 0.5, behind: false, pages: all() });
          break;
        case "pageNumbers":
          await engine().call("addHeaderFooter", docId, { top: ["", "", ""], bottom: ["", step.format, ""], fontSize: 9, color: [0.25, 0.25, 0.25], margin: 28, startNumber: 1, fileName: name, pages: all() });
          break;
        case "rotate":
          await engine().call("rotatePages", docId, all(), step.by);
          break;
        case "sanitize":
          await engine().call("sanitize", docId, { metadata: true, javascript: true, attachments: true, comments: false, thumbnails: true, privateData: true });
          break;
        case "flatten":
          await engine().call("flatten", docId, { annotations: true, fields: true });
          break;
        case "pdfa": {
          const r = await engine().call("convertToPdfA", docId);
          const fails = r.report.checks.filter((c) => c.status === "fail");
          if (fails.length) throw new Error(`Couldn't make it PDF/A: ${fails.map((f) => f.label.toLowerCase()).join(", ")}.`);
          break;
        }
        case "protect":
          await engine().call("setSecurity", docId, { userPassword: step.requireOpen ? secrets.userPassword : "", ownerPassword: secrets.ownerPassword, permissions: { ...ALL_PERMISSIONS, edit: false, assemble: false } });
          break;
      }
    }
    return await engine().call("save", docId, { incremental: false });
  } finally {
    await engine().call("close", docId).catch(() => {});
  }
}

export function needsPasswords(steps: Step[]): { owner: boolean; open: boolean } {
  const p = steps.find((s): s is Extract<Step, { kind: "protect" }> => s.kind === "protect");
  return { owner: !!p, open: !!p?.requireOpen };
}
