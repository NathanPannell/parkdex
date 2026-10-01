import { useEffect, useState, type MouseEvent } from "react";
import { api, type Health } from "./api";
import { BuildsPage } from "./builds/BuildsPage";
import { FeedbackBoard } from "./feedback/FeedbackBoard";
import { ProposalsPage } from "./proposals/ProposalsPage";
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
  const [route, setRoute] = useState<Route>(() => routeFor(window.location.pathname));
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(routeFor(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const label = NAV.find((item) => item.route === route)?.label ?? "Operator";
    document.title = `${label} · Parkdex Operator`;
  }, [route]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, path: string, next: Route) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute(next);
    window.scrollTo({ top: 0 });
  }

  const environment = health?.environment ?? "";
  const live = environment === "production";

  return (
    <ToastProvider>
      <div className="shell">
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
              <a key={item.route} href={item.path} className={`nav__item${route === item.route ? " is-on" : ""}`} aria-current={route === item.route ? "page" : undefined} onClick={(event) => navigate(event, item.path, item.route)}>
                <Icon name={item.icon} size={20} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar__foot">
            {health && (
              <div className={`env${live ? " env--live" : ""}`} title="The database this dashboard reads and writes">
                <span className="env__dot" aria-hidden="true" />
                <span>{live ? "Production data" : `${environment[0]?.toUpperCase() ?? ""}${environment.slice(1)} data`}</span>
              </div>
            )}
            {health?.emailMode === "disabled" && <p className="sidebar__note">Email sending is off here.</p>}
            <p className="sidebar__note"><Icon name="shield" size={14} /> Protected by Vercel login</p>
          </div>
        </aside>
        <main className="main">
          {route === "feedback" && <FeedbackBoard />}
          {route === "proposals" && <ProposalsPage />}
          {route === "builds" && <BuildsPage />}
        </main>
      </div>
    </ToastProvider>
  );
}
