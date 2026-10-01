import type { GeoJSONSource, Map as MLMap, MapMouseEvent } from "maplibre-gl";
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
  squareLabels,
  surroundingCellKeys,
  writeSavedSquares,
  type CellIndex,
  type CellState,
} from "../../lib/mapCells";
import { mapChunkPath, setAllowedMapChunks } from "../../lib/offlineTiles";
import { sfx } from "../../lib/feedback";
import { readAllowMobileMapData, subscribeAllowMobileMapData, writeAllowMobileMapData } from "../../lib/downloadPreferences";
import "../../download-maps.css";

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  hasFix: boolean;
  onClose: () => void;
};

type Progress = { done: number; total: number; waitingForWifi: boolean };

const SOURCE = "download-grid";
const FILL = "download-grid-fill";
const LINE = "download-grid-line";
const LABEL_SOURCE = "download-grid-labels";
const LABEL = "download-grid-label";
// Size and park labels need room inside a square, which is about 90 px wide at zoom 6.5.
const LABEL_MIN_ZOOM = 6.5;
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Download maps: a grid of map squares over the map, each labelled with its size and
 * park count. The map moves as usual; tapping a square marks it to download, or marks
 * a saved square to remove. Downloads wait for Wi-Fi.
 */
export function DownloadMaps({ mapRef, user, hasFix, onClose }: Props) {
  const content = useContent();
  const runtime = useContentRuntime();
  const [index, setIndex] = useState<CellIndex | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(() => new Set(readSavedSquares()));
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [wifi, setWifi] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [mobileData, setMobileData] = useState(() => readAllowMobileMapData());
  const abort = useRef<AbortController | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const busyRef = useRef(false);
  busyRef.current = progress !== null;

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
  useEffect(() => subscribeAllowMobileMapData(setMobileData), []);

  // The map pans and zooms normally; a tap (not a drag) toggles the square under it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index) return;
    const toggle = (event: MapMouseEvent) => {
      if (busyRef.current) return;
      const key = cellKeyAt([event.lngLat.lng, event.lngLat.lat]);
      if (!index.cells[key]) return;
      const flip = (current: Set<string>) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      };
      sfx.tap();
      if (savedRef.current.has(key)) setToRemove(flip);
      else setToAdd(flip);
    };
    map.on("click", toggle);
    return () => void map.off("click", toggle);
  }, [mapRef, index]);

  const states = useMemo(() => {
    const result = new Map<string, CellState>();
    for (const key of saved) result.set(key, toRemove.has(key) ? "unselect" : "saved");
    for (const key of toAdd) result.set(key, "selected");
    return result;
  }, [saved, toAdd, toRemove]);

  // Each square's full size and park count, shown once squares are large enough to label.
  const labels = useMemo(() => (index ? squareLabels(index, content?.parks ?? []) : null), [index, content?.parks]);

  // Draw the grid above the base map and below the park pins, which are HTML markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index) return;
    const data = gridFeatures(index, states);
    // Add whatever is missing and refresh the data; safe to call repeatedly.
    const draw = () => {
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (source) source.setData(data);
      if (!map.isStyleLoaded()) return;
      if (!source) map.addSource(SOURCE, { type: "geojson", data });
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: "fill",
          source: SOURCE,
          paint: {
            "fill-color": ["match", ["get", "state"], "saved", "#2f9e6b", "selected", "#ffc93c", "unselect", "#ff5c8a", "#ffffff"],
            "fill-opacity": ["match", ["get", "state"], "saved", 0.32, "selected", 0.5, "unselect", 0.45, 0.06],
          },
        });
      }
      if (!map.getLayer(LINE)) {
        map.addLayer({
          id: LINE,
          type: "line",
          source: SOURCE,
          paint: { "line-color": "#1c5b43", "line-width": 1, "line-opacity": 0.45 },
        });
      }
      // Labels need map glyphs, which only the detailed map style provides.
      if (labels && map.getStyle().glyphs && !map.getLayer(LABEL)) {
        if (!map.getSource(LABEL_SOURCE)) map.addSource(LABEL_SOURCE, { type: "geojson", data: labels });
        map.addLayer({
          id: LABEL,
          type: "symbol",
          source: LABEL_SOURCE,
          minzoom: LABEL_MIN_ZOOM,
          layout: {
            "text-field": ["get", "label"],
            "text-font": ["Noto Sans Medium"],
            "text-size": 12,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: { "text-color": "#14231c", "text-halo-color": "#fff8ec", "text-halo-width": 1.6 },
        });
      }
    };
    // Style swaps (a new release, or new detail coverage) can drop these layers, or restore
    // an older copy of the grid when a diff deferred until the style loads is applied later.
    // Redraw on every style change, and again once the map settles if layers are missing.
    const onStyleData = () => {
      draw();
      if (!map.getLayer(FILL)) map.once("idle", draw);
    };
    onStyleData();
    map.on("styledata", onStyleData);
    return () => {
      map.off("styledata", onStyleData);
      map.off("idle", draw);
    };
  }, [mapRef, index, states, labels]);

  useEffect(() => () => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of [LABEL, LINE, FILL]) if (map.getLayer(layer)) map.removeLayer(layer);
    for (const source of [LABEL_SOURCE, SOURCE]) if (map.getSource(source)) map.removeSource(source);
  }, [mapRef]);

  const savedBytes = index ? bytesForChunks(index, chunkIdsForCells(index, saved)) : 0;
  const addBytes = useMemo(() => {
    if (!index) return 0;
    const have = chunkIdsForCells(index, saved);
    return bytesForChunks(index, [...chunkIdsForCells(index, toAdd)].filter((id) => !have.has(id)));
  }, [index, toAdd, saved]);
  const removeBytes = useMemo(() => {
    if (!index) return 0;
    return bytesForChunks(index, chunksToRemove(index, toRemove, [...saved].filter((key) => !toRemove.has(key))));
  }, [index, toRemove, saved]);

  const releaseId = content?.releaseId;
  const mapReady = !!releaseId && content?.manifest.mapManifest.size === index?.size;
  const busy = progress !== null;

  async function download() {
    if (!index || !releaseId || !toAdd.size || busy) return;
    const keys = [...toAdd];
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
      setToAdd(new Set());
      sfx.chirp();
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "The download stopped. Try again.");
    } finally {
      if (abort.current === controller) abort.current = null;
      setProgress(null);
    }
  }

  async function remove() {
    if (!index || !releaseId || !toRemove.size || busy) return;
    const removed = [...toRemove];
    const remaining = [...saved].filter((key) => !toRemove.has(key));
    // Keep the squares around the visitor, which nearby coverage downloads again anyway.
    const kept = hasFix ? [...remaining, ...surroundingCellKeys(user)] : remaining;
    setError(null);
    try {
      for (const id of chunksToRemove(index, removed, kept)) await runtime.deleteMapChunk?.(releaseId, mapChunkPath(id));
      const nextSaved = new Set(remaining);
      writeSavedSquares(nextSaved);
      setSaved(nextSaved);
      setToRemove(new Set());
    } catch {
      setError("Some squares could not be removed. Try again.");
    }
  }

  const instruction = loadError
    ? "Map squares are unavailable in this build."
    : "Tap a square to download it, or tap a saved square to remove it.";

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
        <dl className="dlmaps-stats">
          <div>
            <dt>To download</dt>
            <dd>{toAdd.size} {toAdd.size === 1 ? "square" : "squares"} · {formatMegabytes(addBytes)}</dd>
          </div>
          {toRemove.size > 0 && (
            <div>
              <dt>To remove</dt>
              <dd>{toRemove.size} {toRemove.size === 1 ? "square" : "squares"} · {formatMegabytes(removeBytes)}</dd>
            </div>
          )}
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
              {progress.waitingForWifi && !wifi && !mobileData
                ? "Waiting for Wi-Fi…"
                : `Downloading ${formatMegabytes(progress.done)} of ${formatMegabytes(progress.total)}`}
            </span>
          </div>
        )}
        {(toAdd.size > 0 || progress) && !wifi && !mobileData && (
          <div className="dlmaps-wifi">
            <p className="dlmaps-note">Downloads wait for Wi-Fi.</p>
            <button className="btn btn--paper btn--sm" onClick={() => writeAllowMobileMapData(true)}>Use mobile data</button>
          </div>
        )}
        {!mapReady && !loadError && <p className="dlmaps-note">Detailed maps are still getting ready. Try again in a moment.</p>}
        {error && <p className="dlmaps-error" role="alert">{error}</p>}

        {busy ? (
          <button className="btn btn--paper btn--block" onClick={() => abort.current?.abort()}>Stop download</button>
        ) : (
          <div className="dlmaps-actions">
            {toRemove.size > 0 && (
              <button className="btn btn--berry" onClick={() => void remove()} disabled={!mapReady}>
                Remove {toRemove.size}
              </button>
            )}
            <button className="btn" onClick={() => void download()} disabled={!toAdd.size || !mapReady}>
              {toAdd.size ? `Download ${formatMegabytes(addBytes)}` : "Tap squares to download"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
