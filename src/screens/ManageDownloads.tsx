import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { useContent, useContentRuntime } from "../lib/content/provider";
import { isUsableGpsAccuracy } from "../lib/geo";
import {
  bytesForChunks,
  cellKeyAt,
  cellRing,
  chunkIdsForCells,
  chunksToRemove,
  formatMegabytes,
  loadCellIndex,
  readSavedSquares,
  requestDownloadMaps,
  surroundingCellKeys,
  writeSavedSquares,
  type CellIndex,
} from "../lib/mapCells";
import { summarizeLocalStorage, type LocalStorageSummary } from "../lib/localStorageSummary";
import { readAllowMobileMapData, subscribeAllowMobileMapData, writeAllowMobileMapData } from "../lib/downloadPreferences";
import { mapChunkPath } from "../lib/offlineTiles";
import { useStore } from "../lib/store";
import "../download-maps.css";

type SquareRow = { key: string; name: string; bytes: number; parks: number };

/** Everything Parkdex keeps on this phone: saved map squares, cached map detail and park content. */
export function ManageDownloads() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const runtime = useContentRuntime();
  const [index, setIndex] = useState<CellIndex | null>(null);
  const [saved, setSaved] = useState<string[]>(() => readSavedSquares());
  const [summary, setSummary] = useState<LocalStorageSummary | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileData, setMobileData] = useState(() => readAllowMobileMapData());

  useEffect(() => subscribeAllowMobileMapData(setMobileData), []);

  const refresh = useCallback(async () => {
    setSummary(await summarizeLocalStorage(runtime));
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (estimate?.quota !== undefined && estimate.usage !== undefined) setFreeBytes(Math.max(0, estimate.quota - estimate.usage));
  }, [runtime]);

  useEffect(() => {
    loadCellIndex().then(setIndex, () => setIndex(null));
    void refresh().catch(() => setError("Storage details are unavailable right now."));
  }, [refresh]);

  const rows = useMemo<SquareRow[]>(() => {
    if (!index) return [];
    const parks = content?.parks ?? [];
    return saved.map((key) => {
      const inside = parks.filter((park) => cellKeyAt([park.lng, park.lat]) === key);
      const ring = cellRing(key);
      const center: [number, number] = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
      const nearest = [...parks].sort((a, b) =>
        Math.hypot(a.lng - center[0], a.lat - center[1]) - Math.hypot(b.lng - center[0], b.lat - center[1]))[0];
      const name = inside.length && nearest ? `Around ${nearest.name}` : `${Math.abs(center[1]).toFixed(1)}° N, ${Math.abs(center[0]).toFixed(1)}° W`;
      return { key, name, bytes: bytesForChunks(index, chunkIdsForCells(index, [key])), parks: inside.length };
    });
  }, [index, saved, content?.parks]);

  const hasFix = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy);
  const releaseId = content?.releaseId;

  async function removeSquare(key: string) {
    if (!index || !releaseId || busy) return;
    setBusy(key);
    setError(null);
    try {
      const remaining = saved.filter((other) => other !== key);
      // Keep pieces another saved square or the area around the visitor still uses.
      const kept = hasFix ? [...remaining, ...surroundingCellKeys(state.user)] : remaining;
      for (const id of chunksToRemove(index, [key], kept)) await runtime.deleteMapChunk?.(releaseId, mapChunkPath(id));
      writeSavedSquares(remaining);
      setSaved(remaining);
      await refresh();
    } catch {
      setError("That square could not be removed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function clearMapCache() {
    if (!summary || !releaseId || busy) return;
    setBusy("cache");
    setError(null);
    try {
      for (const id of summary.mapCacheChunks) await runtime.deleteMapChunk?.(releaseId, mapChunkPath(id));
      await refresh();
    } catch {
      setError("Some map detail could not be cleared. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function clearUnused() {
    if (busy) return;
    setBusy("unused");
    setError(null);
    try {
      await runtime.deleteUnusedFiles?.();
      await refresh();
    } catch {
      setError("Some old files could not be cleared. Try again.");
    } finally {
      setBusy(null);
    }
  }

  // Neighbouring squares share some pieces, so count each piece once.
  const savedBytes = index ? bytesForChunks(index, chunkIdsForCells(index, saved)) : 0;

  return (
    <motion.main
      className="screen account-screen scroll"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
      aria-labelledby="downloads-title"
    >
      <header className="account-head">
        <button className="btn btn--paper btn--icon account-back" onClick={() => dispatch({ type: "go", screen: "settings" })} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
        <div className="account-head__title">
          <span className="eyebrow">Settings</span>
          <h1 id="downloads-title">Manage downloads</h1>
        </div>
      </header>

      <div className="account-body">
        {error && <section className="account-notice card is-error" role="alert"><span>{error}</span></section>}

        <section className="account-card card account-section" aria-labelledby="downloads-total">
          <span className="eyebrow" id="downloads-total">On this phone</span>
          <dl className="downloads-stats">
            <div><dt>Parkdex is using</dt><dd>{summary ? formatMegabytes(summary.totalBytes) : "…"}</dd></div>
            {freeBytes !== null && <div><dt>Free space</dt><dd>{formatMegabytes(freeBytes)}</dd></div>}
          </dl>
        </section>

        <section className="account-card card account-section" aria-label="Download settings">
          <label className="account-setting account-setting--row">
            <span className="account-setting__icon" aria-hidden="true"><Icon name="download" size={20} /></span>
            <span className="account-setting__text">
              <strong>Allow downloads on mobile data</strong>
              <span>{mobileData ? "Map squares and the area around you download on any connection" : "Map squares and the area around you wait for Wi-Fi"}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="account-switch"
              checked={mobileData}
              onChange={(event) => writeAllowMobileMapData(event.target.checked)}
              aria-label="Allow downloads on mobile data"
            />
          </label>
        </section>

        <section className="account-card card account-section" aria-labelledby="downloads-squares">
          <span className="eyebrow" id="downloads-squares">Map squares</span>
          <p className="account-help">
            {saved.length
              ? `${saved.length} ${saved.length === 1 ? "square" : "squares"} kept offline · ${formatMegabytes(savedBytes)}`
              : "Choose 50 km squares to keep their full map detail offline."}
          </p>
          {rows.length > 0 && (
            <ul className="downloads-list">
              {rows.map((row) => (
                <li key={row.key}>
                  <span className="downloads-list__text">
                    <strong>{row.name}</strong>
                    <span>{formatMegabytes(row.bytes)} · {row.parks} {row.parks === 1 ? "park" : "parks"}</span>
                  </span>
                  <button className="btn btn--paper btn--sm" disabled={!!busy} onClick={() => void removeSquare(row.key)}>
                    {busy === row.key ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className="btn btn--block"
            onClick={() => {
              requestDownloadMaps("downloads");
              dispatch({ type: "go", screen: "map" });
            }}
          >
            <Icon name="map" size={18} /> {saved.length ? "Add or remove squares" : "Choose squares on the map"}
          </button>
        </section>

        <section className="account-card card account-section" aria-labelledby="downloads-cached">
          <span className="eyebrow" id="downloads-cached">Cached automatically</span>
          <ul className="downloads-list">
            <li>
              <span className="downloads-list__text">
                <strong>Map detail around you and where you browsed</strong>
                <span>{summary ? formatMegabytes(summary.mapCacheBytes) : "…"} · downloads again when needed</span>
              </span>
              <button className="btn btn--paper btn--sm" disabled={!!busy || !summary?.mapCacheBytes} onClick={() => void clearMapCache()}>
                {busy === "cache" ? "Clearing…" : "Clear"}
              </button>
            </li>
            <li>
              <span className="downloads-list__text">
                <strong>Park guides and badge art</strong>
                <span>{summary ? formatMegabytes(summary.parkContentBytes) : "…"} · needed to show parks offline</span>
              </span>
            </li>
            <li>
              <span className="downloads-list__text">
                <strong>Map labels</strong>
                <span>{summary ? formatMegabytes(summary.mapSupportBytes) : "…"} · needed for place names</span>
              </span>
            </li>
            {!!summary?.unusedBytes && (
              <li>
                <span className="downloads-list__text">
                  <strong>Old content no longer used</strong>
                  <span>{formatMegabytes(summary.unusedBytes)} · from earlier maps and updates</span>
                </span>
                <button className="btn btn--paper btn--sm" disabled={!!busy} onClick={() => void clearUnused()}>
                  {busy === "unused" ? "Clearing…" : "Clear"}
                </button>
              </li>
            )}
          </ul>
          <p className="account-help">Your claimed badges and photos are never removed here.</p>
        </section>
      </div>
    </motion.main>
  );
}
