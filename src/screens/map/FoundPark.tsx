import { LngLatBounds, Marker, type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import { PhotoCapture } from "../../components/PhotoCapture";
import { useAuth } from "../../lib/accounts/AuthProvider";
import { insidePark } from "../../lib/boundaries";
import { buzz, sfx } from "../../lib/feedback";
import {
  canFound, checkFlags, defaultPark, formatHectares, founderLine, foundPark, FounderError, isFreshFix, MAX_FOUND_ACCURACY_M, parkKey, parkLabel, scanParks, targetFor,
  type ContainingPark, type DeviceFix, type FoundResult, type FoundTarget, type PhotoFlag,
} from "../../lib/founders";
import { createVisitId } from "../../lib/game/client";
import { useGame } from "../../lib/game/GameProvider";
import type { Boundary, LngLat } from "../../lib/geo";
import { currentFix } from "../../lib/native";
import type { Park } from "../../lib/parks";
import type { EncodedPhoto } from "../../lib/photoEncode";
import { captureProductEvent } from "../../lib/productAnalytics";
import { FoundCelebration } from "./FoundCelebration";
import "../../found-park.css";

type Props = {
  mapRef: RefObject<MLMap | null>;
  /** Found this Parkdex park, opened from its sheet; otherwise scan for the parks around you. */
  park: Park | null;
  boundary?: Boundary;
  /** The map's own location, used for the scan ring until a fresh fix arrives. */
  user: LngLat;
  hasFix: boolean;
  onLocated: (fix: DeviceFix) => void;
  onSignIn: () => void;
  /** Closes the flow; with a park ID, the map opens that park next. */
  onClose: (showParkId?: string) => void;
  /** Called once the park is founded, to refresh content, flags and the score. */
  onFounded: (parkId: string) => void;
};

/** The outline picked for founding, from the scan or the park's own boundary. */
type Choice = { key: string; label: string; target: FoundTarget; geometry: Boundary };

type Step =
  | { kind: "locating" }
  | { kind: "scanning" }
  | { kind: "results" }
  | { kind: "problem"; message: string; detail?: string; action: "scan" | "close" }
  | { kind: "camera" }
  | { kind: "checking" }
  | { kind: "rejected"; outcome: "rejected" | "unsure"; flags: PhotoFlag[] }
  | { kind: "retry"; message: string }
  | { kind: "taken"; founder: string | null }
  | { kind: "founded"; result: Extract<FoundResult, { outcome: "founded" }> };

const SOURCE = "found-parks";
const FILL = "found-parks-fill";
const LINE = "found-parks-line";
// Long enough for the scan sweep to read as a scan, even when the answer is instant.
const MIN_SCAN_MS = 1600;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FLAG_ICONS: Record<string, IconName> = {
  people: "walk",
  lighting: "bulb",
  not_park: "forest",
  inappropriate: "close",
  not_photo: "image",
  personal_info: "lock",
  unsure: "search",
};

function locationProblem(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "denied") return "Turn on location for Parkdex to found a park.";
  if (reason === "timeout") return "Finding you took too long. Step into the open and try again.";
  return "We couldn't find your location. Try again.";
}

function collection(parks: { key: string; geometry: Boundary; open: boolean }[], selected: string | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: parks.map((park) => ({
      type: "Feature",
      properties: { key: park.key, selected: park.key === selected, open: park.open },
      geometry: park.geometry,
    })),
  };
}

function boundsOf(geometry: Boundary): LngLatBounds {
  const bounds = new LngLatBounds();
  for (const polygon of geometry.coordinates) for (const position of polygon[0]) bounds.extend(position);
  return bounds;
}

function candidateDetail(park: ContainingPark): string {
  if (park.founder) return founderLine(park.founder.handle);
  const size = formatHectares(park.areaM2);
  return park.inCatalogue ? `On the map, no founder yet · ${size}` : `New to Parkdex · ${size}`;
}

/**
 * Found a park: scan where you stand for mapped park outlines that contain you, take a photo,
 * and let the server check it. An approved photo makes you the founder, becomes the park's
 * cover and counts as today's visit.
 */
export function FoundPark({ mapRef, park, boundary, user, hasFix, onLocated, onSignIn, onClose, onFounded }: Props) {
  const auth = useAuth();
  const game = useGame();
  const [accountId] = useState(() => auth.ownerAccountId);
  const [step, setStep] = useState<Step>({ kind: "locating" });
  const [fix, setFix] = useState<DeviceFix | null>(null);
  const [parks, setParks] = useState<ContainingPark[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [photo, setPhoto] = useState<EncodedPhoto | null>(null);
  const [scanRun, setScanRun] = useState(0);
  const attemptId = useRef(createVisitId());
  const live = useRef(true);
  const fixRef = useRef<DeviceFix | null>(null);
  const radar = useRef<Marker | null>(null);
  const topCard = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const parksRef = useRef<ContainingPark[]>([]);
  parksRef.current = parks;
  fixRef.current = fix;

  const choices: Choice[] = park && boundary
    ? [{ key: `park/${park.id}`, label: park.name, target: { parkId: park.id }, geometry: boundary }]
    : parks.filter(canFound).map((item) => ({ key: parkKey(item), label: parkLabel(item), target: targetFor(item), geometry: item.geometry }));
  const choice = choices.find((item) => item.key === selected) ?? null;
  const scanningNow = step.kind === "locating" || step.kind === "scanning";

  useEffect(() => {
    live.current = true;
    captureProductEvent("found_park_started", { entry: park ? "sheet" : "menu" });
    return () => { live.current = false; };
  }, []);

  // Locate, then scan. A sheet's park skips the scan: its own boundary is checked here and on the server.
  useEffect(() => {
    const controller = new AbortController();
    setStep({ kind: "locating" });
    setSelected(null);
    void (async () => {
      const started = Date.now();
      let next: DeviceFix;
      try {
        next = await currentFix();
      } catch (error) {
        if (!controller.signal.aborted) setStep({ kind: "problem", message: locationProblem(error), action: "scan" });
        return;
      }
      if (controller.signal.aborted) return;
      setFix(next);
      onLocated(next);
      mapRef.current?.easeTo({ center: next.point, zoom: Math.max(mapRef.current.getZoom(), 15.5), duration: 900 });
      if (next.accuracy > MAX_FOUND_ACCURACY_M) {
        await wait(Math.max(0, MIN_SCAN_MS - (Date.now() - started)));
        if (!controller.signal.aborted) setStep({ kind: "problem", message: "Your location is not precise enough.", detail: `It's within ${Math.round(next.accuracy)} m right now. Step into the open, wait a moment and scan again.`, action: "scan" });
        return;
      }
      setStep({ kind: "scanning" });
      try {
        if (park) {
          await wait(Math.max(0, MIN_SCAN_MS - (Date.now() - started)));
          if (controller.signal.aborted) return;
          if (!insidePark(next.point, boundary, next.accuracy)) {
            setStep({ kind: "problem", message: `You're not inside ${park.name} yet.`, detail: "Get inside the park's boundary, then try again.", action: "scan" });
            return;
          }
          setSelected(`park/${park.id}`);
          setStep({ kind: "results" });
          return;
        }
        const [found] = await Promise.all([scanParks(next, controller.signal), wait(Math.max(0, MIN_SCAN_MS - (Date.now() - started)))]);
        if (controller.signal.aborted) return;
        setParks(found);
        const first = defaultPark(found);
        setSelected(first ? parkKey(first) : null);
        setStep({ kind: "results" });
        sfx.chirp();
      } catch (error) {
        if (controller.signal.aborted) return;
        setStep({ kind: "problem", message: error instanceof FounderError ? error.message : "Parkdex couldn't scan right now.", action: "scan" });
      }
    })();
    return () => controller.abort();
  }, [scanRun]);

  // The scan sweep sits on the map at your position, so it pans and zooms with it.
  const ringAt = fix?.point ?? (hasFix ? user : null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !scanningNow || !ringAt) {
      radar.current?.remove();
      radar.current = null;
      return;
    }
    if (!radar.current) {
      const el = document.createElement("div");
      el.className = "found-radar";
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = '<span class="found-radar__sweep"></span><span class="found-radar__ring"></span><span class="found-radar__ring found-radar__ring--2"></span><span class="found-radar__core"></span>';
      radar.current = new Marker({ element: el }).setLngLat(ringAt).addTo(map);
    } else {
      radar.current.setLngLat(ringAt);
    }
  }, [mapRef, scanningNow, ringAt?.[0], ringAt?.[1]]);

  useEffect(() => () => {
    radar.current?.remove();
    radar.current = null;
  }, []);

  // Outlines on the map: the picked one strong, others light, founded ones grey.
  const shown = step.kind === "results" || step.kind === "problem";
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const outlines = !shown ? [] : park && boundary
      ? [{ key: `park/${park.id}`, geometry: boundary, open: true }]
      : parks.map((item) => ({ key: parkKey(item), geometry: item.geometry, open: canFound(item) }));
    const data = collection(outlines, selected);
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else if (map.isStyleLoaded()) {
      map.addSource(SOURCE, { type: "geojson", data });
      map.addLayer({
        id: FILL,
        type: "fill",
        source: SOURCE,
        paint: {
          "fill-color": ["case", ["get", "selected"], "#ff5a1f", ["get", "open"], "#2f9e6b", "#7a8a81"],
          "fill-opacity": ["case", ["get", "selected"], 0.26, ["get", "open"], 0.12, 0.08],
        },
      });
      map.addLayer({
        id: LINE,
        type: "line",
        source: SOURCE,
        paint: {
          "line-color": ["case", ["get", "selected"], "#ff5a1f", ["get", "open"], "#1c5b43", "#7a8a81"],
          "line-width": ["case", ["get", "selected"], 4, 2],
          "line-dasharray": [2, 1.5],
        },
      });
    }
  }, [mapRef, parks, selected, shown, park, boundary]);

  useEffect(() => () => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of [LINE, FILL]) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  }, [mapRef]);

  // Tapping an outline picks it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || step.kind !== "results" || park) return;
    const pick = (event: MapMouseEvent) => {
      const hits = map.getLayer(FILL) ? map.queryRenderedFeatures(event.point, { layers: [FILL] }) : [];
      // Nested outlines stack; the smallest one under the finger is the one meant.
      const keys = hits.map((hit) => hit.properties?.key).filter((key): key is string => typeof key === "string");
      const options = parksRef.current.filter((item) => canFound(item) && keys.includes(parkKey(item))).sort((a, b) => a.areaM2 - b.areaM2);
      if (options[0]) {
        sfx.tap();
        setSelected(parkKey(options[0]));
      }
    };
    map.on("click", pick);
    return () => void map.off("click", pick);
  }, [mapRef, step.kind, park]);

  // Frame the picked outline in the part of the map the cards leave visible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !choice || step.kind !== "results") return;
    const frame = window.requestAnimationFrame(() => {
      const box = map.getContainer().getBoundingClientRect();
      const top = (topCard.current?.getBoundingClientRect().bottom ?? box.top + 100) - box.top + 16;
      const bottom = box.bottom - (sheet.current?.getBoundingClientRect().top ?? box.bottom - 320) + 16;
      if (box.height - top - bottom < 80) return;
      map.fitBounds(boundsOf(choice.geometry), { padding: { top, bottom, left: 32, right: 32 }, maxZoom: 17, duration: 700 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mapRef, choice?.key, step.kind]);

  async function freshPosition(): Promise<DeviceFix> {
    const known = fixRef.current;
    if (known && isFreshFix(known)) return known;
    const next = await currentFix();
    setFix(next);
    onLocated(next);
    return next;
  }

  async function check(picture: EncodedPhoto, target: FoundTarget) {
    if (!accountId) {
      onSignIn();
      return;
    }
    setStep({ kind: "checking" });
    let position: DeviceFix;
    try {
      position = await freshPosition();
    } catch (error) {
      if (live.current) setStep({ kind: "retry", message: locationProblem(error) });
      return;
    }
    if (position.accuracy > MAX_FOUND_ACCURACY_M) {
      if (live.current) setStep({ kind: "retry", message: "Your location is not precise enough. Step into the open and try again." });
      return;
    }
    try {
      const result = await foundPark(accountId, {
        attemptId: attemptId.current,
        position: { lat: Number(position.point[1].toFixed(6)), lng: Number(position.point[0].toFixed(6)), accuracyM: Math.max(1, Math.round(position.accuracy)) },
        target,
        photo: { mime: "image/jpeg", base64: picture.base64, width: picture.width, height: picture.height },
      });
      if (!live.current) return;
      if (result.outcome === "founded") {
        sfx.claim();
        captureProductEvent("found_park_completed", { source: "osm" in target ? "osm" : "catalogue", visit: result.visit?.outcome ?? null });
        setStep({ kind: "founded", result });
        onFounded(result.park.id);
        return;
      }
      const flags = checkFlags(result);
      buzz([30, 40, 30]);
      captureProductEvent("found_park_photo_rejected", { outcome: result.outcome, flags: flags.map((flag) => flag.code) });
      setStep({ kind: "rejected", outcome: result.outcome, flags });
    } catch (error) {
      if (!live.current) return;
      if (!(error instanceof FounderError)) {
        setStep({ kind: "retry", message: "Try again in a moment." });
        return;
      }
      if (error.retryable) setStep({ kind: "retry", message: error.code === "unavailable" ? "Try again in a moment." : error.message });
      else if (error.code === "already_founded") setStep({ kind: "taken", founder: error.founder });
      else if (error.code === "handle_required") {
        setStep({ kind: "retry", message: error.message });
        game.openHandleSheet({ onDone: () => void check(picture, target) });
      } else if (error.code === "unauthenticated") {
        setStep({ kind: "problem", message: error.message, action: "close" });
      } else if (error.code === "not_inside" || error.code === "location_imprecise") {
        setStep({ kind: "problem", message: error.message, action: "scan" });
      } else {
        setStep({ kind: "problem", message: error.message, action: "close" });
      }
    }
  }

  function openCamera() {
    if (!choice) return;
    sfx.tap();
    // A new photo is a new attempt; only a retry of the same photo reuses its ID.
    attemptId.current = createVisitId();
    setPhoto(null);
    setStep({ kind: "camera" });
  }

  function rescan() {
    sfx.tap();
    setParks([]);
    setFix(null);
    setScanRun((value) => value + 1);
  }

  if (step.kind === "founded" && photo) {
    return <FoundCelebration result={step.result} photo={photo.dataUrl} flagSeed={game.me?.player?.flagSeed ?? game.me?.flagSeed ?? null} onClose={onClose} />;
  }

  const allFounded = !park && step.kind === "results" && parks.length > 0 && !parks.some(canFound);
  const firstFounder = parks.find((item) => item.founder)?.founder?.handle ?? null;

  const instruction = step.kind === "locating" ? "Finding you…"
    : step.kind === "scanning" ? (park ? `Checking you're inside ${park.name}…` : "Looking for mapped parks around you…")
      : step.kind === "results" && choice ? "Take a photo of the park to found it."
        : "Stand inside a park to found it.";
  const busyStep = step.kind === "checking" || step.kind === "rejected" || step.kind === "retry" || step.kind === "taken";

  return (
    <div className="found" aria-label="Found a park">
      <div className="found-top card" ref={topCard}>
        <div>
          <span className="eyebrow">Found a park</span>
          <p aria-live="polite">{instruction}</p>
        </div>
        <button className="btn btn--paper btn--icon" onClick={() => onClose()} aria-label="Close founding">
          <Icon name="close" size={18} />
        </button>
      </div>

      {!busyStep && step.kind !== "camera" && (
        <motion.div className="found-sheet card" ref={sheet} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 380, damping: 30 }}>
          {scanningNow ? (
            <div className="found-status" role="status">
              <span className="found-status__spinner" aria-hidden="true" />
              <div>
                <strong>{step.kind === "locating" ? "Finding you" : "Scanning"}</strong>
                <span>{park ? "Only parks you're standing in can be founded." : "Only parks that contain you show up."}</span>
              </div>
            </div>
          ) : step.kind === "problem" ? (
            <div className="found-empty" role="alert">
              <Kip pose="think" size={64} />
              <div>
                <strong>{step.message}</strong>
                {step.detail && <span>{step.detail}</span>}
              </div>
              <div className="found-row">
                {step.action === "scan" && <button className="btn btn--sm" onClick={rescan}><Icon name="refresh" size={16} /> Try again</button>}
                <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Close</button>
              </div>
            </div>
          ) : !park && parks.length === 0 ? (
            <div className="found-empty" role="status">
              <Kip pose="think" size={64} />
              <div>
                <strong>No mapped park here</strong>
                <span>You can found a park only while you stand inside its outline on OpenStreetMap. Head into a park and scan again.</span>
              </div>
              <div className="found-row">
                <button className="btn btn--sm" onClick={rescan}><Icon name="refresh" size={16} /> Scan again</button>
                <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Close</button>
              </div>
            </div>
          ) : allFounded ? (
            <div className="found-empty" role="status">
              <Kip pose="point" size={64} />
              <div>
                <strong>{founderLine(firstFounder)}</strong>
                <span>Every park has one founder. You can still plant your flag here.</span>
              </div>
              <div className="found-row">
                <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Back to the map</button>
              </div>
            </div>
          ) : (
            <>
              {park ? (
                <div className="found-pick">
                  <span className="found-pick__title">You're in</span>
                  <strong className="found-pick__name">{park.name}</strong>
                </div>
              ) : (
                <div className="found-pick">
                  <span className="found-pick__title">{parks.length > 1 ? "Which park are you founding?" : "You're in"}</span>
                  {parks.length > 1 ? (
                    <div className="found-list" role="radiogroup" aria-label="Parks around you">
                      {parks.map((item) => (
                        <button
                          key={parkKey(item)}
                          role="radio"
                          aria-checked={selected === parkKey(item)}
                          disabled={!canFound(item)}
                          className={`found-option${selected === parkKey(item) ? " is-on" : ""}${canFound(item) ? "" : " is-founded"}`}
                          onClick={() => {
                            sfx.tap();
                            setSelected(parkKey(item));
                          }}
                        >
                          <span className="found-option__name">{parkLabel(item)}</span>
                          <span className="found-option__detail">{candidateDetail(item)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <strong className="found-pick__name">{parkLabel(parks[0])}</strong>
                      <span className="found-pick__detail">{candidateDetail(parks[0])}</span>
                    </>
                  )}
                  <span className="found-credit">Outlines © OpenStreetMap contributors</span>
                </div>
              )}
              <button className="btn btn--block btn--glow" onClick={openCamera} disabled={!choice}>
                <Icon name="camera" /> Take the photo
              </button>
            </>
          )}
        </motion.div>
      )}

      <AnimatePresence>
        {step.kind === "camera" && choice && (
          <PhotoCapture
            key="camera"
            place={`Inside ${choice.label}`}
            hint="Get the park in the shot, with no people in it. This becomes the park's cover photo."
            caption={`${choice.label} · ${new Date().toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`}
            onClose={() => setStep({ kind: "results" })}
            onUse={(picture) => {
              setPhoto(picture);
              void check(picture, choice.target);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {busyStep && photo && (
          <motion.div key="check" className="found-check" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className={`polaroid found-check__photo${step.kind === "checking" ? " is-checking" : ""}`} initial={{ scale: 0.9, rotate: 0 }} animate={{ scale: 1, rotate: step.kind === "rejected" ? 2 : -3 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
              <div className="polaroid__img" style={{ aspectRatio: `${photo.width} / ${photo.height}` }}>
                <img src={photo.dataUrl} alt="Your photo" />
                {step.kind === "checking" && <span className="found-check__scan" aria-hidden="true" />}
              </div>
              <span className="polaroid__caption">{choice?.label ?? ""}</span>
            </motion.div>

            <div className="found-check__panel card" role={step.kind === "checking" ? "status" : "alert"}>
              {step.kind === "checking" ? (
                <div className="found-status">
                  <span className="found-status__spinner" aria-hidden="true" />
                  <div>
                    <strong>Checking your photo</strong>
                    <span>This takes a few seconds.</span>
                  </div>
                </div>
              ) : step.kind === "rejected" ? (
                <>
                  <strong className="found-check__title">{step.outcome === "unsure" ? "We couldn't tell" : "This photo can't be the cover"}</strong>
                  <ul className="found-flags">
                    {step.flags.map((flag) => (
                      <li key={flag.code}>
                        <span className="found-flags__icon"><Icon name={FLAG_ICONS[flag.code] ?? "camera"} size={18} /></span>
                        <span>{flag.message}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="found-row">
                    <button className="btn btn--sm" onClick={openCamera}><Icon name="camera" size={16} /> Retake</button>
                    <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Close</button>
                  </div>
                </>
              ) : step.kind === "retry" ? (
                <>
                  <strong className="found-check__title">{step.message}</strong>
                  <span className="found-check__detail">Your photo is kept here. Nothing was saved yet.</span>
                  <div className="found-row">
                    <button className="btn btn--sm" onClick={() => choice && void check(photo, choice.target)}><Icon name="refresh" size={16} /> Try again</button>
                    <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Close</button>
                  </div>
                </>
              ) : step.kind === "taken" ? (
                <>
                  <strong className="found-check__title">{founderLine(step.founder)}</strong>
                  <span className="found-check__detail">Someone got here first. You can still plant your flag.</span>
                  <div className="found-row">
                    <button className="btn btn--sm btn--paper" onClick={() => onClose()}>Back to the map</button>
                  </div>
                </>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
