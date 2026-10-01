import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, errorText, uploadImage, type LivePark, type LiveParkDetail, type MultiPolygon, type Position } from "../api";
import { MapEditor } from "../components/MapEditor";
import { RegionSelect } from "../components/RegionSelect";
import { linkHandler } from "../router";
import { Icon, Spinner, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";

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

export function LiveParkEditor({ id }: { id: string }) {
  const toast = useToast();
  const [park, setPark] = useState<LiveParkDetail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [pin, setPin] = useState<Position | null>(null);
  const [geometry, setGeometry] = useState<MultiPolygon | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<{ park: LiveParkDetail }>(`/api/parks/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(({ park: loaded }) => { setPark(loaded); setForm(formOf(loaded)); setPin(null); setGeometry(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load this park.")); });
    return () => controller.abort();
  }, [id, revision]);

  if (error) return <section className="page"><ParksTabs current="/proposals/live" /><div className="notice notice--error" role="alert"><Icon name="alert" /> {error}</div></section>;
  if (!park || !form) return <section className="page"><ParksTabs current="/proposals/live" /><div className="drawer__state"><Spinner /> Opening park...</div></section>;

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
    if (!window.confirm(`Save ${describe()} for ${park.name}? Every player's app picks this up on its next content sync.`)) return;
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

  async function uploadBadge(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !park) return;
    if (file.size > 4 * 1024 * 1024) return toast.show("That image is larger than 4 MB.", { tone: "error" });
    if (!window.confirm(`Replace the badge for ${park.name}? Players will see the new badge after their next content sync.`)) return;
    setUploading(true);
    try {
      const { park: saved } = await uploadImage<{ park: LiveParkDetail }>(`/api/parks/${encodeURIComponent(id)}/badge`, file, {
        "x-parkdex-expected": encodeURIComponent(JSON.stringify(expectedOf(park))),
      });
      // Only the badge changed on the server, so unsaved edits stay staged.
      setPark(saved);
      toast.show("Badge replaced");
    } catch (reason) {
      toast.show(errorText(reason, "The badge upload failed. Nothing was changed."), { tone: "error" });
    } finally {
      setUploading(false);
    }
  }

  const shownPin: Position = pin ?? [park.lng, park.lat];

  return (
    <section className="page" aria-labelledby="park-title">
      <ParksTabs current="/proposals/live" />
      <a className="back-link" href="/proposals/live" onClick={linkHandler("/proposals/live")}><Icon name="chevron" size={14} className="flip" /> All live parks</a>
      <header className="page-head">
        <div>
          <p className="eyebrow">Live park · {park.id}</p>
          <h1 id="park-title">{form.name || "Untitled park"}</h1>
          <p className="page-lede">{dirty ? `Unsaved: ${describe()}.` : "This park is in players' apps. Edits stay here until you save."}</p>
        </div>
        <div className="toolbar">
          <button type="button" className="button button--ghost" onClick={revert} disabled={!dirty || saving}>Discard changes</button>
          <button type="button" className="button button--primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <><Spinner small /> Saving</> : <><Icon name="check" size={16} /> Save to Parkdex</>}
          </button>
        </div>
      </header>

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
          {!park.geometry && <div className="notice"><Icon name="alert" size={18} /> This park has no boundary in the database.</div>}
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

          <section className="panel image-slot image-slot--wide">
            <h3>Badge</h3>
            <button type="button" className={`dropzone${park.badgeUrl ? " has-image" : ""}`} onClick={() => input.current?.click()} disabled={uploading || !park.badgeUploads}>
              {uploading ? <Spinner /> : park.badgeUrl ? <img src={park.badgeUrl} alt={`${park.name} badge`} /> : <><Icon name="image" size={26} /><span>Choose a badge</span></>}
            </button>
            <input ref={input} type="file" accept="image/webp" hidden onChange={(event) => void uploadBadge(event)} />
            <p className="muted image-slot__hint">
              {park.badgeUploads ? `${park.scene ? `Scene ${park.scene}. ` : "No badge yet. "}Choose a square WebP up to 4 MB to replace it. It goes live straight away.` : "Badge uploads are not set up on this deployment."}
            </p>
          </section>

          <p className="muted reload-row">Someone else editing this park? <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Reload it</button> (drops unsaved changes).</p>
        </div>
      </div>
    </section>
  );
}
