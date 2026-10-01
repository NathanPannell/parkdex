import { useCallback, useState, type FormEvent } from "react";
import { Kip } from "../components/Kip";
import { OperatorNav } from "../components/OperatorNav";
import { OperatorGate, operatorRequest as request, useOperatorSession } from "../components/OperatorSession";
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
  minimumBuild: number | null;
  latestBuild: number | null;
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
  minimumBuild: string;
  latestBuild: string;
  notes: string;
};

const FLAG_LABELS: Record<string, string> = {
  rankProgression: "Rank progression (level up to unlock rarities)",
  parkProposals: "Propose a park (button next to feedback)",
};

const CHANNEL_LABELS: Record<"" | Channel, string> = {
  "": "Built-in (whatever the build was made for)",
  staging: "Staging database",
  main: "Production database",
};

function emptyDraft(flags: string[]): Draft {
  return { platform: "android", build: "", label: "", contentChannel: "", flags: Object.fromEntries(flags.map((flag) => [flag, ""])), minimumBuild: "", latestBuild: "", notes: "" };
}

function draftFrom(config: BuildConfig, flags: string[]): Draft {
  return {
    platform: config.platform,
    build: String(config.build),
    label: config.label,
    contentChannel: config.contentChannel ?? "",
    flags: Object.fromEntries(flags.map((flag) => [flag, config.flags[flag] === undefined ? "" : config.flags[flag] ? "on" : "off"])),
    minimumBuild: config.minimumBuild === null ? "" : String(config.minimumBuild),
    latestBuild: config.latestBuild === null ? "" : String(config.latestBuild),
    notes: config.notes,
  };
}

function buildName(config: Pick<BuildConfig, "build" | "platform">): string {
  return config.build === 0 ? `All ${config.platform} builds (default)` : `${config.platform} build ${config.build}`;
}

function updateSummary(config: BuildConfig): string | null {
  if (config.minimumBuild === null && config.latestBuild === null) return null;
  const parts = [];
  if (config.minimumBuild !== null) parts.push(`must update below ${config.minimumBuild}`);
  if (config.latestBuild !== null) parts.push(`nudge below ${config.latestBuild}`);
  return `Updates: ${parts.join(", ")}`;
}

function flagSummary(config: BuildConfig): string {
  const entries = Object.entries(config.flags);
  if (!entries.length) return "Flags: defaults";
  return entries.map(([flag, on]) => `${flag} ${on ? "on" : "off"}`).join(", ");
}

/** Private operator page for per-build remote configuration: content database and feature flags. */
export function BuildConfigAdmin() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setListing(await request<Listing>("/api/operator/app-config"));
  }, []);
  const session = useOperatorSession(load);
  const { notice, setNotice } = session;

  async function signOut() {
    setBusy(true);
    await session.signOut();
    setListing(null);
    setDraft(null);
    setBusy(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !listing) return;
    for (const value of [draft.minimumBuild, draft.latestBuild]) {
      if (value && !/^\d{1,10}$/.test(value)) {
        setNotice("Minimum and latest build must be whole numbers, or left blank.");
        return;
      }
    }
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
        body: JSON.stringify({
          label: draft.label,
          contentChannel: draft.contentChannel || null,
          flags,
          minimumBuild: draft.minimumBuild ? Number(draft.minimumBuild) : null,
          latestBuild: draft.latestBuild ? Number(draft.latestBuild) : null,
          notes: draft.notes,
        }),
      });
      setDraft(null);
      await session.refresh();
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
      await session.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove.");
    } finally {
      setBusy(false);
    }
  }

  const flags = listing?.flags ?? [];
  return (
    <OperatorGate auth={session.auth} notice={notice} signIn={session.signIn} copy="Build configuration controls which database each app build reads and which features it shows.">
    <main className="fr-review bc-page" aria-label="Build configuration">
      <header className="bc-header">
        <Kip pose="avatar" size={43} />
        <div className="bc-title">
          <p className="fr-brand-name">parkdex · {window.location.host}</p>
          <h1>Build configuration</h1>
        </div>
        <div className="bc-actions">
          <OperatorNav />
          <button className="fr-button fr-button--quiet" type="button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
        </div>
      </header>
      <p className="bc-intro">
        Apps check in at launch and apply content and flag changes on their next launch; update prompts apply right away. A specific build overrides the default row (build 0). Accounts always stay with the server the build was made for; only park content switches databases.
      </p>
      {notice && <p className="fr-auth-notice" role="status">{notice}</p>}

      <ul className="bc-list">
        {listing?.builds.map((config) => (
          <li key={`${config.platform}:${config.build}`} className="bc-row">
            <div>
              <strong>{buildName(config)}</strong>
              {config.label && <span className="bc-label">{config.label}</span>}
              <p>{CHANNEL_LABELS[config.contentChannel ?? ""]} · {flagSummary(config)}</p>
              {updateSummary(config) && <p>{updateSummary(config)}</p>}
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
            <label>Minimum build (older must update)
              <input inputMode="numeric" value={draft.minimumBuild} placeholder="Blank for none" onChange={(event) => setDraft({ ...draft, minimumBuild: event.target.value.trim() })} />
            </label>
            <label>Latest build (older get a nudge)
              <input inputMode="numeric" value={draft.latestBuild} placeholder="Blank for none" onChange={(event) => setDraft({ ...draft, latestBuild: event.target.value.trim() })} />
            </label>
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
    </OperatorGate>
  );
}
