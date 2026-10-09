import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { linkHandler } from "../router";
import { Icon, Notice, PageHeader, Spinner, useConfirm, useToast } from "../ui";
import { MapEditor } from "./MapEditor";
import { RegionSelect } from "./RegionSelect";
import type { LivePark, LiveParkDetail, MultiPolygon, Position } from "./types";

const CATEGORIES = ["national", "provincial", "regional", "municipal", "community"];
const BIOMES = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"];
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
/** Mirrors the server: the badge shape follows the category. */
const SHAPE_FOR_CATEGORY: Record<string, string> = { community: "circle", municipal: "circle", regional: "hex", provincial: "shield", national: "seal" };

type Form = Pick<LivePark, "name" | "short" | "category" | "region" | "biome" | "rarity" | "blurb">;
const FORM_KEYS = ["name", "short", "category", "region", "biome", "rarity", "blurb"] as const;
const PARK_KEYS = ["id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb"] as const;

function formOf(park: LivePark): Form {
  return Object.fromEntries(FORM_KEYS.map((key) => [key, park[key]])) as Form;
}

/** The park as it was opened, which the server checks before saving. */
function expectedOf(park: LiveParkDetail): LivePark {
  return Object.fromEntries(PARK_KEYS.map((key) => [key, park[key]])) as LivePark;
}

function title(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function BackLink() {
  return <a className="back-link" href="/parks" onClick={linkHandler("/parks")}><Icon name="chevron" size={14} className="flip" /> All parks</a>;
}

export function LiveParkEditor({ id }: { id: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [park, setPark] = useState<LiveParkDetail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pin, setPin] = useState<Position | null>(null);
  const [geometry, setGeometry] = useState<MultiPolygon | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ park: LiveParkDetail }>(`/api/parks/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(({ park: loaded }) => { setPark(loaded); setForm(formOf(loaded)); setPin(null); setGeometry(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load this park.")); });
    return () => controller.abort();
  }, [id, revision]);

  if (error) return <section className="page"><BackLink /><Notice tone="error">{error}</Notice></section>;
  if (!park || !form) return <section className="page"><BackLink /><div className="drawer__state"><Spinner /> Opening park...</div></section>;

  const changed = FORM_KEYS.filter((key) => form[key] !== park[key]);
  const pinChanged = Boolean(pin && (pin[0] !== park.lng || pin[1] !== park.lat));
  const dirty = changed.length > 0 || pinChanged || Boolean(geometry);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });

  function describe(): string {
    const parts: string[] = changed.map((key) => key === "blurb" ? "description" : key === "short" ? "short name" : key);
    if (pinChanged) parts.push("pin");
    if (geometry) parts.push("boundary");
    return parts.join(", ");
  }

  async function save() {
    if (!park || !form || !dirty) return;
    const confirmed = await confirm({
      title: `Save changes to ${park.name}?`,
      body: <p>Changing the {describe()}. Every player's app picks this up on its next content sync.</p>,
      confirmLabel: "Save to Parkdex",
      icon: "check",
    });
    if (!confirmed) return;
    const changes: Record<string, unknown> = Object.fromEntries(changed.map((key) => [key, form[key]]));
    if (pinChanged && pin) Object.assign(changes, { lng: pin[0], lat: pin[1] });
    if (geometry) changes.geometry = geometry;
    setSaving(true);
    try {
      const { park: saved } = await api<{ park: LiveParkDetail }>(`/api/parks/${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify({ expected: expectedOf(park), changes }),
      });
      setPark(saved);
      setForm(formOf(saved));
      setPin(null);
      setGeometry(null);
      toast.show(`${saved.name} saved to Parkdex`);
    } catch (reason) {
      toast.show(errorText(reason, "Could not save. Nothing was changed."), { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    if (!park) return;
    setForm(formOf(park));
    setPin(null);
    setGeometry(null);
  }

  const shownPin: Position = pin ?? [park.lng, park.lat];

  return (
    <section className="page" aria-labelledby="park-title">
      <BackLink />
      <PageHeader
        id="park-title"
        eyebrow={`Live park · ${park.id}`}
        title={form.name || "Untitled park"}
        lede={dirty ? `Unsaved: ${describe()}.` : "This park is in players' apps. Edits stay here until you save."}
        actions={<>
          <button type="button" className="button button--ghost" onClick={revert} disabled={!dirty || saving}>Discard changes</button>
          <button type="button" className="button button--primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <><Spinner small /> Saving</> : <><Icon name="check" size={16} /> Save to Parkdex</>}
          </button>
        </>}
      />

      <div className="editor">
        <div className="editor__side">
          <MapEditor
            boundary={geometry ?? park.geometry}
            pin={shownPin}
            editable
            onBoundary={(next) => { setGeometry(next); return true; }}
            onPin={setPin}
            fitKey={`${park.id}-${revision}`}
          />
          <p className="muted map-legend">
            <span className="legend-pin" /> Park pin{pinChanged && " (moved, not saved)"} <span className="legend-boundary" /> Boundary{geometry && " (redrawn, not saved)"}
          </p>
          {!park.geometry && <Notice>This park has no boundary in the database.</Notice>}
        </div>

        <div className="editor__main">
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
          </fieldset>

          <fieldset className="panel form-panel" disabled={saving}>
            <h3>Description</h3>
            <label className="field">
              <span className="sr-only">Description</span>
              <textarea rows={5} maxLength={800} value={form.blurb} placeholder="No description yet." onChange={(event) => set("blurb", event.target.value)} />
              <small className="muted counter">{form.blurb.length} / 800</small>
            </label>
          </fieldset>

          <p className="muted reload-row">Someone else editing this park? <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Reload it</button> (drops unsaved changes).</p>
        </div>
      </div>
    </section>
  );
}
