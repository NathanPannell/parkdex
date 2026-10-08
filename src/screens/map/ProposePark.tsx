import { LngLatBounds, Marker, type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import { useContentRuntime } from "../../lib/content/provider";
import type { LngLat } from "../../lib/geo";
import { searchOsmParks, simplifyOutline, submitParkProposal, type OsmParkCandidate, type ProposalReview } from "../../lib/parkProposal";
import { sfx } from "../../lib/feedback";
import "../../propose-park.css";

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  /** Where the pin starts, for a proposal begun by pressing and holding the map. */
  initialPin?: LngLat | null;
  onClose: () => void;
};

type ScreenPoint = [number, number];
type Search = { state: "idle" | "loading" | "done" | "error"; candidates: OsmParkCandidate[]; error?: string };

const OSM_SOURCE = "propose-osm";
const OSM_FILL = "propose-osm-fill";
const OSM_LINE = "propose-osm-line";
// Waits for the pin to settle before asking OpenStreetMap, so repositioning stays cheap.
const SEARCH_DELAY_MS = 350;

function newSubmissionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
}

function pathOf(points: ScreenPoint[], closed: boolean): string {
  if (!points.length) return "";
  return `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}${closed ? "Z" : ""}`;
}

const keyOf = (candidate: { type: string; id: number }) => `${candidate.type}/${candidate.id}`;

function candidateLabel(candidate: OsmParkCandidate): string {
  return candidate.name ?? (candidate.kind === "leisure=garden" ? "Unnamed garden" : candidate.kind === "leisure=nature_reserve" ? "Unnamed nature reserve" : "Unnamed park");
}

function candidateDetail(candidate: OsmParkCandidate): string {
  const hectares = candidate.areaM2 / 10_000;
  const size = hectares < 0.1 ? "under 0.1 ha" : `${hectares < 10 ? hectares.toFixed(1) : Math.round(hectares)} ha`;
  return `${candidate.containsPin ? "Pin is inside" : `${candidate.distanceM} m from the pin`} · ${size}`;
}

function collection(candidates: OsmParkCandidate[], selected: string | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: candidates.map((candidate) => ({
      type: "Feature",
      properties: { key: keyOf(candidate), selected: keyOf(candidate) === selected },
      geometry: candidate.geometry,
    })),
  };
}

function boundsOf(candidate: OsmParkCandidate): LngLatBounds {
  const bounds = new LngLatBounds();
  for (const polygon of candidate.geometry.coordinates) for (const position of polygon[0]) bounds.extend(position);
  return bounds;
}

/**
 * Propose a park: drop a pin, pick the park's outline from OpenStreetMap or say it is not on
 * the map (then optionally trace a rough outline), and name it. The server may approve it
 * straight away; otherwise it waits for the Parkdex team.
 */
export function ProposePark({ mapRef, user, initialPin = null, onClose }: Props) {
  const content = useContentRuntime();
  const [pin, setPin] = useState<LngLat | null>(initialPin);
  const [outline, setOutline] = useState<LngLat[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [trace, setTrace] = useState<ScreenPoint[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposalReview | null>(null);
  const [search, setSearch] = useState<Search>({ state: "idle", candidates: [] });
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [notListed, setNotListed] = useState(false);
  const [, setFrame] = useState(0);
  const submissionId = useRef(newSubmissionId());
  const marker = useRef<Marker | null>(null);
  const tracing = useRef(false);
  const candidatesRef = useRef<OsmParkCandidate[]>([]);
  const autoName = useRef("");
  const nameRef = useRef(name);
  candidatesRef.current = search.candidates;
  nameRef.current = name;
  const sent = result !== null;

  function choose(candidate: OsmParkCandidate | null) {
    sfx.tap();
    setError(null);
    if (!candidate) {
      setSelected(null);
      setNotListed(true);
      return;
    }
    setSelected(keyOf(candidate));
    setNotListed(false);
    setOutline(null);
    // Fill the name from the map unless the player already typed their own.
    const typed = nameRef.current;
    if (candidate.name && (!typed.trim() || typed === autoName.current)) {
      setName(candidate.name);
      autoName.current = candidate.name;
    }
    mapRef.current?.fitBounds(boundsOf(candidate), { padding: { top: 110, bottom: 380, left: 36, right: 36 }, maxZoom: 17, duration: 600 });
  }

  // Tap the map to place or move the pin, or tap an outline to pick it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || drawing || sent) return;
    const place = (event: MapMouseEvent) => {
      const hit = map.getLayer(OSM_FILL) ? map.queryRenderedFeatures(event.point, { layers: [OSM_FILL] }) : [];
      const key = hit[0]?.properties?.key;
      const candidate = typeof key === "string" ? candidatesRef.current.find((item) => keyOf(item) === key) : undefined;
      if (candidate) {
        choose(candidate);
        return;
      }
      sfx.tap();
      setPin([event.lngLat.lng, event.lngLat.lat]);
      setError(null);
    };
    map.on("click", place);
    return () => void map.off("click", place);
  }, [mapRef, drawing, sent]);

  // Ask OpenStreetMap for park outlines around the pin.
  useEffect(() => {
    if (!pin || drawing || sent) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearch((current) => ({ state: "loading", candidates: current.candidates }));
      searchOsmParks(pin, controller.signal)
        .then((candidates) => {
          setSearch({ state: "done", candidates });
          setSelected((current) => current && candidates.some((item) => keyOf(item) === current) ? current : null);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setSearch({ state: "error", candidates: [], error: caught instanceof Error ? caught.message : "OpenStreetMap is busy right now." });
          setSelected(null);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pin, drawing, sent, searchAttempt]);

  // Draw the candidates on the map, the picked one stronger.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data = collection(sent ? [] : search.candidates, selected);
    const source = map.getSource(OSM_SOURCE) as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else if (map.isStyleLoaded()) {
      map.addSource(OSM_SOURCE, { type: "geojson", data });
      map.addLayer({
        id: OSM_FILL,
        type: "fill",
        source: OSM_SOURCE,
        paint: { "fill-color": ["case", ["get", "selected"], "#ff5a1f", "#2f9e6b"], "fill-opacity": ["case", ["get", "selected"], 0.28, 0.16] },
      });
      map.addLayer({
        id: OSM_LINE,
        type: "line",
        source: OSM_SOURCE,
        paint: {
          "line-color": ["case", ["get", "selected"], "#ff5a1f", "#1c5b43"],
          "line-width": ["case", ["get", "selected"], 3.5, 2],
          "line-dasharray": [2, 1.5],
        },
      });
    }
  }, [mapRef, search.candidates, selected, sent]);

  useEffect(() => () => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of [OSM_LINE, OSM_FILL]) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(OSM_SOURCE)) map.removeSource(OSM_SOURCE);
  }, [mapRef]);

  // Keep the outline drawn over the map as it pans and zooms.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const redraw = () => setFrame((frame) => frame + 1);
    map.on("move", redraw);
    return () => void map.off("move", redraw);
  }, [mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      const el = document.createElement("div");
      el.className = "propose-pin";
      el.innerHTML = '<span class="propose-pin__head"></span><span class="propose-pin__stem"></span>';
      marker.current = new Marker({ element: el, anchor: "bottom" }).setLngLat(pin).addTo(map);
    } else {
      marker.current.setLngLat(pin);
    }
  }, [mapRef, pin]);

  useEffect(() => () => {
    marker.current?.remove();
    marker.current = null;
  }, []);

  const map = mapRef.current;
  // Re-projected on every render; the frame counter re-renders on each map move.
  const outlinePath = map && outline
    ? pathOf(outline.map((point) => {
      const projected = map.project(point);
      return [projected.x, projected.y] as ScreenPoint;
    }), true)
    : "";

  function containerOffset(): { left: number; top: number } {
    const rect = mapRef.current?.getContainer().getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
  }

  function startTrace(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    tracing.current = true;
    const { left, top } = containerOffset();
    setTrace([[event.clientX - left, event.clientY - top]]);
  }

  function continueTrace(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tracing.current) return;
    const { left, top } = containerOffset();
    const next: ScreenPoint = [event.clientX - left, event.clientY - top];
    setTrace((points) => {
      const last = points[points.length - 1];
      return last && Math.hypot(next[0] - last[0], next[1] - last[1]) < 6 ? points : [...points, next];
    });
  }

  function finishTrace() {
    if (!tracing.current) return;
    tracing.current = false;
    const current = mapRef.current;
    setDrawing(false);
    if (!current || trace.length < 3) {
      setTrace([]);
      setError("Trace a loop around the park to draw its outline.");
      return;
    }
    const points = simplifyOutline(trace.map(([x, y]) => {
      const lngLat = current.unproject([x, y]);
      return [lngLat.lng, lngLat.lat] as LngLat;
    }));
    setOutline(points);
    setTrace([]);
    setError(null);
    // An outline without a pin gets one in its middle.
    if (!pin) {
      const lng = points.reduce((sum, point) => sum + point[0], 0) / points.length;
      const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
      setPin([lng, lat]);
    }
  }

  const picked = selected ? search.candidates.find((candidate) => keyOf(candidate) === selected) ?? null : null;
  // With outlines on offer, the player picks one or says the park is not on the map.
  const needsChoice = search.state === "done" && search.candidates.length > 0 && !picked && !notListed;
  const canDraw = !picked && (notListed || search.state === "error" || (search.state === "done" && !search.candidates.length));

  async function submit() {
    if (!pin || !name.trim() || busy || needsChoice) return;
    setBusy(true);
    setError(null);
    try {
      const review = await submitParkProposal({
        submissionId: submissionId.current,
        name: name.trim(),
        note: note.trim(),
        point: pin,
        outline: picked ? null : outline,
        osm: picked ? { type: picked.type, id: picked.id } : null,
      });
      sfx.chirp();
      setResult(review);
      // The new park arrives through the normal content update.
      if (review.decision === "approved") void content.retry().catch(() => {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't send this proposal. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const instruction = drawing
    ? "Trace a rough loop around the park with your finger."
    : !pin
      ? "Tap the map where the park is."
      : search.candidates.length && !notListed
        ? "Pick the park's outline, or tap the map to move the pin."
        : "Tap again to move the pin. Drawing an outline is optional.";

  return (
    <div className="propose" aria-label="Propose a park">
      <svg className="propose-outline" aria-hidden="true">
        {outlinePath && <path className="propose-outline__shape" d={outlinePath} />}
        {trace.length > 1 && <path className="propose-outline__trace" d={pathOf(trace, false)} />}
      </svg>
      {drawing && (
        <div
          className="propose-draw"
          onPointerDown={startTrace}
          onPointerMove={continueTrace}
          onPointerUp={finishTrace}
          onPointerCancel={finishTrace}
        />
      )}

      <div className="propose-top card">
        <div>
          <span className="eyebrow">Propose a park</span>
          <p>{result ? result.decision === "approved" ? "Added to the map." : "Sent to the Parkdex team." : instruction}</p>
        </div>
        <button className="btn btn--paper btn--icon" onClick={onClose} aria-label="Close park proposal">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="propose-sheet card">
        {result ? (
          <div className="propose-done" role="status">
            <Kip pose="cheer" size={84} />
            {result.decision === "approved" ? (
              <>
                <h2>Approved, it's on the map</h2>
                <p>{result.parkName} is in Parkdex now. Go plant your flag.</p>
              </>
            ) : (
              <>
                <h2>Thanks, we'll review it</h2>
                <p>We'll take a look at {name.trim()}. If it makes the map, you can plant your flag there.</p>
              </>
            )}
            <button className="btn btn--block" onClick={onClose}>Back to the map</button>
          </div>
        ) : (
          <>
            <div className="propose-actions">
              <button
                className="btn btn--paper btn--sm"
                onClick={() => {
                  setPin(user);
                  mapRef.current?.flyTo({ center: user, zoom: Math.max(mapRef.current.getZoom(), 14), duration: 700 });
                }}
              >
                <Icon name="locate" size={16} /> I'm here
              </button>
              {canDraw && (
                <button
                  className={`btn btn--sm ${drawing ? "btn--ink" : "btn--paper"}`}
                  onClick={() => {
                    setDrawing((value) => !value);
                    setTrace([]);
                  }}
                  aria-pressed={drawing}
                >
                  <Icon name="draw" size={16} /> {drawing ? "Cancel" : outline ? "Redraw" : "Draw outline"}
                </button>
              )}
              {canDraw && outline && !drawing && (
                <button className="btn btn--paper btn--sm" onClick={() => setOutline(null)}>Clear</button>
              )}
            </div>
            {pin && !drawing && (
              <div className="propose-osm" aria-live="polite">
                <span className="propose-osm__title">Which park is it?</span>
                {search.state === "loading" && !search.candidates.length && <p className="propose-osm__status">Looking for parks on OpenStreetMap...</p>}
                {search.state === "error" && (
                  <p className="propose-osm__status">
                    {search.error} You can still send it.{" "}
                    <button className="propose-osm__retry" onClick={() => setSearchAttempt((value) => value + 1)}>Try again</button>
                  </p>
                )}
                {search.state === "done" && !search.candidates.length && <p className="propose-osm__status">No mapped parks here. Draw a rough outline if you like.</p>}
                {search.candidates.length > 0 && (
                  <div className="propose-osm__list" role="radiogroup" aria-label="Park outlines from OpenStreetMap">
                    {search.candidates.map((candidate) => (
                      <button
                        key={keyOf(candidate)}
                        role="radio"
                        aria-checked={selected === keyOf(candidate)}
                        className={`propose-candidate${selected === keyOf(candidate) ? " is-on" : ""}`}
                        onClick={() => choose(candidate)}
                      >
                        <span className="propose-candidate__name">{candidateLabel(candidate)}</span>
                        <span className="propose-candidate__detail">{candidateDetail(candidate)}</span>
                      </button>
                    ))}
                    <button
                      role="radio"
                      aria-checked={notListed}
                      className={`propose-candidate propose-candidate--none${notListed ? " is-on" : ""}`}
                      onClick={() => choose(null)}
                    >
                      <span className="propose-candidate__name">It's not on the map</span>
                    </button>
                  </div>
                )}
                {search.candidates.length > 0 && <span className="propose-osm__credit">Outlines © OpenStreetMap contributors</span>}
              </div>
            )}
            <label className="propose-field">
              <span>Park name</span>
              <input value={name} maxLength={120} placeholder="e.g. Cedar Hill Woods" onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="propose-field">
              <span>Anything we should know? <em>Optional</em></span>
              <textarea value={note} maxLength={1000} rows={2} placeholder="Trails, landmarks, how to get in" onChange={(event) => setNote(event.target.value)} />
            </label>
            {error && <p className="propose-error" role="alert">{error}</p>}
            <button className="btn btn--block" onClick={() => void submit()} disabled={!pin || !name.trim() || busy || needsChoice}>
              {busy ? "Sending…" : !pin ? "Drop a pin to continue" : needsChoice ? "Pick the park above" : "Send proposal"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
