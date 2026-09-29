"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { confirmPasswordReset, loadAuthConfig, requestGoogleAuthorization, requestPasswordReset, type AuthConfig } from "@/lib/account";
import { notifyError } from "@/lib/application-notifications";
import { navigationUrl, readNavigation } from "@/lib/navigation";
import { notifyNavigationChange } from "@/lib/use-public-navigation";

const GOOGLE_VERIFIER_KEY = "parkdex:google-code-verifier:v1";

export function cleanAuthParams(names: string[]) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href), fragment = new URLSearchParams(url.hash.slice(1));
  names.forEach((name) => { url.searchParams.delete(name); fragment.delete(name); });
  const hash = fragment.toString(); url.hash = hash ? `#${hash}` : "";
  const state = readNavigation(url.href);
  const next = navigationUrl(url.href, { ...state, view: "account", settingsOpen: names.includes("action") || url.pathname === "/settings", selectedId: null });
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.replaceState(window.history.state, "", next);
  notifyNavigationChange();
}

function emailToken(name: "resetToken" | "verificationToken") {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.hash.slice(1)).get(name) ?? "";
}

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256Challenge(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function useAccountController({
  apiBaseUrl,
  onGoogleAuth,
  onConfirmVerification,
  onRequestVerification,
  setFormBusy,
  setError,
  setNotice,
}: {
  apiBaseUrl: string;
  onGoogleAuth: (code: string, state: string, verifier: string) => Promise<void>;
  onConfirmVerification: (token: string) => Promise<void>;
  onRequestVerification: () => Promise<void>;
  setFormBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
}) {
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [resetToken] = useState(emailToken("resetToken"));
  const callbackHandled = useRef(false);

  useEffect(() => {
    let active = true;
    void loadAuthConfig(apiBaseUrl).then((config) => {
      if (active) setAuthConfig(config);
    }).catch(() => {
      if (active) setAuthConfig({ googleEnabled: false, emailEnabled: false });
    });
    return () => { active = false; };
  }, [apiBaseUrl]);

  useEffect(() => { if (resetToken) cleanAuthParams(["resetToken"]); }, [resetToken]);

  useEffect(() => {
    if (callbackHandled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code"), state = params.get("state"), oauthError = params.get("error");
    const verificationToken = emailToken("verificationToken");
    if (!code && !verificationToken && !oauthError) return;
    callbackHandled.current = true;
    if (verificationToken) cleanAuthParams(["verificationToken"]);

    async function completeCallback() {
      if (oauthError) {
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY);
        cleanAuthParams(["code", "error", "error_description", "state"]);
        throw new Error(oauthError === "access_denied" ? "Google sign-in was cancelled. You can try again." : "Google could not complete sign-in. Please try again.");
      }
      if (code && state) {
        const verifier = window.sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
        window.sessionStorage.removeItem(GOOGLE_VERIFIER_KEY);
        cleanAuthParams(["code", "state"]);
        if (!verifier) throw new Error("Google sign-in expired. Please try again.");
        await onGoogleAuth(code, state, verifier);
        setNotice("Signed in with Google.");
        return;
      }
      if (verificationToken) {
        await onConfirmVerification(verificationToken);
        setNotice("Email verified. Your field journal is ready.");
        cleanAuthParams(["verificationToken"]);
        return;
      }
      throw new Error("The sign-in response was incomplete. Please try again.");
    }

    queueMicrotask(() => {
      setFormBusy(true);
      setError("");
      void completeCallback()
        .catch((caught) => {
          const message = caught instanceof Error ? caught.message : "Could not complete this account link.";
          setError(message);
          notifyError(caught, "Could not complete this account link.");
        })
        .finally(() => setFormBusy(false));
    });
  }, [onConfirmVerification, onGoogleAuth, setError, setFormBusy, setNotice]);

  const startGoogleAuthorization = useCallback(async () => {
    setFormBusy(true);
    setError("");
    try {
      const verifier = randomVerifier();
      window.sessionStorage.setItem(GOOGLE_VERIFIER_KEY, verifier);
      window.location.assign(await requestGoogleAuthorization(apiBaseUrl, await sha256Challenge(verifier)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start Google sign-in.");
      notifyError(caught, "Could not start Google sign-in.");
      setFormBusy(false);
    }
  }, [apiBaseUrl, setError, setFormBusy]);

  const resendVerification = useCallback(async () => {
    setFormBusy(true);
    setError("");
    try {
      await onRequestVerification();
      setNotice("Verification email sent. Check your inbox.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send a verification email.");
      notifyError(caught, "Could not send a verification email.");
    } finally {
      setFormBusy(false);
    }
  }, [onRequestVerification, setError, setFormBusy, setNotice]);

  return {
    authConfig,
    resetToken,
    startGoogleAuthorization,
    resendVerification,
    requestPasswordReset: (email: string) => requestPasswordReset(apiBaseUrl, email),
    confirmPasswordReset: (token: string, password: string) => confirmPasswordReset(apiBaseUrl, token, password),
  };
}
