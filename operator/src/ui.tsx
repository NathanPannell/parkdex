import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const ICONS = {
  inbox: "M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z",
  pin: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  close: "M6 6l12 12M18 6L6 18",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  bug: "M8 9h8v6a4 4 0 0 1-8 0zM9 9V7a3 3 0 0 1 6 0v2M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  chat: "M5 5h14v10H9l-4 4z",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  plus: "M12 5v14M5 12h14",
  trash: "M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  alert: "M12 8v5M12 17h.01M10.3 3.9L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M5 12l5 5 9-10",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  phone: "M8 3h8v18H8zM11 18h2",
  chevron: "M9 6l6 6-6 6",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Kip({ pose, size = 48, className }: { pose: "avatar" | "think" | "sleep" | "celebrate" | "map"; size?: number; className?: string }) {
  return <img className={className} src={`/kip-${pose}.webp`} width={size} height={size} alt="" draggable={false} />;
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner${small ? " spinner--small" : ""}`} aria-hidden="true" />;
}

export function timeAgo(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "Unknown time";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(then));
}

export function fullDate(value: string | null | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

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

type Toast = { id: number; message: string; tone: "info" | "error"; action?: { label: string; run(): void } };
type ToastApi = { show(message: string, options?: { tone?: Toast["tone"]; action?: Toast["action"] }): void };

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback<ToastApi["show"]>((message, options = {}) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, message, tone: options.tone ?? "info", action: options.action }]);
    window.setTimeout(() => dismiss(id), options.action ? 6500 : 4000);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <Icon name={toast.tone === "error" ? "alert" : "check"} size={17} />
            <span>{toast.message}</span>
            {toast.action && (
              <button type="button" className="toast__action" onClick={() => { dismiss(toast.id); toast.action!.run(); }}>
                <Icon name="undo" size={15} /> {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
