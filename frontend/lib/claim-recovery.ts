import { isDurablePhotoOwner } from "./photo-retry";
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";

const STORAGE_PREFIX = "parkdex:claim-recovery:v1:";

export type UnresolvedClaim = {
  placeId: string;
  photoExpected: boolean;
  createdAt: string;
};

type StoredOwnerState = {
  version: 1;
  claims: Record<string, UnresolvedClaim>;
};

export type ClaimRecoveryStore = ReturnType<typeof createClaimRecoveryStore>;

function ownerStorageKey(ownerKey: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`;
}

function parseState(raw: string | null): StoredOwnerState {
  if (raw === null) return { version: 1, claims: {} };
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1
    || typeof (value as { claims?: unknown }).claims !== "object" || (value as { claims?: unknown }).claims === null) {
    throw new Error("Saved visit recovery data is invalid.");
  }
  const claims = (value as { claims: Record<string, unknown> }).claims;
  const validClaims: Record<string, UnresolvedClaim> = {};
  for (const [placeId, claim] of Object.entries(claims)) {
    if (typeof claim !== "object" || claim === null) throw new Error("Saved visit recovery data is invalid.");
    const candidate = claim as Partial<UnresolvedClaim>;
    if (candidate.placeId !== placeId || typeof candidate.photoExpected !== "boolean" || typeof candidate.createdAt !== "string") {
      throw new Error("Saved visit recovery data is invalid.");
    }
    validClaims[placeId] = { placeId, photoExpected: candidate.photoExpected, createdAt: candidate.createdAt };
  }
  return { version: 1, claims: validClaims };
}

/** Small, owner-scoped markers for create requests whose server outcome is unknown. */
export function createClaimRecoveryStore(storage?: KeyValueStore) {
  let previous = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = previous.then(operation);
    previous = result.then(() => undefined, () => undefined);
    return result;
  };
  const target = async () => storage ?? getPlatformStorage();
  const readOwner = async (ownerKey: string) => {
    const platform = await target();
    return { platform, state: parseState(await platform.getItem(ownerStorageKey(ownerKey))) };
  };
  const writeOwner = async (platform: KeyValueStore, ownerKey: string, state: StoredOwnerState) => {
    const key = ownerStorageKey(ownerKey);
    if (Object.keys(state.claims).length === 0) await platform.removeItem(key);
    else await platform.setItem(key, JSON.stringify(state));
  };

  return {
    loadUnresolvedClaim(ownerKey: string | undefined, placeId: string): Promise<UnresolvedClaim | null> {
      if (!isDurablePhotoOwner(ownerKey)) return Promise.resolve(null);
      return serial(async () => (await readOwner(ownerKey)).state.claims[placeId] ?? null);
    },
    markUnresolvedClaim(ownerKey: string | undefined, placeId: string, photoExpected: boolean): Promise<void> {
      if (!isDurablePhotoOwner(ownerKey)) return Promise.reject(new Error("Saved visit recovery requires a signed-in account."));
      return serial(async () => {
        const { platform, state } = await readOwner(ownerKey);
        const previousClaim = state.claims[placeId];
        state.claims[placeId] = {
          placeId,
          photoExpected,
          createdAt: previousClaim?.createdAt ?? new Date().toISOString(),
        };
        await writeOwner(platform, ownerKey, state);
      });
    },
    clearUnresolvedClaim(ownerKey: string | undefined, placeId: string): Promise<void> {
      if (!isDurablePhotoOwner(ownerKey)) return Promise.resolve();
      return serial(async () => {
        const { platform, state } = await readOwner(ownerKey);
        delete state.claims[placeId];
        await writeOwner(platform, ownerKey, state);
      });
    },
    hasUnresolvedClaim(ownerKey: string | undefined): Promise<boolean> {
      if (!isDurablePhotoOwner(ownerKey)) return Promise.resolve(false);
      return serial(async () => Object.keys((await readOwner(ownerKey)).state.claims).length > 0);
    },
    clearUnresolvedClaims(ownerKey: string | undefined): Promise<void> {
      if (!isDurablePhotoOwner(ownerKey)) return Promise.resolve();
      return serial(async () => {
        const platform = await target();
        await platform.removeItem(ownerStorageKey(ownerKey));
      });
    },
  };
}

let defaultStore: ClaimRecoveryStore | undefined;

function store() {
  defaultStore ??= createClaimRecoveryStore();
  return defaultStore;
}

export const loadUnresolvedClaim = (ownerKey: string | undefined, placeId: string) => store().loadUnresolvedClaim(ownerKey, placeId);
export const markUnresolvedClaim = (ownerKey: string | undefined, placeId: string, photoExpected: boolean) => store().markUnresolvedClaim(ownerKey, placeId, photoExpected);
export const clearUnresolvedClaim = (ownerKey: string | undefined, placeId: string) => store().clearUnresolvedClaim(ownerKey, placeId);
export const hasUnresolvedClaim = (ownerKey: string | undefined) => store().hasUnresolvedClaim(ownerKey);
export const clearUnresolvedClaims = (ownerKey: string | undefined) => store().clearUnresolvedClaims(ownerKey);
