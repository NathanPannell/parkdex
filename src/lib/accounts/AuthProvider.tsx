import { App as CapacitorApp } from "@capacitor/app";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clearAccountProgressAfterServerDeletion,
  getLastSuccessfulBackupAt,
  getLastCompleteSyncAt,
  initializePersonalStore,
  listPersonalClaims,
  listPersonalPhotos,
  reserveGuestClaimsForAccount,
  setLastSuccessfulBackupAt,
  setLastCompleteSyncAt,
} from "./personalStore";
import { coalesceProgressSync, persistLastCompleteSyncTimestamp, persistSuccessfulOutboundBackupTimestamp, runProgressSyncWhenReady, shouldScheduleAccountBackup, type ProgressSyncResult } from "./progressSync";
import {
  AuthHttpError,
  clearLocalNativeSession,
  completeGoogleSignIn,
  confirmEmailVerification,
  confirmPasswordReset,
  createGoogleChallenge,
  deleteCurrentAccount,
  fetchAuthConfig,
  fetchAuthenticated,
  getCurrentAccount,
  isNativeAccountRuntime,
  isValidGoogleWebClientId,
  linkGoogleAccount,
  loginAccount,
  logoutAccount,
  reauthenticateGoogle,
  reauthenticatePassword,
  readLocalNativeSession,
  registerAccount,
  renewSession,
  requestEmailVerification,
  requestPasswordReset,
  type AccountProfile,
  type AuthConfig,
  type DeletionResponse,
  type GooglePurpose,
} from "./authClient";
import { listenForNativeAuthLinks, parseNativeAuthLink, resolveGoogleWebClientId } from "./nativeIdentity";
import { getAccountBackupConnectivity, subscribeAccountBackupConnectivity, type AccountBackupConnectivity } from "./accountBackupConnectivity";

const LAST_ACCOUNT_KEY = "kip-account-last-id";

export type AuthPhase = "starting" | "guest" | "authenticated" | "offline-account" | "error";
export type BackupPhase = "idle" | "syncing" | "success" | "pending" | "offline" | "error";
export type BackupStatus = {
  phase: BackupPhase;
  claimsPending: number;
  photosPending: number;
  message: string | null;
  updatedAt: number | null;
  lastSyncedAt: number | null;
};
export type AuthAction = { kind: "password_reset"; token: string } | null;
export type SyncBackupOptions = { retryAfterFlight?: boolean };

type AuthState = {
  phase: AuthPhase;
  account: AccountProfile | null;
  offlineAccountId: string | null;
  config: AuthConfig | null;
  startupError: string | null;
  notice: { kind: "success" | "error"; message: string } | null;
  pendingAction: AuthAction;
  backup: BackupStatus;
  progressRevision: number;
};

type AuthContextValue = AuthState & {
  isNative: boolean;
  ownerAccountId: string | null;
  googleWebClientId: string | null;
  refresh: () => Promise<void>;
  signUp: (input: { email: string; password: string; displayName: string }) => Promise<AccountProfile>;
  signIn: (input: { email: string; password: string }) => Promise<AccountProfile>;
  signInGoogle: (idToken: string, nonce: string) => Promise<AccountProfile>;
  linkGoogle: (idToken: string, nonce: string) => Promise<void>;
  signOut: () => Promise<void>;
  sendVerification: () => Promise<void>;
  verifyEmail: (token: string) => Promise<void>;
  requestReset: (email: string) => Promise<void>;
  resetPassword: (token: string, password: string) => Promise<void>;
  clearPendingAction: () => void;
  clearNotice: () => void;
  reauthPassword: (password: string) => Promise<void>;
  reauthGoogle: (idToken: string, nonce: string) => Promise<void>;
  googleChallenge: (purpose: GooglePurpose) => ReturnType<typeof createGoogleChallenge>;
  syncBackup: (options?: SyncBackupOptions) => Promise<ProgressSyncResult | null>;
  deleteAccount: () => Promise<DeletionResponse>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPTY_BACKUP: BackupStatus = { phase: "idle", claimsPending: 0, photosPending: 0, message: null, updatedAt: null, lastSyncedAt: null };
const EMPTY_AUTH: AuthState = {
  phase: "starting",
  account: null,
  offlineAccountId: null,
  config: null,
  startupError: null,
  notice: null,
  pendingAction: null,
  backup: EMPTY_BACKUP,
  progressRevision: 0,
};

function lastAccountId() {
  try {
    const value = localStorage.getItem(LAST_ACCOUNT_KEY);
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberAccount(accountId: string | null) {
  try {
    if (accountId) localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
    else localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // The current session remains usable when local browser storage is unavailable.
  }
}

function isUnauthorized(error: unknown) {
  return error instanceof AuthHttpError && error.status === 401;
}

function networkMessage(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return "You're offline. Your saved Dex stays on this device until you reconnect.";
  if (error instanceof AuthHttpError && error.status >= 500) return "The account service is having trouble. Try again shortly.";
  return "The account service could not be reached. Check your connection and try again.";
}

class GuestReservationFailedError extends Error {
  constructor() {
    super("Saved progress could not be prepared for this account. Retry while this device can access its saved Dex.");
    this.name = "GuestReservationFailedError";
  }
}

function abortProgressRequests(controllers: Map<string, AbortController>) {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
}

function parseWebAuthAction(): { kind: "verification" | "password_reset"; token: string } | null {
  if (typeof window === "undefined" || !["/account", "/account/"].includes(window.location.pathname)) return null;
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const verifyTokens = params.getAll("verificationToken");
  const resetTokens = params.getAll("resetToken");
  if (verifyTokens.length + resetTokens.length !== 1) return null;
  const token = (verifyTokens[0] ?? resetTokens[0] ?? "").trim();
  if (!token || token.length > 2048) return null;
  params.delete("verificationToken");
  params.delete("resetToken");
  const cleanHash = params.toString() ? `#${params.toString()}` : "";
  history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}${cleanHash}`);
  return { kind: verifyTokens.length === 1 ? "verification" : "password_reset", token };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(EMPTY_AUTH);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionGeneration = useRef(0);
  const authOperationGeneration = useRef(0);
  const refreshInFlight = useRef<{ operation: number; promise: Promise<void> } | null>(null);
  const lastRenewalAt = useRef(0);
  const syncInFlight = useRef(new Map<string, Promise<ProgressSyncResult | null>>());
  const syncRerunRequested = useRef(new Set<string>());
  const syncAbortControllers = useRef(new Map<string, AbortController>());
  const syncRef = useRef<(options?: SyncBackupOptions) => Promise<ProgressSyncResult | null>>(async () => null);
  const refreshRef = useRef<(expectedOverride?: string | null) => Promise<void>>(async () => {});
  const resumeInFlight = useRef<Promise<void> | null>(null);
  const lastResumeAt = useRef(0);
  const foreground = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
  const isNative = isNativeAccountRuntime();

  const establishAccount = useCallback(async (account: AccountProfile, operation?: number) => {
    const startingSessionGeneration = sessionGeneration.current;
    const current = () => (operation === undefined || authOperationGeneration.current === operation) && sessionGeneration.current === startingSessionGeneration;
    if (!current()) throw new Error("The account session changed before this action finished.");
    try {
      await reserveGuestClaimsForAccount(account.id);
    } catch {
      if (current()) {
        setState((value) => ({ ...value, phase: "error", account: null, offlineAccountId: null, backup: EMPTY_BACKUP, startupError: new GuestReservationFailedError().message }));
      }
      throw new GuestReservationFailedError();
    }
    if (!current()) throw new Error("The account session changed before this action finished.");
    let lastSuccessfulBackupAt: number | null = null;
    try { lastSuccessfulBackupAt = await getLastSuccessfulBackupAt(account.id); }
    catch { /* A local status read must not prevent a verified account from opening. */ }
    let lastCompleteSyncAt: number | null = null;
    try { lastCompleteSyncAt = await getLastCompleteSyncAt(account.id); }
    catch { /* A local status read must not prevent a verified account from opening. */ }
    if (!current()) throw new Error("The account session changed before this action finished.");
    abortProgressRequests(syncAbortControllers.current);
    syncRerunRequested.current.clear();
    sessionGeneration.current += 1;
    lastRenewalAt.current = Date.now();
    rememberAccount(account.id);
    setState((current) => ({
      ...current,
      phase: "authenticated",
      account,
      offlineAccountId: null,
      startupError: null,
      notice: null,
      backup: { ...EMPTY_BACKUP, updatedAt: lastSuccessfulBackupAt, lastSyncedAt: lastCompleteSyncAt },
      progressRevision: current.progressRevision + 1,
    }));
    return account;
  }, []);

  const refresh = useCallback((expectedOverride?: string | null) => {
    if (refreshInFlight.current?.operation === authOperationGeneration.current) return refreshInFlight.current.promise;
    const operation = ++authOperationGeneration.current;
    const current = () => authOperationGeneration.current === operation;
    const expectedAccountId = expectedOverride !== undefined
      ? expectedOverride
      : stateRef.current.account?.id ?? stateRef.current.offlineAccountId ?? lastAccountId();
    const task = (async () => {
      setState((value) => ({ ...value, startupError: null }));
      try {
        await initializePersonalStore();
      } catch {
        if (current()) setState((value) => ({ ...value, phase: "error", startupError: "Saved progress could not be opened. Your existing local data was left untouched." }));
        return;
      }

      try {
        const config = await fetchAuthConfig();
        if (current()) setState((value) => ({ ...value, config }));
      } catch (error) {
        if (current()) setState((value) => ({ ...value, config: null, startupError: networkMessage(error) }));
      }
      if (!current()) return;

      let localSession: Awaited<ReturnType<typeof readLocalNativeSession>> = null;
      if (isNative) {
        try { localSession = await readLocalNativeSession(); }
        catch {
          if (!current()) return;
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          setState((value) => ({ ...value, phase: "guest", account: null, offlineAccountId: null }));
          rememberAccount(null);
          return;
        }
        if (!current()) return;
        if (!localSession) {
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          setState((value) => ({ ...value, phase: "guest", account: null, offlineAccountId: null, backup: EMPTY_BACKUP }));
          rememberAccount(null);
          return;
        }
      }

      try {
        let account = await getCurrentAccount(expectedAccountId ?? undefined);
        if (!current()) return;
        // /me is intentionally usable to discover a cookie session, so compare its
        // result locally before any account-scoped renew or progress operation.
        if (expectedAccountId && account.id.toLowerCase() !== expectedAccountId.toLowerCase()) {
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          rememberAccount(null);
          setState((value) => ({ ...value, phase: "guest", account: null, offlineAccountId: null, backup: EMPTY_BACKUP, startupError: "A different account is active in another tab. Sign in again here to open its saved Dex." }));
          return;
        }

        const nativeNeedsRenewal = !!localSession && localSession.expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000;
        const webNeedsRenewal = !isNative && Date.now() - lastRenewalAt.current >= 12 * 60 * 60 * 1000;
        if (nativeNeedsRenewal || webNeedsRenewal) {
          try {
            await renewSession(account.id);
            if (!current()) return;
            lastRenewalAt.current = Date.now();
          } catch (error) {
            if (!current()) return;
            if (isUnauthorized(error)) throw error;
            // A transient renew failure does not hide an account whose session
            // was just confirmed by /me. A later foreground event can retry it.
          }
        }
        if (current()) await establishAccount(account, operation);
      } catch (error) {
        if (!current()) return;
        if (error instanceof GuestReservationFailedError) return;
        if (isUnauthorized(error)) {
          if (isNative) await clearLocalNativeSession().catch(() => {});
          if (!current()) return;
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          rememberAccount(null);
          setState((value) => ({ ...value, phase: "guest", account: null, offlineAccountId: null, backup: EMPTY_BACKUP, startupError: null }));
          return;
        }
        const cachedId = expectedAccountId ?? lastAccountId();
        if (cachedId) {
          let lastSuccessfulBackupAt: number | null = null;
          try { lastSuccessfulBackupAt = await getLastSuccessfulBackupAt(cachedId); }
          catch { /* Keep offline access available if status metadata cannot be read. */ }
          let lastCompleteSyncAt: number | null = null;
          try { lastCompleteSyncAt = await getLastCompleteSyncAt(cachedId); }
          catch { /* Keep offline access available if status metadata cannot be read. */ }
          if (!current()) return;
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          setState((value) => ({
            ...value,
            phase: "offline-account",
            account: null,
            offlineAccountId: cachedId,
            backup: { ...EMPTY_BACKUP, phase: "offline", message: networkMessage(error), updatedAt: lastSuccessfulBackupAt, lastSyncedAt: lastCompleteSyncAt },
            startupError: networkMessage(error),
          }));
        } else {
          abortProgressRequests(syncAbortControllers.current);
          syncRerunRequested.current.clear();
          sessionGeneration.current += 1;
          setState((value) => ({ ...value, phase: "guest", account: null, offlineAccountId: null, backup: EMPTY_BACKUP, startupError: networkMessage(error) }));
        }
      }
    })();
    refreshInFlight.current = { operation, promise: task };
    void task.then(
      () => { if (refreshInFlight.current?.promise === task) refreshInFlight.current = null; },
      () => { if (refreshInFlight.current?.promise === task) refreshInFlight.current = null; },
    );
    return task;
  }, [establishAccount, isNative]);
  refreshRef.current = refresh;

  useEffect(() => { void refresh(); }, [refresh]);

  const signUp = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const operation = ++authOperationGeneration.current;
    return establishAccount(await registerAccount(input), operation);
  }, [establishAccount]);
  const signIn = useCallback(async (input: { email: string; password: string }) => {
    const operation = ++authOperationGeneration.current;
    return establishAccount(await loginAccount(input), operation);
  }, [establishAccount]);
  const signInGoogle = useCallback(async (idToken: string, nonce: string) => {
    const operation = ++authOperationGeneration.current;
    return establishAccount(await completeGoogleSignIn(idToken, nonce, isNative ? "native" : "web"), operation);
  }, [establishAccount, isNative]);
  const linkGoogle = useCallback(async (idToken: string, nonce: string) => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId) throw new Error("Sign in again before linking Google.");
    const generation = sessionGeneration.current;
    const account = await linkGoogleAccount(idToken, nonce, isNative ? "native" : "web", accountId);
    if (sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) throw new Error("The signed-in account changed. Retry Google linking.");
    setState((current) => ({ ...current, account, notice: { kind: "success", message: "Google is now linked to this account." } }));
  }, [isNative]);

  const signOut = useCallback(async () => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId) throw new Error("Reconnect before signing out so Parkdex can revoke this session safely.");
    const operation = ++authOperationGeneration.current;
    const generation = sessionGeneration.current;
    abortProgressRequests(syncAbortControllers.current);
    syncRerunRequested.current.clear();
    await logoutAccount(accountId);
    if (authOperationGeneration.current !== operation || sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) return;
    let localCleanupFailed = false;
    if (isNative) {
      try { await clearLocalNativeSession(); }
      catch { localCleanupFailed = true; }
    }
    if (authOperationGeneration.current !== operation || sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) return;
    abortProgressRequests(syncAbortControllers.current);
    syncRerunRequested.current.clear();
    sessionGeneration.current += 1;
    rememberAccount(null);
    setState((current) => ({ ...current, phase: "guest", account: null, offlineAccountId: null, backup: EMPTY_BACKUP, notice: { kind: localCleanupFailed ? "error" : "success", message: localCleanupFailed ? "You signed out, but this device could not clear its secure session. Reopen the app while online to finish." : "You signed out. This account's Dex remains saved separately on this device." }, progressRevision: current.progressRevision + 1 }));
  }, [isNative]);

  const sendVerification = useCallback(async () => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId) throw new Error("Sign in again before requesting a verification link.");
    const generation = sessionGeneration.current;
    await requestEmailVerification(accountId);
    if (sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) throw new Error("The signed-in account changed. Retry the verification request.");
  }, []);
  const verifyEmail = useCallback(async (token: string) => {
    const operation = authOperationGeneration.current;
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    await confirmEmailVerification(token);
    if (authOperationGeneration.current !== operation) return;
    let account = stateRef.current.account;
    if (accountId) account = await getCurrentAccount(accountId);
    if (authOperationGeneration.current !== operation || (accountId && stateRef.current.account?.id !== accountId)) return;
    setState((current) => ({ ...current, account, notice: { kind: "success", message: "Your email address is verified." } }));
  }, []);
  const requestReset = useCallback(async (email: string) => { await requestPasswordReset(email); }, []);
  const resetPassword = useCallback(async (token: string, password: string) => {
    await confirmPasswordReset(token, password);
    setState((current) => ({ ...current, pendingAction: null, notice: { kind: "success", message: "Your password was changed. Sign in with the new password." } }));
  }, []);
  const clearPendingAction = useCallback(() => setState((current) => ({ ...current, pendingAction: null })), []);
  const clearNotice = useCallback(() => setState((current) => ({ ...current, notice: null })), []);
  const reauthPassword = useCallback(async (password: string) => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId) throw new Error("Sign in again before verifying this account.");
    const generation = sessionGeneration.current;
    await reauthenticatePassword(password, accountId);
    if (sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) throw new Error("The signed-in account changed. Verify it again before continuing.");
  }, []);
  const reauthGoogle = useCallback(async (idToken: string, nonce: string) => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId) throw new Error("Sign in again before verifying this account.");
    const generation = sessionGeneration.current;
    await reauthenticateGoogle(idToken, nonce, isNative ? "native" : "web", accountId);
    if (sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) throw new Error("The signed-in account changed. Verify it again before continuing.");
  }, [isNative]);
  const googleChallenge = useCallback((purpose: GooglePurpose) => {
    const accountId = purpose === "sign_in" ? undefined : stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : undefined;
    if (purpose !== "sign_in" && !accountId) throw new Error("Sign in again before verifying this account.");
    return createGoogleChallenge(purpose, accountId);
  }, []);

  const syncBackup = useCallback((options: SyncBackupOptions = {}): Promise<ProgressSyncResult | null> => {
    const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
    if (!accountId || !foreground.current) return Promise.resolve(null);
    const generation = sessionGeneration.current;
    const flightKey = `${generation}:${accountId.toLowerCase()}`;
    const isCurrentSession = () => sessionGeneration.current === generation && stateRef.current.phase === "authenticated" && stateRef.current.account?.id?.toLowerCase() === accountId.toLowerCase();
    const setUnavailableStatus = async (connected: boolean) => {
      const owner = { kind: "account" as const, accountId };
      const [claims, photos] = await Promise.all([listPersonalClaims(owner), listPersonalPhotos(owner)]);
      if (isCurrentSession()) {
        setState((current) => sessionGeneration.current === generation && current.account?.id?.toLowerCase() === accountId.toLowerCase()
          ? { ...current, backup: {
            phase: connected ? "pending" : "offline",
            claimsPending: claims.filter((claim) => claim.syncState !== "acknowledged").length,
            photosPending: photos.filter((photo) => photo.backupState === "pending").length,
            message: "Your saved Dex stays on this device.",
            updatedAt: current.backup.updatedAt,
            lastSyncedAt: current.backup.lastSyncedAt,
          } }
          : current);
      }
      return null;
    };
    const run = async (): Promise<ProgressSyncResult | null> => {
      let controller: AbortController | null = null;
      try {
        const connectivity = await getAccountBackupConnectivity().catch(() => ({ connected: false, allowed: false }));
        if (!isCurrentSession() || !foreground.current) return null;
        if (!connectivity.connected || !connectivity.allowed) return setUnavailableStatus(connectivity.connected);

        controller = new AbortController();
        syncAbortControllers.current.set(flightKey, controller);
        setState((current) => sessionGeneration.current === generation && current.account?.id?.toLowerCase() === accountId.toLowerCase()
          ? { ...current, backup: { ...current.backup, phase: "syncing", message: null } }
          : current);
        const result = await runProgressSyncWhenReady({
          accountId,
          fetchAuthenticated: (input, init) => fetchAuthenticated(input, { ...init, signal: controller?.signal }, accountId),
          isCurrent: isCurrentSession,
        }, () => foreground.current, connectivity);
        if (!result) {
          if (isCurrentSession() && foreground.current) {
            const latest = await getAccountBackupConnectivity().catch(() => ({ connected: false, allowed: false }));
            if (!latest.connected || !latest.allowed) await setUnavailableStatus(latest.connected);
          }
          return null;
        }
        if (!isCurrentSession()) return result;

        let updatedAt = stateRef.current.backup.updatedAt;
        updatedAt = await persistSuccessfulOutboundBackupTimestamp(accountId, result, updatedAt, {
          get: getLastSuccessfulBackupAt,
          set: setLastSuccessfulBackupAt,
        });
        if (!isCurrentSession()) return result;

        let lastSyncedAt = stateRef.current.backup.lastSyncedAt;
        lastSyncedAt = await persistLastCompleteSyncTimestamp(accountId, result, lastSyncedAt, {
          get: getLastCompleteSyncAt,
          set: setLastCompleteSyncAt,
        }, async () => {
          const currentConnectivity = await getAccountBackupConnectivity().catch(() => ({ connected: false, allowed: false }));
          return isCurrentSession() && foreground.current && currentConnectivity.connected && currentConnectivity.allowed;
        });
        if (!isCurrentSession()) return result;

        const afterSyncConnectivity = await getAccountBackupConnectivity().catch(() => ({ connected: false, allowed: false }));
        const offline = !afterSyncConnectivity.connected;
        const hasPending = result.claimsPending + result.photosPending > 0;
        const waitingForConnection = afterSyncConnectivity.connected && !afterSyncConnectivity.allowed && (hasPending || result.issues.length > 0);
        const phase: BackupPhase = offline ? "offline" : result.issues.length ? "error" : hasPending || waitingForConnection ? "pending" : "success";
        const message = offline
          ? "Your saved Dex stays on this device."
          : waitingForConnection
            ? "Your saved Dex stays on this device."
            : result.issues.length
              ? result.issues.some((issue) => issue.operation === "photo-upload")
                ? "Some saved photos remain on this device because they could not be backed up."
                : "Some saved progress is waiting for backup. It will sync when a usable connection is available."
              : hasPending
                ? "Your saved Dex stays on this device."
                : "Your Dex is backed up.";
        setState((current) => sessionGeneration.current === generation && current.account?.id?.toLowerCase() === accountId.toLowerCase()
          ? { ...current, backup: { phase, claimsPending: result.claimsPending, photosPending: result.photosPending, message, updatedAt, lastSyncedAt }, progressRevision: current.progressRevision + 1 }
          : current);
        return result;
      } catch {
        if (isCurrentSession() && foreground.current) setState((current) => ({ ...current, backup: { ...current.backup, phase: "error", message: "Progress backup couldn't finish. Your local Dex is safe." } }));
        return null;
      } finally {
        if (controller && syncAbortControllers.current.get(flightKey) === controller) syncAbortControllers.current.delete(flightKey);
      }
    };
    return coalesceProgressSync(
      syncInFlight.current,
      syncRerunRequested.current,
      flightKey,
      run,
      options.retryAfterFlight === true,
      () => { if (isCurrentSession() && foreground.current) void syncRef.current(); },
    );
  }, []);
  syncRef.current = syncBackup;

  const deleteAccount = useCallback(async () => {
    const accountId = stateRef.current.account?.id;
    if (stateRef.current.phase !== "authenticated" || !accountId) throw new Error("Sign in again before deleting this account.");
    const operation = ++authOperationGeneration.current;
    const generation = sessionGeneration.current;
    abortProgressRequests(syncAbortControllers.current);
    syncRerunRequested.current.clear();
    const response = await deleteCurrentAccount(accountId);
    if (authOperationGeneration.current !== operation || sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) return response;
    let localCleanupError = false;
    try { await clearAccountProgressAfterServerDeletion(accountId); }
    catch { localCleanupError = true; }
    if (authOperationGeneration.current !== operation || sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) return response;
    if (isNative) await clearLocalNativeSession().catch(() => { localCleanupError = true; });
    if (authOperationGeneration.current !== operation || sessionGeneration.current !== generation || stateRef.current.account?.id !== accountId) return response;
    abortProgressRequests(syncAbortControllers.current);
    syncRerunRequested.current.clear();
    sessionGeneration.current += 1;
    rememberAccount(null);
    setState((current) => ({
      ...current,
      phase: "guest",
      account: null,
      offlineAccountId: null,
      backup: EMPTY_BACKUP,
      notice: { kind: localCleanupError ? "error" : "success", message: localCleanupError ? `The server accepted deletion (${response.receiptId}), but this device could not finish clearing its saved account copy.` : `Account deletion ${response.status === "complete" ? "is complete" : `is being processed (receipt ${response.receiptId})`}.` },
      progressRevision: current.progressRevision + 1,
    }));
    return response;
  }, [isNative]);

  useEffect(() => {
    if (state.phase === "authenticated" && state.account) void syncBackup();
  }, [state.phase, state.account?.id, syncBackup]);

  useEffect(() => {
    let live = true;
    let lastConnectivity: AccountBackupConnectivity | null = null;
    const setForeground = (isForeground: boolean) => {
      foreground.current = isForeground;
      if (!isForeground) {
        abortProgressRequests(syncAbortControllers.current);
        syncRerunRequested.current.clear();
      }
    };
    setForeground(document.visibilityState !== "hidden");
    const resumeWork = async (retryAfterFlight = false) => {
      if (!foreground.current || document.visibilityState === "hidden") return;
      const connectivity = await getAccountBackupConnectivity().catch(() => ({ connected: false, allowed: false }));
      if (!live || !foreground.current || !connectivity.connected) return;
      const now = Date.now();
      if (resumeInFlight.current) return resumeInFlight.current;
      if (!retryAfterFlight && now - lastResumeAt.current < 3000) return;
      lastResumeAt.current = now;
      const task = (async () => {
        await refreshRef.current();
        if (stateRef.current.phase === "authenticated") await syncRef.current({ retryAfterFlight });
      })();
      resumeInFlight.current = task;
      try { await task; }
      finally { if (resumeInFlight.current === task) resumeInFlight.current = null; }
    };
    const onVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      const becameVisible = visible && !foreground.current;
      setForeground(visible);
      if (becameVisible) void resumeWork(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    const stopConnectivity = subscribeAccountBackupConnectivity((connectivity) => {
      const previous = lastConnectivity;
      lastConnectivity = connectivity;
      if (!connectivity.connected || !connectivity.allowed) abortProgressRequests(syncAbortControllers.current);
      if (!previous) return;
      if (shouldScheduleAccountBackup(previous, connectivity) && stateRef.current.phase === "authenticated") void syncRef.current({ retryAfterFlight: true });
      if (!previous.connected && connectivity.connected) void resumeWork(false);
    });
    let appListener: { remove: () => Promise<void> } | undefined;
    if (isNative) void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      const becameActive = isActive && !foreground.current;
      setForeground(isActive);
      if (becameActive) void resumeWork(true);
    }).then((listener) => { if (live) appListener = listener; else void listener.remove(); }).catch(() => {});
    if (isNative) void CapacitorApp.getState().then(({ isActive }) => {
      if (!live) return;
      const becameActive = isActive && !foreground.current;
      setForeground(isActive);
      if (becameActive) void resumeWork(true);
    }).catch(() => {});
    return () => {
      live = false;
      abortProgressRequests(syncAbortControllers.current);
      syncRerunRequested.current.clear();
      document.removeEventListener("visibilitychange", onVisibility);
      stopConnectivity();
      void appListener?.remove();
    };
  }, [isNative]);

  useEffect(() => {
    const onAccountStorage = (event: StorageEvent) => {
      if (event.key !== LAST_ACCOUNT_KEY) return;
      const nextId = event.newValue && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.newValue)
        ? event.newValue
        : null;
      const currentId = stateRef.current.account?.id ?? stateRef.current.offlineAccountId;
      if ((currentId ?? null)?.toLowerCase() === (nextId ?? null)?.toLowerCase()) return;
      authOperationGeneration.current += 1;
      abortProgressRequests(syncAbortControllers.current);
      syncRerunRequested.current.clear();
      sessionGeneration.current += 1;
      setState((current) => ({
        ...current,
        phase: "starting",
        account: null,
        offlineAccountId: null,
        backup: EMPTY_BACKUP,
        progressRevision: current.progressRevision + 1,
      }));
      void refreshRef.current(nextId);
    };
    window.addEventListener("storage", onAccountStorage);
    return () => window.removeEventListener("storage", onAccountStorage);
  }, []);

  const handleAuthLink = useCallback(async (rawUrl: string) => {
    const action = isNative ? parseNativeAuthLink(rawUrl) : parseWebAuthAction();
    if (!action) return;
    if (action.kind === "password_reset") {
      setState((current) => ({ ...current, pendingAction: { kind: "password_reset", token: action.token }, notice: null }));
      return;
    }
    try {
      const operation = authOperationGeneration.current;
      const accountId = stateRef.current.phase === "authenticated" ? stateRef.current.account?.id : null;
      await confirmEmailVerification(action.token);
      if (authOperationGeneration.current !== operation) return;
      let account = stateRef.current.account;
      if (accountId) account = await getCurrentAccount(accountId);
      if (authOperationGeneration.current !== operation || (accountId && stateRef.current.account?.id !== accountId)) return;
      setState((current) => ({ ...current, account, notice: { kind: "success", message: "Your email address is verified." } }));
    } catch (error) {
      setState((current) => ({ ...current, notice: { kind: "error", message: error instanceof Error ? error.message : "This verification link could not be used. Request a new one from your account." } }));
    }
  }, [isNative]);

  useEffect(() => {
    if (!isNative) {
      void handleAuthLink(window.location.href);
      return;
    }
    let live = true;
    let stop: (() => Promise<void>) | undefined;
    void listenForNativeAuthLinks((url) => handleAuthLink(url)).then((cleanup) => {
      if (live) stop = cleanup;
      else void cleanup();
    }).catch(() => {});
    return () => { live = false; void stop?.(); };
  }, [handleAuthLink, isNative]);

  const googleWebClientId = useMemo(() => {
    if (!state.config?.googleWebEnabled || !isValidGoogleWebClientId(state.config.googleWebClientId)) return null;
    return resolveGoogleWebClientId(state.config.googleWebClientId);
  }, [state.config]);
  const ownerAccountId = state.phase === "authenticated" ? state.account?.id ?? null : state.phase === "offline-account" ? state.offlineAccountId : null;

  const value: AuthContextValue = {
    ...state,
    isNative,
    ownerAccountId,
    googleWebClientId,
    refresh,
    signUp,
    signIn,
    signInGoogle,
    linkGoogle,
    signOut,
    sendVerification,
    verifyEmail,
    requestReset,
    resetPassword,
    clearPendingAction,
    clearNotice,
    reauthPassword,
    reauthGoogle,
    googleChallenge,
    syncBackup,
    deleteAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth outside AuthProvider");
  return auth;
}
