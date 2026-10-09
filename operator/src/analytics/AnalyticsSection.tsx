import { Placeholder } from "../shell/Placeholder";
import { SectionTabs } from "../shell/SectionTabs";
import { StatGrid, StatTile } from "../ui";

/** Analytics section: /analytics/overview, /analytics/accounts and /analytics/events. */
export function AnalyticsSection({ path }: { path: string }) {
  return (
    <>
      <SectionTabs section="analytics" path={path} />
      {path.startsWith("/analytics/accounts") ? <AccountsPage /> : path.startsWith("/analytics/events") ? <EventsPage /> : <OverviewPage />}
    </>
  );
}

function OverviewPage() {
  return (
    <Placeholder
      eyebrow="Analytics"
      title="Overview"
      lede="How many people play, and what they do in parks."
      items={[
        "Accounts created and signed-in players per day, week and month",
        "Parks founded, visits, plants and takes",
        "Photo approve rate and the top parks",
        "App taps and screen views from PostHog, with a personal API key in the dashboard environment",
      ]}
    >
      <StatGrid>
        <StatTile label="Accounts" value={null} icon="users" hint="Not connected yet" />
        <StatTile label="Players this week" value={null} icon="activity" tone="moss" hint="Not connected yet" />
        <StatTile label="Parks founded" value={null} icon="park" tone="sun" hint="Not connected yet" />
        <StatTile label="Visits" value={null} icon="pin" tone="sea" hint="Not connected yet" />
      </StatGrid>
    </Placeholder>
  );
}

function AccountsPage() {
  return (
    <Placeholder
      eyebrow="Analytics"
      title="Accounts"
      lede="Every Parkdex account, with search."
      items={[
        "Search accounts by email or name",
        "Delete an account through the app's own deletion, so its photos are cleaned up too",
      ]}
    />
  );
}

function EventsPage() {
  return (
    <Placeholder
      eyebrow="Analytics"
      title="Events"
      lede="Server events from kip_analytics.events, kept for 90 days."
      items={[
        "Filter by event name, account, park and time",
        "Open an event to see its full payload",
      ]}
    />
  );
}
