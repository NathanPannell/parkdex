import { prewarm, setWorkerUrl } from "maplibre-gl";
import { prewarmBundledOverview } from "./offlineTiles";

const MAPLIBRE_WORKER_PATH = "/maplibre/maplibre-gl-worker.mjs";

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
