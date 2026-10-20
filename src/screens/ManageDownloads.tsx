import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useContent, useContentRuntime } from "../lib/content/provider";
import { bytesForChunks, chunkIdsForCells, formatMegabytes, loadCellIndex, readSavedSquares, requestDownloadMaps, type CellIndex } from "../lib/mapCells";
import { summarizeLocalStorage, type LocalStorageSummary } from "../lib/localStorageSummary";
import { readAllowMobileMapData, subscribeAllowMobileMapData, writeAllowMobileMapData } from "../lib/downloadPreferences";
import { mapFolder, OFFLINE_DOWNLOADS } from "../lib/content/contracts";
import { mapChunkPath } from "../lib/offlineTiles";
import { useStore } from "../lib/store";
import "../download-maps.css";

/**
 * Everything Parkdex keeps on this phone. For now Parkdex needs the internet and caches only
 * what is near the player; the map squares card and the mobile data switch return with
 * offline downloads (#199, OFFLINE_DOWNLOADS).
 */
export function ManageDownloads() {
  const { dispatch } = useStore();
  const content = useContent();
  const runtime = useContentRuntime();
  const [index, setIndex] = useState<CellIndex | null>(null);
  const [saved] = useState<string[]>(() => readSavedSquares());
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

  const releaseId = content?.releaseId;

  async function clearMapCache() {
    if (!summary || !releaseId || busy) return;
    setBusy("cache");
    setError(null);
    try {
      const folder = mapFolder(content?.manifest.files ?? []);
      for (const id of summary.mapCacheChunks) await runtime.deleteMapChunk?.(releaseId, mapChunkPath(id, folder));
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
        {error && (
          <section className="account-notice card is-error" role="alert">
            <span>{error}</span>
          </section>
        )}

        <section className="account-card card account-section" aria-labelledby="downloads-total">
          <span className="eyebrow" id="downloads-total">
            On this phone
          </span>
          <dl className="downloads-stats">
            <div>
              <dt>Parkdex is using</dt>
              <dd>{summary ? formatMegabytes(summary.totalBytes) : "…"}</dd>
            </div>
            {freeBytes !== null && (
              <div>
                <dt>Free space</dt>
                <dd>{formatMegabytes(freeBytes)}</dd>
              </div>
            )}
          </dl>
        </section>

        {OFFLINE_DOWNLOADS && (
          <section className="account-card card account-section" aria-label="Download settings">
            <label className="account-setting account-setting--row">
              <span className="account-setting__icon" aria-hidden="true">
                <Icon name="download" size={20} />
              </span>
              <span className="account-setting__text">
                <strong>Allow downloads on mobile data</strong>
                <span>
                  {mobileData ? "Map squares and the area around you download on any connection" : "Map squares and the area around you wait for Wi-Fi"}
                </span>
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
        )}

        {OFFLINE_DOWNLOADS && (
          <section className="account-card card account-section" aria-labelledby="downloads-squares">
            <span className="eyebrow" id="downloads-squares">
              Map squares
            </span>
            <p className="account-help">
              {saved.length
                ? `${saved.length} ${saved.length === 1 ? "square" : "squares"} offline · ${formatMegabytes(savedBytes)}`
                : "Choose 50 km squares to keep their full map detail offline."}
            </p>
            <button
              className="btn btn--block"
              onClick={() => {
                requestDownloadMaps("downloads");
                dispatch({ type: "go", screen: "map" });
              }}
            >
              <Icon name="map" size={18} /> {saved.length ? "Add or remove squares" : "Choose map squares"}
            </button>
          </section>
        )}

        <section className="account-card card account-section" aria-labelledby="downloads-cached">
          <span className="eyebrow" id="downloads-cached">
            Cached automatically
          </span>
          <ul className="downloads-list">
            <li>
              <span className="downloads-list__text">
                <strong>Map detail around you</strong>
                <span>{summary ? formatMegabytes(summary.mapCacheBytes) : "…"} · downloads again when needed</span>
              </span>
              <button className="btn btn--paper btn--sm" disabled={!!busy || !summary?.mapCacheBytes} onClick={() => void clearMapCache()}>
                {busy === "cache" ? "Clearing…" : "Clear"}
              </button>
            </li>
            <li>
              <span className="downloads-list__text">
                <strong>Park guides around you</strong>
                <span>{summary ? formatMegabytes(summary.parkContentBytes) : "…"} · other parks load when you look at them</span>
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
          <p className="account-help">
            Parkdex keeps only what is near you and clears old content after updates. Your visits and photos are never removed here.
          </p>
        </section>
      </div>
    </motion.main>
  );
}
