export type LayoutRect = { top: number; right: number; bottom: number; left: number; width: number; height: number };
export type CameraPadding = { top: number; right: number; bottom: number; left: number };

export function hasUsableCameraViewport(
  map: Pick<LayoutRect, "width" | "height">,
  padding: CameraPadding,
  minimumVisibleSize = 64,
) {
  return map.width - padding.left - padding.right >= minimumVisibleSize
    && map.height - padding.top - padding.bottom >= minimumVisibleSize;
}

export function selectedPlacePadding(
  map: LayoutRect,
  sheet: LayoutRect | null,
  overlayBottom: number,
): CameraPadding {
  const padding: CameraPadding = {
    top: Math.max(28, overlayBottom - map.top + 12),
    right: 32,
    bottom: 96,
    left: 32,
  };
  if (!sheet) return padding;

  const overlapWidth = Math.max(0, Math.min(map.right, sheet.right) - Math.max(map.left, sheet.left));
  if (overlapWidth / map.width >= 0.72) {
    const desiredBottom = Math.max(padding.bottom, map.bottom - sheet.top + 18);
    padding.bottom = Math.min(desiredBottom, Math.max(96, map.height - padding.top - 96));
    return padding;
  }

  const spaceBefore = Math.max(0, sheet.left - map.left);
  const spaceAfter = Math.max(0, map.right - sheet.right);
  if (spaceBefore <= spaceAfter) padding.left = Math.min(Math.max(padding.left, sheet.right - map.left + 18), map.width - padding.right - 120);
  else padding.right = Math.min(Math.max(padding.right, map.right - sheet.left + 18), map.width - padding.left - 120);
  padding.bottom = 32;
  return padding;
}
