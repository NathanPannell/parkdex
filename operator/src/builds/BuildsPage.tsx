import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, type BuildConfig, type Channel, type Platform } from "../api";
import { Drawer, Icon, Kip, Spinner, timeAgo, useToast } from "../ui";

type Listing = { builds: BuildConfig[]; flags: string[] };

type Draft = {
  isNew: boolean;
  platform: Platform;
  build: string;
  label: string;
  contentChannel: "" | Channel;
  flags: Record<string, "" | "on" | "off">;
  minimumBuild: string;
  latestBuild: string;
  notes: string;
};

const FLAG_LABELS: Record<string, { title: string; detail: string }> = {
  rankProgression: { title: "Rank progression", detail: "Level up to unlock rarities" },
  parkProposals: { title: "Propose a park", detail: "Button next to feedback on the map" },
};

const CHANNELS: { value: "" | Channel; label: string; detail: string }[] = [
  { value: "", label: "Built-in", detail: "Whatever the build was made for" },
  { value: "staging", label: "Staging", detail: "Staging park content" },
  { value: "main", label: "Production", detail: "Production park content" },
];

const PLATFORMS: Record<Platform, string> = { android: "Android", web: "Web" };

function emptyDraft(flags: string[]): Draft {
  return { isNew: true, platform: "android", build: "", label: "", contentChannel: "", flags: Object.fromEntries(flags.map((flag) => [flag, ""])), minimumBuild: "", latestBuild: "", notes: "" };
}

function draftFrom(config: BuildConfig, flags: string[]): Draft {
  return {
    isNew: false,
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

function buildTitle(config: Pick<BuildConfig, "build" | "platform">): string {
  return config.build === 0 ? `Every ${PLATFORMS[config.platform]} build` : `${PLATFORMS[config.platform]} build ${config.build}`;
}

export function BuildsPage() {
  const toast = useToast();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Listing>("/api/builds", { signal: controller.signal })
      .then(setListing)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load build configuration.")); });
    return () => controller.abort();
  }, [revision]);

  const flags = listing?.flags ?? [];

  function open(next: Draft) {
    setFormError("");
    setDraft(next);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!/^\d{1,10}$/.test(draft.build)) return setFormError("Build must be a whole number. Use 0 for the default row.");
    for (const value of [draft.minimumBuild, draft.latestBuild]) {
      if (value && !/^\d{1,10}$/.test(value)) return setFormError("Minimum and latest build must be whole numbers, or left blank.");
    }
    const flagValues: Record<string, boolean> = {};
    for (const [flag, value] of Object.entries(draft.flags)) if (value) flagValues[flag] = value === "on";
    setBusy(true);
    setFormError("");
    try {
      await api(`/api/builds/${draft.platform}/${draft.build}`, {
        method: "PUT",
        body: JSON.stringify({
          label: draft.label,
          contentChannel: draft.contentChannel || null,
          flags: flagValues,
          minimumBuild: draft.minimumBuild ? Number(draft.minimumBuild) : null,
          latestBuild: draft.latestBuild ? Number(draft.latestBuild) : null,
          notes: draft.notes,
        }),
      });
      toast.show(`Saved ${buildTitle({ platform: draft.platform, build: Number(draft.build) }).toLowerCase()}`);
      setDraft(null);
      setRevision((value) => value + 1);
    } catch (reason) {
      setFormError(errorText(reason, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(config: BuildConfig) {
    if (!window.confirm(`Remove the row for ${buildTitle(config).toLowerCase()}? It will fall back to the default.`)) return;
    setBusy(true);
    try {
      await api(`/api/builds/${config.platform}/${config.build}`, { method: "DELETE" });
      toast.show("Row removed");
      setDraft(null);
      setRevision((value) => value + 1);
    } catch (reason) {
      toast.show(errorText(reason, "Could not remove that row."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const groups = (Object.keys(PLATFORMS) as Platform[]).map((platform) => ({
    platform,
    // The default row (build 0) leads, then specific builds newest first.
    rows: (listing?.builds.filter((row) => row.platform === platform) ?? []).sort((a, b) => (a.build === 0 ? -1 : b.build === 0 ? 1 : b.build - a.build)),
  }));

  return (
    <section className="page" aria-labelledby="builds-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Remote config</p>
          <h1 id="builds-title">Build configuration</h1>
          <p className="page-lede">Choose which park content each app build reads, which features it shows, and when it should update. A build's own row overrides the default (build 0).</p>
        </div>
        <div className="toolbar">
          <button type="button" className="button button--primary" onClick={() => open(emptyDraft(flags))} disabled={!listing}><Icon name="plus" size={16} /> Add a build</button>
        </div>
      </header>

      <div className="notice"><Icon name="alert" size={18} /> Apps pick up content and flag changes on their next launch. Update prompts apply right away. Accounts always stay on the server the build was made for.</div>
      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}

      {!listing && !error && <div className="build-group"><div className="build build--skeleton" aria-hidden="true" /><div className="build build--skeleton" aria-hidden="true" /></div>}
      {listing && listing.builds.length === 0 && (
        <div className="empty">
          <Kip pose="think" size={96} />
          <h2>No builds configured</h2>
          <p className="muted">Every build uses its built-in defaults until you add a row.</p>
        </div>
      )}
      {listing && groups.filter((group) => group.rows.length).map((group) => (
        <div key={group.platform} className="build-group">
          <h2 className="build-group__title">{PLATFORMS[group.platform]}</h2>
          {group.rows.map((config) => (
            <button key={`${config.platform}:${config.build}`} type="button" className={`build${config.build === 0 ? " build--default" : ""}`} onClick={() => open(draftFrom(config, flags))}>
              <span className="build__number">{config.build === 0 ? "All" : config.build}</span>
              <span className="build__main">
                <strong>{buildTitle(config)}{config.label && <span className="build__label">{config.label}</span>}</strong>
                <span className="build__chips">
                  <span className={`meta-pill meta-pill--${config.contentChannel ?? "builtin"}`}>{CHANNELS.find((item) => item.value === (config.contentChannel ?? ""))?.label} content</span>
                  {Object.entries(config.flags).map(([flag, on]) => (
                    <span key={flag} className={`meta-pill ${on ? "meta-pill--on" : "meta-pill--off"}`}>{FLAG_LABELS[flag]?.title ?? flag} {on ? "on" : "off"}</span>
                  ))}
                  {config.minimumBuild !== null && <span className="meta-pill meta-pill--warn">Must update below {config.minimumBuild}</span>}
                  {config.latestBuild !== null && <span className="meta-pill">Nudge below {config.latestBuild}</span>}
                </span>
                {config.notes && <span className="build__notes">{config.notes}</span>}
              </span>
              <span className="build__time muted">Updated {timeAgo(config.updatedAt)}</span>
              <Icon name="edit" size={18} className="build__edit" />
            </button>
          ))}
        </div>
      ))}

      <Drawer open={Boolean(draft)} onClose={() => !busy && setDraft(null)} label="Edit build configuration">
        {draft && (
          <form className="build-form" onSubmit={save}>
            <div className="drawer__head">
              <div>
                <p className="eyebrow">{draft.isNew ? "New row" : "Edit row"}</p>
                <h2>{draft.isNew ? "Add a build" : buildTitle({ platform: draft.platform, build: Number(draft.build) })}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setDraft(null)} aria-label="Close" disabled={busy}><Icon name="close" /></button>
            </div>
            <div className="drawer__body">
              <div className="field-row">
                <label className="field">
                  <span>Platform</span>
                  <select value={draft.platform} disabled={!draft.isNew} onChange={(event) => setDraft({ ...draft, platform: event.target.value as Platform })}>
                    <option value="android">Android</option>
                    <option value="web">Web</option>
                  </select>
                </label>
                <label className="field">
                  <span>Build number</span>
                  <input inputMode="numeric" value={draft.build} disabled={!draft.isNew} placeholder="0 = default" onChange={(event) => setDraft({ ...draft, build: event.target.value.trim() })} required />
                </label>
              </div>
              <label className="field">
                <span>Label</span>
                <input value={draft.label} maxLength={80} placeholder="e.g. 1.4 closed test" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
              </label>

              <fieldset className="field">
                <legend>Park content</legend>
                <div className="choice-row">
                  {CHANNELS.map((channel) => (
                    <label key={channel.value || "builtin"} className={`choice${draft.contentChannel === channel.value ? " is-on" : ""}`}>
                      <input type="radio" name="channel" checked={draft.contentChannel === channel.value} onChange={() => setDraft({ ...draft, contentChannel: channel.value })} />
                      <strong>{channel.label}</strong>
                      <span>{channel.detail}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="field">
                <legend>Features</legend>
                {flags.map((flag) => (
                  <div key={flag} className="flag">
                    <div>
                      <strong>{FLAG_LABELS[flag]?.title ?? flag}</strong>
                      {FLAG_LABELS[flag] && <span className="muted">{FLAG_LABELS[flag].detail}</span>}
                    </div>
                    <div className="tri" role="radiogroup" aria-label={FLAG_LABELS[flag]?.title ?? flag}>
                      {(["", "on", "off"] as const).map((value) => (
                        <button key={value || "default"} type="button" role="radio" aria-checked={draft.flags[flag] === value} className={`tri__item${draft.flags[flag] === value ? ` is-on tri__item--${value || "default"}` : ""}`} onClick={() => setDraft({ ...draft, flags: { ...draft.flags, [flag]: value } })}>
                          {value === "" ? "Default" : value === "on" ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </fieldset>

              <div className="field-row">
                <label className="field">
                  <span>Minimum build</span>
                  <input inputMode="numeric" value={draft.minimumBuild} placeholder="None" onChange={(event) => setDraft({ ...draft, minimumBuild: event.target.value.trim() })} />
                  <small className="muted">Older builds must update.</small>
                </label>
                <label className="field">
                  <span>Latest build</span>
                  <input inputMode="numeric" value={draft.latestBuild} placeholder="None" onChange={(event) => setDraft({ ...draft, latestBuild: event.target.value.trim() })} />
                  <small className="muted">Older builds get a nudge.</small>
                </label>
              </div>
              <label className="field">
                <span>Notes</span>
                <textarea value={draft.notes} maxLength={500} rows={3} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </label>
              {formError && <div className="notice notice--error" role="alert"><Icon name="alert" size={18} /> {formError}</div>}
            </div>
            <div className="drawer__foot">
              {!draft.isNew && (
                <button type="button" className="button button--danger" disabled={busy} onClick={() => {
                  const row = listing?.builds.find((item) => item.platform === draft.platform && String(item.build) === draft.build);
                  if (row) void remove(row);
                }}><Icon name="trash" size={16} /> Remove</button>
              )}
              <span className="spacer" />
              <button type="button" className="button button--ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy}>{busy ? <><Spinner small /> Saving</> : "Save"}</button>
            </div>
          </form>
        )}
      </Drawer>
    </section>
  );
}
