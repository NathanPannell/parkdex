import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

import { getPlatformStorage, type KeyValueStore } from "./platform-storage";
import type { BoundaryFeature } from "./boundaries";
import { formatPlaceArea } from "./place-detail-facts";
import { getPlaceDescriptionSource, type PlaceDescriptionSource } from "./place-description-sources";
import { getPlaceImages, type PlaceImageRecord } from "./place-images";
import { toPlaceCatalogueSummary, type Place, type PlaceCatalogueSummary } from "./places";
import { getVisitorInformation, type VisitorInformation } from "./visitor-information";
import { parsePlaceVisitorDetails } from "./visitor-details";

export const RECENT_PLACE_CACHE_LIMIT = 20;
export const RECENT_PLACE_PHOTO_TIMEOUT_MS = 15_000;
const CACHE_DATABASE_NAME = "parkdex-recent-place-cache-v1";
const CACHE_BUNDLE_STORE = "bundles";
const CACHE_GEOMETRY_STORE = "geometry";
const CACHE_METADATA_STORE = "metadata";
const CACHE_VIEW_ORDER_KEY = "last-viewed-order";
const NATIVE_CACHE_INDEX_KEY = "parkdex:recent-place-cache:v1";
const NATIVE_CACHE_DIRECTORY = "parkdex-recent-place-cache";

export type PlaceSourceAttribution = {
  place: { name: string; url: string; id?: string };
  boundary: { name: string; url: string; id?: string } | null;
  photo: { creator: string; license: string; licenseUrl: string; sourceUrl: string; originalUrl: string } | null;
};

export type CachedGalleryPhoto = {
  image: PlaceImageRecord;
  photo: Blob | null;
  photoError: string | null;
};

export type CachedPlaceBundle = {
  place: Place;
  boundary: BoundaryFeature | null;
  boundaryVersion: string | number | null;
  visitorInformation: VisitorInformation | null;
  image: PlaceImageRecord | null;
  descriptionSource: PlaceDescriptionSource | null;
  area: string | null;
  sourceAttribution: PlaceSourceAttribution;
  photo: Blob | null;
  photoError: string | null;
  /** Approved alternate photos in the same order as getPlaceImages() after the primary image. */
  galleryPhotos: CachedGalleryPhoto[];
  viewedAt: number;
};

export type RecentPlaceCacheRecord = {
  placeId: string;
  viewedAt: number;
  bundle: CachedPlaceBundle;
};

export type CachedPlaceGeometry = {
  placeId: string;
  viewedAt: number;
  place: PlaceCatalogueSummary;
  boundary: BoundaryFeature | null;
  boundaryVersion: string | number | null;
};

export type RecentPlaceCacheStorage = {
  reserveViewOrder(): Promise<number>;
  get(placeId: string): Promise<RecentPlaceCacheRecord | null>;
  list(): Promise<RecentPlaceCacheRecord[]>;
  listMetadata(): Promise<CachedPlaceGeometry[]>;
  saveAndPrune(record: RecentPlaceCacheRecord): Promise<boolean>;
  clear(): Promise<void>;
};

export type RecentPlaceCache = {
  get(placeId: string): Promise<CachedPlaceBundle | null>;
  /** Call only when the place detail view is opened. A fetch by itself does not affect recency. */
  view(placeId: string, apiBaseUrl: string): Promise<CachedPlaceBundle>;
  list(): Promise<CachedPlaceBundle[]>;
  /** Metadata-only boundary view for GPS checks. Results are served from a bounded in-memory index after hydration. */
  listForClaims(): Promise<CachedPlaceGeometry[]>;
  clear(): Promise<void>;
};

type RecentPlaceCacheOptions = {
  storage?: RecentPlaceCacheStorage;
  indexedDB?: IDBFactory;
  fetcher?: typeof fetch;
  assetUrl?: (src: string, apiBaseUrl: string) => string;
};

function compareRecent(left: Pick<RecentPlaceCacheRecord, "placeId" | "viewedAt">, right: Pick<RecentPlaceCacheRecord, "placeId" | "viewedAt">) {
  return right.viewedAt - left.viewedAt || left.placeId.localeCompare(right.placeId);
}

function parseBoundary(value: unknown, placeId: string): BoundaryFeature | null {
  if (value === null) return null;
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.geometry) || !isRecord(value.properties)) {
    throw new Error("The offline place bundle contains an invalid boundary.");
  }
  const geometryType = value.geometry.type;
  if ((geometryType !== "Polygon" && geometryType !== "MultiPolygon")
    || !Array.isArray(value.geometry.coordinates)
    || value.properties.id !== placeId) {
    throw new Error("The offline place bundle contains an invalid boundary.");
  }
  return value as unknown as BoundaryFeature;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePlace(value: unknown, expectedId: string): Place {
  if (!isRecord(value)
    || value.id !== expectedId
    || typeof value.name !== "string"
    || !["national", "provincial", "regional", "island"].includes(String(value.category))
    || !Number.isFinite(value.latitude)
    || !Number.isFinite(value.longitude)
    || typeof value.region !== "string"
    || typeof value.description !== "string"
    || typeof value.sourceUrl !== "string"
    || typeof value.sourceName !== "string") {
    throw new Error("The offline place bundle contains invalid place details.");
  }
  const place = { ...value } as unknown as Place;
  delete place.visitorDetails;
  if ("visitorDetails" in value) {
    const visitorDetails = parsePlaceVisitorDetails(value.visitorDetails);
    if (visitorDetails !== undefined) place.visitorDetails = visitorDetails;
  }
  return place;
}

/** Old bundles remain readable. Invalid visitor metadata is omitted without touching the place boundary. */
function normalizeCachedRecord(value: unknown, expectedPlaceId?: string): RecentPlaceCacheRecord | null {
  if (!isRecord(value) || !isRecord(value.bundle)
    || typeof value.placeId !== "string" || !value.placeId
    || (expectedPlaceId !== undefined && value.placeId !== expectedPlaceId)
    || !Number.isFinite(value.viewedAt)) return null;
  try {
    const place = parsePlace(value.bundle.place, value.placeId);
    return {
      placeId: value.placeId,
      viewedAt: Number(value.viewedAt),
      bundle: normalizeCachedPlaceBundle({ ...value.bundle, place } as unknown as CachedPlaceBundle),
    };
  } catch {
    return null;
  }
}

function normalizeCachedGeometry(value: unknown): CachedPlaceGeometry | null {
  if (!isRecord(value) || typeof value.placeId !== "string" || !value.placeId || !Number.isFinite(value.viewedAt)) return null;
  try {
    const place = parsePlace(value.place, value.placeId);
    const boundaryVersion = typeof value.boundaryVersion === "string" || typeof value.boundaryVersion === "number"
      ? value.boundaryVersion
      : null;
    return {
      placeId: value.placeId,
      viewedAt: Number(value.viewedAt),
      place: toPlaceCatalogueSummary(place),
      boundary: value.boundary as BoundaryFeature | null,
      boundaryVersion,
    };
  } catch {
    return null;
  }
}

function placeAttribution(place: Place): PlaceSourceAttribution["place"] {
  return {
    name: place.sourceName,
    url: place.sourceUrl,
    ...(place.sourceId ? { id: place.sourceId } : {}),
  };
}

function boundaryAttribution(boundary: BoundaryFeature | null): PlaceSourceAttribution["boundary"] {
  if (!boundary) return null;
  return {
    name: boundary.properties.sourceName,
    url: boundary.properties.sourceUrl,
    ...(boundary.properties.sourceId ? { id: boundary.properties.sourceId } : {}),
  };
}

function photoAttribution(image: PlaceImageRecord | undefined): PlaceSourceAttribution["photo"] {
  if (!image) return null;
  return {
    creator: image.creator,
    license: image.license,
    licenseUrl: image.licenseUrl,
    sourceUrl: image.sourceUrl,
    originalUrl: image.originalUrl,
  };
}

function samePhotoSource(left: PlaceImageRecord | null, right: PlaceImageRecord | null) {
  return Boolean(left && right
    && left.detail.src === right.detail.src
    && left.originalUrl === right.originalUrl);
}

function preservePhotoOnSameSourceFailure<T extends { image: PlaceImageRecord | null; photo: Blob | null; photoError: string | null }>(
  fresh: T,
  prior: { image: PlaceImageRecord | null; photo: Blob | null } | undefined,
): T {
  if (fresh.photo || !fresh.photoError || !prior?.photo || !samePhotoSource(prior.image, fresh.image)) return fresh;
  return { ...fresh, photo: prior.photo, photoError: null } as T;
}

function normalizeCachedPlaceBundle(bundle: CachedPlaceBundle): CachedPlaceBundle {
  const storedGalleryPhotos = (bundle as CachedPlaceBundle & { galleryPhotos?: CachedGalleryPhoto[] }).galleryPhotos;
  return {
    ...bundle,
    galleryPhotos: Array.isArray(storedGalleryPhotos) ? storedGalleryPhotos : [],
  };
}

function defaultAssetUrl(src: string, apiBaseUrl: string) {
  if (/^https?:\/\//i.test(src)) return src;
  if (typeof window !== "undefined") return new URL(src, window.location.origin).toString();
  if (apiBaseUrl) return new URL(src, apiBaseUrl).toString();
  return src;
}

async function fetchPhoto(
  fetcher: typeof fetch,
  src: string,
  apiBaseUrl: string,
  resolveAssetUrl: RecentPlaceCacheOptions["assetUrl"],
  signal: AbortSignal,
): Promise<Blob> {
  const url = resolveAssetUrl ? resolveAssetUrl(src, apiBaseUrl) : defaultAssetUrl(src, apiBaseUrl);
  const response = await fetcher(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`The place photo returned ${response.status}.`);
  const blob = await response.blob();
  const mimeType = blob.type || response.headers.get("content-type") || "";
  if (blob.size === 0 || !mimeType.toLowerCase().startsWith("image/")) {
    throw new Error("The place photo response was empty or was not an image.");
  }
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

function fetchPhotoWithDeadline(
  fetcher: typeof fetch,
  src: string,
  apiBaseUrl: string,
  resolveAssetUrl: RecentPlaceCacheOptions["assetUrl"],
): Promise<Blob> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error("The full-resolution photo request timed out."));
    }, RECENT_PLACE_PHOTO_TIMEOUT_MS);
  });

  return Promise.race([fetchPhoto(fetcher, src, apiBaseUrl, resolveAssetUrl, controller.signal), timeout])
    .finally(() => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (!controller.signal.aborted) controller.abort();
    });
}

async function fetchPlaceBundle(
  placeId: string,
  apiBaseUrl: string,
  fetcher: typeof fetch,
  resolveAssetUrl: RecentPlaceCacheOptions["assetUrl"],
  viewedAt: number,
): Promise<CachedPlaceBundle> {
  if (!apiBaseUrl) throw new Error("The place service is unavailable while offline.");
  const response = await fetcher(`${apiBaseUrl.replace(/\/$/, "")}/api/places/${encodeURIComponent(placeId)}/offline-bundle`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`The offline place bundle returned ${response.status}.`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("The offline place bundle has an invalid format.");
  const place = parsePlace(value.place, placeId);
  const boundary = parseBoundary(value.boundary, place.id);
  const boundaryVersion = typeof value.boundaryVersion === "string" || typeof value.boundaryVersion === "number"
    ? value.boundaryVersion
    : null;
  const images = getPlaceImages(place.id);
  const fetchedImages = await Promise.all(images.map(async (image) => {
    try {
      return {
        image,
        photo: await fetchPhotoWithDeadline(fetcher, image.detail.src, apiBaseUrl, resolveAssetUrl),
        photoError: null,
      } satisfies CachedGalleryPhoto;
    } catch (error) {
      return {
        image,
        photo: null,
        photoError: error instanceof Error ? error.message : "The place photo could not be cached.",
      } satisfies CachedGalleryPhoto;
    }
  }));
  const [primary, ...galleryPhotos] = fetchedImages;
  const image = primary?.image ?? null;
  const photo = primary?.photo ?? null;
  const photoError = primary?.photoError ?? null;
  const attribution: PlaceSourceAttribution = {
    place: placeAttribution(place),
    boundary: boundaryAttribution(boundary),
    photo: photoAttribution(image ?? undefined),
  };

  return {
    place,
    boundary,
    boundaryVersion,
    visitorInformation: getVisitorInformation(place.id) ?? null,
    image,
    descriptionSource: getPlaceDescriptionSource(place.id) ?? null,
    area: formatPlaceArea(place.id),
    sourceAttribution: attribution,
    photo,
    photoError,
    galleryPhotos,
    viewedAt,
  };
}

function openCacheDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CACHE_DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_BUNDLE_STORE)) {
        database.createObjectStore(CACHE_BUNDLE_STORE, { keyPath: "placeId" });
      }
      if (!database.objectStoreNames.contains(CACHE_GEOMETRY_STORE)) {
        database.createObjectStore(CACHE_GEOMETRY_STORE, { keyPath: "placeId" });
      }
      if (!database.objectStoreNames.contains(CACHE_METADATA_STORE)) {
        database.createObjectStore(CACHE_METADATA_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recent place storage."));
    request.onblocked = () => reject(new Error("Recent place storage is blocked by another tab."));
  });
}

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Recent place storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Recent place storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Recent place storage transaction failed."));
  });
}

/** IndexedDB keeps each full bundle and its Blob in one durable transaction. */
export function createIndexedDbRecentPlaceStore(factory: IDBFactory): RecentPlaceCacheStorage {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const database = () => {
    if (!databasePromise) {
      databasePromise = openCacheDatabase(factory).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  };

  return {
    async reserveViewOrder() {
      const db = await database();
      const transaction = db.transaction(CACHE_METADATA_STORE, "readwrite");
      const store = transaction.objectStore(CACHE_METADATA_STORE);
      let order = 0;
      const request = store.get(CACHE_VIEW_ORDER_KEY);
      request.onsuccess = () => {
        const prior = isRecord(request.result) && Number.isFinite(request.result.value) ? Number(request.result.value) : 0;
        order = Math.max(Date.now(), prior + 1);
        store.put({ key: CACHE_VIEW_ORDER_KEY, value: order });
      };
      await transactionDone(transaction);
      return order;
    },
    async get(placeId) {
      const db = await database();
      const transaction = db.transaction(CACHE_BUNDLE_STORE, "readonly");
      const result = await idbRequest(transaction.objectStore(CACHE_BUNDLE_STORE).get(placeId));
      await transactionDone(transaction);
      return normalizeCachedRecord(result, placeId);
    },
    async list() {
      const db = await database();
      const transaction = db.transaction(CACHE_BUNDLE_STORE, "readonly");
      const result = await idbRequest(transaction.objectStore(CACHE_BUNDLE_STORE).getAll());
      await transactionDone(transaction);
      return result.map((entry) => normalizeCachedRecord(entry)).filter((entry): entry is RecentPlaceCacheRecord => entry !== null).sort(compareRecent);
    },
    async listMetadata() {
      const db = await database();
      const transaction = db.transaction(CACHE_GEOMETRY_STORE, "readonly");
      const result = await idbRequest(transaction.objectStore(CACHE_GEOMETRY_STORE).getAll());
      await transactionDone(transaction);
      return result.map(normalizeCachedGeometry).filter((entry): entry is CachedPlaceGeometry => entry !== null).sort(compareRecent);
    },
    async saveAndPrune(record) {
      const db = await database();
      const transaction = db.transaction([CACHE_BUNDLE_STORE, CACHE_GEOMETRY_STORE], "readwrite");
      const store = transaction.objectStore(CACHE_BUNDLE_STORE);
      const geometryStore = transaction.objectStore(CACHE_GEOMETRY_STORE);
      let persisted = false;
      const request = store.getAll();
      request.onsuccess = () => {
        const current = request.result as RecentPlaceCacheRecord[];
        const prior = current.find((entry) => entry.placeId === record.placeId);
        const nextRecord = prior && prior.viewedAt > record.viewedAt ? prior : record;
        const candidates = current.filter((entry) => entry.placeId !== record.placeId).concat(nextRecord).sort(compareRecent);
        const keep = candidates.slice(0, RECENT_PLACE_CACHE_LIMIT);
        const keepIds = new Set(keep.map((entry) => entry.placeId));
        for (const entry of current) {
          if (keepIds.has(entry.placeId)) continue;
          store.delete(entry.placeId);
          geometryStore.delete(entry.placeId);
        }
        if (keepIds.has(record.placeId)) {
          if (nextRecord === record) {
            store.put(record);
            geometryStore.put({
              placeId: record.placeId,
              viewedAt: record.viewedAt,
              place: toPlaceCatalogueSummary(record.bundle.place),
              boundary: record.bundle.boundary,
              boundaryVersion: record.bundle.boundaryVersion,
            } satisfies CachedPlaceGeometry);
          }
          persisted = true;
        }
      };
      await transactionDone(transaction);
      return persisted;
    },
    async clear() {
      const db = await database();
      const transaction = db.transaction([CACHE_BUNDLE_STORE, CACHE_GEOMETRY_STORE, CACHE_METADATA_STORE], "readwrite");
      transaction.objectStore(CACHE_BUNDLE_STORE).clear();
      transaction.objectStore(CACHE_GEOMETRY_STORE).clear();
      transaction.objectStore(CACHE_METADATA_STORE).clear();
      await transactionDone(transaction);
    },
  };
}

type NativeManifestEntry = {
  placeId: string;
  viewedAt: number;
  path: string;
  photoPath: string | null;
  /** Distinguishes same-view metadata touches from a fresh replacement bundle. */
  fileId?: string;
  /** Optional for manifests written before gallery photos were cached. */
  galleryPhotoPaths?: Array<string | null>;
};
type NativeManifest = { version: 1; lastViewedAt: number; entries: NativeManifestEntry[] };
type NativeBundleMetadata = Omit<CachedPlaceBundle, "photo" | "galleryPhotos"> & {
  galleryPhotos: Array<Omit<CachedGalleryPhoto, "photo">>;
};
type NativeSerializedRecord = {
  record: Omit<RecentPlaceCacheRecord, "bundle"> & { bundle: NativeBundleMetadata };
  photoType: string | null;
  galleryPhotoTypes: Array<string | null>;
};
type ParsedNativeRecord = {
  record: RecentPlaceCacheRecord;
  photoType: string | null;
  galleryPhotoTypes: Array<string | null>;
};

let nativeMutationTail: Promise<unknown> = Promise.resolve();
let nativeFileSequence = 0;

function nextNativeFileId() {
  nativeFileSequence += 1;
  return `${Date.now().toString(36)}-${nativeFileSequence.toString(36)}`;
}

function serializeNative<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeMutationTail.then(operation);
  nativeMutationTail = result.catch(() => undefined);
  return result;
}

function isMissingFileError(error: unknown) {
  if (!isRecord(error)) return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return error.code === "ENOENT" || message.includes("does not exist") || message.includes("no such file");
}

function parseNativeManifest(value: string | null): NativeManifest {
  if (!value) return { version: 1, lastViewedAt: 0, entries: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !Number.isFinite(parsed.lastViewedAt) || !Array.isArray(parsed.entries)) {
      throw new Error("Invalid recent place index.");
    }
    const entries = parsed.entries.filter((entry): entry is NativeManifestEntry => {
      if (!isRecord(entry)
        || typeof entry.placeId !== "string"
        || !Number.isFinite(entry.viewedAt)
        || (entry.fileId !== undefined && (typeof entry.fileId !== "string" || !/^[a-z0-9-]{1,32}$/.test(entry.fileId)))
        || typeof entry.path !== "string") return false;
      const fileId = typeof entry.fileId === "string" ? entry.fileId : undefined;
      if (!isNativeRecordPath(entry.path, entry.placeId, Number(entry.viewedAt), fileId)
        || !(entry.photoPath === null || (typeof entry.photoPath === "string"
          && isNativePhotoPath(entry.photoPath, entry.placeId, Number(entry.viewedAt), fileId)))) return false;
      if (entry.galleryPhotoPaths === undefined) return true;
      return Array.isArray(entry.galleryPhotoPaths)
        && entry.galleryPhotoPaths.length <= 20
        && entry.galleryPhotoPaths.every((path, index) => path === null || (typeof path === "string"
          && isNativeGalleryPhotoPath(path, entry.placeId as string, Number(entry.viewedAt), index, fileId)));
    });
    if (entries.length !== parsed.entries.length || entries.length > RECENT_PLACE_CACHE_LIMIT
      || new Set(entries.map((entry) => entry.placeId)).size !== entries.length) {
      throw new Error("Invalid recent place index entries.");
    }
    return { version: 1, lastViewedAt: Number(parsed.lastViewedAt), entries };
  } catch {
    throw new Error("Recent place storage index is corrupt.");
  }
}

async function readNativeManifest(platformStorage: KeyValueStore): Promise<NativeManifest> {
  return parseNativeManifest(await platformStorage.getItem(NATIVE_CACHE_INDEX_KEY));
}

function imageBase64(photo: Blob | null): Promise<string | null> {
  if (!photo) return Promise.resolve(null);
  return photo.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const sliceSize = 0x8000;
    for (let index = 0; index < bytes.length; index += sliceSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + sliceSize));
    }
    return btoa(binary);
  });
}

function imageFromBase64(value: string | null, mimeType: string | null): Blob | null {
  if (value === null) return null;
  if (!mimeType?.toLowerCase().startsWith("image/")) throw new Error("Cached place photo has invalid metadata.");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function serializeNativeRecord(record: RecentPlaceCacheRecord): Promise<{
  metadata: string;
  photoBase64: string | null;
  galleryPhotoBase64: Array<string | null>;
}> {
  const bundle = normalizeCachedPlaceBundle(record.bundle);
  const [photoBase64, ...galleryPhotoBase64] = await Promise.all([
    imageBase64(bundle.photo),
    ...bundle.galleryPhotos.map((entry) => imageBase64(entry.photo)),
  ]);
  const { photo, ...bundleMetadata } = bundle;
  const value: NativeSerializedRecord = {
    record: {
      ...record,
      bundle: {
        ...bundleMetadata,
        galleryPhotos: bundle.galleryPhotos.map(({ image, photoError }) => ({ image, photoError })),
      },
    },
    photoType: photo?.type || null,
    galleryPhotoTypes: bundle.galleryPhotos.map((entry) => entry.photo?.type || null),
  };
  return { metadata: JSON.stringify(value), photoBase64, galleryPhotoBase64 };
}

function parseNativeRecord(value: string): ParsedNativeRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !isRecord(parsed.record) || !isRecord(parsed.record.bundle)
    || typeof parsed.record.placeId !== "string" || !Number.isFinite(parsed.record.viewedAt)) {
    throw new Error("Cached place data is corrupt.");
  }
  const rawBundle = parsed.record.bundle as unknown as Omit<CachedPlaceBundle, "photo"> & {
    galleryPhotos?: Array<Omit<CachedGalleryPhoto, "photo">>;
  };
  const galleryPhotos = Array.isArray(rawBundle.galleryPhotos)
    ? rawBundle.galleryPhotos.map((entry) => ({ ...entry, photo: null }))
    : [];
  const normalized = normalizeCachedRecord({
    placeId: parsed.record.placeId,
    viewedAt: parsed.record.viewedAt,
    bundle: { ...rawBundle, photo: null, galleryPhotos },
  });
  if (!normalized) throw new Error("Cached place details are invalid.");
  return {
    record: { ...normalized, bundle: { ...normalized.bundle, photo: null } },
    photoType: typeof parsed.photoType === "string" ? parsed.photoType : null,
    galleryPhotoTypes: Array.isArray(parsed.galleryPhotoTypes)
      ? parsed.galleryPhotoTypes.map((value) => typeof value === "string" ? value : null)
      : [],
  };
}

async function removeNativeFile(path: string) {
  assertNativeCachePath(path);
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function readNativeMetadata(entry: NativeManifestEntry): Promise<ParsedNativeRecord | null> {
  if (!isNativeRecordPath(entry.path, entry.placeId, entry.viewedAt, entry.fileId)) {
    throw new Error("Recent place storage index contains an unsafe file path.");
  }
  try {
    const file = await Filesystem.readFile({ path: entry.path, directory: Directory.Data, encoding: Encoding.UTF8 });
    const content = typeof file.data === "string" ? file.data : await file.data.text();
    const { record, photoType, galleryPhotoTypes } = parseNativeRecord(content);
    if (record.placeId !== entry.placeId || record.viewedAt !== entry.viewedAt) return null;
    return { record, photoType, galleryPhotoTypes };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readNativeRecord(entry: NativeManifestEntry): Promise<RecentPlaceCacheRecord | null> {
  const metadata = await readNativeMetadata(entry);
  if (!metadata) return null;
  const readPhoto = async (path: string | null, mimeType: string | null, isGallery: boolean, index?: number) => {
    if (!path) return { photo: null, photoError: null as string | null };
    const validPath = isGallery && index !== undefined
      ? isNativeGalleryPhotoPath(path, entry.placeId, entry.viewedAt, index, entry.fileId)
      : isNativePhotoPath(path, entry.placeId, entry.viewedAt, entry.fileId);
    if (!validPath) throw new Error("Recent place storage index contains an unsafe photo path.");
    try {
      const file = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      const photoBase64 = typeof file.data === "string" ? file.data : await file.data.text();
      return { photo: imageFromBase64(photoBase64, mimeType), photoError: null as string | null };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      return { photo: null, photoError: isGallery ? "Cached gallery photo file is missing." : "Cached place photo file is missing." };
    }
  };
  const galleryPaths = entry.galleryPhotoPaths ?? [];
  const [primary, ...galleryPhotos] = await Promise.all([
    readPhoto(entry.photoPath, metadata.photoType, false),
    ...metadata.record.bundle.galleryPhotos.map((gallery, index) => readPhoto(
      galleryPaths[index] ?? null,
      metadata.galleryPhotoTypes[index] ?? null,
      true,
      index,
    )),
  ]);
  const bundle = metadata.record.bundle;
  return {
    ...metadata.record,
    bundle: {
      ...bundle,
      photo: primary?.photo ?? null,
      photoError: primary?.photoError ?? bundle.photoError,
      galleryPhotos: bundle.galleryPhotos.map((gallery, index) => ({
        ...gallery,
        photo: galleryPhotos[index]?.photo ?? null,
        photoError: galleryPhotos[index]?.photoError ?? gallery.photoError,
      })),
    },
  };
}

async function removeNativeOrphans(manifest: NativeManifest) {
  const activePaths = new Set(manifest.entries.flatMap((entry) => [
    entry.path,
    ...(entry.photoPath ? [entry.photoPath] : []),
    ...(entry.galleryPhotoPaths ?? []).filter((path): path is string => path !== null),
  ]));
  try {
    const listing = await Filesystem.readdir({ path: NATIVE_CACHE_DIRECTORY, directory: Directory.Data });
    for (const entry of listing.files) {
      const path = `${NATIVE_CACHE_DIRECTORY}/${entry.name}`;
      if (!activePaths.has(path)) await removeNativeFile(path);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isNativeRecordPath(path: string, placeId: string, viewedAt: number, fileId?: string) {
  return path === `${NATIVE_CACHE_DIRECTORY}/${encodeURIComponent(placeId)}-${viewedAt}${fileId ? `-${fileId}` : ""}.json`;
}

function isNativePhotoPath(path: string, placeId: string, viewedAt: number, fileId?: string) {
  return path === `${NATIVE_CACHE_DIRECTORY}/${encodeURIComponent(placeId)}-${viewedAt}${fileId ? `-${fileId}` : ""}.photo`;
}

function isNativeGalleryPhotoPath(path: string, placeId: string, viewedAt: number, index: number, fileId?: string) {
  return path === `${NATIVE_CACHE_DIRECTORY}/${encodeURIComponent(placeId)}-${viewedAt}${fileId ? `-${fileId}` : ""}.gallery-${index}.photo`;
}

function assertNativeCachePath(path: string) {
  const prefix = `${NATIVE_CACHE_DIRECTORY}/`;
  const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new Error("Refusing to access a file outside recent place storage.");
  }
}

/** Native metadata stays in the existing platform store. Full public bundles and photo bytes use app-private Filesystem files. */
export function createNativeFilesystemRecentPlaceStore(): RecentPlaceCacheStorage {
  return {
    reserveViewOrder: () => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      const order = Math.max(Date.now(), manifest.lastViewedAt + 1);
      await platformStorage.setItem(NATIVE_CACHE_INDEX_KEY, JSON.stringify({ ...manifest, lastViewedAt: order }));
      return order;
    }),
    get: (placeId) => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      await removeNativeOrphans(manifest);
      const entry = manifest.entries.find((candidate) => candidate.placeId === placeId);
      return entry ? readNativeRecord(entry) : null;
    }),
    list: () => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      await removeNativeOrphans(manifest);
      const records = await Promise.all(manifest.entries.map(readNativeRecord));
      return records.filter((record): record is RecentPlaceCacheRecord => record !== null).sort(compareRecent);
    }),
    listMetadata: () => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      await removeNativeOrphans(manifest);
      const records = await Promise.all(manifest.entries.map(readNativeMetadata));
      return records.filter((record): record is ParsedNativeRecord => record !== null).map(({ record }) => ({
        placeId: record.placeId,
        viewedAt: record.viewedAt,
        place: toPlaceCatalogueSummary(record.bundle.place),
        boundary: record.bundle.boundary,
        boundaryVersion: record.bundle.boundaryVersion,
      })).sort(compareRecent);
    }),
    saveAndPrune: (record) => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      const prior = manifest.entries.find((entry) => entry.placeId === record.placeId);
      if (prior && prior.viewedAt > record.viewedAt) return true;
      const fileId = nextNativeFileId();
      const filename = `${encodeURIComponent(record.placeId)}-${record.viewedAt}-${fileId}`;
      const path = `${NATIVE_CACHE_DIRECTORY}/${filename}.json`;
      const bundle = normalizeCachedPlaceBundle(record.bundle);
      const photoPath = bundle.photo ? `${NATIVE_CACHE_DIRECTORY}/${filename}.photo` : null;
      const galleryPhotoPaths = bundle.galleryPhotos.map((entry, index) => entry.photo
        ? `${NATIVE_CACHE_DIRECTORY}/${filename}.gallery-${index}.photo`
        : null);
      const candidate: NativeManifestEntry = { placeId: record.placeId, viewedAt: record.viewedAt, path, photoPath, fileId, galleryPhotoPaths };
      const entries = manifest.entries.filter((entry) => entry.placeId !== record.placeId).concat(candidate)
        .sort((left, right) => right.viewedAt - left.viewedAt || left.placeId.localeCompare(right.placeId));
      const keep = entries.slice(0, RECENT_PLACE_CACHE_LIMIT);
      if (!keep.some((entry) => entry.placeId === record.placeId)) return false;
      const content = await serializeNativeRecord({ ...record, bundle });
      const nextManifest: NativeManifest = {
        version: 1,
        lastViewedAt: Math.max(manifest.lastViewedAt, record.viewedAt),
        entries: keep,
      };
      try {
        await Filesystem.writeFile({ path, directory: Directory.Data, data: content.metadata, encoding: Encoding.UTF8, recursive: true });
        if (photoPath && content.photoBase64 !== null) {
          await Filesystem.writeFile({ path: photoPath, directory: Directory.Data, data: content.photoBase64, encoding: Encoding.UTF8, recursive: true });
        }
        const galleryWrites = await Promise.allSettled(galleryPhotoPaths.map(async (galleryPath, index) => {
          const photoBase64 = content.galleryPhotoBase64[index];
          if (galleryPath && photoBase64 !== null && photoBase64 !== undefined) {
            await Filesystem.writeFile({ path: galleryPath, directory: Directory.Data, data: photoBase64, encoding: Encoding.UTF8, recursive: true });
          }
        }));
        const failedGalleryWrite = galleryWrites.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failedGalleryWrite) throw failedGalleryWrite.reason;
        await platformStorage.setItem(NATIVE_CACHE_INDEX_KEY, JSON.stringify(nextManifest));
      } catch (error) {
        await removeNativeFile(path).catch(() => undefined);
        if (photoPath) await removeNativeFile(photoPath).catch(() => undefined);
        for (const galleryPath of galleryPhotoPaths) {
          if (galleryPath) await removeNativeFile(galleryPath).catch(() => undefined);
        }
        throw error;
      }
      await removeNativeOrphans(nextManifest);
      return true;
    }),
    clear: () => serializeNative(async () => {
      const platformStorage = await getPlatformStorage();
      const manifest = await readNativeManifest(platformStorage);
      for (const entry of manifest.entries) {
        await removeNativeFile(entry.path);
        if (entry.photoPath) await removeNativeFile(entry.photoPath);
        for (const galleryPath of entry.galleryPhotoPaths ?? []) {
          if (galleryPath) await removeNativeFile(galleryPath);
        }
      }
      await platformStorage.removeItem(NATIVE_CACHE_INDEX_KEY);
      await removeNativeOrphans({ version: 1, lastViewedAt: 0, entries: [] });
    }),
  };
}

export function createRecentPlaceCache(options: RecentPlaceCacheOptions = {}): RecentPlaceCache {
  const indexedDBFactory = options.indexedDB ?? globalThis.indexedDB;
  const storage = options.storage ?? (Capacitor.isNativePlatform()
    ? createNativeFilesystemRecentPlaceStore()
    : indexedDBFactory
      ? createIndexedDbRecentPlaceStore(indexedDBFactory)
      : null);
  if (!storage) throw new Error("Durable recent place storage is unavailable.");

  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  let clearGeneration = 0;
  let mutationTail: Promise<unknown> = Promise.resolve();
  let claimIndex: CachedPlaceGeometry[] | null = null;
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => undefined);
    return result;
  };
  const waitForMutations = () => mutationTail.then(() => undefined);
  const readBundle = async (placeId: string) => {
    await waitForMutations();
    const record = await storage.get(placeId);
    return record ? normalizeCachedPlaceBundle(record.bundle) : null;
  };
  const refreshClaimIndex = async () => {
    claimIndex = null;
    const refreshed = (await storage.listMetadata()).sort(compareRecent);
    claimIndex = refreshed;
    return refreshed;
  };

  return {
    get: readBundle,
    async view(placeId, apiBaseUrl) {
      const generation = clearGeneration;
      const viewedAt = await mutate(() => storage.reserveViewOrder());
      let cachedAtView: CachedPlaceBundle | null = null;
      try {
        cachedAtView = await readBundle(placeId);
      } catch {
        // A cache read failure must not prevent a fresh online bundle request.
      }
      if (cachedAtView && generation === clearGeneration) {
        await mutate(async () => {
          if (generation !== clearGeneration) return;
          try {
            await storage.saveAndPrune({ placeId, viewedAt, bundle: { ...cachedAtView!, viewedAt } });
          } finally {
            await refreshClaimIndex();
          }
        }).catch(() => undefined);
      }

      let fresh: CachedPlaceBundle;
      try {
        fresh = await fetchPlaceBundle(placeId, apiBaseUrl, fetcher, options.assetUrl, viewedAt);
      } catch (error) {
        let cached: CachedPlaceBundle | null = null;
        try {
          cached = await readBundle(placeId);
        } catch {
          // Keep the in-memory copy from before the request as an offline fallback.
        }
        if (!cached && generation === clearGeneration) cached = cachedAtView;
        if (!cached) throw error;
        if (generation === clearGeneration) {
          await mutate(async () => {
            if (generation !== clearGeneration) return;
            try {
              await storage.saveAndPrune({ placeId, viewedAt, bundle: { ...cached, viewedAt } });
            } finally {
              await refreshClaimIndex();
            }
          }).catch(() => undefined);
        }
        if (generation !== clearGeneration) throw error;
        try {
          return (await readBundle(placeId)) ?? cached;
        } catch {
          return cached;
        }
      }

      if ((fresh.photoError && fresh.image) || fresh.galleryPhotos.some((entry) => entry.photoError && !entry.photo)) {
        const prior = await readBundle(placeId);
        if (prior) {
          const preservedPrimary = preservePhotoOnSameSourceFailure(fresh, prior);
          const priorGallery = prior.galleryPhotos ?? [];
          fresh = {
            ...fresh,
            ...preservedPrimary,
            galleryPhotos: fresh.galleryPhotos.map((entry) => preservePhotoOnSameSourceFailure(
              entry,
              priorGallery.find((priorEntry) => samePhotoSource(priorEntry.image, entry.image)),
            )),
          };
        }
      }

      if (generation === clearGeneration) {
        await mutate(async () => {
          if (generation !== clearGeneration) return;
          try {
            await storage.saveAndPrune({ placeId, viewedAt, bundle: fresh });
          } finally {
            await refreshClaimIndex();
          }
        });
      }
      return fresh;
    },
    async list() {
      await waitForMutations();
      return (await storage.list()).sort(compareRecent).map((record) => normalizeCachedPlaceBundle(record.bundle));
    },
    async listForClaims() {
      await waitForMutations();
      if (claimIndex) return [...claimIndex];
      return mutate(refreshClaimIndex).then((entries) => [...entries]);
    },
    async clear() {
      clearGeneration += 1;
      claimIndex = [];
      await mutate(async () => {
        try {
          await storage.clear();
        } finally {
          claimIndex = [];
        }
      });
    },
  };
}

let recentPlaceCache: RecentPlaceCache | null = null;

export function getRecentPlaceCache(): RecentPlaceCache {
  if (!recentPlaceCache) recentPlaceCache = createRecentPlaceCache();
  return recentPlaceCache;
}

export function resetRecentPlaceCacheForTests() {
  recentPlaceCache = null;
  nativeMutationTail = Promise.resolve();
  nativeFileSequence = 0;
}
