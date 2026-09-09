"use client";

import { App } from "@capacitor/app";
import { registerPlugin, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { useEffect, useMemo, useState } from "react";

import { createCapacitorNativeCapabilities } from "@/lib/capacitor-native-capabilities";
import { registerNativeCapabilities } from "@/lib/native-capabilities";
import { openNativeGoogleAuthorization, startNativeOAuthBridge } from "@/lib/native-oauth";
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

function dispatchBack() {
  return window.dispatchEvent(new CustomEvent("parkdex:back", { cancelable: true }));
}

export function NativeRuntime({
  children,
  enabled,
}: Readonly<{ children: React.ReactNode; enabled: boolean }>) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(!enabled);
  const nativeCapabilities = useMemo(() => ({
    ...createCapacitorNativeCapabilities(),
    openExternalAuth: openNativeGoogleAuthorization,
  }), []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let removeOAuth = async () => {};
    ensureNativeStorageRegistered();
    const unregisterCapabilities = registerNativeCapabilities(nativeCapabilities);
    void Promise.all([
      getPlatformStorage(),
      SystemBars.setStyle({ style: SystemBarsStyle.Light }),
      startNativeOAuthBridge().then(async (remove) => {
        if (active) removeOAuth = remove;
        else await remove();
      }),
    ]).then(() => {
      if (active) setReady(true);
    }).catch((reason: unknown) => {
      if (!active) return;
      setReady(false);
      setError(reason instanceof Error ? reason.message : "Native storage could not be opened.");
    });
    return () => {
      active = false;
      unregisterCapabilities();
      void removeOAuth();
    };
  }, [attempt, enabled, nativeCapabilities]);

  useEffect(() => {
    if (!enabled || !ready) return;
    let removeBack = async () => {};
    let active = true;
    void App.addListener("backButton", () => {
      if (!dispatchBack()) return;
      if (window.location.pathname !== "/" || window.location.hash) window.history.back();
      else void App.minimizeApp();
    }).then((listener) => {
      const remove = async () => listener.remove();
      if (active) removeBack = remove;
      else void remove();
    });
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
