import { CommentMultiple16Regular, Delete16Regular, Dismiss16Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { AnnotationInfo, PageSize, ViewRotation } from "../../core/types";
import { rectToView, rotatedSize } from "../geometry";

/** The popup next to a sticky note: read or edit its text. */
export function NotePopover({
  annot, size, rotation, scale, editable, startEditing, onCommit, onDelete, onClose, onOpenThread,
}: {
  annot: AnnotationInfo;
  size: PageSize;
  rotation: ViewRotation;
  scale: number;
  editable: boolean;
  startEditing: boolean;
  onCommit: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
  onOpenThread: () => void;
}) {
  const [text, setText] = useState(annot.contents);
  const ref = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const [x0, y0, x1] = rectToView(annot.rect, size, rotation, scale);
  const pageW = rotatedSize(size, rotation).width * scale;
  const left = x1 + 8 + 260 > pageW ? Math.max(4, x0 - 268) : x1 + 8;

  useEffect(() => {
    if (startEditing) ref.current?.focus();
  }, [startEditing]);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text);
  };

  return (
    <div
      className="note-popover"
      role="dialog"
      aria-label="Note"
      style={{ left, top: Math.max(4, y0) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="note-popover__head">
        <span className="note-popover__author">{annot.author || "Unknown"}</span>
        {annot.modified && <span className="note-popover__date">{new Date(annot.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>}
        <button className="icon-button icon-button--xs" aria-label="Close note" onClick={() => (editable ? commit() : undefined, onClose())}>
          <Dismiss16Regular />
        </button>
      </div>
      {editable ? (
        <textarea
          ref={ref}
          className="note-popover__text"
          aria-label="Note text"
          placeholder="Write a note"
          value={text}
          onChange={(e) => {
            committed.current = false;
            setText(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              commit();
              onClose();
            }
          }}
        />
      ) : (
        <p className="note-popover__read">{annot.contents || <span className="muted">Empty note</span>}</p>
      )}
      <div className="note-popover__actions">
        <button className="link-button" onClick={onOpenThread}>
          <CommentMultiple16Regular /> Replies
        </button>
        {editable && (
          <button className="icon-button icon-button--xs" aria-label="Delete note" title="Delete" onClick={onDelete}>
            <Delete16Regular />
          </button>
        )}
      </div>
    </div>
  );
}
