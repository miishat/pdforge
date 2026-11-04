import { ArrowUpload20Regular, Delete20Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { pickFile } from "../../platform";
import { Dialog } from "../components/Dialog";
import { removeBackground, scriptFonts, trimCanvas } from "./signatures";

type Tab = "type" | "draw" | "image";
const INK = ["#1F1C18", "#1A3D8F"];

/** Creates a handwritten signature or initials as a transparent PNG. */
export function SignatureDialog({
  kind,
  defaultName,
  onSave,
  onClose,
}: {
  kind: "signature" | "initials";
  defaultName: string;
  onSave: (png: string, aspect: number, remember: boolean) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("type");
  const initials = defaultName.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase();
  const [name, setName] = useState(kind === "initials" ? initials : defaultName);
  const fonts = scriptFonts();
  const [font, setFont] = useState(fonts[0]);
  const [ink, setInk] = useState(INK[0]);
  const [remember, setRemember] = useState(true);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [image, setImage] = useState<HTMLCanvasElement | null>(null);
  const [cleanBg, setCleanBg] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pad = useRef<HTMLCanvasElement>(null);

  const make = (): HTMLCanvasElement | null => {
    if (tab === "type") {
      if (!name.trim()) return null;
      const c = document.createElement("canvas");
      c.width = 1200;
      c.height = 300;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = ink;
      ctx.textBaseline = "middle";
      let size = 150;
      do {
        ctx.font = font === "cursive" ? `${size}px cursive` : `${size}px "${font}", cursive`;
        size -= 6;
      } while (ctx.measureText(name).width > c.width - 40 && size > 30);
      ctx.fillText(name, 20, c.height / 2);
      return trimCanvas(c, 8);
    }
    if (tab === "draw") return pad.current ? trimCanvas(pad.current, 8) : null;
    if (!image) return null;
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")!.drawImage(image, 0, 0);
    if (cleanBg) removeBackground(c);
    return trimCanvas(c, 4);
  };

  const save = () => {
    const c = make();
    if (!c) {
      setError(tab === "type" ? "Type your name first." : tab === "draw" ? "Draw your signature first." : "Choose an image first.");
      return;
    }
    onSave(c.toDataURL("image/png"), c.width / c.height, remember);
  };

  const label = kind === "initials" ? "initials" : "signature";
  return (
    <Dialog
      title={kind === "initials" ? "Create initials" : "Create signature"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <label className="check check--footer">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Save for next time
          </label>
          <span className="spacer" />
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" onClick={save}>Use {label}</button>
        </>
      }
    >
      <div className="segmented-tabs" role="tablist">
        {(["type", "draw", "image"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className="segmented-tabs__tab" onClick={() => (setTab(t), setError(null))}>
            {t === "type" ? "Type" : t === "draw" ? "Draw" : "Image"}
          </button>
        ))}
      </div>

      {tab === "type" && (
        <div className="sig-type">
          <input className="field" aria-label={kind === "initials" ? "Initials" : "Your name"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <div className="sig-fonts" role="radiogroup" aria-label="Style">
            {fonts.map((f) => (
              <button key={f} role="radio" aria-checked={font === f} className="sig-font" style={{ fontFamily: f === "cursive" ? "cursive" : `"${f}", cursive`, color: ink }} onClick={() => setFont(f)}>
                {name || "Your name"}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "draw" && <DrawPad canvasRef={pad} ink={ink} onChange={setHasDrawing} hasDrawing={hasDrawing} />}

      {tab === "image" && (
        <div className="sig-image">
          {image ? (
            <ImagePreview image={image} clean={cleanBg} />
          ) : (
            <p className="muted">Use a photo or scan of your signature on white paper.</p>
          )}
          <div className="sig-image__actions">
            <button
              className="button"
              onClick={async () => {
                const f = await pickFile({ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] });
                if (!f) return;
                const bmp = await createImageBitmap(new Blob([f.bytes as Uint8Array<ArrayBuffer>]));
                const scale = Math.min(1, 1600 / bmp.width);
                const c = document.createElement("canvas");
                c.width = Math.round(bmp.width * scale);
                c.height = Math.round(bmp.height * scale);
                c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
                setImage(c);
              }}
            >
              <ArrowUpload20Regular /> Choose image…
            </button>
            <label className="check">
              <input type="checkbox" checked={cleanBg} onChange={(e) => setCleanBg(e.target.checked)} />
              Remove white background
            </label>
          </div>
        </div>
      )}

      {tab !== "image" && (
        <div className="sig-ink" role="radiogroup" aria-label="Ink colour">
          {INK.map((c) => (
            <button key={c} role="radio" aria-checked={ink === c} aria-label={c === INK[0] ? "Black ink" : "Blue ink"} className="swatch" style={{ background: c }} onClick={() => setInk(c)} />
          ))}
        </div>
      )}
      {error && <p className="panel__error">{error}</p>}
      <p className="muted">Your {label} is stored only on this computer.</p>
    </Dialog>
  );
}

function DrawPad({ canvasRef, ink, onChange, hasDrawing }: { canvasRef: React.RefObject<HTMLCanvasElement>; ink: string; onChange: (v: boolean) => void; hasDrawing: boolean }) {
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, [canvasRef]);
  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div className="sig-pad">
      <canvas
        ref={canvasRef}
        className="sig-pad__canvas"
        aria-label="Draw your signature"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          last.current = pos(e);
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const ctx = canvasRef.current!.getContext("2d")!;
          const p = pos(e);
          // Pressure where available; otherwise a natural-looking constant width.
          ctx.lineWidth = e.pressure && e.pointerType === "pen" ? 1 + e.pressure * 3.5 : 2.6;
          ctx.strokeStyle = ink;
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
          ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last.current = p;
          onChange(true);
        }}
        onPointerUp={() => (last.current = null)}
      />
      <div className="sig-pad__baseline" />
      {!hasDrawing && <span className="sig-pad__hint">Sign here with your mouse, pen or finger</span>}
      <button
        className="icon-button icon-button--sm sig-pad__clear"
        aria-label="Clear"
        title="Clear"
        onClick={() => {
          const c = canvasRef.current!;
          c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          onChange(false);
        }}
      >
        <Delete20Regular />
      </button>
    </div>
  );
}

function ImagePreview({ image, clean }: { image: HTMLCanvasElement; clean: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(image, 0, 0);
    if (clean) removeBackground(c);
  }, [image, clean]);
  return <canvas ref={ref} className="sig-image__preview" />;
}
