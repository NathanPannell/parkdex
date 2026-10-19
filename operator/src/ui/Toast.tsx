import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

type Toast = { id: number; message: string; tone: "info" | "error"; action?: { label: string; run(): void } };
type ToastApi = { show(message: string, options?: { tone?: Toast["tone"]; action?: Toast["action"] }): void };

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Short confirmations and errors at the bottom of the screen, with an optional Undo. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback<ToastApi["show"]>(
    (message, options = {}) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { id, message, tone: options.tone ?? "info", action: options.action }]);
      window.setTimeout(() => dismiss(id), options.action ? 6500 : 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <Icon name={toast.tone === "error" ? "alert" : "check"} size={17} />
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  dismiss(toast.id);
                  toast.action!.run();
                }}
              >
                <Icon name="undo" size={15} /> {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
