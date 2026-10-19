import type { FeedbackReport } from "./feedbackReport";

const DB_NAME = "parkdex-feedback";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
const DRAFT_KEY = "current";

export const MAX_FEEDBACK_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_SELECTED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type SavedFeedbackScreenshot = { blob: Blob; name: string; generation: string };
export type FeedbackSubmissionAttempt = { id: string; report: FeedbackReport };

type StoredSubmissionAttempt = FeedbackSubmissionAttempt & { fingerprint: string; generation: string };
type FeedbackLocalState = {
  screenshot?: SavedFeedbackScreenshot;
  attempt?: StoredSubmissionAttempt;
};

export type FeedbackScreenshotErrorCode = "unsupported" | "too-large" | "empty" | "unreadable" | "compression";

export class FeedbackScreenshotError extends Error {
  constructor(readonly code: FeedbackScreenshotErrorCode) {
    super(code);
    this.name = "FeedbackScreenshotError";
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open feedback storage"));
  });
}

async function readState(): Promise<FeedbackLocalState> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(DRAFT_KEY);
      request.onsuccess = () => resolve((request.result as FeedbackLocalState | undefined) ?? {});
      request.onerror = () => reject(request.error ?? tx.error ?? new Error("Couldn't read feedback storage"));
      tx.onabort = () => reject(tx.error ?? new Error("Couldn't read feedback storage"));
    });
  } finally {
    db.close();
  }
}

async function updateState(update: (state: FeedbackLocalState) => FeedbackLocalState | null): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(DRAFT_KEY);
      request.onsuccess = () => {
        try {
          const next = update((request.result as FeedbackLocalState | undefined) ?? {});
          if (next) store.put(next, DRAFT_KEY);
          else store.delete(DRAFT_KEY);
        } catch {
          tx.abort();
        }
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Couldn't save feedback storage"));
      tx.onabort = () => reject(tx.error ?? new Error("Couldn't save feedback storage"));
    });
  } finally {
    db.close();
  }
}

export function createFeedbackDraftGeneration(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export async function loadFeedbackScreenshot(generation: string): Promise<SavedFeedbackScreenshot | null> {
  const screenshot = (await readState()).screenshot;
  return screenshot?.generation === generation ? screenshot : null;
}

export async function saveFeedbackScreenshot(screenshot: SavedFeedbackScreenshot): Promise<void> {
  await updateState(() => ({ screenshot, attempt: undefined }));
}

export async function clearFeedbackScreenshot(generation: string): Promise<void> {
  await updateState((state) => ({
    ...(state.screenshot?.generation === generation ? {} : state.screenshot ? { screenshot: state.screenshot } : {}),
    ...(state.attempt?.generation === generation ? {} : state.attempt ? { attempt: state.attempt } : {}),
  }));
}

export async function clearFeedbackLocalDraft(): Promise<void> {
  await updateState(() => null);
}

export async function resetFeedbackSubmissionAttempt(generation: string): Promise<void> {
  await updateState((state) => ({
    ...(state.screenshot ? { screenshot: state.screenshot } : {}),
    ...(state.attempt?.generation === generation ? {} : state.attempt ? { attempt: state.attempt } : {}),
  }));
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

async function fingerprintPayload(report: FeedbackReport): Promise<string> {
  // Context stays anchored to the first attempt. These are the fields an edit changes.
  const text = JSON.stringify({
    kind: report.kind,
    message: report.message,
    contact: report.contact,
    email: report.email,
    screenshot: report.screenshot,
  });
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  // Older WebViews can lack SubtleCrypto; keep a deterministic 64-bit fingerprint there.
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function matchesAttempt(attempt: StoredSubmissionAttempt | undefined, fingerprint: string, generation: string) {
  return attempt?.generation === generation && attempt.fingerprint === fingerprint;
}

export async function loadFeedbackSubmissionAttempt(report: FeedbackReport, generation: string): Promise<FeedbackSubmissionAttempt | null> {
  const fingerprint = await fingerprintPayload(report);
  const attempt = (await readState()).attempt;
  return matchesAttempt(attempt, fingerprint, generation) ? { id: attempt!.id, report: attempt!.report } : null;
}

export async function getFeedbackSubmissionAttempt(report: FeedbackReport, generation: string): Promise<FeedbackSubmissionAttempt> {
  const fingerprint = await fingerprintPayload(report);
  const state = await readState();
  if (matchesAttempt(state.attempt, fingerprint, generation)) {
    return { id: state.attempt!.id, report: state.attempt!.report };
  }

  const attempt: StoredSubmissionAttempt = { id: makeUuid(), report, fingerprint, generation };
  await updateState((current) => ({
    ...(current.screenshot?.generation === generation ? { screenshot: current.screenshot } : {}),
    attempt,
  }));
  return { id: attempt.id, report: attempt.report };
}

type ImageDimensions = { width: number; height: number; orientation: number };

function exifOrientation(bytes: Uint8Array, start: number, length: number): number {
  const hasExifPrefix = length >= 6 && String.fromCharCode(...bytes.subarray(start, start + 6)) === "Exif\0\0";
  const tiff = start + (hasExifPrefix ? 6 : 0);
  if (length < (hasExifPrefix ? 20 : 14) || tiff + 8 > start + length) return 1;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > start + length) return 1;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > start + length) return 1;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const type = view.getUint16(entry + 2, little);
    const values = view.getUint32(entry + 4, little);
    if (type !== 3 || values !== 1) return 1;
    const orientation = view.getUint16(entry + 8, little);
    return orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  let orientation = 1;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) break;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "eXIf") orientation = exifOrientation(bytes, dataStart, length);
    if (type === "IDAT") break;
    offset += 12 + length;
  }
  return width && height ? { width, height, orientation } : null;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let width = 0;
  let height = 0;
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
    const length = view.getUint16(offset, false);
    const dataStart = offset + 2;
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xe1) orientation = exifOrientation(bytes, dataStart, length - 2);
    if (startOfFrame.has(marker) && length >= 7) {
      height = view.getUint16(dataStart + 1, false);
      width = view.getUint16(dataStart + 3, false);
      if (!width || !height) {
        width = 0;
        height = 0;
      }
    }
    offset += length;
  }
  return width && height ? { width, height, orientation } : null;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let orientation = 1;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > bytes.length) break;
    if (kind === "EXIF") orientation = exifOrientation(bytes, data, length);
    if (kind === "VP8X" && length >= 10) {
      width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
      height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
    } else if (kind === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      width = (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff;
      height = (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff;
    } else if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      width = 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8);
      height = 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10);
    }
    offset += 8 + length + (length % 2);
  }
  return width && height ? { width, height, orientation } : null;
}

async function readImageDimensions(file: File, type: string): Promise<ImageDimensions> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new FeedbackScreenshotError("unreadable");
  }
  const dimensions = type === "image/png" ? readPngDimensions(bytes) : type === "image/jpeg" ? readJpegDimensions(bytes) : readWebpDimensions(bytes);
  if (!dimensions) throw new FeedbackScreenshotError("unreadable");
  return dimensions;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function drawOrientedImage(context: CanvasRenderingContext2D, bitmap: ImageBitmap, width: number, height: number, scale: number, orientation: number) {
  const w = width * scale;
  const h = height * scale;
  switch (orientation) {
    case 2:
      context.setTransform(-scale, 0, 0, scale, w, 0);
      break;
    case 3:
      context.setTransform(-scale, 0, 0, -scale, w, h);
      break;
    case 4:
      context.setTransform(scale, 0, 0, -scale, 0, h);
      break;
    case 5:
      context.setTransform(0, scale, scale, 0, 0, 0);
      break;
    case 6:
      context.setTransform(0, scale, -scale, 0, h, 0);
      break;
    case 7:
      context.setTransform(0, -scale, -scale, 0, h, w);
      break;
    case 8:
      context.setTransform(0, -scale, scale, 0, 0, w);
      break;
    default:
      context.setTransform(scale, 0, 0, scale, 0, 0);
  }
  context.drawImage(bitmap, 0, 0);
}

export async function prepareFeedbackScreenshot(file: File): Promise<Blob> {
  const type = file.type.toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new FeedbackScreenshotError("unsupported");
  if (file.size === 0) throw new FeedbackScreenshotError("empty");
  if (file.size > MAX_SELECTED_IMAGE_BYTES) throw new FeedbackScreenshotError("too-large");
  if (typeof createImageBitmap !== "function") throw new FeedbackScreenshotError("unreadable");

  const metadata = await readImageDimensions(file, type);
  const sourceScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(metadata.width, metadata.height));
  const targetWidth = Math.max(1, Math.round(metadata.width * sourceScale));
  const targetHeight = Math.max(1, Math.round(metadata.height * sourceScale));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: "none",
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: "high",
    });
  } catch {
    throw new FeedbackScreenshotError("unreadable");
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context || bitmap.width < 1 || bitmap.height < 1) throw new FeedbackScreenshotError("unreadable");
    const swapsDimensions = metadata.orientation >= 5 && metadata.orientation <= 8;
    let scale = 1;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const rawWidth = Math.max(1, Math.round(bitmap.width * scale));
      const rawHeight = Math.max(1, Math.round(bitmap.height * scale));
      canvas.width = swapsDimensions ? rawHeight : rawWidth;
      canvas.height = swapsDimensions ? rawWidth : rawHeight;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawOrientedImage(context, bitmap, bitmap.width, bitmap.height, scale, metadata.orientation);

      for (const quality of [0.84, 0.7, 0.56, 0.42]) {
        const webp = await canvasBlob(canvas, "image/webp", quality);
        if (webp && IMAGE_TYPES.has(webp.type) && webp.size <= MAX_FEEDBACK_IMAGE_BYTES) return webp;
      }

      if (type === "image/jpeg") {
        for (const quality of [0.82, 0.68, 0.54, 0.4]) {
          const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
          if (jpeg && jpeg.type === "image/jpeg" && jpeg.size <= MAX_FEEDBACK_IMAGE_BYTES) return jpeg;
        }
      }
      scale *= 0.78;
    }
    throw new FeedbackScreenshotError("compression");
  } finally {
    bitmap.close();
  }
}

export function feedbackScreenshotErrorMessage(error: unknown): string {
  if (!(error instanceof FeedbackScreenshotError)) return "Couldn't store the screenshot in device storage. Check available space and try again.";
  switch (error.code) {
    case "unsupported":
      return "Choose a PNG, JPEG or WebP image.";
    case "too-large":
      return "That image is larger than 8 MiB. Choose a smaller screenshot.";
    case "empty":
      return "That image is empty. Choose another screenshot.";
    case "unreadable":
      return "Couldn't open that image. Choose another PNG, JPEG or WebP screenshot.";
    case "compression":
      return "That image couldn't be reduced to 2 MiB. Choose a smaller screenshot.";
  }
}

export function feedbackScreenshotUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function feedbackScreenshotDataUrl(blob: Blob): Promise<string> {
  if (!IMAGE_TYPES.has(blob.type.toLowerCase())) return Promise.reject(new FeedbackScreenshotError("unsupported"));
  if (blob.size > MAX_FEEDBACK_IMAGE_BYTES) return Promise.reject(new FeedbackScreenshotError("compression"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new FeedbackScreenshotError("unreadable"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.toLowerCase().startsWith(`data:${blob.type.toLowerCase()};base64,`)) {
        reject(new FeedbackScreenshotError("unreadable"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}
