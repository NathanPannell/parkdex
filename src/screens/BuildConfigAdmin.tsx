import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Kip } from "../components/Kip";
import { fetchOperatorApi } from "../lib/operatorApiTransport";
import "../feedback-review.css";
import "../build-config.css";

type Channel = "staging" | "main";
type Platform = "android" | "web";

type BuildConfig = {
  platform: Platform;
  build: number;
  label: string;
  contentChannel: Channel | null;
  flags: Record<string, boolean>;
  notes: string;
  updatedAt: string;
};

type Listing = { builds: BuildConfig[]; flags: string[] };

type Draft = {
  platform: Platform;
  build: string;
  label: string;
  contentChannel: "" | Channel;
  flags: Record<string, "" | "on" | "off">;
  notes: string;
};

const FLAG_LABELS: Record<string, string> = {
  rankProgression: "Rank progression (level up to unlock rarities)",
};

const CHANNEL_LABELS: Record<"" | Channel, string> = {
  "": "Built-in (whatever the build was made for)",
  staging: "Staging database",
  main: "Production database",
};

class OperatorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const response = await fetchOperatorApi(path, { ...init, headers }, globalThis.fetch, {
    pageOrigin: window.location.origin,
    allowLoopbackHttp: import.meta.env.DEV,
  });
  if (!response.ok) {
    let message = response.status === 401 ? "Your operator session has expired." : "The request could not be completed.";
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === "string" && body.message.trim()) message = body.message.slice(0, 240);
    } catch {
      // Keep the generic message.
    }
    throw new OperatorError(response.status, message);
  }
  return await response.json() as T;
}

function emptyDraft(flags: string[]): Draft {
  return { platform: "android", build: "", label: "", contentChannel: "", flags: Object.fromEntries(flags.map((flag) => [flag, ""])), notes: "" };
}

function draftFrom(config: BuildConfig, flags: string[]): Draft {
  return {
    platform: config.platform,
    build: String(config.build),
    label: config.label,
    contentChannel: config.contentChannel ?? "",
    flags: Object.fromEntries(flags.map((flag) => [flag, config.flags[flag] === undefined ? "" : config.flags[flag] ? "on" : "off"])),
    notes: config.notes,
  };
}

function buildName(config: Pick<BuildConfig, "build" | "platform">): string {
  return config.build === 0 ? `All ${config.platform} builds (default)` : `${config.platform} build ${config.build}`;
}

function flagSummary(config: BuildConfig): string {
  const entries = Object.entries(config.flags);
  if (!entries.length) return "Flags: defaults";
  return entries.map(([flag, on]) => `${flag} ${on ? "on" : "off"}`).join(", ");
}

/** Private operator page for per-build remote configuration: content database and feature flags. */
export function BuildConfigAdmin() {
  const [auth, setAuth] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await request<Listing>("/api/operator/app-config");
      setListing(result);
      setAuth("signed-in");
    } catch (error) {
      if (error instanceof OperatorError && error.status === 401) setAuth("signed-out");
      else setNotice(error instanceof Error ? error.message : "Could not load build configuration.");
    }
  }, []);

  useEffect(() => {
    request<{ authenticated?: boolean }>("/api/operator/session")
      .then((session) => (session.authenticated ? load() : setAuth("signed-out")))
      .catch(() => setAuth("signed-out"));
  }, [load]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await request("/api/operator/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      await load();
    } catch (error) {
      setNotice(error instanceof OperatorError && error.status === 401 ? "That password did not match. Try again." : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !listing) return;
    if (!/^\d{1,10}$/.test(draft.build)) {
      setNotice("Build must be a whole number. Use 0 for the default that applies to every build.");
      return;
    }
    const flags: Record<string, boolean> = {};
    for (const [flag, value] of Object.entries(draft.flags)) if (value) flags[flag] = value === "on";
    setBusy(true);
    setNotice(null);
    try {
      await request(`/api/operator/app-config/${draft.platform}/${draft.build}`, {
        method: "PUT",
        body: JSON.stringify({ label: draft.label, contentChannel: draft.contentChannel || null, flags, notes: draft.notes }),
      });
      setDraft(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(config: BuildConfig) {
    if (!window.confirm(`Remove the configuration for ${buildName(config)}? It will fall back to the default.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await request(`/api/operator/app-config/${config.platform}/${config.build}`, { method: "DELETE" });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove.");
    } finally {
      setBusy(false);
    }
  }

  if (auth === "checking") {
    return (
      <main className="fr-review fr-review--center" aria-live="polite">
        <div className="fr-state-card"><span className="fr-spinner" aria-hidden="true" /><p>Checking operator access...</p></div>
      </main>
    );
  }

  if (auth === "signed-out") {
    return (
      <main className="fr-review fr-review--auth">
        <section className="fr-auth-panel" aria-labelledby="bc-auth-title">
          <div className="fr-auth-mark"><Kip pose="think" size={62} /></div>
          <h1 id="bc-auth-title">Operator sign in</h1>
          <p className="fr-auth-copy">Build configuration controls which database each app build reads and which features it shows.</p>
          {notice && <p className="fr-auth-notice" role="status">{notice}</p>}
          <form className="fr-login-form" onSubmit={signIn}>
            <label htmlFor="bc-password">Operator password</label>
            <input id="bc-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
            <button className="fr-button fr-button--primary fr-button--wide" type="submit" disabled={!password.trim() || busy}>Sign in</button>
          </form>
        </section>
      </main>
    );
  }

  const flags = listing?.flags ?? [];
  return (
    <main className="fr-review bc-page" aria-label="Build configuration">
      <header className="bc-header">
        <Kip pose="avatar" size={43} />
        <div>
          <p className="fr-brand-name">parkdex · {window.location.host}</p>
          <h1>Build configuration</h1>
        </div>
      </header>
      <p className="bc-intro">
        Apps check in at launch and apply changes on their next launch. A specific build overrides the default row (build 0). Accounts always stay with the server the build was made for; only park content switches databases.
      </p>
      {notice && <p className="fr-auth-notice" role="status">{notice}</p>}

      <ul className="bc-list">
        {listing?.builds.map((config) => (
          <li key={`${config.platform}:${config.build}`} className="bc-row">
            <div>
              <strong>{buildName(config)}</strong>
              {config.label && <span className="bc-label">{config.label}</span>}
              <p>{CHANNEL_LABELS[config.contentChannel ?? ""]} · {flagSummary(config)}</p>
              {config.notes && <p className="bc-notes">{config.notes}</p>}
            </div>
            <div className="bc-actions">
              <button className="fr-button fr-button--paper" onClick={() => setDraft(draftFrom(config, flags))} disabled={busy}>Edit</button>
              <button className="fr-button fr-button--quiet" onClick={() => void remove(config)} disabled={busy}>Remove</button>
            </div>
          </li>
        ))}
        {listing && listing.builds.length === 0 && <li className="bc-row bc-row--empty">No builds configured yet. Every build uses its built-in defaults.</li>}
      </ul>

      {!draft && <button className="fr-button fr-button--primary" onClick={() => setDraft(emptyDraft(flags))}>Add a build</button>}

      {draft && (
        <form className="bc-form" onSubmit={save}>
          <div className="bc-grid">
            <label>Platform
              <select value={draft.platform} onChange={(event) => setDraft({ ...draft, platform: event.target.value as Platform })}>
                <option value="android">Android</option>
                <option value="web">Web</option>
              </select>
            </label>
            <label>Build (version code, 0 = default)
              <input inputMode="numeric" value={draft.build} onChange={(event) => setDraft({ ...draft, build: event.target.value.trim() })} required />
            </label>
            <label>Label
              <input value={draft.label} maxLength={80} placeholder="e.g. 1.4 closed test" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </label>
            <label>Content database
              <select value={draft.contentChannel} onChange={(event) => setDraft({ ...draft, contentChannel: event.target.value as Draft["contentChannel"] })}>
                {(Object.keys(CHANNEL_LABELS) as Array<"" | Channel>).map((value) => <option key={value} value={value}>{CHANNEL_LABELS[value]}</option>)}
              </select>
            </label>
            {flags.map((flag) => (
              <label key={flag}>{FLAG_LABELS[flag] ?? flag}
                <select value={draft.flags[flag] ?? ""} onChange={(event) => setDraft({ ...draft, flags: { ...draft.flags, [flag]: event.target.value as "" | "on" | "off" } })}>
                  <option value="">Default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            ))}
            <label className="bc-wide">Notes
              <textarea value={draft.notes} maxLength={500} rows={2} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </label>
          </div>
          <div className="bc-actions">
            <button className="fr-button fr-button--primary" type="submit" disabled={busy}>Save</button>
            <button className="fr-button fr-button--quiet" type="button" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </main>
  );
}
