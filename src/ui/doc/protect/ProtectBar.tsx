import { Archive20Regular, ArrowExport20Regular, ArrowMinimize20Regular, LockClosed20Regular, ScanText20Regular, Wrench20Regular } from "@fluentui/react-icons";
import type { SecurityState } from "../../../core/engine";
import { MenuButton } from "../../components/Menu";
import { Divider, UndoRedo } from "../ModeBar";

export type ExportFormat = "docx" | "markdown" | "html" | "text" | "images";

export type ProtectDialog =
  | { kind: "security" }
  | { kind: "ocr" }
  | { kind: "compress" }
  | { kind: "export"; format: ExportFormat }
  | { kind: "pdfa" }
  | { kind: "repair" };

export function ProtectBar(p: {
  security: SecurityState | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onOpen: (d: ProtectDialog) => void;
}) {
  const s = p.security;
  const status = !s ? "" : s.pending === "encrypt" ? "Protected when you save" : s.pending === "decrypt" ? "Unprotected when you save" : s.encrypted ? `Protected · ${s.method}` : "Not protected";
  return (
    <div className="modebar" role="toolbar" aria-label="Protect and convert tools">
      <div className="modebar__group">
        <button className="text-button" onClick={() => p.onOpen({ kind: "security" })}>
          <LockClosed20Regular /> Security
        </button>
        {s && (
          <span className={`status-pill ${s.pending ? "status-pill--pending" : s.encrypted ? "status-pill--on" : ""}`} title={s.weak ? "This file uses old, weak encryption. Protect it again to upgrade to AES-256." : undefined}>
            {status}
            {s.weak && !s.pending ? " (weak)" : ""}
          </span>
        )}
      </div>
      <Divider />
      <div className="modebar__group">
        <button className="text-button" onClick={() => p.onOpen({ kind: "ocr" })} title="Make scanned pages searchable and selectable">
          <ScanText20Regular /> Recognise text
        </button>
        <button className="text-button" onClick={() => p.onOpen({ kind: "compress" })} title="Make the file smaller">
          <ArrowMinimize20Regular /> Compress
        </button>
        <MenuButton
          label="Export"
          icon={<ArrowExport20Regular />}
          text="Export"
          className="text-button"
          entries={() => [
            { label: "Word document (.docx)…", onSelect: () => p.onOpen({ kind: "export", format: "docx" }) },
            { label: "Markdown (.md)…", onSelect: () => p.onOpen({ kind: "export", format: "markdown" }) },
            { label: "Web page (.html)…", onSelect: () => p.onOpen({ kind: "export", format: "html" }) },
            { label: "Plain text (.txt)…", onSelect: () => p.onOpen({ kind: "export", format: "text" }) },
            { kind: "separator" },
            { label: "Images (PNG, JPEG, TIFF)…", onSelect: () => p.onOpen({ kind: "export", format: "images" }) },
          ]}
        />
      </div>
      <Divider />
      <div className="modebar__group">
        <button className="text-button" onClick={() => p.onOpen({ kind: "pdfa" })} title="Check or convert to PDF/A for long-term archiving">
          <Archive20Regular /> PDF/A
        </button>
        <button className="text-button" onClick={() => p.onOpen({ kind: "repair" })} title="Check the file's structure and rebuild it">
          <Wrench20Regular /> Repair
        </button>
      </div>
      <span className="spacer" />
      <UndoRedo {...p} />
    </div>
  );
}
