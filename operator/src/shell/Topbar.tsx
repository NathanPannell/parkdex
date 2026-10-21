import type { ResolvedRoute } from "../routes";
import { Icon, Kip } from "../ui";

/** Which data the page shows, always visible, so a staging or production edit is never a surprise. */
export function EnvBadge({ environment, pinned }: { environment: string; pinned: boolean }) {
  if (!environment) return null;
  const tone = environment === "production" ? "production" : environment === "staging" ? "staging" : "other";
  const label = environment === "production" ? "Production" : environment === "staging" ? "Staging" : `${environment[0].toUpperCase()}${environment.slice(1)}`;
  return (
    <span className={`env-badge env-badge--${tone}`} title={pinned ? "This page always reads production" : "The database this page reads and writes"}>
      <span className="env-badge__dot" aria-hidden="true" />
      <span className="env-badge__label">{label}</span>
      {pinned && <span className="env-badge__pin">only</span>}
    </span>
  );
}

export function Topbar({ route, environment, menuOpen, onMenu }: { route: ResolvedRoute | null; environment: string; menuOpen: boolean; onMenu(): void }) {
  const pinned = route?.database === "production";
  return (
    <header className="topbar">
      <button type="button" className="topbar__menu" aria-label="Open navigation" aria-controls="sidebar" aria-expanded={menuOpen} onClick={onMenu}>
        <Icon name="menu" size={20} />
      </button>
      <Kip pose="avatar" size={30} className="topbar__kip" />
      <nav className="crumbs" aria-label="You are here">
        <span className="crumbs__section">{route?.section.label ?? "Operator"}</span>
        {route?.child && (
          <>
            <Icon name="chevron" size={14} className="crumbs__sep" />
            <span className="crumbs__page">{route.child.label}</span>
          </>
        )}
      </nav>
      <EnvBadge environment={environment} pinned={pinned} />
    </header>
  );
}
