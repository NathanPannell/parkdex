import type { PhotoAsset } from "./native-capabilities";

export const VISIT_PHOTO_MAX_EDGE = 1_600;
export const VISIT_PHOTO_MAX_BYTES = 900_000;

const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52] as const;
const SCALE_STEPS = [1, 0.82, 0.67] as const;

export type DecodedVisitPhoto = {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?: () => void;
};

export type VisitPhotoProcessingPrimitives = {
  decode(file: File): Promise<DecodedVisitPhoto>;
  encode(
    decoded: DecodedVisitPhoto,
    options: { width: number; height: number; quality: number },
  ): Promise<Blob>;
};

export function isPreparedVisitPhoto(photo: PhotoAsset) {
  const mimeType = (photo.mimeType || photo.file.type).toLowerCase().split(";", 1)[0];
  return photo.processingState === "prepared"
    && mimeType === "image/jpeg"
    && photo.file.size > 0
    && photo.file.size <= VISIT_PHOTO_MAX_BYTES;
}

function outputSize(width: number, height: number, scale: number) {
  const edgeScale = Math.min(1, VISIT_PHOTO_MAX_EDGE / Math.max(width, height));
  const applied = edgeScale * scale;
  return {
    width: Math.max(1, Math.round(width * applied)),
    height: Math.max(1, Math.round(height * applied)),
  };
}

function browserPrimitives(): VisitPhotoProcessingPrimitives {
  return {
    async decode(file) {
      if (typeof createImageBitmap !== "function") {
        throw new Error("This device could not prepare the photo for upload.");
      }
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
    },
    async encode(decoded, { width, height, quality }) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This device could not prepare the photo for upload.");
      context.drawImage(decoded.source, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      canvas.width = 1;
      canvas.height = 1;
      if (!blob) throw new Error("This device could not compress the photo for upload.");
      return blob;
    },
  };
}

/**
 * Strip metadata and bound the exact bytes saved for retry and sent over a field connection.
 * The injected primitives keep the retry/quality algorithm deterministic in unit tests.
 */
export async function normalizeVisitPhoto(
  photo: PhotoAsset,
  primitives: VisitPhotoProcessingPrimitives = browserPrimitives(),
): Promise<PhotoAsset> {
  if (isPreparedVisitPhoto(photo)) return photo;
  const decoded = await primitives.decode(photo.file);
  try {
    if (!Number.isFinite(decoded.width) || !Number.isFinite(decoded.height) || decoded.width < 1 || decoded.height < 1) {
      throw new Error("The captured photo has invalid dimensions.");
    }
    for (const scale of SCALE_STEPS) {
      const size = outputSize(decoded.width, decoded.height, scale);
      for (const quality of QUALITY_STEPS) {
        const encoded = await primitives.encode(decoded, { ...size, quality });
        if (encoded.size > 0 && encoded.size <= VISIT_PHOTO_MAX_BYTES) {
          const name = photo.file.name.replace(/\.[^.]*$/, "") || "parkdex-visit";
          return {
            file: new File([encoded], `${name}.jpg`, { type: "image/jpeg", lastModified: Date.now() }),
            mimeType: "image/jpeg",
            processingState: "prepared",
          };
        }
      }
    }
    throw new Error("The photo is too detailed to prepare for a reliable field upload. Try another photo.");
  } finally {
    decoded.close?.();
  }
}
