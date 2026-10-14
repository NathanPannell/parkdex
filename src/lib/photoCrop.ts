/**
 * The manual photo crop (#173). A crop is a rectangle normalised to 0–1 against the upright
 * original photo: `x` and `width` are fractions of its width, `y` and `height` of its height.
 * The original is kept as taken and the crop is stored beside it, so re-cropping later (#174)
 * changes only the rectangle. Every crop has a fixed shape in pixels, its aspect (width over
 * height): the Dex polaroid's 3:4 by default, or the park sheet's 16:9 for a founder's cover.
 */

export type PhotoCrop = { x: number; y: number; width: number; height: number };

/** Width over height, in pixels: the polaroid shape used in the Dex. */
export const CROP_ASPECT = 3 / 4;
/**
 * Width over height of a park's public cover as the park sheet shows it. The founder crops their
 * photo to this shape, so what they frame is what everyone sees. Older 3:4 covers stay valid and
 * are drawn with `object-fit: cover`.
 */
export const PARK_COVER_ASPECT = 16 / 9;
/** The crop can zoom in at most this far from the largest fit. */
export const MAX_CROP_ZOOM = 4;
/**
 * A crop's short edge never gets below this many pixels of the original, so a cover is never a
 * smudge. For a 3:4 crop that is its width; for a 16:9 crop, its height.
 */
export const MIN_CROP_EDGE_PX = 450;

const EPSILON = 1e-6;

function checkSize(width: number, height: number) {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("The photo has no size.");
}

function checkAspect(aspect: number) {
  if (!(aspect > 0) || !Number.isFinite(aspect)) throw new Error("The crop has no shape.");
}

/** The width of a crop of this aspect, as a fraction of the photo's width, for a crop `height` fraction tall. */
function widthFor(height: number, imageWidth: number, imageHeight: number, aspect: number): number {
  return (height * imageHeight * aspect) / imageWidth;
}

/** The largest crop of this aspect that fits the photo, centred. This is where every crop starts. */
export function largestCrop(imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): PhotoCrop {
  checkSize(imageWidth, imageHeight);
  checkAspect(aspect);
  const tall = widthFor(1, imageWidth, imageHeight, aspect);
  // Photo wider than the crop: full height, trimmed sides. Taller: full width, trimmed top and bottom.
  const width = Math.min(1, tall);
  const height = tall > 1 ? 1 / tall : 1;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/** How far in the crop may zoom for this photo: at least 1 (no zoom), at most MAX_CROP_ZOOM. */
export function maxCropZoom(imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): number {
  const largest = largestCrop(imageWidth, imageHeight, aspect);
  const shortEdge = Math.min(largest.width * imageWidth, largest.height * imageHeight);
  return Math.min(MAX_CROP_ZOOM, Math.max(1, shortEdge / MIN_CROP_EDGE_PX));
}

/** The crop's zoom: 1 at the largest fit, larger when zoomed in. */
export function cropZoom(crop: PhotoCrop, imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): number {
  return largestCrop(imageWidth, imageHeight, aspect).width / crop.width;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Makes any rectangle a valid crop for this photo: `aspect` in pixels, within the zoom limits, and
 * inside the photo. A rectangle that is not a number at all becomes the largest fit.
 */
export function clampCrop(crop: PhotoCrop, imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): PhotoCrop {
  const largest = largestCrop(imageWidth, imageHeight, aspect);
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || !(crop.width > 0) || !(crop.height > 0)) return largest;
  const zoom = clamp(largest.width / crop.width, 1, maxCropZoom(imageWidth, imageHeight, aspect));
  const width = largest.width / zoom;
  const height = largest.height / zoom;
  // Keep the centre where it was, then push the rectangle back inside the photo.
  const centreX = crop.x + crop.width / 2;
  const centreY = crop.y + crop.height / 2;
  return {
    x: clamp(centreX - width / 2, 0, 1 - width),
    y: clamp(centreY - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/**
 * Zooms by `factor` (above 1 zooms in) around `focus`, a point in the crop frame given as 0–1 of
 * its width and height, so the part of the photo under the fingers stays under them.
 */
export function zoomCrop(crop: PhotoCrop, factor: number, focus: { x: number; y: number }, imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): PhotoCrop {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampCrop(crop, imageWidth, imageHeight, aspect);
  const pointX = crop.x + focus.x * crop.width;
  const pointY = crop.y + focus.y * crop.height;
  const largest = largestCrop(imageWidth, imageHeight, aspect);
  const zoom = clamp(cropZoom(crop, imageWidth, imageHeight, aspect) * factor, 1, maxCropZoom(imageWidth, imageHeight, aspect));
  const width = largest.width / zoom;
  const height = largest.height / zoom;
  return clampCrop({ x: pointX - focus.x * width, y: pointY - focus.y * height, width, height }, imageWidth, imageHeight, aspect);
}

/**
 * Moves the photo under the frame by `dx` and `dy`, in frame widths and heights: dragging right
 * by half the frame shows what was to the left of it.
 */
export function panCrop(crop: PhotoCrop, dx: number, dy: number, imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): PhotoCrop {
  return clampCrop({ ...crop, x: crop.x - dx * crop.width, y: crop.y - dy * crop.height }, imageWidth, imageHeight, aspect);
}

/** The crop in whole source pixels, inside the photo and as close to `aspect` as whole pixels allow. */
export function cropPixels(crop: PhotoCrop, imageWidth: number, imageHeight: number, aspect = CROP_ASPECT): { sx: number; sy: number; sw: number; sh: number } {
  const valid = clampCrop(crop, imageWidth, imageHeight, aspect);
  const sh = clamp(Math.round(valid.height * imageHeight), 1, imageHeight);
  const sw = clamp(Math.round(sh * aspect), 1, imageWidth);
  return {
    sx: clamp(Math.round(valid.x * imageWidth), 0, imageWidth - sw),
    sy: clamp(Math.round(valid.y * imageHeight), 0, imageHeight - sh),
    sw,
    sh,
  };
}

/** Room left around the crop frame inside the cropper's stage, in CSS pixels. */
export const CROP_STAGE_GUTTER = 28;

/**
 * The cropper's frame on screen: the largest box of this shape that fits the stage inside its
 * gutter. A 16:9 frame on an upright phone fills the width; a 3:4 one is usually held by the height.
 */
export function cropFrameSize(stageWidth: number, stageHeight: number, aspect = CROP_ASPECT): { width: number; height: number } {
  checkAspect(aspect);
  const width = Math.max(120, Math.min(stageWidth - CROP_STAGE_GUTTER * 2, (stageHeight - CROP_STAGE_GUTTER * 2) * aspect));
  return { width, height: width / aspect };
}

/** True for a stored crop that can be shown: finite, inside 0–1 and not empty. Shape is not checked. */
export function isPhotoCrop(value: unknown): value is PhotoCrop {
  if (!value || typeof value !== "object") return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) return false;
  const crop = value as PhotoCrop;
  return crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 &&
    crop.x + crop.width <= 1 + EPSILON && crop.y + crop.height <= 1 + EPSILON;
}

/** Rounds a crop for storage: six decimals is well under a pixel on any photo we keep. */
export function roundCrop(crop: PhotoCrop): PhotoCrop {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return { x: round(crop.x), y: round(crop.y), width: round(crop.width), height: round(crop.height) };
}

/**
 * Shows a crop without re-encoding: put the original in an `<img>` with this style inside a
 * `position: relative; overflow: hidden` box of the crop's shape.
 */
export function cropImageStyle(crop: PhotoCrop): { position: "absolute"; left: string; top: string; width: string; height: string; maxWidth: "none" } {
  const percent = (value: number) => `${Math.round(value * 1e4) / 1e2}%`;
  return {
    position: "absolute",
    left: percent(-crop.x / crop.width),
    top: percent(-crop.y / crop.height),
    width: percent(1 / crop.width),
    height: percent(1 / crop.height),
    maxWidth: "none",
  };
}
