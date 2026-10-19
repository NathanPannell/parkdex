import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { linkHandler, navigate } from "../router";
import { useDashboard } from "../shell/DashboardContext";
import { Icon, Notice, PageHeader, Spinner, useConfirm, useToast } from "../ui";
import { MapEditor } from "./MapEditor";
import { RegionSelect } from "./RegionSelect";
import { BIOMES, CATEGORIES, RARITIES, SHAPE_FOR_CATEGORY, title, type OsmDraft, type OsmOutline } from "./types";

/**
 * /parks/osm/<type>-<id>: create a park from an OpenStreetMap outline that is not in Parkdex.
 * The form starts from the outline's name, a category guess and the region of the nearest park;
 * publishing uses the same transaction as park founding.
 */

type Form = Pick<OsmDraft, "name" | "short" | "category" | "region" | "biome" | "rarity" | "blurb">;

function BackLink() {
  return (
    <a className="back-link" href="/parks" onClick={linkHandler("/parks")}>
      <Icon name="chevron" size={14} className="flip" /> All parks
    </a>
  );
}

export function CreateFromOsm({ refKey }: { refKey: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { environment } = useDashboard();
  const [outline, setOutline] = useState<OsmOutline | null>(null);
  const [draft, setDraft] = useState<OsmDraft | null>(null);
  const [match, setMatch] = useState<OsmOutline["inParkdex"]>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const path = `/api/parks/osm/${encodeURIComponent(refKey)}`;

  useEffect(() => {
    const controller = new AbortController();
    api<{ outline: OsmOutline; draft: OsmDraft; inParkdex: OsmOutline["inParkdex"] }>(path, { signal: controller.signal })
      .then((loaded) => {
        setOutline(loaded.outline);
        setDraft(loaded.draft);
        setMatch(loaded.inParkdex);
        const { name, short, category, region, biome, rarity, blurb } = loaded.draft;
        setForm({ name, short, category, region, biome, rarity, blurb });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorText(reason, "Could not load this outline."));
      });
    return () => controller.abort();
  }, [path]);

  if (error)
    return (
      <section className="page">
        <BackLink />
        <Notice tone="error">{error}</Notice>
      </section>
    );
  if (!outline || !draft || !form)
    return (
      <section className="page">
        <BackLink />
        <div className="drawer__state">
          <Spinner /> Loading the outline...
        </div>
      </section>
    );

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const missing = (["name", "short", "region", "blurb"] as const).filter((key) => !form[key].trim());
  const ready = !match && missing.length === 0;

  async function publish() {
    if (!form || !draft || !ready) return;
    const confirmed = await confirm({
      title: `Publish ${form.name} to Parkdex?`,
      confirmLabel: "Publish park",
      icon: "plus",
      body: (
        <>
          <p>
            Adds <strong>{draft.id}</strong> to the {environment || "selected"} catalogue in one content change, with this outline, the pin inside it and
            unverified drive data.
          </p>
          <ul>
            <li>Every player's app shows it on its next content sync.</li>
            <li>It has no founder; the first player to stand in it with an approved photo can found it.</li>
            <li>Category rules never hide it, like any osm-* park.</li>
          </ul>
        </>
      ),
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const { parkId } = await api<{ parkId: string }>(path, { method: "POST", body: JSON.stringify({ park: form }) });
      toast.show(`${form.name} is in Parkdex`);
      navigate(`/parks/${encodeURIComponent(parkId)}`, { replace: true });
    } catch (reason) {
      toast.show(errorText(reason, "Could not publish. Nothing was changed."), { tone: "error" });
      setSaving(false);
    }
  }

  return (
    <section className="page" aria-labelledby="create-title">
      <BackLink />
      <PageHeader
        id="create-title"
        eyebrow={`Create from OpenStreetMap · ${outline.type} ${outline.id}`}
        title={form.name || outline.name || "Unnamed outline"}
        lede={
          match
            ? `This outline is already in Parkdex as ${match.name}.`
            : "Check the fields, then publish. The outline and pin come from OpenStreetMap; you can redraw them after publishing."
        }
        actions={
          <>
            <a className="button button--ghost" href="/parks" onClick={linkHandler("/parks")}>
              Cancel
            </a>
            <button type="button" className="button button--primary" disabled={!ready || saving} onClick={() => void publish()}>
              {saving ? (
                <>
                  <Spinner small /> Publishing
                </>
              ) : (
                <>
                  <Icon name="plus" size={16} /> Publish to Parkdex
                </>
              )}
            </button>
          </>
        }
      />

      {match && (
        <Notice
          action={
            <a
              className="button button--small"
              href={`/parks/${encodeURIComponent(match.parkId)}`}
              onClick={linkHandler(`/parks/${encodeURIComponent(match.parkId)}`)}
            >
              Open {match.name}
            </a>
          }
        >
          Founding and the catalogue match treat this outline as {match.name}, so it is not published a second time.
        </Notice>
      )}

      <div className="editor">
        <div className="editor__side">
          <MapEditor
            boundary={draft.geometry}
            pin={[draft.lng, draft.lat]}
            editable={false}
            onBoundary={() => false}
            onPin={() => undefined}
            fitKey={draft.id}
          />
          <p className="muted map-legend">
            <span className="legend-pin" /> Pin inside the outline <span className="legend-boundary" /> OpenStreetMap outline ({outline.kind})
          </p>
        </div>
        <div className="editor__main">
          <fieldset className="panel form-panel" disabled={saving || Boolean(match)}>
            <h3>New park</h3>
            <div className="field-row">
              <label className="field">
                <span>Name</span>
                <input value={form.name} maxLength={140} onChange={(event) => set("name", event.target.value)} />
              </label>
              <label className="field">
                <span>Short name</span>
                <input value={form.short} maxLength={140} onChange={(event) => set("short", event.target.value)} />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Category (guessed from the tags)</span>
                <select value={form.category} onChange={(event) => set("category", event.target.value)}>
                  {CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {title(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Region (from the nearest park)</span>
                <RegionSelect value={form.region} onChange={(value) => set("region", value)} />
              </label>
            </div>
            <div className="field">
              <span>Rarity</span>
              <div className="rarity-picker" role="radiogroup" aria-label="Rarity">
                {RARITIES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={form.rarity === value}
                    className={`rarity rarity--${value}${form.rarity === value ? " is-on" : ""}`}
                    onClick={() => set("rarity", value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Biome</span>
                <select value={form.biome} onChange={(event) => set("biome", event.target.value)}>
                  {BIOMES.map((value) => (
                    <option key={value} value={value}>
                      {title(value)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>Badge shape</span>
                <p className="derived">{title(SHAPE_FOR_CATEGORY[form.category] ?? "circle")}</p>
              </div>
            </div>
            <label className="field">
              <span>Description</span>
              <textarea rows={4} maxLength={800} value={form.blurb} onChange={(event) => set("blurb", event.target.value)} />
              <small className="muted counter">{form.blurb.length} / 800</small>
            </label>
            {missing.length > 0 && !match && (
              <p className="muted pp-help">
                Fill in the {missing.map((key) => (key === "blurb" ? "description" : key === "short" ? "short name" : key)).join(", ")}: claim backups refuse a
                park without them.
              </p>
            )}
            <dl className="pp-facts">
              <div>
                <dt>Park id</dt>
                <dd>{draft.id}</dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd>{draft.seed}</dd>
              </div>
              <div>
                <dt>Area</dt>
                <dd>{(outline.areaM2 / 10_000).toFixed(1)} ha</dd>
              </div>
            </dl>
          </fieldset>
        </div>
      </div>
    </section>
  );
}
