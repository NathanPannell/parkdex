import { Marker, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import type { LngLat } from "../../lib/geo";
import { simplifyOutline, submitParkProposal } from "../../lib/parkProposal";
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

function newSubmissionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
}

function pathOf(points: ScreenPoint[], closed: boolean): string {
  if (!points.length) return "";
  return `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}${closed ? "Z" : ""}`;
}

/**
 * Propose a park: tap the map to drop a pin, optionally trace a rough outline with a finger,
 * then name it. Proposals go to the operator area for review.
 */
export function ProposePark({ mapRef, user, initialPin = null, onClose }: Props) {
  const [pin, setPin] = useState<LngLat | null>(initialPin);
  const [outline, setOutline] = useState<LngLat[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [trace, setTrace] = useState<ScreenPoint[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [, setFrame] = useState(0);
  const submissionId = useRef(newSubmissionId());
  const marker = useRef<Marker | null>(null);
  const tracing = useRef(false);

  // Tap the map to place or move the pin, unless a finger is tracing an outline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || drawing) return;
    const place = (event: MapMouseEvent) => {
      sfx.tap();
      setPin([event.lngLat.lng, event.lngLat.lat]);
      setError(null);
    };
    map.on("click", place);
    return () => void map.off("click", place);
  }, [mapRef, drawing]);

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

  async function submit() {
    if (!pin || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitParkProposal({ submissionId: submissionId.current, name: name.trim(), note: note.trim(), point: pin, outline });
      sfx.chirp();
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't send this proposal. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const instruction = drawing
    ? "Trace a rough loop around the park with your finger."
    : pin
      ? "Tap again to move the pin. Drawing an outline is optional."
      : "Tap the map where the park is.";

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
          <p>{sent ? "Sent to the Parkdex team." : instruction}</p>
        </div>
        <button className="btn btn--paper btn--icon" onClick={onClose} aria-label="Close park proposal">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="propose-sheet card">
        {sent ? (
          <div className="propose-done">
            <Kip pose="cheer" size={84} />
            <h2>Thanks for the tip!</h2>
            <p>We'll take a look at {name.trim()}. If it makes the map, it'll get its own badge.</p>
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
              {outline && !drawing && (
                <button className="btn btn--paper btn--sm" onClick={() => setOutline(null)}>Clear</button>
              )}
            </div>
            <label className="propose-field">
              <span>Park name</span>
              <input value={name} maxLength={120} placeholder="e.g. Cedar Hill Woods" onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="propose-field">
              <span>Anything we should know? <em>Optional</em></span>
              <textarea value={note} maxLength={1000} rows={2} placeholder="Trails, landmarks, how to get in" onChange={(event) => setNote(event.target.value)} />
            </label>
            {error && <p className="propose-error" role="alert">{error}</p>}
            <button className="btn btn--block" onClick={() => void submit()} disabled={!pin || !name.trim() || busy}>
              {busy ? "Sending…" : !pin ? "Drop a pin to continue" : "Send proposal"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
