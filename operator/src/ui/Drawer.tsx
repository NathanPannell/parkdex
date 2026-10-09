import { useEffect, useRef, type ReactNode } from "react";

/** A panel that slides in from the right on desktop and up from the bottom on phones. */
export function Drawer({ open, onClose, label, children }: { open: boolean; onClose(): void; label: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; keep focus handling tied to opening only,
  // or each keystroke in a field would move focus back to the panel.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" type="button" aria-label="Close panel" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={panel}>
        {children}
      </div>
    </div>
  );
}
