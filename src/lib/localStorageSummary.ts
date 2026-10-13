import { mapChunkIndex, type ContentRuntime } from "./content/contracts";
import { chunkIdsForCells, loadCellIndex, readSavedSquares } from "./mapCells";

/** What Parkdex keeps on this device, grouped the way Manage downloads shows it. */
export type LocalStorageSummary = {
  totalBytes: number;
  /** Detail inside the map squares the visitor chose to keep. */
  savedSquaresBytes: number;
  /** Other detailed map pieces: the area around the visitor and detail streamed while browsing. */
  mapCacheBytes: number;
  mapCacheChunks: number[];
  /** Map labels and map indexes. */
  mapSupportBytes: number;
  /** Park guides and badge art the app needs to show parks offline. */
  parkContentBytes: number;
  /** Files from earlier content or maps that nothing uses any more. */
  unusedBytes: number;
};

export async function summarizeLocalStorage(runtime: ContentRuntime): Promise<LocalStorageSummary> {
  const files = (await runtime.listStoredFiles?.()) ?? [];
  const index = await loadCellIndex().catch(() => null);
  const saved = index ? chunkIdsForCells(index, readSavedSquares()) : new Set<number>();
  const summary: LocalStorageSummary = {
    totalBytes: 0, savedSquaresBytes: 0, mapCacheBytes: 0, mapCacheChunks: [], mapSupportBytes: 0, parkContentBytes: 0, unusedBytes: 0,
  };
  for (const file of files) {
    summary.totalBytes += file.size;
    if (file.path === null) {
      summary.unusedBytes += file.size;
      continue;
    }
    const id = mapChunkIndex(file.path);
    if (id !== null) {
      if (saved.has(id)) summary.savedSquaresBytes += file.size;
      else {
        summary.mapCacheBytes += file.size;
        summary.mapCacheChunks.push(id);
      }
    } else if (file.path.startsWith("map/")) {
      summary.mapSupportBytes += file.size;
    } else {
      summary.parkContentBytes += file.size;
    }
  }
  summary.mapCacheChunks.sort((a, b) => a - b);
  return summary;
}
