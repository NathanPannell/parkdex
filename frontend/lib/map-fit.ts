export type LayoutRect = { top: number; right: number; bottom: number; left: number; width: number; height: number };
export type CameraPadding = { top: number; right: number; bottom: number; left: number };

export const VANCOUVER_ISLAND_OVERVIEW_BOUNDS: [[number, number], [number, number]] = [
  [-128.52, 48.25],
  [-123.0, 50.92],
];

export function overviewPadding(viewportWidth: number): CameraPadding {
  return viewportWidth < 640
    ? { top: 156, right: 12, bottom: 112, left: 12 }
    : { top: 180, right: 32, bottom: 96, left: 32 };
}

export function cameraPaddingForOverlays(
  map: LayoutRect,
  overlays: LayoutRect[],
  base: CameraPadding = { top: 28, right: 24, bottom: 32, left: 24 },
): CameraPadding {
  const padding = { ...base };
  const mapMidX = map.left + map.width / 2;
  const mapMidY = map.top + map.height / 2;

  overlays.forEach((overlay) => {
    const overlapWidth = Math.max(0, Math.min(map.right, overlay.right) - Math.max(map.left, overlay.left));
    const overlapHeight = Math.max(0, Math.min(map.bottom, overlay.bottom) - Math.max(map.top, overlay.top));
    if (!overlapWidth || !overlapHeight) return;

    const overlayMidX = (Math.max(map.left, overlay.left) + Math.min(map.right, overlay.right)) / 2;
    const overlayMidY = (Math.max(map.top, overlay.top) + Math.min(map.bottom, overlay.bottom)) / 2;
    if (overlapWidth / map.width >= 0.72) {
      if (overlayMidY <= mapMidY) padding.top = Math.max(padding.top, Math.min(map.height - 96, overlay.bottom - map.top + 12));
      else padding.bottom = Math.max(padding.bottom, Math.min(map.height - 96, map.bottom - overlay.top + 18));
      return;
    }

    if (overlapHeight / map.height >= 0.28) {
      if (overlayMidX <= mapMidX) padding.left = Math.max(padding.left, Math.min(map.width - 96, overlay.right - map.left + 18));
      else padding.right = Math.max(padding.right, Math.min(map.width - 96, map.right - overlay.left + 18));
    }
  });

  const constrainPair = (start: number, end: number, size: number, startFloor: number, endFloor: number) => {
    const available = Math.max(0, size - 96);
    if (start + end <= available) return [start, end] as const;
    const floorTotal = startFloor + endFloor;
    if (available <= floorTotal) {
      const scale = floorTotal ? available / floorTotal : 0;
      return [startFloor * scale, endFloor * scale] as const;
    }
    const startExtra = Math.max(0, start - startFloor);
    const endExtra = Math.max(0, end - endFloor);
    const extraTotal = startExtra + endExtra;
    const extraScale = extraTotal ? (available - floorTotal) / extraTotal : 0;
    return [startFloor + startExtra * extraScale, endFloor + endExtra * extraScale] as const;
  };
  [padding.left, padding.right] = constrainPair(padding.left, padding.right, map.width, base.left, base.right);
  [padding.top, padding.bottom] = constrainPair(padding.top, padding.bottom, map.height, base.top, base.bottom);

  return padding;
}

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
