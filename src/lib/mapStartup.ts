import { prewarm, setWorkerUrl, type ErrorEvent, type Map as MapLibreMap } from "maplibre-gl";
import { prewarmBundledOverview } from "./offlineTiles";

const MAPLIBRE_WORKER_PATH = "/maplibre/maplibre-gl-worker.mjs";
const OVERVIEW_SOURCE_ID = "islandOverview";
const OVERVIEW_READY_TIMEOUT_MS = 8_000;

let workerConfigured = false;
let workersPrewarmed = false;

/** Configure the same app-local worker URL before either prewarm or map creation. */
export function configureMapLibreWorker(): boolean {
  if (workerConfigured) return true;
  try {
    setWorkerUrl(`${location.origin}${MAPLIBRE_WORKER_PATH}`);
    workerConfigured = true;
    return true;
  } catch {
    // Keep app startup available if the optional worker warmup cannot be configured.
    return false;
  }
}

/** Warm local map resources without delaying app rendering or adding API traffic. */
export function prewarmMapStartup(): void {
  if (configureMapLibreWorker() && !workersPrewarmed) {
    try {
      prewarm();
      workersPrewarmed = true;
    } catch {
      // The first map can still initialize its own workers if prewarming fails.
    }
  }
  void prewarmBundledOverview().catch(() => {});
}

/**
 * Let pins mount after the overview has rendered, or after a bounded fallback
 * if the local archive cannot be read. Detailed-source errors do not open the gate.
 */
export function watchBundledOverviewReadiness(
  map: Pick<MapLibreMap, "isSourceLoaded" | "on" | "off">,
  onReady: () => void,
  timeoutMs = OVERVIEW_READY_TIMEOUT_MS,
): () => void {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const removeListeners = () => {
    map.off("render", checkRenderedOverview);
    map.off("error", handleSourceError);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timeout !== null) clearTimeout(timeout);
    removeListeners();
    onReady();
  };
  const checkRenderedOverview = () => {
    if (map.isSourceLoaded(OVERVIEW_SOURCE_ID)) finish();
  };
  const handleSourceError = (event: ErrorEvent) => {
    if ((event as ErrorEvent & { sourceId?: string }).sourceId === OVERVIEW_SOURCE_ID) finish();
  };

  timeout = setTimeout(finish, timeoutMs);
  map.on("render", checkRenderedOverview);
  map.on("error", handleSourceError);

  return () => {
    if (settled) return;
    settled = true;
    if (timeout !== null) clearTimeout(timeout);
    removeListeners();
  };
}
