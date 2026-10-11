import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "../api";
import { linkHandler, navigate } from "../router";
import { Card, formatCount, fullDate, Icon, Notice, PageHeader, Spinner, timeAgo, useConfirm, useToast } from "../ui";
import { MapEditor } from "./MapEditor";
import { RegionSelect } from "./RegionSelect";
import {
  BIOMES, CATEGORIES, RARITIES, SHAPE_FOR_CATEGORY, SOURCE_LABELS, title,
  type ChangeRow, type LivePark, type LiveParkDetail, type MultiPolygon, type ParkActivity, type Position, type RemovalPlan, type RemovalResult,
} from "./types";

/**
 * /parks/<id>: one park. Edit its fields and outline (a guarded save that is refused with 409
 * park_changed when someone else changed it first), hide or unhide it, remove it from the map so it
 * can be founded again, delete it, and moderate its founder and cover. The side panels show
 * visits, the flag holder and the content history.
 */

type Form = Pick<LivePark, "name" | "short" | "category" | "region" | "biome" | "rarity" | "blurb">;
const FORM_KEYS = ["name", "short", "category", "region", "biome", "rarity", "blurb"] as const;
const PARK_KEYS = ["id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb"] as const;
const FIELD_LABELS: Record<string, string> = { blurb: "description", short: "short name", lat: "pin", lng: "pin" };

function formOf(park: LivePark): Form {
  return Object.fromEntries(FORM_KEYS.map((key) => [key, park[key]])) as Form;
}

/** The park as it was opened, which the server checks before saving. */
function expectedOf(park: LiveParkDetail): LivePark {
  return Object.fromEntries(PARK_KEYS.map((key) => [key, park[key]])) as LivePark;
}

function BackLink() {
  return <a className="back-link" href="/parks" onClick={linkHandler("/parks")}><Icon name="chevron" size={14} className="flip" /> All parks</a>;
}

function bytes(value: number): string {
  return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function day(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

/** What changed in each park upsert, compared with the one before it in the list. */
function describeChange(change: ChangeRow, previous: Record<string, unknown> | null): ReactNode {
  if (change.operation === "delete") {
    return change.entity === "park" ? "Removed from phones (hidden or deleted)" : `${title(change.entity)} removed`;
  }
  if (change.entity === "boundary") return "Outline written";
  if (change.entity === "drive") return "Drive data written";
  if (change.entity !== "park" || !change.value) return "Updated";
  if (!previous) return "Park written";
  const keys = Object.keys(change.value).filter((key) => JSON.stringify(change.value![key]) !== JSON.stringify(previous[key]));
  if (!keys.length) return "Park written again with the same values";
  return (
    <span className="pp-diff">
      {keys.slice(0, 4).map((key) => (
        <span key={key}><strong>{FIELD_LABELS[key] ?? key}</strong> {String(previous[key] ?? "").slice(0, 40) || "empty"} <Icon name="chevron" size={11} /> {String(change.value![key] ?? "").slice(0, 40) || "empty"}</span>
      ))}
      {keys.length > 4 && <span>and {keys.length - 4} more</span>}
    </span>
  );
}

function History({ history }: { history: ChangeRow[] }) {
  if (!history.length) return <p className="muted pp-empty">No content changes are recorded for this park yet.</p>;
  // Park upserts newest first; each is compared with the next older park upsert.
  const parkValues = history.filter((change) => change.entity === "park" && change.operation === "upsert" && change.value);
  return (
    <div className="table-wrap pp-history">
      <table className="table table--dense">
        <thead><tr><th scope="col" style={{ width: 64 }}>Rev</th><th scope="col" style={{ width: 96 }}>When</th><th scope="col">Change</th></tr></thead>
        <tbody>
          {history.map((change) => {
            const index = parkValues.indexOf(change);
            const previous = index >= 0 ? parkValues[index + 1]?.value ?? null : null;
            return (
              <tr key={`${change.revision}-${change.entity}`}>
                <td className="pp-num">{change.revision}</td>
                <td title={fullDate(change.at)}>{timeAgo(change.at)}</td>
                <td><span className={`pp-op pp-op--${change.operation}`}>{change.entity}</span> {describeChange(change, previous)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ParkPage({ id }: { id: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [park, setPark] = useState<LiveParkDetail | null>(null);
  const [activity, setActivity] = useState<ParkActivity | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pin, setPin] = useState<Position | null>(null);
  const [geometry, setGeometry] = useState<MultiPolygon | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);
  const [removal, setRemoval] = useState<RemovalPlan | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const path = `/api/parks/${encodeURIComponent(id)}`;

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ park: LiveParkDetail; activity: ParkActivity }>(path, { signal: controller.signal })
      .then((loaded) => { setPark(loaded.park); setActivity(loaded.activity); setForm(formOf(loaded.park)); setPin(null); setGeometry(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load this park.")); });
    return () => controller.abort();
  }, [path, reload]);

  // Whether Remove from map can apply, so the button can say why not before anyone clicks it.
  const loadRemoval = useCallback(async (signal?: AbortSignal) => {
    try {
      const loaded = await api<{ plan: RemovalPlan }>(`${path}/remove-from-map`, { signal });
      setRemoval(loaded.plan);
      return loaded.plan;
    } catch {
      if (!signal?.aborted) setRemoval(null);
      return null;
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRemoval(controller.signal);
    return () => controller.abort();
  }, [loadRemoval, reload]);

  // Moderation changes the activity panels, not the form; refresh them without dropping edits.
  const refreshActivity = useCallback(async () => {
    try {
      const loaded = await api<{ activity: ParkActivity }>(path);
      setActivity(loaded.activity);
    } catch {
      // The next full load shows it.
    }
    void loadRemoval();
  }, [path, loadRemoval]);

  if (error) return <section className="page"><BackLink /><Notice tone="error">{error}</Notice></section>;
  if (!park || !form || !activity) return <section className="page"><BackLink /><div className="drawer__state"><Spinner /> Opening park...</div></section>;

  const changed = FORM_KEYS.filter((key) => form[key] !== park[key]);
  const pinChanged = Boolean(pin && (pin[0] !== park.lng || pin[1] !== park.lat));
  const dirty = changed.length > 0 || pinChanged || Boolean(geometry);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const { hidden, founder, flag } = activity;

  function describe(): string {
    const parts: string[] = changed.map((key) => FIELD_LABELS[key] ?? key);
    if (pinChanged) parts.push("pin");
    if (geometry) parts.push("boundary");
    return parts.join(", ");
  }

  async function save() {
    if (!park || !form || !dirty) return;
    const confirmed = await confirm({
      title: `Save changes to ${park.name}?`,
      body: <p>Changing the {describe()}. {hidden ? "The park is hidden, so players see this only after you unhide it." : "Every player's app picks this up on its next content sync."}</p>,
      confirmLabel: "Save to Parkdex",
      icon: "check",
    });
    if (!confirmed) return;
    const changes: Record<string, unknown> = Object.fromEntries(changed.map((key) => [key, form[key]]));
    if (pinChanged && pin) Object.assign(changes, { lng: pin[0], lat: pin[1] });
    if (geometry) changes.geometry = geometry;
    setSaving(true);
    try {
      const { park: saved } = await api<{ park: LiveParkDetail }>(path, { method: "PATCH", body: JSON.stringify({ expected: expectedOf(park), changes }) });
      setPark(saved);
      setForm(formOf(saved));
      setPin(null);
      setGeometry(null);
      toast.show(`${saved.name} saved to Parkdex`);
      void refreshActivity();
    } catch (reason) {
      toast.show(errorText(reason, "Could not save. Nothing was changed."), { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function act(label: string, run: () => Promise<unknown>, done: string, undo?: { label: string; run(): void }) {
    setBusy(label);
    try {
      await run();
      toast.show(done, undo ? { action: undo } : undefined);
      await refreshActivity();
    } catch (reason) {
      toast.show(errorText(reason, "That did not work. Nothing was changed."), { tone: "error" });
      await refreshActivity();
    } finally {
      setBusy(null);
    }
  }

  const unhide = () => act("unhide", () => api(`${path}/unhide`, { method: "POST" }), `${park.name} is visible again`);
  const hide = () => act("hide", () => api(`${path}/hide`, { method: "POST", body: JSON.stringify({ reason }) }), `${park.name} is hidden`, { label: "Undo", run: () => void unhide() });

  async function remove() {
    if (!park || !activity) return;
    const { visits, tenures } = activity;
    const confirmed = await confirm({
      title: `Delete ${park.name}?`,
      tone: "danger",
      confirmLabel: "Delete",
      body: (
        <>
          <p>This takes the park out of Parkdex in one content change. It cannot be undone from here.</p>
          <ul>
            <li>Its outline and drive data are deleted. The change feed gets park, boundary and drive tombstones, so phones drop the park on their next sync.</li>
            {founder ? <li>The founder <strong>@{founder.handle ?? "deleted account"}</strong>, the cover photo and their 10 founder points are deleted.</li> : <li>It has no founder or cover photo.</li>}
            <li>{formatCount(visits.total)} {visits.total === 1 ? "visit" : "visits"} and {formatCount(tenures)} flag {tenures === 1 ? "tenure stays" : "tenures stay"} in the game history with no park to open.</li>
            {flag?.up && <li>The flag held by @{flag.handle ?? "deleted"} keeps earning points until it falls on {day(flag.fallsAt)}.</li>}
            <li>Parks already in a player's Dex keep showing from their saved copy.</li>
          </ul>
          <p className="dialog__recommend"><Icon name="shield" size={15} /> {hidden ? "It is already hidden, which keeps everything and can be undone." : "Hiding keeps everything and can be undone. Prefer Hide unless the park should never have existed."}</p>
        </>
      ),
    });
    if (!confirmed) return;
    setBusy("delete");
    try {
      await api(path, { method: "DELETE" });
      toast.show(`${park.name} was deleted`);
      navigate("/parks");
    } catch (reason) {
      toast.show(errorText(reason, "Could not delete this park. Nothing was changed."), { tone: "error" });
      setBusy(null);
    }
  }

  async function removeFromMap() {
    if (!park || !activity) return;
    setBusy("removal");
    // Read again, so the popup counts what is there now.
    const plan = await loadRemoval();
    setBusy(null);
    if (!plan) { toast.show("Could not check this park. Nothing was changed.", { tone: "error" }); return; }
    if (plan.blocked || !plan.outline) { toast.show(plan.blocked?.message ?? "This park can't be removed from the map.", { tone: "error" }); return; }
    const { outline, founder: planFounder, pendingReviews } = plan;
    const confirmed = await confirm({
      title: `Remove ${park.name} from the map?`,
      tone: "danger",
      icon: "park",
      confirmLabel: "Remove from map",
      body: (
        <>
          <p>This unfounds the park and takes it off the map in one change, so it can be founded again straight away.</p>
          <ul className="removal-list">
            <li><strong>Removed from the map.</strong> The park, its outline and drive data get tombstones in one content revision, and phones drop it on their next sync.</li>
            {planFounder
              ? <li><strong>Founder @{planFounder.handle ?? "deleted account"} and the cover photo are cleared</strong>, with their 10 founder points.</li>
              : <li>It has no founder or cover photo to clear.</li>}
            {pendingReviews > 0
              ? <li><strong>{formatCount(pendingReviews)} pending founding {pendingReviews === 1 ? "review is" : "reviews are"} closed.</strong> The player reads that the park was removed from the map before anyone reviewed it.</li>
              : <li>No founding reviews are waiting for it.</li>}
            <li><strong>The OpenStreetMap outline {outline.name ?? ""} ({outline.type} {outline.id}) is kept.</strong> The app offers it as not in Parkdex, and founding it publishes <code>{outline.parkId}</code>.</li>
            <li>{formatCount(activity.visits.total)} {activity.visits.total === 1 ? "visit" : "visits"} and {formatCount(activity.tenures)} flag {activity.tenures === 1 ? "tenure stay" : "tenures stay"} as game history, as with Delete.</li>
          </ul>
          {!plan.audited && <p className="muted">This database has no park_removed analytics event yet (founders_003), so only the content change records it.</p>}
        </>
      ),
    });
    if (!confirmed) return;
    setBusy("removal");
    try {
      const result = await api<RemovalResult>(`${path}/remove-from-map`, { method: "POST" });
      const closed = result.reviewsClosed ? ` ${result.reviewsClosed} pending ${result.reviewsClosed === 1 ? "review" : "reviews"} closed.` : "";
      toast.show(`${park.name} was removed from the map and can be founded again.${closed}`);
      navigate("/parks");
    } catch (reason) {
      toast.show(errorText(reason, "Could not remove this park from the map. Nothing was changed."), { tone: "error" });
      setBusy(null);
      await refreshActivity();
    }
  }

  async function clearFounder() {
    if (!park || !founder) return;
    const confirmed = await confirm({
      title: "Remove the founder and cover?",
      tone: "danger",
      confirmLabel: "Remove founder and cover",
      body: <p>Removes <strong>@{founder.handle ?? "deleted account"}</strong> as the founder of {park.name}, deletes the cover photo and takes away their 10 founder points. The park stays, and the next player who stands in it with an approved photo can found it.</p>,
    });
    if (confirmed) await act("founder", () => api(`${path}/founder`, { method: "DELETE" }), "The founder and cover were removed");
  }

  async function replaceCover(file: File | undefined) {
    if (!park || !file) return;
    if (file.type && file.type !== "image/jpeg") { toast.show("The cover must be a JPEG photo.", { tone: "error" }); return; }
    const confirmed = await confirm({
      title: "Replace the cover photo?",
      confirmLabel: "Replace cover",
      icon: "image",
      body: <p>{file.name} ({bytes(file.size)}) becomes the public cover of {park.name}. Location and camera details are removed before it is stored. The founder stays.</p>,
    });
    if (!confirmed) return;
    await act("cover", async () => api(`${path}/cover`, { method: "PUT", body: JSON.stringify({ photo: { base64: await readBase64(file) } }) }), "The cover was replaced");
  }

  const shownPin: Position = pin ?? [park.lng, park.lat];
  const status = hidden ? (hidden.source === "operator" ? "Hidden by the operator" : "Hidden by a category rule") : "Live";

  return (
    <section className="page pp" aria-labelledby="park-title">
      <BackLink />
      <PageHeader
        id="park-title"
        eyebrow={`${SOURCE_LABELS[activity.source]} · ${park.id}`}
        title={<>{form.name || "Untitled park"} <span className={`pp-status${hidden ? " pp-status--hidden" : ""}`}>{status}</span></>}
        lede={dirty ? `Unsaved: ${describe()}.` : hidden ? `Players do not see this park. ${hidden.reason}` : "This park is in players' apps. Edits stay here until you save."}
        actions={<>
          <button type="button" className="button button--ghost" onClick={() => { setForm(formOf(park)); setPin(null); setGeometry(null); }} disabled={!dirty || saving}>Discard changes</button>
          <button type="button" className="button button--primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <><Spinner small /> Saving</> : <><Icon name="check" size={16} /> Save to Parkdex</>}
          </button>
        </>}
      />

      <div className="editor pp-grid">
        <div className="editor__side">
          <MapEditor
            boundary={geometry ?? park.geometry}
            pin={shownPin}
            editable
            onBoundary={(next) => { setGeometry(next); return true; }}
            onPin={setPin}
            fitKey={`${park.id}-${reload}`}
          />
          <p className="muted map-legend">
            <span className="legend-pin" /> Pin {shownPin[1].toFixed(5)}, {shownPin[0].toFixed(5)}{pinChanged && " (moved, not saved)"}
            <span className="legend-boundary" /> Boundary{geometry && " (redrawn, not saved)"}
          </p>
          {!park.geometry && <Notice>This park has no boundary in the database.</Notice>}

          <Card title="Visits and flag" className="pp-card">
            <div className="pp-mini">
              <div><span>Total visits</span><strong>{formatCount(activity.visits.total)}</strong></div>
              <div><span>Last 30 days</span><strong>{formatCount(activity.visits.last30Days)}</strong></div>
              <div><span>Players</span><strong>{formatCount(activity.visits.uniquePlayers)}</strong></div>
              <div><span>Flag tenures</span><strong>{formatCount(activity.tenures)}</strong></div>
            </div>
            <div className={`pp-flag${flag?.up ? " is-up" : ""}`}>
              <Icon name="flag" size={18} />
              {flag ? (flag.up ? (
                <p><strong>@{flag.handle ?? "deleted account"}</strong> holds the flag since {day(flag.since)}. Last visit {timeAgo(flag.lastVisitAt)}; it falls on {day(flag.fallsAt)} without another visit.</p>
              ) : (
                <p>The flag of <strong>@{flag.handle ?? "deleted account"}</strong> fell on {day(flag.fallsAt)}. The next visit plants a new one.</p>
              )) : <p>No flag is planted here.</p>}
            </div>
          </Card>
        </div>

        <div className="editor__main">
          <Card title="Visibility" subtitle={hidden ? `Hidden ${timeAgo(hidden.hiddenAt)} · ${hidden.source === "operator" ? "by the operator" : "by a category rule"}` : "Live in players' apps"} className="pp-card">
            {hidden ? (
              <div className="pp-actions">
                <p className="pp-reason">{hidden.reason}</p>
                <button type="button" className="button" onClick={() => void unhide()} disabled={busy !== null}>
                  {busy === "unhide" ? <Spinner small /> : <Icon name="undo" size={16} />} Unhide
                </button>
              </div>
            ) : (
              <div className="pp-actions">
                <label className="field pp-reason-field">
                  <span className="sr-only">Reason for hiding (optional)</span>
                  <input value={reason} maxLength={500} placeholder="Reason (optional), for example: closed for repairs" onChange={(event) => setReason(event.target.value)} />
                </label>
                <button type="button" className="button" onClick={() => void hide()} disabled={busy !== null}>
                  {busy === "hide" ? <Spinner small /> : <Icon name="shield" size={16} />} Hide
                </button>
              </div>
            )}
            <p className="muted pp-help">{hidden ? "Unhiding sends the park back to phones with its current values." : "Hiding keeps the park, its visits and flags, and takes it off every player's map on their next sync. Undo at any time."}</p>
            <div className="pp-danger">
              <div>
                <strong>Remove from map</strong>
                <p className="muted">{removal?.blocked
                  ? removal.blocked.message
                  : "Unfounds the park and takes it off the map, but keeps its OpenStreetMap outline so it can be founded again."}</p>
              </div>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void removeFromMap()}
                disabled={busy !== null || !removal || removal.blocked !== null}
                title={removal?.blocked?.message}
              >
                {busy === "removal" ? <Spinner small /> : <Icon name="park" size={16} />} Remove from map...
              </button>
            </div>
            <div className="pp-danger pp-danger--next">
              <div>
                <strong>Delete park</strong>
                <p className="muted">Removes the park and its founder for good. Visits stay as history.</p>
              </div>
              <button type="button" className="button button--danger" onClick={() => void remove()} disabled={busy !== null}>
                {busy === "delete" ? <Spinner small /> : <Icon name="trash" size={16} />} Delete...
              </button>
            </div>
          </Card>

          <fieldset className="panel form-panel" disabled={saving}>
            <h3>Identity</h3>
            <div className="field-row">
              <label className="field"><span>Name</span><input value={form.name} maxLength={140} onChange={(event) => set("name", event.target.value)} /></label>
              <label className="field"><span>Short name</span><input value={form.short} maxLength={140} onChange={(event) => set("short", event.target.value)} /></label>
            </div>
            <div className="field-row">
              <label className="field"><span>Category</span>
                <select value={form.category} onChange={(event) => set("category", event.target.value)}>
                  {CATEGORIES.map((value) => <option key={value} value={value}>{title(value)}</option>)}
                </select>
              </label>
              <label className="field"><span>Region</span><RegionSelect value={form.region} onChange={(value) => set("region", value)} /></label>
            </div>
            <div className="field">
              <span>Rarity</span>
              <div className="rarity-picker" role="radiogroup" aria-label="Rarity">
                {RARITIES.map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={form.rarity === value} className={`rarity rarity--${value}${form.rarity === value ? " is-on" : ""}`} onClick={() => set("rarity", value)}>{value}</button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <label className="field"><span>Biome</span>
                <select value={form.biome} onChange={(event) => set("biome", event.target.value)}>{BIOMES.map((value) => <option key={value} value={value}>{title(value)}</option>)}</select>
              </label>
              <div className="field"><span>Badge shape</span>
                <p className="derived">{title(form.category === park.category ? park.shape : SHAPE_FOR_CATEGORY[form.category] ?? park.shape)}</p>
              </div>
            </div>
            <label className="field">
              <span>Description</span>
              <textarea rows={4} maxLength={800} value={form.blurb} placeholder="No description yet." onChange={(event) => set("blurb", event.target.value)} />
              <small className="muted counter">{form.blurb.length} / 800</small>
            </label>
            <dl className="pp-facts">
              <div><dt>Seed</dt><dd>{park.seed}</dd></div>
              <div><dt>Scene</dt><dd>{park.scene ?? "None"}</dd></div>
              <div><dt>Pin</dt><dd>{park.lat.toFixed(6)}, {park.lng.toFixed(6)}</dd></div>
            </dl>
          </fieldset>

          <Card
            title="Founder and cover"
            subtitle={founder ? `${founder.source === "osm_new" ? "Founded as a new OpenStreetMap park" : "Founded as a catalogue park"} ${timeAgo(founder.foundedAt)}` : "Nobody has founded this park yet"}
            className="pp-card"
          >
            {founder ? (
              <div className="pp-founder">
                <a className="pp-cover" href={`${path}/cover?v=${founder.photoSha256.slice(0, 12)}`} target="_blank" rel="noreferrer" title="Open the full cover">
                  <img src={`${path}/cover?v=${founder.photoSha256.slice(0, 12)}`} alt={`Cover photo of ${park.name}`} width={founder.photoWidth} height={founder.photoHeight} />
                </a>
                <div className="pp-founder__info">
                  <p><Icon name="user" size={15} /> <strong>@{founder.handle ?? "deleted account"}</strong></p>
                  <p className="muted">{fullDate(founder.foundedAt)}</p>
                  <p className="muted">{founder.photoWidth} × {founder.photoHeight} · {bytes(founder.photoBytes)}</p>
                  <div className="pp-founder__actions">
                    <input ref={coverInput} type="file" accept="image/jpeg" hidden onChange={(event) => { void replaceCover(event.target.files?.[0]); event.target.value = ""; }} />
                    <button type="button" className="button button--small" onClick={() => coverInput.current?.click()} disabled={busy !== null}>
                      {busy === "cover" ? <Spinner small /> : <Icon name="upload" size={15} />} Replace cover
                    </button>
                    <button type="button" className="button button--small button--danger" onClick={() => void clearFounder()} disabled={busy !== null}>
                      {busy === "founder" ? <Spinner small /> : <Icon name="trash" size={15} />} Remove founder and cover
                    </button>
                  </div>
                </div>
              </div>
            ) : <p className="muted pp-empty">The first player to stand here with an approved photo becomes the founder, and their photo becomes the cover.</p>}
          </Card>

          <Card title="Content history" subtitle={`The last ${activity.history.length} synchronized changes for this park`} className="pp-card" padded={false}>
            <History history={activity.history} />
          </Card>

          <p className="muted reload-row">Someone else editing this park? <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Reload it</button> (drops unsaved changes).</p>
        </div>
      </div>
    </section>
  );
}
