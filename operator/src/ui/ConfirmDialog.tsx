import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ConfirmOptions = {
  title: string;
  /** What will happen, in plain words. Say what is removed or who sees the change. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styles the confirm button for deletes and other changes that are hard to undo. */
  tone?: "default" | "danger";
  icon?: IconName;
};

type Pending = ConfirmOptions & { resolve(value: boolean): void };

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

/**
 * Asks the operator to confirm before a change. Resolves true only on the confirm button;
 * Escape, the scrim and Cancel all resolve false.
 *
 *   const confirm = useConfirm();
 *   if (!await confirm({ title: "Delete this park?", body: "...", tone: "danger", confirmLabel: "Delete" })) return;
 */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })), []);
  const finish = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog options={pending} onFinish={finish} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ options, onFinish }: { options: ConfirmOptions; onFinish(value: boolean): void }) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const danger = options.tone === "danger";

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Dangerous actions start on Cancel so a stray Enter does not delete anything.
    (danger ? cancelButton : confirmButton).current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") finish.current(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [danger]);

  return (
    <div className="dialog-layer">
      <button className="drawer-scrim" type="button" aria-label="Cancel" onClick={() => onFinish(false)} />
      <div className={`dialog${danger ? " dialog--danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={options.body ? "confirm-body" : undefined}>
        <span className="dialog__icon" aria-hidden="true"><Icon name={options.icon ?? (danger ? "trash" : "alert")} size={22} /></span>
        <h2 id="confirm-title">{options.title}</h2>
        {options.body && <div id="confirm-body" className="dialog__body">{options.body}</div>}
        <div className="dialog__actions">
          <button ref={cancelButton} type="button" className="button button--ghost" onClick={() => onFinish(false)}>{options.cancelLabel ?? "Cancel"}</button>
          <button ref={confirmButton} type="button" className={`button ${danger ? "button--danger-solid" : "button--primary"}`} onClick={() => onFinish(true)}>{options.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}
