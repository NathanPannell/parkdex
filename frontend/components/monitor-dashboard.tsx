"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Monitor = {
  id: string;
  name: string;
  url: string;
  status: "UNKNOWN" | "UP" | "DOWN";
  http_status: number | null;
  response_time_ms: number | null;
  checked_at: string | null;
  created_at: string;
};

function checkedLabel(value: string | null): string {
  if (!value) return "Waiting for first check";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function MonitorDashboard({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!apiBaseUrl) return;
    try {
      const response = await fetch(`${apiBaseUrl}/api/monitors`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load monitors");
      setMonitors(await response.json());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load monitors");
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  async function addMonitor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/monitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Could not add monitor");
      }
      setName("");
      setUrl("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add monitor");
    } finally {
      setBusy(false);
    }
  }

  async function removeMonitor(id: string) {
    setError("");
    const response = await fetch(`${apiBaseUrl}/api/monitors/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete monitor");
      return;
    }
    setMonitors((current) => current.filter((monitor) => monitor.id !== id));
  }

  if (!apiBaseUrl) {
    return (
      <section className="notice error" role="alert">
        NEXT_PUBLIC_API_BASE_URL is missing. This preview is deliberately not falling back to
        production.
      </section>
    );
  }

  return (
    <>
      <form className="add-form" onSubmit={addMonitor}>
        <div className="form-row">
          <div className="field name-field">
            <label htmlFor="name">Monitor name</label>
            <input
              id="name"
              type="text"
              placeholder="Marketing site"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
          </div>
          <div className="field url-field">
            <label htmlFor="url">URL to monitor</label>
            <input
              id="url"
              type="url"
              placeholder="https://example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              maxLength={2048}
            />
          </div>
          <button disabled={busy}>{busy ? "Adding..." : "Add monitor"}</button>
        </div>
      </form>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <section className="monitor-list" aria-live="polite">
        <div className="list-heading">
          <h2>Monitors</h2>
          <button className="quiet" onClick={() => void load()} type="button">
            Refresh
          </button>
        </div>
        {monitors.length === 0 ? (
          <div className="empty">No URLs yet. Add one above.</div>
        ) : (
          monitors.map((monitor) => (
            <article className="monitor" key={monitor.id}>
              <div className={`status ${monitor.status.toLowerCase()}`}>
                <span className="status-dot" />
                {monitor.status}
              </div>
              <div className="monitor-main">
                <h3>{monitor.name}</h3>
                <a href={monitor.url} target="_blank" rel="noreferrer">
                  {monitor.url}
                </a>
                <p>Last checked {checkedLabel(monitor.checked_at)}</p>
              </div>
              <dl>
                <div>
                  <dt>HTTP</dt>
                  <dd>{monitor.http_status ?? "\u2014"}</dd>
                </div>
                <div>
                  <dt>Response</dt>
                  <dd>
                    {monitor.response_time_ms === null
                      ? "\u2014"
                      : `${monitor.response_time_ms} ms`}
                  </dd>
                </div>
              </dl>
              <button
                className="delete"
                aria-label={`Delete ${monitor.name}`}
                onClick={() => void removeMonitor(monitor.id)}
                type="button"
              >
                Delete
              </button>
            </article>
          ))
        )}
      </section>
    </>
  );
}
