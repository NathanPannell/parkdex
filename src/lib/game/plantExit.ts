import type { Action } from "../store";

/** Where the plant screen is in its run. */
export type PlantPhase = "charge" | "sending" | "playing" | "done" | "failed";

/**
 * The player can back out of the plant screen any time except while the visit is in
 * flight or its result is playing: leaving then would hide an outcome the server has
 * already recorded.
 */
export function canLeavePlant(phase: PlantPhase): boolean {
  return phase === "charge" || phase === "failed" || phase === "done";
}

// The Android back handler lives in App, so the open plant screen reports its phase here.
let openPhase: PlantPhase | null = null;

export function reportPlantPhase(phase: PlantPhase | null): void {
  openPhase = phase;
}

/** Whether the hardware back button may leave the plant screen right now. */
export function backCanLeavePlant(): boolean {
  return openPhase === null || canLeavePlant(openPhase);
}

/** Leaving ends the trip; back on the map, the park's sheet opens so the player sees where they were. */
export function leavePlant(parkId: string | null, to: "map" | "parks" = "map"): Action[] {
  const actions: Action[] = [{ type: "trip", id: null }];
  if (to === "map" && parkId) actions.push({ type: "focus", id: parkId });
  actions.push({ type: "go", screen: to });
  return actions;
}
