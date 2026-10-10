import type { Health } from "../api";
import { linkHandler } from "../router";
import { SECTIONS, type ResolvedRoute } from "../routes";
import { Icon, Kip } from "../ui";

function within(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The left navigation: brand, the four sections with their pages, and the database controls. */
export function Sidebar({ path, route, health, environment, open, onClose, onSwitch }: {
  path: string;
  route: ResolvedRoute | null;
  health: Health | null;
  environment: string;
  open: boolean;
  onClose(): void;
  onSwitch(target: string): void;
}) {
  const pinned = route?.database === "production";
  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`sidebar${open ? " is-open" : ""}`} id="sidebar" aria-label="Dashboard">
        <div className="brand">
          <Kip pose="avatar" size={42} className="brand__kip" />
          <div>
            <p className="brand__name">parkdex</p>
            <p className="brand__sub">Operator</p>
          </div>
          <button type="button" className="sidebar__close" aria-label="Close navigation" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>

        <nav className="nav" aria-label="Sections">
          {SECTIONS.map((section) => {
            const on = route?.section.id === section.id;
            const href = section.children?.[0].path ?? section.path;
            return (
              <div key={section.id} className={`nav__group${on ? " is-on" : ""}`}>
                <a href={href} className={`nav__item${on ? " is-on" : ""}`} aria-current={on && !section.children ? "page" : undefined} title={section.description} onClick={(event) => { linkHandler(href)(event); onClose(); }}>
                  <Icon name={section.icon} size={19} />
                  <span>{section.label}</span>
                </a>
                {section.children && (
                  <div className="nav__children">
                    {section.children.map((child) => {
                      const current = within(path, child.path);
                      return (
                        <a key={child.path} href={child.path} className={`nav__child${current ? " is-on" : ""}`} aria-current={current ? "page" : undefined} onClick={(event) => { linkHandler(child.path)(event); onClose(); }}>
                          {child.label}
                          {child.database === "production" && <span className="nav__tag" title="Always reads production">Prod</span>}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          <p className="sidebar__label">Database</p>
          {pinned && health ? (
            <div className="env env--live" title="Installed apps read this page's data from production only">
              <span className="env__dot" aria-hidden="true" />
              <span>Production only on this page</span>
            </div>
          ) : health?.canSwitch ? (
            <div className="db-toggle" role="radiogroup" aria-label="Database">
              {(["production", "staging"] as const).map((target) => (
                <button key={target} type="button" role="radio" aria-checked={environment === target} className={`db-toggle__item db-toggle__item--${target}${environment === target ? " is-on" : ""}`} onClick={() => onSwitch(target)}>
                  <span className="env__dot" aria-hidden="true" />
                  {target === "production" ? "Production" : "Staging"}
                </button>
              ))}
            </div>
          ) : health ? (
            <div className={`env${environment === "production" ? " env--live" : ""}`} title="The database this dashboard reads and writes">
              <span className="env__dot" aria-hidden="true" />
              <span>{environment === "production" ? "Production data" : `${environment[0]?.toUpperCase() ?? ""}${environment.slice(1)} data`}</span>
            </div>
          ) : (
            <p className="sidebar__note">Checking the connection...</p>
          )}
          {health && health.emailMode !== "resend" && <p className="sidebar__note">{health.emailMode === "disabled" ? "Email sending is off here." : "Email retry is not set up yet."}</p>}
          <p className="sidebar__note"><Icon name="shield" size={14} /> Protected by Vercel login</p>
        </div>
      </aside>
    </>
  );
}
