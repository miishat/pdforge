import { Dismiss20Regular } from "@fluentui/react-icons";
import { useEffect, useRef, type ReactNode } from "react";

/** A modal dialog on the native <dialog> element: focus trapping and Esc handling come for free. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
      <header className="dialog__header">
        <h2 id="dialog-title" className="dialog__title">
          {title}
        </h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <Dismiss20Regular />
        </button>
      </header>
      <div className="dialog__body">{children}</div>
      {footer && <footer className="dialog__footer">{footer}</footer>}
    </dialog>
  );
}
