import { memo, useState } from "react";
import type { WidgetInfo } from "../../core/forms";
import { formatDate, isAcceptable, parseDate } from "../../core/formScripts";
import type { PageSize, Rect, ViewRotation } from "../../core/types";
import { rectToView } from "../geometry";

interface Props {
  widgets: WidgetInfo[];
  size: PageSize;
  rotation: ViewRotation;
  scale: number;
  highlight: boolean;
  onSet: (w: WidgetInfo, value: string) => void;
  onInvalid: (message: string) => void;
  onSignField: (w: WidgetInfo) => void;
}

/**
 * Real HTML controls over each field: transparent until focused, so the PDF's own appearance shows,
 * but keyboard focus, Tab order and screen readers work like a normal form.
 */
export const FormLayer = memo(function FormLayer(p: Props) {
  return (
    <div className={`form-layer ${p.highlight ? "form-layer--highlight" : ""}`}>
      {p.widgets.map((w) => (
        <Field key={w.id} w={w} {...p} />
      ))}
    </div>
  );
});

function Field({ w, size, rotation, scale, onSet, onInvalid, onSignField }: Props & { w: WidgetInfo }) {
  const [x0, y0, x1, y1] = rectToView(w.rect, size, rotation, scale);
  const box: React.CSSProperties = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  const h = y1 - y0;
  const fontSize = w.fontSize ? w.fontSize * scale : Math.max(9, Math.min(h * 0.62, 14 * scale));
  const common = {
    "aria-label": w.label,
    "aria-required": w.required || undefined,
    title: w.label + (w.required ? " (required)" : ""),
    "data-required": w.required || undefined,
    "data-field": w.name,
    disabled: w.readOnly,
  };
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  switch (w.type) {
    case "text":
      return (
        <TextField
          w={w}
          style={{ ...box, fontSize }}
          common={common}
          onPointerDown={stop}
          onCommit={(v) => {
            if (!isAcceptable(w.format, v)) {
              onInvalid(w.format?.kind === "date" ? `"${v}" isn't a date. Use ${w.format.pattern}.` : `"${v}" isn't a number.`);
              return false;
            }
            if (v !== w.value) onSet(w, v);
            return true;
          }}
        />
      );
    case "checkbox":
    case "radio": {
      const on = w.value !== "" && w.value !== "Off" && (w.type === "checkbox" || w.value === w.exportValue);
      return (
        <button
          type="button"
          role={w.type}
          aria-checked={on}
          className="form-field form-field--toggle"
          style={box}
          {...common}
          onPointerDown={stop}
          onClick={() => onSet(w, w.type === "checkbox" ? (on ? "off" : "on") : (w.exportValue ?? "on"))}
        />
      );
    }
    case "combobox":
    case "listbox":
      if (w.editable) {
        const listId = `opts-${w.id}`;
        return (
          <>
            <TextField w={w} style={{ ...box, fontSize }} common={{ ...common, list: listId }} onPointerDown={stop} onCommit={(v) => (v !== w.value && onSet(w, v), true)} />
            <datalist id={listId}>{w.options.map((o) => <option key={o} value={o} />)}</datalist>
          </>
        );
      }
      return (
        <select
          className="form-field form-field--choice"
          style={{ ...box, fontSize }}
          size={w.type === "listbox" ? Math.max(2, Math.min(w.options.length, Math.floor(h / (fontSize * 1.3)))) : undefined}
          value={w.value}
          {...common}
          onPointerDown={stop}
          onChange={(e) => onSet(w, e.target.value)}
        >
          {w.type === "combobox" && !w.options.includes(w.value) && <option value={w.value}>{w.value}</option>}
          {w.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "signature":
      return w.signed ? null : (
        <button type="button" className="form-field form-field--sign" style={box} {...common} disabled={false} onPointerDown={stop} onClick={() => onSignField(w)}>
          <span>Sign here</span>
        </button>
      );
    default:
      return null;
  }
}

function TextField({
  w,
  style,
  common,
  onPointerDown,
  onCommit,
}: {
  w: WidgetInfo;
  style: React.CSSProperties;
  common: Record<string, unknown>;
  onPointerDown: (e: React.PointerEvent) => void;
  onCommit: (v: string) => boolean;
}) {
  const pattern = w.format?.kind === "date" ? w.format.pattern : null;
  const isDate = pattern !== null;
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const shown = editing ? draft : w.value;
  const props = {
    ...common,
    className: `form-field form-field--text ${editing ? "form-field--editing" : ""}`,
    style,
    value: shown,
    maxLength: w.maxLen > 0 ? w.maxLen : undefined,
    onPointerDown,
    onFocus: () => setDraft(pattern ? toIso(w.value, pattern) : w.value),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && onCommit(draft)) setDraft(null);
      else setDraft(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        setDraft(null);
        (e.target as HTMLElement).blur();
      } else if (e.key === "Enter" && !w.multiline) {
        (e.target as HTMLElement).blur();
      }
    },
  };
  if (w.multiline) return <textarea {...(props as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} />;
  return <input type={isDate && editing ? "date" : w.password ? "password" : "text"} {...(props as React.InputHTMLAttributes<HTMLInputElement>)} />;
}

/** The value shown in a date picker: ISO yyyy-mm-dd parsed from the field's own format. */
function toIso(value: string, pattern: string): string {
  if (!value) return "";
  const d = parseDate(value, pattern);
  return d ? formatDate(d, "yyyy-mm-dd") : value;
}

export type { Rect };
