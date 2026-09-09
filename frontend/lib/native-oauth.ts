import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export const NATIVE_OAUTH_CALLBACK_EVENT = "parkdex:oauth-callback";
export const NATIVE_OAUTH_CALLBACK_READY_EVENT = "parkdex:oauth-callback-ready";
const PENDING_STATE_KEY = "parkdex:native-oauth-state:v1";
const AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const AUTHORIZATION_PATH = "/o/oauth2/v2/auth";
const CALLBACK_ORIGIN = "https://staging.parkdex.app";
const CALLBACK_PATH = "/auth/google/callback";
const CALLBACK_URL = `${CALLBACK_ORIGIN}${CALLBACK_PATH}`;

export type NativeOAuthCallback = { code: string; state: string };
let callbackConsumed = false;
let callbackListenerReady = false;
let queuedCallbackUrl: string | undefined;

function oneQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] ? values[0] : null;
}

export function parseNativeOAuthCallback(value: string): NativeOAuthCallback | null {
  try {
    const url = new URL(value);
    if (url.origin !== CALLBACK_ORIGIN || url.pathname !== CALLBACK_PATH || url.hash) return null;
    const code = oneQueryValue(url, "code");
    const state = oneQueryValue(url, "state");
    return code && state ? { code, state } : null;
  } catch {
    return null;
  }
}

async function pendingState(): Promise<string | null> {
  return (await Preferences.get({ key: PENDING_STATE_KEY })).value;
}

async function consumeCallback(value: string): Promise<NativeOAuthCallback | null> {
  const callback = parseNativeOAuthCallback(value);
  const expectedState = await pendingState();
  if (!callback || callbackConsumed || !expectedState || callback.state !== expectedState) return null;
  callbackConsumed = true;
  await Preferences.remove({ key: PENDING_STATE_KEY });
  return callback;
}

async function dispatchCallback(value: string): Promise<void> {
  const callback = await consumeCallback(value);
  if (!callback) return;
  try {
    await Browser.close();
  } finally {
    window.dispatchEvent(new CustomEvent<NativeOAuthCallback>(NATIVE_OAUTH_CALLBACK_EVENT, { detail: callback }));
  }
}

function queueCallback(value: string): void {
  if (!parseNativeOAuthCallback(value) || queuedCallbackUrl) return;
  queuedCallbackUrl = value;
  void flushQueuedCallback().catch(() => console.error("Native OAuth callback could not be processed."));
}

async function flushQueuedCallback(): Promise<void> {
  if (!callbackListenerReady || !queuedCallbackUrl) return;
  const value = queuedCallbackUrl;
  queuedCallbackUrl = undefined;
  await dispatchCallback(value);
}

function validAuthorizationUrl(value: string): URL {
  const url = new URL(value);
  const challenge = oneQueryValue(url, "code_challenge");
  const challengeMethod = oneQueryValue(url, "code_challenge_method");
  const redirectUri = oneQueryValue(url, "redirect_uri");
  const responseType = oneQueryValue(url, "response_type");
  const state = oneQueryValue(url, "state");
  if (
    url.origin !== AUTHORIZATION_ORIGIN ||
    url.pathname !== AUTHORIZATION_PATH ||
    redirectUri !== CALLBACK_URL ||
    responseType !== "code" ||
    challengeMethod !== "S256" ||
    !challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
    !state
  ) {
    throw new Error("Refusing an unrecognized Google authorization URL.");
  }
  return url;
}

export async function openNativeGoogleAuthorization(value: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error("Native OAuth is unavailable in this browser.");
  const url = validAuthorizationUrl(value);
  const state = oneQueryValue(url, "state");
  if (!state) throw new Error("Refusing an authorization request without state.");
  callbackConsumed = false;
  queuedCallbackUrl = undefined;
  await Preferences.set({ key: PENDING_STATE_KEY, value: state });
  await Browser.open({ url: url.toString() });
}

export async function startNativeOAuthBridge(): Promise<() => Promise<void>> {
  if (!Capacitor.isNativePlatform()) return async () => {};
  callbackListenerReady = false;
  const onReady = () => {
    callbackListenerReady = true;
    void flushQueuedCallback().catch(() => console.error("Native OAuth callback could not be processed."));
  };
  window.addEventListener(NATIVE_OAUTH_CALLBACK_READY_EVENT, onReady);
  const listener: PluginListenerHandle = await App.addListener("appUrlOpen", ({ url }) => {
    queueCallback(url);
  });
  const launch = await App.getLaunchUrl();
  if (launch?.url) queueCallback(launch.url);
  return async () => {
    window.removeEventListener(NATIVE_OAUTH_CALLBACK_READY_EVENT, onReady);
    await listener.remove();
  };
}
