export type BoundarySourceKey = "canonical" | "display";
export type BoundarySourceSignal = "ready" | "failed";
export type BoundarySourceStatus = "loading" | "ready" | "failed";
export type BoundarySourceReadiness = Record<BoundarySourceKey, BoundarySourceStatus>;

export function initialBoundarySourceReadiness(): BoundarySourceReadiness {
  return { canonical: "loading", display: "loading" };
}

export function settleBoundarySourceReadiness(
  current: BoundarySourceReadiness,
  source: BoundarySourceKey,
  signal: BoundarySourceSignal,
): { sources: BoundarySourceReadiness; status: BoundarySourceStatus } {
  const sources = current[source] === "loading" ? { ...current, [source]: signal } : current;
  const values = Object.values(sources);
  const status = values.includes("failed") ? "failed" : values.every((value) => value === "ready") ? "ready" : "loading";
  return { sources, status };
}

