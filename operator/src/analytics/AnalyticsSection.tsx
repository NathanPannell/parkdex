import { useState } from "react";
import { SectionTabs } from "../shell/SectionTabs";
import { PageHeader, Tabs } from "../ui";
import { AccountsPage } from "./AccountsPage";
import "./analytics.css";
import { OverviewPage } from "./OverviewPage";
import { PostHogEvents } from "./PostHogEvents";
import { ServerEvents } from "./ServerEvents";

/** Analytics section: /analytics/overview, /analytics/accounts and /analytics/events. */
export function AnalyticsSection({ path }: { path: string }) {
  return (
    <>
      <SectionTabs section="analytics" path={path} />
      {path.startsWith("/analytics/accounts") ? <AccountsPage /> : path.startsWith("/analytics/events") ? <EventsPage /> : <OverviewPage />}
    </>
  );
}

const SOURCES = [
  { id: "server", label: "Server events", icon: "database" as const },
  { id: "app", label: "App events (PostHog)", icon: "phone" as const },
];

/** Two sources in tabs; ?tab=app opens PostHog, so links from an account land on the right one. */
function EventsPage() {
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get("tab") === "app" ? "app" : "server"));
  const choose = (id: string) => {
    setTab(id);
    // Each tab keeps its own filters in the URL; switching starts the other one fresh.
    window.history.replaceState(null, "", id === "app" ? `${window.location.pathname}?tab=app` : window.location.pathname);
  };
  return (
    <section className="page analytics an-wide" aria-labelledby="events-title">
      <PageHeader
        id="events-title"
        eyebrow="Analytics"
        title="Events"
        lede={
          tab === "app"
            ? "What players tap and see in the app, from PostHog."
            : "Server events from kip_analytics.events: game events and, when you ask for them, one row per database query. Kept for 90 days."
        }
        actions={<Tabs label="Event source" value={tab} onChange={choose} items={SOURCES} />}
      />
      {tab === "app" ? <PostHogEvents /> : <ServerEvents />}
    </section>
  );
}
