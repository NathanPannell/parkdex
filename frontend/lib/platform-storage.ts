export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type NativePlatformStores = {
  credentials: KeyValueStore;
  journal: KeyValueStore;
};

type NativeStorageFactory = () => Promise<NativePlatformStores>;
type LegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const LEGACY_PREFIX = "every-park:";
const PERSISTENT_CREDENTIAL_KEYS = new Set([
  "every-park:account-token:v1",
  "every-park:collection-key:v1",
]);
const SESSION_CREDENTIAL_KEYS = new Set([
  "parkdex:google-code-verifier:v1",
  "parkdex:google-state:v1",
]);
const CREDENTIAL_KEYS = new Set([...PERSISTENT_CREDENTIAL_KEYS, ...SESSION_CREDENTIAL_KEYS]);

let nativeStorageFactory: NativeStorageFactory | undefined;
let platformStoragePromise: Promise<KeyValueStore> | undefined;

function nativePlatformDetected() {
  const capacitor = (globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

function browserStorage(): KeyValueStore {
  const target = (key: string) => SESSION_CREDENTIAL_KEYS.has(key) ? window.sessionStorage : window.localStorage;
  return {
    getItem: async (key) => target(key).getItem(key),
    setItem: async (key, value) => { target(key).setItem(key, value); },
    removeItem: async (key) => { target(key).removeItem(key); },
  };
}

function routedNativeStorage({ credentials, journal }: NativePlatformStores): KeyValueStore {
  const target = (key: string) => CREDENTIAL_KEYS.has(key) ? credentials : journal;
  let previousMutation = Promise.resolve();

  const afterMutations = <T>(operation: () => Promise<T>) => previousMutation.then(operation);
  const mutate = (operation: () => Promise<void>) => {
    const result = previousMutation.then(operation);
    previousMutation = result.catch(() => undefined);
    return result;
  };

  return {
    getItem: (key) => afterMutations(() => target(key).getItem(key)),
    setItem: (key, value) => mutate(() => target(key).setItem(key, value)),
    removeItem: (key) => mutate(() => target(key).removeItem(key)),
  };
}

async function migrateKey(source: LegacyStorage, destination: KeyValueStore, key: string) {
  const legacyValue = source.getItem(key);
  if (legacyValue === null) return;

  const currentValue = await destination.getItem(key);
  if (currentValue === null) {
    await destination.setItem(key, legacyValue);
    if (await destination.getItem(key) !== legacyValue) {
      throw new Error(`Could not verify migrated storage key: ${key}`);
    }
  }
  source.removeItem(key);
}

async function migrateLegacyStorage(source: LegacyStorage, stores: NativePlatformStores) {
  for (const key of PERSISTENT_CREDENTIAL_KEYS) {
    await migrateKey(source, stores.credentials, key);
  }
  for (const key of SESSION_CREDENTIAL_KEYS) {
    await migrateKey(window.sessionStorage, stores.credentials, key);
  }

  const journalKeys: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index);
    if (key?.startsWith(LEGACY_PREFIX) && !CREDENTIAL_KEYS.has(key)) journalKeys.push(key);
  }
  for (const key of journalKeys) {
    await migrateKey(source, stores.journal, key);
  }
}

export function registerNativePlatformStorage(factory: NativeStorageFactory) {
  if (platformStoragePromise) {
    throw new Error("Native platform storage must be registered before initialization.");
  }
  nativeStorageFactory = factory;
}

export function getPlatformStorage(): Promise<KeyValueStore> {
  if (platformStoragePromise) return platformStoragePromise;

  if (!nativePlatformDetected()) {
    platformStoragePromise = Promise.resolve(browserStorage());
    return platformStoragePromise;
  }

  if (!nativeStorageFactory) {
    return Promise.reject(new Error("Native platform storage is not registered."));
  }

  platformStoragePromise = nativeStorageFactory().then(async (stores) => {
    await migrateLegacyStorage(window.localStorage, stores);
    return routedNativeStorage(stores);
  }).catch((error: unknown) => {
    platformStoragePromise = undefined;
    throw error;
  });
  return platformStoragePromise;
}

export function resetPlatformStorageForTests() {
  nativeStorageFactory = undefined;
  platformStoragePromise = undefined;
}
