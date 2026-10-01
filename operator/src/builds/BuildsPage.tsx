import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, type ApiPointer, type BuildConfig, type Platform, type UpdateRules } from "../api";
import { Drawer, Icon, Kip, Spinner, timeAgo, useToast } from "../ui";

type Listing = { builds: BuildConfig[]; rules: UpdateRules[]; knownFlags: string[] };

type FlagDraft = { name: string; value: boolean };

type Draft = {
  isNew: boolean;
  platform: Platform;
  build: string;
  label: string;
  apiPointer: "" | ApiPointer;
  flags: FlagDraft[];
  notes: string;
};

const FLAG_HINTS: Record<string, string> = {
  rankProgression: "Level up to unlock rarities",
  parkProposals: "Propose-a-park button on the map",
};

const POINTERS: { value: "" | ApiPointer; label: string; detail: string }[] = [
  { value: "", label: "Built-in", detail: "The server the build was made for" },
  { value: "production", label: "Production", detail: "web.parkdex.app API, accounts and content" },
  { value: "staging", label: "Staging", detail: "staging.web.parkdex.app API, accounts and content" },
];

const PLATFORMS: Record<Platform, string> = { android: "Android", web: "Web" };
const FLAG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

function emptyDraft(knownFlags: string[]): Draft {
  return { isNew: true, platform: "android", build: "", label: "", apiPointer: "", flags: knownFlags.map((name) => ({ name, value: true })), notes: "" };
}

function draftFrom(config: BuildConfig): Draft {
  return {
    isNew: false,
    platform: config.platform,
    build: String(config.build),
    label: config.label,
    apiPointer: config.apiPointer ?? "",
    flags: Object.entries(config.flags).map(([name, value]) => ({ name, value })),
    notes: config.notes,
  };
}

function buildTitle(config: Pick<BuildConfig, "build" | "platform">): string {
  return config.build === 0 ? `Every ${PLATFORMS[config.platform]} build` : `${PLATFORMS[config.platform]} build ${config.build}`;
}

function UpdateRulesRow({ rules, onSaved }: { rules: UpdateRules; onSaved(rules: UpdateRules): void }) {
  const toast = useToast();
  const [minimum, setMinimum] = useState(rules.minimumBuild === null ? "" : String(rules.minimumBuild));
  const [latest, setLatest] = useState(rules.latestBuild === null ? "" : String(rules.latestBuild));
  const [busy, setBusy] = useState(false);
  const dirty = minimum !== (rules.minimumBuild === null ? "" : String(rules.minimumBuild)) || latest !== (rules.latestBuild === null ? "" : String(rules.latestBuild));
  const name = rules.environment === "production" ? "Production" : "Staging";

  async function save(event: FormEvent) {
    event.preventDefault();
    for (const value of [minimum, latest]) {
      if (value && !/^\d{1,10}$/.test(value)) return toast.show("Builds are whole numbers, or leave the box empty.", { tone: "error" });
    }
    setBusy(true);
    try {
      const saved = await api<{ rules: UpdateRules }>(`/api/update-rules/${rules.environment}`, {
        method: "PUT",
        body: JSON.stringify({ minimumBuild: minimum ? Number(minimum) : null, latestBuild: latest ? Number(latest) : null }),
      });
      onSaved(saved.rules);
      toast.show(`Saved ${name.toLowerCase()} update rules`);
    } catch (reason) {
      toast.show(errorText(reason, "Could not save the update rules."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rule-row" onSubmit={save}>
      <div className="rule-row__env"><strong>{name}</strong></div>
      <label className="rule-row__field">
        <span className="sr-only">{name}: force update below build</span>
        <input className="build-input" inputMode="numeric" value={minimum} placeholder="—" onChange={(event) => setMinimum(event.target.value.trim())} />
      </label>
      <label className="rule-row__field">
        <span className="sr-only">{name}: latest build</span>
        <input className="build-input" inputMode="numeric" value={latest} placeholder="—" onChange={(event) => setLatest(event.target.value.trim())} />
      </label>
      <div className="rule-row__action">
        {dirty || busy
          ? <button type="submit" className="button button--primary button--small" disabled={busy}>{busy ? <><Spinner small /> Saving</> : "Save"}</button>
          : <span className="muted">{rules.updatedAt ? `Saved ${timeAgo(rules.updatedAt)}` : "Not set"}</span>}
      </div>
    </form>
  );
}

const SERVER: Record<"production" | "staging" | "builtin", { name: string; detail: string }> = {
  production: { name: "Production", detail: "web.parkdex.app" },
  staging: { name: "Staging", detail: "staging.web.parkdex.app" },
  builtin: { name: "Built-in", detail: "The server it shipped with" },
};

function BuildCard({ config, onOpen }: { config: BuildConfig; onOpen(): void }) {
  const server = SERVER[config.apiPointer ?? "builtin"];
  const flags = Object.entries(config.flags);
  return (
    <button type="button" className={`build${config.build === 0 ? " build--default" : ""}`} onClick={onOpen} aria-label={`Edit ${buildTitle(config).toLowerCase()}`}>
      <span className="build__id">
        <span className="build__kicker">{config.build === 0 ? "Default" : "Build"}</span>
        <span className="build__number">{config.build === 0 ? "All" : config.build}</span>
      </span>
      <span className="build__main">
        <strong className="build__title">{config.label || buildTitle(config)}</strong>
        {config.label && <span className="build__sub">{buildTitle(config)}</span>}
        {config.notes && <span className="build__notes">{config.notes}</span>}
        <span className="build__flags">
          {flags.length ? flags.map(([flag, on]) => (
            <span key={flag} className={`flag-pill${on ? " is-on" : ""}`}><span className="flag-pill__state">{on ? "On" : "Off"}</span>{flag}</span>
          )) : <span className="muted">No flags set</span>}
        </span>
        <span className="build__time">Updated {timeAgo(config.updatedAt)}</span>
      </span>
      <span className={`server server--${config.apiPointer ?? "builtin"}`}>
        <span className="server__kicker">Talks to</span>
        <span className="server__name">{server.name}</span>
        <span className="server__detail">{server.detail}</span>
      </span>
    </button>
  );
}

export function BuildsPage() {
  const toast = useToast();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newFlag, setNewFlag] = useState("");
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

  const knownFlags = listing?.knownFlags ?? [];

  function open(next: Draft) {
    setFormError("");
    setNewFlag("");
    setDraft(next);
  }

  function addFlag() {
    if (!draft) return;
    const name = newFlag.trim();
    if (!FLAG_NAME.test(name)) return setFormError("Flag names start with a letter and use letters, digits or underscores.");
    if (draft.flags.some((flag) => flag.name === name)) return setFormError("That flag is already on this build.");
    setFormError("");
    setDraft({ ...draft, flags: [...draft.flags, { name, value: true }] });
    setNewFlag("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!/^\d{1,10}$/.test(draft.build)) return setFormError("Build must be a whole number. Use 0 for the default row.");
    setBusy(true);
    setFormError("");
    try {
      await api(`/api/builds/${draft.platform}/${draft.build}`, {
        method: "PUT",
        body: JSON.stringify({
          label: draft.label,
          apiPointer: draft.apiPointer || null,
          flags: Object.fromEntries(draft.flags.map((flag) => [flag.name, flag.value])),
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
    if (!window.confirm(`Remove the row for ${buildTitle(config).toLowerCase()}? It will fall back to the default row.`)) return;
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
          <p className="page-lede">When each environment's builds must or should update, and which server and features each build uses.</p>
        </div>
        <div className="toolbar">
          <button type="button" className="button button--primary" onClick={() => open(emptyDraft(knownFlags))} disabled={!listing}><Icon name="plus" size={16} /> Add a build</button>
        </div>
      </header>

      {error && <div className="notice notice--error" role="alert"><Icon name="alert" /> {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}

      <section className="rules-panel" aria-labelledby="rules-title">
        <div className="rules-panel__head">
          <h2 id="rules-title">Update rules</h2>
          <p className="muted">Builds 8 and earlier count as production.</p>
        </div>
        <div className="rule-row rule-row--header" aria-hidden="true">
          <span>Environment</span>
          <span>Force update below<small>Blocking update screen</small></span>
          <span>Latest build<small>Dismissable update prompt</small></span>
          <span />
        </div>
        {listing ? listing.rules.map((rules) => (
          <UpdateRulesRow key={`${rules.environment}:${rules.updatedAt}`} rules={rules} onSaved={(saved) => setListing({ ...listing, rules: listing.rules.map((item) => item.environment === saved.environment ? saved : item) })} />
        )) : <div className="rule-row rule-row--loading"><Spinner small /> Loading rules...</div>}
      </section>

      {listing && listing.builds.length === 0 && (
        <div className="empty">
          <Kip pose="think" size={96} />
          <h2>No builds configured</h2>
          <p className="muted">Every build uses its built-in server and flags until you add a row.</p>
        </div>
      )}
      {listing && groups.filter((group) => group.rows.length).map((group) => (
        <div key={group.platform} className="build-group">
          <div className="build-group__head"><h2 className="build-group__title">{PLATFORMS[group.platform]} builds</h2><p className="muted">Server and flag changes apply on the next app launch.</p></div>
          {group.rows.map((config) => <BuildCard key={`${config.platform}:${config.build}`} config={config} onOpen={() => open(draftFrom(config))} />)}
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
                  <input inputMode="numeric" value={draft.build} disabled={!draft.isNew} placeholder="0 = every build" onChange={(event) => setDraft({ ...draft, build: event.target.value.trim() })} required />
                </label>
              </div>
              <label className="field">
                <span>Label</span>
                <input value={draft.label} maxLength={80} placeholder="e.g. 1.4 closed test" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
              </label>

              <fieldset className="field">
                <legend>API pointer</legend>
                <small className="muted field-hint">Moving a build to the other server signs players out there on their next launch; progress on the phone is kept.</small>
                <div className="choice-row">
                  {POINTERS.map((pointer) => (
                    <label key={pointer.value || "builtin"} className={`choice${draft.apiPointer === pointer.value ? " is-on" : ""}`}>
                      <input type="radio" name="pointer" checked={draft.apiPointer === pointer.value} onChange={() => setDraft({ ...draft, apiPointer: pointer.value })} />
                      <strong>{pointer.label}</strong>
                      <span>{pointer.detail}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="field">
                <legend>Feature flags</legend>
                {draft.flags.length === 0 && <p className="muted">No flags. The build uses its built-in defaults.</p>}
                {draft.flags.map((flag, index) => (
                  <div key={flag.name} className="flag">
                    <div>
                      <strong>{flag.name}</strong>
                      <span className="muted">{FLAG_HINTS[flag.name] ?? (knownFlags.includes(flag.name) ? "" : "Not read by current builds yet")}</span>
                    </div>
                    <div className="flag__controls">
                      <div className="tri" role="radiogroup" aria-label={flag.name}>
                        {([true, false] as const).map((value) => (
                          <button key={String(value)} type="button" role="radio" aria-checked={flag.value === value} className={`tri__item${flag.value === value ? ` is-on tri__item--${value ? "on" : "off"}` : ""}`}
                            onClick={() => setDraft({ ...draft, flags: draft.flags.map((item, at) => at === index ? { ...item, value } : item) })}>
                            {value ? "On" : "Off"}
                          </button>
                        ))}
                      </div>
                      <button type="button" className="icon-button icon-button--small" aria-label={`Remove ${flag.name}`} onClick={() => setDraft({ ...draft, flags: draft.flags.filter((_, at) => at !== index) })}><Icon name="close" size={15} /></button>
                    </div>
                  </div>
                ))}
                <div className="flag-add">
                  <input value={newFlag} placeholder="newFlagName" onChange={(event) => setNewFlag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFlag(); } }} aria-label="New flag name" />
                  <button type="button" className="button button--ghost button--small" onClick={addFlag}><Icon name="plus" size={15} /> Add flag</button>
                </div>
                {knownFlags.filter((name) => !draft.flags.some((flag) => flag.name === name)).length > 0 && (
                  <div className="chip-row flag-suggestions">
                    {knownFlags.filter((name) => !draft.flags.some((flag) => flag.name === name)).map((name) => (
                      <button key={name} type="button" className="chip" onClick={() => setDraft({ ...draft, flags: [...draft.flags, { name, value: true }] })}><Icon name="plus" size={13} /> {name}</button>
                    ))}
                  </div>
                )}
              </fieldset>

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
