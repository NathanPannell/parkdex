import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, errorText, uploadImage, type Draft, type MultiPolygon, type Position } from "../api";
import { MapEditor } from "../components/MapEditor";
import { RegionSelect } from "../components/RegionSelect";
import { linkHandler, navigate } from "../router";
import { Icon, Kip, Spinner, timeAgo, useToast } from "../ui";
import { ParksTabs } from "./ParksTabs";
import { ReferenceFinder } from "./ReferenceFinder";

const CATEGORIES = ["national", "provincial", "regional", "municipal", "community"];
const BIOMES = ["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"];
/** Mirrors the server: the badge shape follows the category. */
const SHAPE_FOR_CATEGORY: Record<string, string> = { community: "Circle", municipal: "Circle", regional: "Hex", provincial: "Shield", national: "Seal" };
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

type Editable = Pick<Draft, "name" | "short" | "category" | "region" | "biome" | "rarity" | "blurb">;

function editable(draft: Draft): Editable {
  const { name, short, category, region, biome, rarity, blurb } = draft;
  return { name, short, category, region, biome, rarity, blurb };
}

// "2h ago" reads well mid-sentence; "Just now" needs a lower-case start.
function when(value: string): string {
  const text = timeAgo(value);
  return text === "Just now" ? "just now" : text;
}

function title(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

export function DraftEditor({ id }: { id: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [form, setForm] = useState<Editable | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState<"badge" | "reference" | null>(null);
  const [imageRevision, setImageRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(({ draft: loaded }) => { setDraft(loaded); setForm(editable(loaded)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load this draft.")); });
    return () => controller.abort();
  }, [id]);

  const dirty = Boolean(draft && form && JSON.stringify(editable(draft)) !== JSON.stringify(form));
  const live = draft?.status === "published";

  async function savePlacement(changes: { geometry?: MultiPolygon | null; lat?: number; lng?: number }, message: string) {
    try {
      const { draft: saved } = await api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) });
      setDraft(saved);
      toast.show(message);
      return true;
    } catch (reason) {
      toast.show(errorText(reason, "Could not save the map change."), { tone: "error" });
      return false;
    }
  }

  async function save(): Promise<Draft | null> {
    if (!draft || !form) return null;
    const changes = Object.fromEntries(Object.entries(form).filter(([key, value]) => draft[key as keyof Editable] !== value));
    if (!Object.keys(changes).length) return draft;
    setSaving(true);
    try {
      const { draft: saved } = await api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) });
      setDraft(saved);
      setForm(editable(saved));
      toast.show("Draft saved");
      return saved;
    } catch (reason) {
      toast.show(errorText(reason, "Could not save the draft."), { tone: "error" });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: "badge" | "reference", event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast.show("That image is larger than 4 MB.", { tone: "error" });
    setUploading(kind);
    try {
      const { draft: saved } = await uploadImage<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}/${kind}`, file);
      setDraft(saved);
      setImageRevision((value) => value + 1);
      toast.show(kind === "badge" ? "Badge uploaded" : "Reference photo attached");
    } catch (reason) {
      toast.show(errorText(reason, "The upload failed."), { tone: "error" });
    } finally {
      setUploading(null);
    }
  }

  async function removeImage(kind: "badge" | "reference") {
    try {
      const { draft: saved } = await api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}/${kind}`, { method: "DELETE" });
      setDraft(saved);
      setImageRevision((value) => value + 1);
    } catch (reason) {
      toast.show(errorText(reason, "Could not remove the image."), { tone: "error" });
    }
  }

  async function copyBrief() {
    try {
      const brief = await api<unknown>(`/api/drafts/${encodeURIComponent(id)}/brief`);
      await navigator.clipboard.writeText(JSON.stringify(brief, null, 2));
      toast.show("AI brief copied to the clipboard");
    } catch (reason) {
      toast.show(errorText(reason, "Could not copy the brief."), { tone: "error" });
    }
  }

  async function publish() {
    const current = dirty ? await save() : draft;
    if (!current) return;
    if (current.blockers.length) return toast.show(current.blockers.join(" "), { tone: "error" });
    const extra = [!current.scene && "no badge", !current.blurb.trim() && "no description"].filter(Boolean).join(" and ");
    if (!window.confirm(`Publish ${current.name} to Parkdex? It will reach every player's app${extra ? ` with ${extra}` : ""}. Published parks cannot be unpublished from here.`)) return;
    setPublishing(true);
    try {
      const { draft: saved } = await api<{ draft: Draft }>(`/api/drafts/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify({ expectedUpdatedAt: current.updatedAt }) });
      setDraft(saved);
      if (saved) setForm(editable(saved));
      toast.show(`${current.name} is now in Parkdex`);
    } catch (reason) {
      toast.show(errorText(reason, "Publishing failed. Nothing was changed."), { tone: "error" });
    } finally {
      setPublishing(false);
    }
  }

  async function discard() {
    if (!window.confirm("Delete this draft? You can import the park again later.")) return;
    try {
      await api(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.show("Draft deleted");
      navigate("/proposals/drafts");
    } catch (reason) {
      toast.show(errorText(reason, "Could not delete the draft."), { tone: "error" });
    }
  }

  if (error) return <section className="page"><ParksTabs current="/proposals/drafts" /><div className="notice notice--error" role="alert"><Icon name="alert" /> {error}</div></section>;
  if (!draft || !form) return <section className="page"><ParksTabs current="/proposals/drafts" /><div className="drawer__state"><Spinner /> Opening draft...</div></section>;

  const record = draft.source.record ?? {};
  const proposal = draft.source.proposal as { name: string; note: string; outline: Position[] | null; createdAt: string } | undefined;
  const fromLegacy = Boolean(draft.source.record);
  const set = <K extends keyof Editable>(key: K, value: Editable[K]) => setForm({ ...form, [key]: value });

  return (
    <section className="page" aria-labelledby="draft-title">
      <ParksTabs current="/proposals/drafts" />
      <a className="back-link" href="/proposals/drafts" onClick={linkHandler("/proposals/drafts")}><Icon name="chevron" size={14} className="flip" /> All drafts</a>
      <header className="page-head">
        <div>
          <p className="eyebrow">{live ? "Published" : "Draft"} · {draft.id}</p>
          <h1 id="draft-title">{form.name || "Untitled park"}</h1>
          <p className="page-lede">{live ? `Published to Parkdex ${when(draft.publishedAt!)}. Edit it from now on with the content tools.` : `${fromLegacy ? "Imported from the legacy map" : "Started from a player's proposal"} ${when(draft.createdAt)}. Phones will not see it until you publish.`}</p>
        </div>
        <div className="toolbar">
          <button type="button" className="button button--ghost" onClick={() => void copyBrief()}><Icon name="bulb" size={16} /> Copy AI brief</button>
          {!live && <button type="button" className="button button--ghost" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <><Spinner small /> Saving</> : "Save"}</button>}
          {!live && <button type="button" className="button button--primary" onClick={() => void publish()} disabled={publishing || saving}>{publishing ? <><Spinner small /> Publishing</> : <><Icon name="check" size={16} /> Publish</>}</button>}
        </div>
      </header>

      <div className="editor">
        <div className="editor__side">
          <MapEditor
            boundary={draft.geometry}
            pin={[draft.lng, draft.lat]}
            sketch={proposal?.outline ?? null}
            editable={!live}
            onBoundary={(geometry) => savePlacement({ geometry }, "Boundary saved")}
            onPin={([lng, lat]) => void savePlacement({ lat, lng }, "Pin moved")}
          />
          <p className="muted map-legend"><span className="legend-pin" /> Park pin <span className="legend-boundary" /> Boundary {proposal?.outline && <><span className="legend-sketch" /> Player's sketch</>}</p>
          {!live && draft.blockers.length > 0 && (
            <div className="notice"><Icon name="alert" size={18} /> Before publishing: {draft.blockers.join(" ")}</div>
          )}
          {!live && !draft.badgeUploads && draft.scene && (
            <div className="notice notice--error"><Icon name="alert" size={18} /> Badge publishing is not set up on this deployment. Remove the badge to publish without one.</div>
          )}
          {proposal && (
            <figure className="quote quote--small">
              <figcaption>Proposed by a player · {proposal.name}</figcaption>
              <blockquote dir="auto">{proposal.note || "No note added."}</blockquote>
            </figure>
          )}
          {fromLegacy && <section className="panel">
            <h3>Legacy record</h3>
            <dl className="facts facts--wide">
              {["name", "category", "region", "description", "sourceName", "sourceId"].filter((key) => record[key]).map((key) => (
                <div key={key}><dt>{key}</dt><dd>{String(record[key])}</dd></div>
              ))}
              {typeof record.sourceUrl === "string" && <div><dt>sourceUrl</dt><dd><a href={record.sourceUrl} target="_blank" rel="noreferrer">{record.sourceUrl}</a></dd></div>}
            </dl>
          </section>}
        </div>

        <div className="editor__main">
          <fieldset className="panel form-panel" disabled={live}>
            <h3>Identity</h3>
            <div className="field-row">
              <label className="field"><span>Name</span><input value={form.name} maxLength={140} onChange={(event) => set("name", event.target.value)} /></label>
              <label className="field"><span>Short name</span><input value={form.short} maxLength={140} onChange={(event) => set("short", event.target.value)} /></label>
            </div>
            <div className="field-row">
              <label className="field"><span>Category</span>
                <select value={form.category ?? ""} onChange={(event) => set("category", event.target.value || null)}>
                  <option value="">Choose a category</option>
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
                <p className="derived">{form.category ? SHAPE_FOR_CATEGORY[form.category] : "Set by category"}</p>
              </div>
            </div>
          </fieldset>

          <fieldset className="panel form-panel" disabled={live}>
            <h3>Description</h3>
            <label className="field">
              <span className="sr-only">Description</span>
              <textarea rows={5} maxLength={800} value={form.blurb} placeholder="Optional. Write one, or generate it from the AI brief." onChange={(event) => set("blurb", event.target.value)} />
              <small className="muted counter">{form.blurb.length} / 800</small>
            </label>
          </fieldset>

          <div className="image-row">
            <ImageSlot
              title="Reference photo"
              hint="JPEG, PNG or WebP. Used for the AI brief only; it never ships to the app."
              src={draft.referencePhotoType ? `/api/drafts/${encodeURIComponent(id)}/reference?v=${imageRevision}` : null}
              accept="image/jpeg,image/png,image/webp"
              busy={uploading === "reference"}
              onPick={(event) => void upload("reference", event)}
              onRemove={() => void removeImage("reference")}
            />
            <ImageSlot
              title="Badge"
              hint={draft.scene ? `Scene ${draft.scene}` : "Square WebP up to 4 MB. Optional; the park can launch without one."}
              src={draft.scene ? `/api/drafts/${encodeURIComponent(id)}/badge?v=${imageRevision}` : null}
              accept="image/webp"
              busy={uploading === "badge"}
              disabled={live}
              onPick={(event) => void upload("badge", event)}
              onRemove={() => void removeImage("badge")}
            />
          </div>

          {!live && (
            <div className="danger-row">
              <button type="button" className="button button--danger button--small" onClick={() => void discard()}><Icon name="trash" size={15} /> Delete draft</button>
            </div>
          )}
        </div>
      </div>
      {!live && <ReferenceFinder draft={draft} onChange={(saved) => { setDraft(saved); setImageRevision((value) => value + 1); }} />}
      {live && <div className="empty"><Kip pose="celebrate" size={90} /><p className="muted">Published. Players can find {draft.name} on the map.</p></div>}
    </section>
  );
}

function ImageSlot({ title: heading, hint, src, accept, busy, disabled, onPick, onRemove }: {
  title: string; hint: string; src: string | null; accept: string; busy: boolean; disabled?: boolean;
  onPick(event: ChangeEvent<HTMLInputElement>): void; onRemove(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="panel image-slot">
      <h3>{heading}</h3>
      <button type="button" className={`dropzone${src ? " has-image" : ""}`} onClick={() => input.current?.click()} disabled={busy || disabled}>
        {busy ? <Spinner /> : src ? <img src={src} alt={heading} /> : <><Icon name="image" size={26} /><span>Choose an image</span></>}
      </button>
      <input ref={input} type="file" accept={accept} hidden onChange={onPick} />
      <p className="muted image-slot__hint">{hint}</p>
      {src && !disabled && <button type="button" className="text-button" onClick={onRemove}>Remove</button>}
    </section>
  );
}
