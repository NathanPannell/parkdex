import { Capacitor } from "@capacitor/core";
import type { ContentStore } from "./contracts";
import { NativeContentStore } from "./store.native";
import { WebContentStore } from "./store.web";

/** Create the storage backend for the current Capacitor platform. */
export function createContentStore(): ContentStore {
  return Capacitor.isNativePlatform() ? new NativeContentStore() : new WebContentStore();
}
