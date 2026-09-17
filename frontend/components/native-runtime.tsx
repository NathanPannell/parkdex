"use client";

import { App } from "@capacitor/app";
import { registerPlugin, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { useEffect, useMemo, useState } from "react";

import {
  createCapacitorNativeCapabilities,
  queueRestoredCameraPhoto,
} from "@/lib/capacitor-native-capabilities";
import { dispatchNativeBack, hasNativeBackHistory } from "@/lib/native-back";
import { publishNativeAppState, registerNativeCapabilities } from "@/lib/native-capabilities";
import {
  getPlatformStorage,
  registerNativePlatformStorage,
  type KeyValueStore,
} from "@/lib/platform-storage";

type SecureCredentialsPlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>("SecureCredentials");
let nativeStorageRegistered = false;

const credentialStore: KeyValueStore = {
  async getItem(key) { return (await SecureCredentials.get({ key })).value; },
  async setItem(key, value) { await SecureCredentials.set({ key, value }); },
  async removeItem(key) { await SecureCredentials.remove({ key }); },
};

const journalStore: KeyValueStore = {
  async getItem(key) { return (await Preferences.get({ key })).value; },
  async setItem(key, value) { await Preferences.set({ key, value }); },
  async removeItem(key) { await Preferences.remove({ key }); },
};

function ensureNativeStorageRegistered() {
  if (nativeStorageRegistered) return;
  registerNativePlatformStorage(async () => ({ credentials: credentialStore, journal: journalStore }));
  nativeStorageRegistered = true;
}

/**
 * Boots Capacitor-only integrations behind the Android build flag. The same
 * component is rendered by the normal web/server build, but remains inert when
 * `enabled` is false so no native plugin is required for static web output.
 */
export function NativeRuntime({
  children,
  enabled,
}: Readonly<{ children: React.ReactNode; enabled: boolean }>) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(!enabled);
  const nativeCapabilities = useMemo(() => createCapacitorNativeCapabilities(), []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let removeCameraRestore = async () => {};
    let removeAppState = async () => {};
    let removePause = async () => {};
    let removeResume = async () => {};
    let lifecycleRevision = 0;
    let snapshotSequence = 0;
    let publishedSnapshotSequence = 0;
    // Native startup is fail-closed: automatic GPS stays off until Capacitor
    // confirms that the Activity is active.
    publishNativeAppState(false);
    ensureNativeStorageRegistered();
    const unregisterCapabilities = registerNativeCapabilities(nativeCapabilities);

    // Storage is the only required integration: the journal must not render until
    // encrypted credentials and Preferences are available.
    void getPlatformStorage().then(() => {
      if (active) {
        setError("");
        setReady(true);
      }
    }).catch((reason: unknown) => {
      if (!active) return;
      setReady(false);
      setError(reason instanceof Error ? reason.message : "Native storage could not be opened.");
    });

    // Cosmetic chrome and Android process-restoration support are optional. A
    // device/plugin mismatch must not strand an otherwise usable journal.
    void SystemBars.setStyle({ style: SystemBarsStyle.Light }).catch(() => undefined);
    void App.addListener("appRestoredResult", queueRestoredCameraPhoto).then(async (listener) => {
      const remove = async () => listener.remove();
      if (active) removeCameraRestore = remove;
      else await remove();
    }).catch(() => undefined);
    const appStateRegistration = App.addListener("appStateChange", ({ isActive }) => {
      if (!active) return;
      lifecycleRevision += 1;
      publishNativeAppState(isActive);
    }).then(async (listener) => {
      const remove = async () => listener.remove();
      if (active) removeAppState = remove;
      else await remove();
    });
    const pauseRegistration = App.addListener("pause", () => {
      if (!active) return;
      lifecycleRevision += 1;
      publishNativeAppState(false);
    }).then(async (listener) => {
      const remove = async () => listener.remove();
      if (active) removePause = remove;
      else await remove();
    });
    const resumeRegistration = App.addListener("resume", () => {
      if (!active) return;
      lifecycleRevision += 1;
      publishNativeAppState(true);
    }).then(async (listener) => {
      const remove = async () => listener.remove();
      if (active) removeResume = remove;
      else await remove();
    });
    const reconcileAppState = async () => {
      const snapshotRevision = lifecycleRevision;
      const sequence = ++snapshotSequence;
      try {
        const { isActive } = await App.getState();
        if (active && lifecycleRevision === snapshotRevision && sequence > publishedSnapshotSequence) {
          publishedSnapshotSequence = sequence;
          publishNativeAppState(isActive);
        }
      } catch { /* Keep automatic location off until a lifecycle event arrives. */ }
    };
    // Read state immediately after listener registration begins so slow plugin
    // promises cannot strand GPS. Reconcile once more after they settle to
    // close the snapshot/subscription gap without overriding a newer event.
    void reconcileAppState();
    void Promise.allSettled([appStateRegistration, pauseRegistration, resumeRegistration]).then(reconcileAppState);

    return () => {
      active = false;
      unregisterCapabilities();
      void removeCameraRestore();
      void removeAppState();
      void removePause();
      void removeResume();
    };
  }, [attempt, enabled, nativeCapabilities]);

  useEffect(() => {
    if (!enabled || !ready) return;
    let removeBack = async () => {};
    let active = true;
    void App.addListener("backButton", () => {
      if (!dispatchNativeBack()) return;
      if (hasNativeBackHistory(window.location)) window.history.back();
      else void App.minimizeApp();
    }).then((listener) => {
      const remove = async () => listener.remove();
      if (active) removeBack = remove;
      else void remove();
    }).catch(() => undefined);
    return () => {
      active = false;
      void removeBack();
    };
  }, [enabled, ready]);

  if (ready) return children;
  return (
    <main className="native-bootstrap" role={error ? "alert" : "status"}>
      <strong>Parkdex</strong>
      {error
        ? <><p>{error}</p><button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Try again</button></>
        : <p>Opening your field journal…</p>}
    </main>
  );
}
