import type { Park } from "./parks";

type ClaimDisplaySnapshot = {
  parkSnapshot: Park | null;
  contentReleaseId: string | null;
};

export function resolveEarnedParkDisplay(
  park: Park,
  claim: ClaimDisplaySnapshot,
  currentPark: Park | undefined,
  currentSceneReady: boolean,
): { park: Park; usesCurrentArt: boolean } {
  const frozenPark = claim.parkSnapshot ?? park;
  if (!currentPark) return { park: frozenPark, usesCurrentArt: false };

  if (currentPark.scene && currentSceneReady) {
    return { park: currentPark, usesCurrentArt: true };
  }

  // Current labels and rarity follow the catalogue. The archived snapshot remains
  // the art fallback until current artwork has a verified local asset URL.
  return {
    park: {
      ...frozenPark,
      name: currentPark.name,
      short: currentPark.short,
      rarity: currentPark.rarity,
      scene: claim.parkSnapshot?.scene ?? null,
    },
    usesCurrentArt: false,
  };
}
