import { useEffect, useState, type ComponentType } from "react";
import { AnalyticsSection } from "./analytics/AnalyticsSection";
import { api, type Health } from "./api";
import { AppSection } from "./app/AppSection";
import { FeedbackSection } from "./feedback/FeedbackSection";
import { ParksSection } from "./parks/ParksSection";
import { linkHandler, navigate, usePath } from "./router";
import { DEFAULT_PATH, redirectFor, resolveRoute, type SectionId } from "./routes";
import { DashboardContext } from "./shell/DashboardContext";
import { Sidebar } from "./shell/Sidebar";
import { Topbar } from "./shell/Topbar";
import { ConfirmProvider, EmptyState, Icon, ToastProvider } from "./ui";

/** Each section's page component. A section owns everything under its own folder. */
const SECTION_PAGES: Record<SectionId, ComponentType<{ path: string }>> = {
  feedback: FeedbackSection,
  parks: ParksSection,
  analytics: AnalyticsSection,
  app: AppSection,
};

export function App() {
  const path = usePath();
  const [health, setHealth] = useState<Health | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const redirect = redirectFor(path);
  const route = redirect ? null : resolveRoute(path);

  useEffect(() => {
    // Keep the query string, so /feedback/review?id=... style links survive a redirect.
    if (redirect) navigate(`${redirect}${window.location.search}`, { replace: true });
  }, [redirect]);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const label = route?.child?.label ?? route?.section.label ?? "Operator";
    document.title = `${label} · Parkdex Operator`;
  }, [route?.child?.label, route?.section.label]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Build config always lives in production, whichever database the other pages are showing.
  const pinned = route?.database === "production";
  const environment = pinned ? "production" : health?.environment ?? "";
  const staging = environment === "staging";

  // A cookie, not local state, so screenshots and images load from the same database.
  function switchDatabase(target: string) {
    if (target === environment) return;
    document.cookie = `parkdex_operator_db=${target}; Path=/; Max-Age=31536000; SameSite=Strict; Secure`;
    window.location.reload();
  }

  const Page = route ? SECTION_PAGES[route.section.id] : null;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardContext.Provider value={{ health, environment, switchDatabase }}>
          <div className={`shell${staging ? " shell--staging" : ""}`}>
            <Sidebar path={path} route={route} health={health} environment={environment} open={menuOpen} onClose={() => setMenuOpen(false)} onSwitch={switchDatabase} />
            <div className="workspace">
              <Topbar route={route} environment={environment} menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} />
              <main className="main" id="main">
                {staging && (
                  <div className="staging-banner" role="status">
                    <Icon name="alert" size={17} />
                    <span>Editing <strong>staging</strong> data. Only staging and builds pointed at staging see these changes.</span>
                  </div>
                )}
                {Page && <Page path={path} />}
                {!Page && !redirect && (
                  <EmptyState title="Nothing lives here" pose="sleep" action={<a className="button" href={DEFAULT_PATH} onClick={linkHandler(DEFAULT_PATH)}>Go to Feedback</a>}>
                    <p className="muted">The page {path} is not part of the dashboard.</p>
                  </EmptyState>
                )}
              </main>
            </div>
          </div>
        </DashboardContext.Provider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
