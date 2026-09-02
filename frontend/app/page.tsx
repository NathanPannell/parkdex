import { MonitorDashboard } from "@/components/monitor-dashboard";

export default function Home() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return (
    <main>
      <header>
        <p className="eyebrow">Small systems, clearly observed</p>
        <h1>Uptime monitor</h1>
        <p className="subtitle">A tiny app for learning serious deployment workflows.</p>
      </header>
      <MonitorDashboard apiBaseUrl={apiBaseUrl} />
    </main>
  );
}

