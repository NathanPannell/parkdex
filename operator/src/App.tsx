import { useEffect, useState } from "react";
import { api, type Health } from "./api";
import { BuildsPage } from "./builds/BuildsPage";
import { FeedbackBoard } from "./feedback/FeedbackBoard";
import { DraftEditor } from "./proposals/DraftEditor";
import { DraftsPage } from "./proposals/DraftsPage";
import { ImportPage } from "./proposals/ImportPage";
import { ProposalsPage } from "./proposals/ProposalsPage";
import { linkHandler, usePath } from "./router";
import { Icon, Kip, ToastProvider, type IconName } from "./ui";

type Route = "feedback" | "proposals" | "builds";

const NAV: { route: Route; path: string; label: string; icon: IconName }[] = [
  { route: "feedback", path: "/feedback", label: "Feedback", icon: "inbox" },
  { route: "proposals", path: "/proposals", label: "Proposals", icon: "pin" },
  { route: "builds", path: "/builds", label: "Builds", icon: "sliders" },
];

function routeFor(pathname: string): Route {
  // /feedback/review is the link used in operator emails.
  if (pathname.startsWith("/proposals")) return "proposals";
  if (pathname.startsWith("/builds")) return "builds";
  return "feedback";
}

export function App() {
  const path = usePath();
  const route = routeFor(path);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const label = NAV.find((item) => item.route === route)?.label ?? "Operator";
    document.title = `${label} · Parkdex Operator`;
  }, [route]);

  const environment = health?.environment ?? "";
  const live = environment === "production";
  const staging = environment === "staging";

  // A cookie, not local state, so screenshots and badge images load from the same database.
  function switchDatabase(target: "production" | "staging") {
    if (target === environment) return;
    document.cookie = `parkdex_operator_db=${target}; Path=/; Max-Age=31536000; SameSite=Strict; Secure`;
    window.location.reload();
  }

  return (
    <ToastProvider>
      <div className={`shell${staging ? " shell--staging" : ""}`}>
        <aside className="sidebar">
          <div className="brand">
            <Kip pose="avatar" size={44} className="brand__kip" />
            <div>
              <p className="brand__name">parkdex</p>
              <p className="brand__sub">Operator</p>
            </div>
          </div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((item) => (
              <a key={item.route} href={item.path} className={`nav__item${route === item.route ? " is-on" : ""}`} aria-current={route === item.route ? "page" : undefined} onClick={linkHandler(item.path)}>
                <Icon name={item.icon} size={20} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar__foot">
            {health?.canSwitch ? (
              <div className="db-toggle" role="radiogroup" aria-label="Database">
                {(["production", "staging"] as const).map((target) => (
                  <button key={target} type="button" role="radio" aria-checked={environment === target} className={`db-toggle__item db-toggle__item--${target}${environment === target ? " is-on" : ""}`} onClick={() => switchDatabase(target)}>
                    <span className="env__dot" aria-hidden="true" />
                    {target === "production" ? "Production" : "Staging"}
                  </button>
                ))}
              </div>
            ) : health && (
              <div className={`env${live ? " env--live" : ""}`} title="The database this dashboard reads and writes">
                <span className="env__dot" aria-hidden="true" />
                <span>{live ? "Production data" : `${environment[0]?.toUpperCase() ?? ""}${environment.slice(1)} data`}</span>
              </div>
            )}
            {health && health.emailMode !== "resend" && <p className="sidebar__note">{health.emailMode === "disabled" ? "Email sending is off here." : "Email retry is not set up yet."}</p>}
            <p className="sidebar__note"><Icon name="shield" size={14} /> Protected by Vercel login</p>
          </div>
        </aside>
        <main className="main">
          {staging && (
            <div className="staging-banner" role="status">
              <Icon name="alert" size={17} />
              <span>Editing <strong>staging</strong> data. Only staging and builds pointed at staging see these changes.</span>
            </div>
          )}
          {route === "feedback" && <FeedbackBoard />}
          {route === "proposals" && <ParksRoute path={path} />}
          {route === "builds" && <BuildsPage />}
        </main>
      </div>
    </ToastProvider>
  );
}

function ParksRoute({ path }: { path: string }) {
  const draft = /^\/proposals\/drafts\/([^/]+)$/.exec(path);
  if (draft) return <DraftEditor key={draft[1]} id={decodeURIComponent(draft[1])} />;
  if (path.startsWith("/proposals/drafts")) return <DraftsPage />;
  if (path.startsWith("/proposals/import")) return <ImportPage />;
  return <ProposalsPage />;
}
