import { useEffect, type ReactNode } from "react";

/**
 * A dialog over the app: dimmed backdrop (click it to close), the panel, and Esc to close.
 * `after` renders on the backdrop beside the panel (popovers and drag ghosts that must not be clipped by it).
 */
export function Modal(p: {
  className: string;
  onClose: () => void;
  /** help article for the ? in tooltips inside (data-help) */
  help?: string;
  /** close on Esc (off when the dialog handles keys itself) */
  escape?: boolean;
  onBackdropClick?: () => void;
  after?: ReactNode;
  children: ReactNode;
}) {
  const { onClose, escape = true } = p;
  useEffect(() => {
    if (!escape) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [escape, onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose} onClick={p.onBackdropClick}>
      <div className={`modal ${p.className}`} data-help={p.help} onMouseDown={(e) => e.stopPropagation()}>
        {p.children}
      </div>
      {p.after}
    </div>
  );
}
