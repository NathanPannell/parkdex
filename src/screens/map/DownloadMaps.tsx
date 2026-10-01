import type { GeoJSONSource, Map as MLMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { useContent, useContentRuntime } from "../../lib/content/provider";
import { getContentConnectivity, subscribeContentConnectivity } from "../../lib/content/transport";
import type { LngLat } from "../../lib/geo";
import {
  bytesForChunks,
  cellKeyAt,
  chunkIdsForCells,
  chunksToRemove,
  formatMegabytes,
  gridFeatures,
  loadCellIndex,
  readSavedSquares,
  surroundingCellKeys,
  writeSavedSquares,
  type CellIndex,
  type CellState,
} from "../../lib/mapCells";
import { mapChunkPath, setAllowedMapChunks } from "../../lib/offlineTiles";
import { sfx } from "../../lib/feedback";
import "../../download-maps.css";

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  hasFix: boolean;
  onClose: () => void;
};

type Mode = "add" | "remove";
type Progress = { done: number; total: number; waitingForWifi: boolean };

const SOURCE = "download-grid";
const FILL = "download-grid-fill";
const LINE = "download-grid-line";
// Squares are about 50 km; below this zoom they are too small to paint accurately.
const MIN_PAINT_ZOOM = 6;
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Download maps: a grid of map squares over the map. One finger paints squares to
 * download or remove; two fingers move the map. Downloads wait for Wi-Fi.
 */
export function DownloadMaps({ mapRef, user, hasFix, onClose }: Props) {
  const content = useContent();
  const runtime = useContentRuntime();
  const [index, setIndex] = useState<CellIndex | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(() => new Set(readSavedSquares()));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("add");
  const [zoom, setZoom] = useState(() => mapRef.current?.getZoom() ?? 0);
  const [wifi, setWifi] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    loadCellIndex().then(setIndex, (caught) => setLoadError(caught instanceof Error ? caught.message : "Map squares failed to load"));
  }, []);

  useEffect(() => {
    let live = true;
    void getContentConnectivity().then((connectivity) => { if (live) setWifi(connectivity.wifi); });
    const unsubscribe = subscribeContentConnectivity((connectivity) => setWifi(connectivity.wifi));
    return () => { live = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    void navigator.storage?.estimate?.().then((estimate) => {
      if (estimate.quota !== undefined && estimate.usage !== undefined) setFreeBytes(Math.max(0, estimate.quota - estimate.usage));
    }).catch(() => {});
  }, [saved]);

  useEffect(() => () => abort.current?.abort(), []);

  // One finger paints squares; two fingers pan and zoom (MapLibre's cooperative gestures).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index) return;
    const container = map.getContainer();
    container.classList.add("download-mode");
    map.cooperativeGestures.enable();
    let painting: boolean | null = null;

    const paint = (event: MapMouseEvent | MapTouchEvent) => {
      const key = cellKeyAt([event.lngLat.lng, event.lngLat.lat]);
      if (!index.cells[key] || painting === null) return;
      const isSaved = savedRef.current.has(key);
      if (modeRef.current === "add" ? isSaved : !isSaved) return;
      setSelection((current) => {
        if (current.has(key) === painting) return current;
        const next = new Set(current);
        if (painting) next.add(key);
        else next.delete(key);
        return next;
      });
    };
    const start = (event: MapMouseEvent | MapTouchEvent) => {
      if ("points" in event && event.points.length !== 1) {
        painting = null;
        return;
      }
      if (map.getZoom() < MIN_PAINT_ZOOM) return;
      if (!("points" in event)) event.preventDefault();
      const key = cellKeyAt([event.lngLat.lng, event.lngLat.lat]);
      painting = !selectionRef.current.has(key);
      paint(event);
    };
    const move = (event: MapMouseEvent | MapTouchEvent) => {
      if ("points" in event && event.points.length !== 1) painting = null;
      else paint(event);
    };
    const end = () => { painting = null; };
    const onZoom = () => setZoom(map.getZoom());

    map.on("mousedown", start);
    map.on("touchstart", start);
    map.on("mousemove", move);
    map.on("touchmove", move);
    map.on("mouseup", end);
    map.on("touchend", end);
    map.on("touchcancel", end);
    map.on("zoom", onZoom);
    return () => {
      map.off("mousedown", start);
      map.off("touchstart", start);
      map.off("mousemove", move);
      map.off("touchmove", move);
      map.off("mouseup", end);
      map.off("touchend", end);
      map.off("touchcancel", end);
      map.off("zoom", onZoom);
      map.cooperativeGestures.disable();
      container.classList.remove("download-mode");
    };
  }, [mapRef, index]);

  const states = useMemo(() => {
    const result = new Map<string, CellState>();
    for (const key of saved) result.set(key, "saved");
    for (const key of selection) result.set(key, mode === "add" ? "selected" : "unselect");
    return result;
  }, [saved, selection, mode]);

  // Draw the grid above the base map and below the park pins, which are HTML markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index) return;
    const data = gridFeatures(index, states);
    const draw = () => {
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
        return;
      }
      map.addSource(SOURCE, { type: "geojson", data });
      map.addLayer({
        id: FILL,
        type: "fill",
        source: SOURCE,
        paint: {
          "fill-color": ["match", ["get", "state"], "saved", "#2f9e6b", "selected", "#ffc93c", "unselect", "#ff5c8a", "#ffffff"],
          "fill-opacity": ["match", ["get", "state"], "saved", 0.32, "selected", 0.5, "unselect", 0.45, 0.06],
        },
      });
      map.addLayer({
        id: LINE,
        type: "line",
        source: SOURCE,
        paint: { "line-color": "#1c5b43", "line-width": 1, "line-opacity": 0.45 },
      });
    };
    // Style swaps (a new release, or new detail coverage) can drop these layers or restore
    // an older copy of the grid from a style snapshot, so redraw with the current states.
    const redraw = () => { if (map.isStyleLoaded()) draw(); };
    if (map.isStyleLoaded()) draw();
    map.on("styledata", redraw);
    return () => void map.off("styledata", redraw);
  }, [mapRef, index, states]);

  useEffect(() => () => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of [LINE, FILL]) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  }, [mapRef]);

  const savedBytes = index ? bytesForChunks(index, chunkIdsForCells(index, saved)) : 0;
  const selectionBytes = useMemo(() => {
    if (!index) return 0;
    if (mode === "remove") return bytesForChunks(index, chunksToRemove(index, selection, [...saved].filter((key) => !selection.has(key))));
    const have = chunkIdsForCells(index, saved);
    return bytesForChunks(index, [...chunkIdsForCells(index, selection)].filter((id) => !have.has(id)));
  }, [index, selection, saved, mode]);

  const releaseId = content?.releaseId;
  const mapReady = !!releaseId && content?.manifest.mapManifest.size === index?.size;
  const busy = progress !== null;

  async function download() {
    if (!index || !releaseId || !selection.size || busy) return;
    const keys = [...selection];
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    try {
      const ids = [...chunkIdsForCells(index, keys)];
      const missing: number[] = [];
      for (const id of ids) {
        if (!(await runtime.hasLocalFile?.(releaseId, mapChunkPath(id)))) missing.push(id);
      }
      const total = bytesForChunks(index, missing);
      let done = 0;
      setProgress({ done, total, waitingForWifi: !wifi });
      let next = 0;
      const worker = async () => {
        while (next < missing.length) {
          const id = missing[next++];
          // "bulk" downloads wait for confirmed Wi-Fi in the scheduler and transport.
          await runtime.ensureFile(releaseId, mapChunkPath(id), "bulk", controller.signal);
          done += bytesForChunks(index, [id]);
          setProgress({ done, total, waitingForWifi: false });
        }
      };
      await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
      setAllowedMapChunks(releaseId, ids);
      const nextSaved = new Set([...savedRef.current, ...keys]);
      writeSavedSquares(nextSaved);
      setSaved(nextSaved);
      setSelection(new Set());
      sfx.chirp();
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "The download stopped. Try again.");
    } finally {
      if (abort.current === controller) abort.current = null;
      setProgress(null);
    }
  }

  async function remove() {
    if (!index || !releaseId || !selection.size || busy) return;
    const removed = [...selection];
    const remaining = [...saved].filter((key) => !selection.has(key));
    // Keep the squares around the visitor, which nearby coverage downloads again anyway.
    const kept = hasFix ? [...remaining, ...surroundingCellKeys(user)] : remaining;
    setError(null);
    try {
      for (const id of chunksToRemove(index, removed, kept)) await runtime.deleteMapChunk?.(releaseId, mapChunkPath(id));
      const nextSaved = new Set(remaining);
      writeSavedSquares(nextSaved);
      setSaved(nextSaved);
      setSelection(new Set());
    } catch {
      setError("Some squares could not be removed. Try again.");
    }
  }

  const instruction = loadError
    ? "Map squares are unavailable in this build."
    : zoom < MIN_PAINT_ZOOM
      ? "Zoom in to choose squares."
      : mode === "add"
        ? "Drag one finger across the squares you want offline. Use two fingers to move the map."
        : "Drag across saved squares to remove them. Use two fingers to move the map.";

  return (
    <div className="dlmaps" aria-label="Download maps">
      <div className="dlmaps-top card">
        <div>
          <span className="eyebrow">Download maps</span>
          <p>{instruction}</p>
        </div>
        <button className="btn btn--paper btn--icon" onClick={() => { abort.current?.abort(); onClose(); }} aria-label="Close download maps">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="dlmaps-sheet card">
        <div className="dlmaps-modes" role="group" aria-label="Choose squares to">
          <button className={`btn btn--sm ${mode === "add" ? "btn--ink" : "btn--paper"}`} aria-pressed={mode === "add"} disabled={busy}
            onClick={() => { setMode("add"); setSelection(new Set()); }}>
            <Icon name="download" size={16} /> Add
          </button>
          <button className={`btn btn--sm ${mode === "remove" ? "btn--ink" : "btn--paper"}`} aria-pressed={mode === "remove"} disabled={busy || !saved.size}
            onClick={() => { setMode("remove"); setSelection(new Set()); }}>
            <Icon name="close" size={16} /> Remove
          </button>
          {selection.size > 0 && !busy && (
            <button className="btn btn--paper btn--sm" onClick={() => setSelection(new Set())}>Clear</button>
          )}
        </div>

        <dl className="dlmaps-stats">
          <div>
            <dt>{mode === "add" ? "Selected" : "To remove"}</dt>
            <dd>{selection.size} {selection.size === 1 ? "square" : "squares"} · {formatMegabytes(selectionBytes)}</dd>
          </div>
          <div>
            <dt>Saved on this phone</dt>
            <dd>{saved.size} {saved.size === 1 ? "square" : "squares"} · {formatMegabytes(savedBytes)}</dd>
          </div>
          {freeBytes !== null && (
            <div>
              <dt>Free space</dt>
              <dd>{formatMegabytes(freeBytes)}</dd>
            </div>
          )}
        </dl>

        {progress && (
          <div className="dlmaps-progress" role="status">
            <span className="dlmaps-progress__bar"><span style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 100}%` }} /></span>
            <span>
              {progress.waitingForWifi && !wifi
                ? "Waiting for Wi-Fi…"
                : `Downloading ${formatMegabytes(progress.done)} of ${formatMegabytes(progress.total)}`}
            </span>
          </div>
        )}
        {mode === "add" && !wifi && !progress && <p className="dlmaps-note">Downloads start when you're on Wi-Fi.</p>}
        {!mapReady && !loadError && <p className="dlmaps-note">Detailed maps are still getting ready. Try again in a moment.</p>}
        {error && <p className="dlmaps-error" role="alert">{error}</p>}

        {busy ? (
          <button className="btn btn--paper btn--block" onClick={() => abort.current?.abort()}>Stop download</button>
        ) : mode === "add" ? (
          <button className="btn btn--block" onClick={() => void download()} disabled={!selection.size || !mapReady}>
            {selection.size ? `Download ${formatMegabytes(selectionBytes)}` : "Choose squares to download"}
          </button>
        ) : (
          <button className="btn btn--block btn--berry" onClick={() => void remove()} disabled={!selection.size || !mapReady}>
            {selection.size ? `Remove ${selection.size} ${selection.size === 1 ? "square" : "squares"}` : "Choose squares to remove"}
          </button>
        )}
      </div>
    </div>
  );
}
