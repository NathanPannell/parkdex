export const GUEST_MIGRATION_KEYS = [
  "every-park:collection-key:v1",
  "every-park:visited:v1",
  "every-park:visit-timestamps:v1",
  "every-park:visit-metadata:v1",
  "every-park:trails:v1",
  "every-park:pending:v1",
  "every-park:trail-pending:v1",
  "every-park:guest-revision:v1",
] as const;

export const GUEST_MIGRATION_MAX_BYTES = 256 * 1024;

export const GUEST_MIGRATION_ORIGIN_PAIRS = [
  { sourceOrigin: "https://parkdex.app", targetOrigin: "https://web.parkdex.app" },
  { sourceOrigin: "https://staging.parkdex.app", targetOrigin: "https://staging.web.parkdex.app" },
] as const;

export const GUEST_MIGRATION_READY_TYPE = "parkdex-guest-migration-ready";
export const GUEST_MIGRATION_TRANSFER_TYPE = "parkdex-guest-migration-transfer";
export const GUEST_MIGRATION_RESULT_TYPE = "parkdex-guest-migration-result";

type GuestMigrationKey = (typeof GUEST_MIGRATION_KEYS)[number];
type GuestMigrationValues = Partial<Record<GuestMigrationKey, string>>;

const COLLECTION_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export type GuestMigrationStatus =
  | "ignored"
  | "imported"
  | "conflict"
  | "invalid"
  | "oversized"
  | "storage-error";

export type GuestMigrationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type GuestMigrationRemoteCheck = (collectionKey: string) => Promise<boolean>;

export type GuestMigrationResult = {
  status: GuestMigrationStatus;
  keys?: GuestMigrationKey[];
};

export function guestMigrationPairForAppOrigin(appOrigin: string) {
  return GUEST_MIGRATION_ORIGIN_PAIRS.find((pair) => pair.targetOrigin === appOrigin) ?? null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function validateGuestMigrationPayload(payload: unknown):
  | { status: "valid"; values: GuestMigrationValues }
  | { status: "invalid" | "oversized" } {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { status: "invalid" };
  }
  if (new TextEncoder().encode(serialized).byteLength > GUEST_MIGRATION_MAX_BYTES) {
    return { status: "oversized" };
  }

  if (!isPlainRecord(payload)) return { status: "invalid" };
  const messageKeys = Object.keys(payload);
  if (
    messageKeys.length !== 3
    || !messageKeys.includes("type")
    || !messageKeys.includes("version")
    || !messageKeys.includes("values")
    || payload.type !== GUEST_MIGRATION_TRANSFER_TYPE
    || payload.version !== 1
    || !isPlainRecord(payload.values)
  ) {
    return { status: "invalid" };
  }

  const values = payload.values;
  const keys = Object.keys(values);
  const allowedKeys = new Set<string>(GUEST_MIGRATION_KEYS);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key))) {
    return { status: "invalid" };
  }
  if (keys.some((key) => typeof values[key] !== "string")) {
    return { status: "invalid" };
  }

  return { status: "valid", values: values as GuestMigrationValues };
}

function restoreStorage(storage: GuestMigrationStorage, previous: Map<GuestMigrationKey, string | null>) {
  for (const [key, value] of previous) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // Best effort rollback after a browser storage failure.
    }
  }
}

function isEmptyStoredGuestValue(key: GuestMigrationKey, value: string | null): boolean {
  if (value === null || value === "") return true;

  if (key === "every-park:collection-key:v1") {
    // Hydration creates this identity before the guest has progress. The API's
    // catalogue GET only reads rows for it; progress mutations create rows.
    return COLLECTION_KEY_PATTERN.test(value);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }

  if (key === "every-park:visited:v1" || key === "every-park:trails:v1") {
    return Array.isArray(parsed) && parsed.length === 0;
  }
  if (key === "every-park:guest-revision:v1") return parsed === 0;
  return isPlainRecord(parsed) && Object.keys(parsed).length === 0;
}

function hasExistingGuestProgress(previous: Map<GuestMigrationKey, string | null>): boolean {
  return GUEST_MIGRATION_KEYS.some((key) => !isEmptyStoredGuestValue(key, previous.get(key) ?? null));
}

function readGuestMigrationSnapshot(storage: GuestMigrationStorage) {
  const snapshot = new Map<GuestMigrationKey, string | null>();
  for (const key of GUEST_MIGRATION_KEYS) snapshot.set(key, storage.getItem(key));
  return snapshot;
}

function sameGuestMigrationSnapshot(
  left: Map<GuestMigrationKey, string | null>,
  right: Map<GuestMigrationKey, string | null>,
) {
  return GUEST_MIGRATION_KEYS.every((key) => left.get(key) === right.get(key));
}

export async function fetchRemoteGuestProgress(
  apiBaseUrl: string,
  appOrigin: string,
  collectionKey: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const trimmedBaseUrl = apiBaseUrl.trim();
  if (!trimmedBaseUrl) throw new Error("The Parkdex API is not configured.");

  let endpoint: URL;
  if (trimmedBaseUrl === ".") {
    endpoint = new URL("/api/guest/progress-state", appOrigin);
  } else {
    const apiUrl = new URL(trimmedBaseUrl);
    if (
      !["http:", "https:"].includes(apiUrl.protocol)
      || apiUrl.username
      || apiUrl.password
      || apiUrl.pathname !== "/"
      || apiUrl.search
      || apiUrl.hash
    ) {
      throw new Error("The Parkdex API origin is invalid.");
    }
    endpoint = new URL("/api/guest/progress-state", apiUrl.origin);
  }

  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { "X-Collection-Key": collectionKey },
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The Parkdex API could not confirm saved guest progress.");

  const payload: unknown = await response.json();
  if (!isPlainRecord(payload) || typeof payload.hasProgress !== "boolean") {
    throw new Error("The Parkdex API returned an invalid guest progress response.");
  }
  return payload.hasProgress;
}

export async function receiveGuestMigrationMessage({
  origin,
  source,
  expectedOrigin,
  expectedSource,
  payload,
  storage,
  checkRemoteProgress,
}: {
  origin: string;
  source: unknown;
  expectedOrigin: string;
  expectedSource: unknown;
  payload: unknown;
  storage: GuestMigrationStorage;
  checkRemoteProgress?: GuestMigrationRemoteCheck;
}): Promise<GuestMigrationResult> {
  if (!expectedSource || origin !== expectedOrigin || source !== expectedSource) {
    return { status: "ignored" };
  }

  const parsed = validateGuestMigrationPayload(payload);
  if (parsed.status !== "valid") return { status: parsed.status };

  const keys = Object.keys(parsed.values) as GuestMigrationKey[];
  let previous: Map<GuestMigrationKey, string | null>;
  try {
    previous = readGuestMigrationSnapshot(storage);
  } catch {
    return { status: "storage-error" };
  }

  if (hasExistingGuestProgress(previous)) {
    return { status: "conflict" };
  }

  const destinationCollectionKey = previous.get("every-park:collection-key:v1");
  if (destinationCollectionKey) {
    if (!checkRemoteProgress) return { status: "conflict" };
    try {
      if (await checkRemoteProgress(destinationCollectionKey)) return { status: "conflict" };
    } catch {
      return { status: "conflict" };
    }

    let current: Map<GuestMigrationKey, string | null>;
    try {
      current = readGuestMigrationSnapshot(storage);
    } catch {
      return { status: "storage-error" };
    }
    if (!sameGuestMigrationSnapshot(previous, current) || hasExistingGuestProgress(current)) {
      return { status: "conflict" };
    }
    previous = current;
  }

  try {
    for (const key of keys) storage.setItem(key, parsed.values[key] as string);
    if (keys.some((key) => storage.getItem(key) !== parsed.values[key])) {
      throw new Error("Guest progress could not be verified after writing.");
    }
  } catch {
    restoreStorage(storage, previous);
    return { status: "storage-error" };
  }

  return { status: "imported", keys };
}
