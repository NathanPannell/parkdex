import type { ReactNode } from "react";
import { linkHandler } from "../router";
import { formatCount } from "./format";
import { Icon, Kip, type IconName, type KipPose } from "./Icon";

/** The title block every page starts with: eyebrow, title, a sentence of context and actions. */
export function PageHeader({ eyebrow, title, lede, actions, id }: { eyebrow?: string; title: ReactNode; lede?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 id={id}>{title}</h1>
        {lede && <p className="page-lede">{lede}</p>}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </header>
  );
}

/** A bordered panel with an optional title row. */
export function Card({ title, subtitle, actions, children, className, padded = true }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean;
}) {
  return (
    <section className={`ui-card${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <header className="ui-card__head">
          <div>
            {title && <h2 className="ui-card__title">{title}</h2>}
            {subtitle && <p className="ui-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? "ui-card__body" : undefined}>{children}</div>
    </section>
  );
}

/** One headline number. Leave value undefined while it loads. */
export function StatTile({ label, value, hint, icon, tone = "default" }: {
  label: string; value: number | string | null | undefined; hint?: ReactNode; icon?: IconName; tone?: "default" | "kip" | "moss" | "sun" | "sea" | "grape";
}) {
  const loading = value === undefined;
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__top">
        <span className="stat__label">{label}</span>
        {icon && <span className="stat__icon" aria-hidden="true"><Icon name={icon} size={16} /></span>}
      </div>
      <strong className={`stat__value${loading ? " is-loading" : ""}`}>{loading ? " " : typeof value === "number" ? formatCount(value) : value ?? "—"}</strong>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

/** Kip and a sentence for empty lists, errors that need no detail, and sections still to come. */
export function EmptyState({ title, children, pose = "think", action, compact }: { title: string; children?: ReactNode; pose?: KipPose; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? " empty--compact" : ""}`}>
      <Kip pose={pose} size={compact ? 64 : 96} />
      <h2>{title}</h2>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export type TabItem = { id: string; label: string; icon?: IconName; href?: string; count?: number };

/**
 * A row of tabs. With href the tabs are links that use the dashboard router (sub-routes);
 * without, they call onChange (local views such as a filter).
 */
export function Tabs({ items, value, onChange, label }: { items: TabItem[]; value: string; onChange?(id: string): void; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => {
        const on = item.id === value;
        const body = <>{item.icon && <Icon name={item.icon} size={16} />}<span>{item.label}</span>{item.count !== undefined && <span className="tab__count">{item.count}</span>}</>;
        return item.href
          ? <a key={item.id} href={item.href} className={`tab${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined} onClick={linkHandler(item.href)}>{body}</a>
          : <button key={item.id} type="button" className={`tab${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => onChange?.(item.id)}>{body}</button>;
      })}
    </nav>
  );
}

/** A note at the top of a page; error notices are announced to screen readers. */
export function Notice({ tone = "info", children, action }: { tone?: "info" | "error"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice${tone === "error" ? " notice--error" : ""}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name="alert" size={18} />
      <span>{children}</span>
      {action}
    </div>
  );
}
