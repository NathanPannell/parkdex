import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { motion } from "motion/react";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { useAuth } from "../lib/accounts/AuthProvider";
import { isValidGoogleWebClientId } from "../lib/accounts/authClient";
import { isAndroidNativeIdentityAvailable, requestNativeGoogleIdToken } from "../lib/accounts/nativeIdentity";
import { listPersonalClaims, setLegacyClaimSnapshot } from "../lib/accounts/personalStore";
import { useStore } from "../lib/store";
import { useContent } from "../lib/content/provider";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";

type GoogleCredentialResponse = { credential?: string };
type GoogleAccounts = {
  id: {
    initialize(options: { client_id: string; nonce: string; callback(response: GoogleCredentialResponse): void }): void;
    renderButton(element: HTMLElement, options: Record<string, string | number | boolean>): void;
  };
};

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts };
  }
}

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) { resolve(); return; }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google sign-in could not load.")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in could not load."));
    document.head.append(script);
  });
}

function expiresAtMs(value: string | number) {
  if (typeof value === "number") return value < 100_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

function GoogleSignInButton({
  purpose,
  disabled,
  onCredential,
  onError,
  resetKey,
}: {
  purpose: "sign_in" | "reauth" | "link";
  disabled?: boolean;
  onCredential: (idToken: string, nonce: string) => Promise<void>;
  onError: (message: string) => void;
  resetKey: number;
}) {
  const auth = useAuth();
  const root = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const errorRef = useRef(onError);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  callbackRef.current = onCredential;
  errorRef.current = onError;

  useEffect(() => {
    let live = true;
    let challengeNonce = "";
    let consumed = false;
    setStatus("loading");
    const clientId = auth.googleWebClientId;
    if (auth.isNative || !clientId || !root.current) return;

    void (async () => {
      const challenge = await auth.googleChallenge(purpose);
      challengeNonce = challenge.nonce;
      if (expiresAtMs(challenge.expiresAt) <= Date.now()) throw new Error("Google sign-in expired. Try again.");
      await loadGoogleIdentity();
      if (!live || !root.current || !window.google?.accounts?.id) return;
      root.current.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        nonce: challenge.nonce,
        callback: (response) => {
          if (!live || consumed) return;
          consumed = true;
          if (!response.credential || expiresAtMs(challenge.expiresAt) <= Date.now()) {
            errorRef.current("Google sign-in expired. Refresh it and try again.");
            return;
          }
          void callbackRef.current(response.credential, challengeNonce).catch((error: unknown) => {
            consumed = false;
            errorRef.current(error instanceof Error ? error.message : "Google sign-in could not be completed.");
          });
        },
      });
      window.google.accounts.id.renderButton(root.current, { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 300 });
      setStatus("ready");
    })().catch((error: unknown) => {
      if (!live) return;
      setStatus("error");
      errorRef.current(error instanceof Error ? error.message : "Google sign-in could not load.");
    });

    return () => { live = false; };
  }, [auth.googleChallenge, auth.googleWebClientId, auth.isNative, purpose, resetKey]);

  if (auth.isNative) return null;
  return (
    <div className={`account-google ${disabled ? "is-disabled" : ""}`} aria-busy={status === "loading"}>
      <div ref={root} aria-label="Continue with Google" />
      {status === "loading" && <span className="account-google__hint">Preparing Google sign-in…</span>}
      {status === "error" && <span className="account-google__hint">Google sign-in is temporarily unavailable. Retry the account screen.</span>}
    </div>
  );
}

export function Account({ onBack }: { onBack: () => void }) {
  const auth = useAuth();
  const { state } = useStore();
  const content = useContent();
  const [mode, setMode] = useState<"sign_in" | "sign_up" | "reset">("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [guestClaims, setGuestClaims] = useState(0);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [googleLinkStep, setGoogleLinkStep] = useState<"closed" | "verify" | "link">("closed");
  const [googleLinkPassword, setGoogleLinkPassword] = useState("");
  const [googleResetKey, setGoogleResetKey] = useState(0);
  const [deleteStep, setDeleteStep] = useState<"closed" | "confirm" | "verified">("closed");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteVerifiedAt, setDeleteVerifiedAt] = useState(0);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletionReceipt, setDeletionReceipt] = useState<{ receiptId: string; status: "complete" | "pending" } | null>(null);
  const [googleDeleteResetKey, setGoogleDeleteResetKey] = useState(0);

  const account = auth.account;
  const signedIn = auth.phase === "authenticated" && !!account;
  const offlineAccount = auth.phase === "offline-account";
  const accountId = account?.id;
  const nativeClientId = auth.config?.googleWebClientId ?? null;
  const nativeGoogleAvailable = !!auth.config?.googleNativeEnabled && isAndroidNativeIdentityAvailable() && isValidGoogleWebClientId(nativeClientId);
  const webGoogleAvailable = !!auth.googleWebClientId;
  const googleAvailable = auth.isNative ? nativeGoogleAvailable : webGoogleAvailable;
  const emailAvailable = !!auth.config?.emailEnabled && (!auth.isNative || isAndroidNativeIdentityAvailable());
  const canRequestEmail = !!auth.config?.emailDeliveryEnabled;
  const hasPassword = !!account?.providers.includes("email");
  const hasGoogle = !!account?.providers.includes("google");
  const canGoogleReauth = hasGoogle && googleAvailable;
  const canPasswordReauth = hasPassword;

  useEffect(() => {
    setGoogleLinkStep("closed");
    setGoogleLinkPassword("");
    setDeleteStep("closed");
    setDeletePassword("");
    setDeletePhrase("");
    setDeleteVerifiedAt(0);
    setDeleteError(null);
    setDeletionReceipt(null);
  }, [accountId]);

  useEffect(() => {
    if (!signedIn) { setGuestClaims(0); return; }
    let live = true;
    void listPersonalClaims({ kind: "guest" }).then((claims) => { if (live) setGuestClaims(claims.length); }).catch(() => {});
    return () => { live = false; };
  }, [signedIn, accountId, auth.progressRevision]);

  useEffect(() => {
    if (!auth.pendingAction) return;
    setMode("reset");
    setFormError(null);
    setFormMessage(null);
  }, [auth.pendingAction]);

  const run = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setFormError(null);
    setFormMessage(null);
    try {
      await work();
      if (success) setFormMessage(success);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "That action could not be completed. Try again.");
      setGoogleResetKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const handleAuthSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "reset" && auth.pendingAction?.kind === "password_reset") {
      await run(async () => {
        await auth.resetPassword(auth.pendingAction!.token, resetPassword);
        setMode("sign_in");
      }, "Your password has been changed.");
      setPassword("");
      setResetPassword("");
      return;
    }
    if (mode === "reset") {
      await run(async () => {
        await auth.requestReset(email.trim());
        setFormMessage("If an account can receive email at that address, a reset link is on its way.");
      });
      return;
    }
    if (mode === "sign_up") {
      await run(async () => {
        await auth.signUp({ email: email.trim(), password, displayName: displayName.trim() });
        setFormMessage(auth.config?.emailDeliveryEnabled ? "Your account is ready. Check your email for a verification link." : "Your account is ready. Email verification is not enabled in this environment.");
      });
      return;
    }
    await run(async () => { await auth.signIn({ email: email.trim(), password }); });
  };

  const onGoogleCredential = useCallback(async (idToken: string, nonce: string) => {
    await auth.signInGoogle(idToken, nonce);
  }, [auth.signInGoogle]);

  const onGoogleError = useCallback((message: string) => setFormError(message), []);

  const onLinkGoogleCredential = useCallback(async (idToken: string, nonce: string) => {
    await auth.linkGoogle(idToken, nonce);
    setGoogleLinkStep("closed");
    setGoogleLinkPassword("");
    setFormError(null);
  }, [auth.linkGoogle]);

  const startNativeGoogle = async (purpose: "sign_in" | "reauth" | "link", onCredential: (idToken: string, nonce: string) => Promise<void>) => {
    const clientId = nativeClientId;
    if (!clientId || !nativeGoogleAvailable) throw new Error("Google sign-in is not configured for this app yet.");
    const challenge = await auth.googleChallenge(purpose);
    if (expiresAtMs(challenge.expiresAt) <= Date.now()) throw new Error("Google sign-in expired. Try again.");
    const idToken = await requestNativeGoogleIdToken({ nonce: challenge.nonce, serverClientId: clientId });
    await onCredential(idToken, challenge.nonce);
  };

  const onDeleteReauthCredential = useCallback(async (idToken: string, nonce: string) => {
    await auth.reauthGoogle(idToken, nonce);
    setDeleteVerifiedAt(Date.now());
    setDeleteStep("verified");
    setDeleteError(null);
  }, [auth.reauthGoogle]);

  const onDeleteGoogleError = useCallback((message: string) => setDeleteError(message), []);

  const submitDeleteReauth = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDeleteError(null);
    try {
      await auth.reauthPassword(deletePassword);
      setDeletePassword("");
      setDeleteVerifiedAt(Date.now());
      setDeleteStep("verified");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Account verification could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const submitGoogleLinkReauth = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await auth.reauthPassword(googleLinkPassword);
      setGoogleLinkPassword("");
      setGoogleLinkStep("link");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Account verification could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeletion = async () => {
    if (Date.now() - deleteVerifiedAt > 5 * 60 * 1000) {
      setDeleteStep("confirm");
      setDeleteError("Please verify your account again before continuing.");
      return;
    }
    setBusy(true);
    setDeleteError(null);
    try {
      const response = await auth.deleteAccount();
      setDeletionReceipt(response);
      setDeleteStep("closed");
      setDeletePhrase("");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Account deletion could not be completed.");
      setDeleteStep("confirm");
    } finally {
      setBusy(false);
    }
  };

  const attachGuest = async () => {
    setMergeConfirm(false);
    setBusy(true);
    setFormError(null);
    setFormMessage(null);
    try {
      const guestRows = await listPersonalClaims({ kind: "guest" });
      if (content) {
        for (const claim of guestRows) {
          if (claim.parkSnapshot) continue;
          const currentPark = content.liveParks.find((candidate) => candidate.id === claim.parkId);
          const park = currentPark ?? content.retiredParks.find((candidate) => candidate.id === claim.parkId);
          if (park) await setLegacyClaimSnapshot({ kind: "guest" }, claim.claimId, park, claim.contentReleaseId ?? (currentPark ? content.releaseId : null));
        }
      }
      const result = await auth.attachGuestCollection();
      setFormMessage(result.guestClaimsRemoved > 0 || result.guestClaimsCopied === 0
        ? "The guest collection was attached to this account."
        : "The guest collection is queued for backup. Its original copy stays here until the server confirms every saved item.");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The guest collection could not be attached yet.");
    } finally {
      setBusy(false);
    }
  };

  const renderGoogleButton = (purpose: "sign_in" | "reauth" | "link", resetKey: number, disabled: boolean, onCredential: (idToken: string, nonce: string) => Promise<void>, onError: (message: string) => void) => {
    if (!googleAvailable) return null;
    if (auth.isNative) {
      return (
        <button className="btn btn--paper btn--block account-google-native" type="button" disabled={disabled} onClick={() => void run(() => startNativeGoogle(purpose, onCredential))}>
          Continue with Google
        </button>
      );
    }
    return <GoogleSignInButton key={`${purpose}-${resetKey}`} purpose={purpose} disabled={disabled} onCredential={onCredential} onError={onError} resetKey={resetKey} />;
  };

  return (
    <motion.main
      className="screen account-screen scroll"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
      aria-labelledby="account-title"
    >
      <header className="account-head">
        <button className="btn btn--paper btn--icon account-back" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
        <div className="account-head__title">
          <span className="eyebrow">Your Kip account</span>
          <h1 id="account-title">Account &amp; backup</h1>
        </div>
        <div className="account-head__kip"><Kip size={54} pose="avatar" /></div>
      </header>

      <div className="account-body">
        {deletionReceipt && (
          <section className="account-notice card" role="status">
            <strong>{deletionReceipt.status === "complete" ? "Account deleted" : "Deletion is processing"}</strong>
            <span>Receipt {deletionReceipt.receiptId}</span>
          </section>
        )}

        {auth.notice && (
          <section className={`account-notice card ${auth.notice.kind === "error" ? "is-error" : ""}`} role={auth.notice.kind === "error" ? "alert" : "status"}>
            <span>{auth.notice.message}</span>
            <button className="account-notice__close" onClick={auth.clearNotice} aria-label="Dismiss message"><Icon name="close" size={16} /></button>
          </section>
        )}

        {auth.phase === "starting" && (
          <section className="account-card card account-loading" aria-live="polite">
            <Kip size={64} pose="think" />
            <div><strong>Opening your case…</strong><p>Your saved progress stays on this device while Kip checks your account.</p></div>
          </section>
        )}

        {offlineAccount && (
          <section className="account-card card">
            <span className="eyebrow">Offline</span>
            <h2>Your saved case is here</h2>
            <p>Kip couldn't confirm the account while offline. The previous account's saved collection remains in its private device partition and is not being backed up.</p>
            <button className="btn btn--sun btn--block" onClick={() => void auth.refresh()}><Icon name="refresh" /> Try again</button>
            {auth.startupError && <p className="account-help" role="status">{auth.startupError}</p>}
          </section>
        )}

        {auth.phase === "error" && (
          <section className="account-card card" role="alert">
            <span className="eyebrow">Saved progress</span>
            <h2>Storage needs attention</h2>
            <p>{auth.startupError ?? "The saved collection could not be opened. Your previous data was left untouched."}</p>
            <button className="btn btn--paper btn--block" onClick={() => void auth.refresh()}><Icon name="refresh" /> Try again</button>
          </section>
        )}

        {signedIn && account && deleteStep === "closed" && (
          <>
            <section className="account-card card account-profile">
              <div className="account-profile__main">
                <span className="eyebrow">Signed in</span>
                <h2>{account.displayName || "Your Kip account"}</h2>
                <p>{account.email}</p>
              </div>
              <span className={`account-verified ${account.emailVerified ? "is-verified" : ""}`}>
                <Icon name={account.emailVerified ? "check" : "image"} size={16} />
                {account.emailVerified ? "Email verified" : "Email not verified"}
              </span>
              {!account.emailVerified && (
                <div className="account-profile__verify">
                  <p>{canRequestEmail ? "Use the link we sent to verify this address and help protect account recovery." : "Email delivery is not enabled in this environment."}</p>
                  {canRequestEmail && <button className="btn btn--paper btn--sm" disabled={busy} onClick={() => void run(auth.sendVerification, "Verification link sent if this address can receive email.")}>Send verification link</button>}
                </div>
              )}
              {signedIn && hasPassword && !hasGoogle && googleAvailable && (
                <div className="account-google-link">
                  {googleLinkStep === "closed" ? (
                    <button className="btn btn--paper btn--sm" disabled={busy} onClick={() => { setFormError(null); setGoogleLinkStep("verify"); }}>Link Google</button>
                  ) : googleLinkStep === "verify" ? (
                    <form className="account-form" onSubmit={(event) => void submitGoogleLinkReauth(event)}>
                      <p>Verify your password before linking Google to this account.</p>
                      <label className="fb-field"><span className="fb-label">Current password</span><input className="fb-input" type="password" autoComplete="current-password" minLength={12} maxLength={128} required value={googleLinkPassword} onChange={(event) => setGoogleLinkPassword(event.target.value)} /></label>
                      <div className="account-delete-panel__actions"><button className="btn btn--paper btn--sm" type="button" onClick={() => setGoogleLinkStep("closed")}>Cancel</button><button className="btn btn--sun btn--sm" disabled={busy}>{busy ? "Checking…" : "Verify and continue"}</button></div>
                    </form>
                  ) : (
                    <div>
                      <p>Continue with Google to link it to this account.</p>
                      {renderGoogleButton("link", googleResetKey, busy, onLinkGoogleCredential, onGoogleError)}
                      <button className="account-text-button" onClick={() => setGoogleLinkStep("closed")}>Cancel linking</button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="account-card card account-backup">
              <div className="account-section-title">
                <div><span className="eyebrow">Collection backup</span><h2>{backupHeading(auth.backup.phase)}</h2></div>
                <span className={`account-backup__dot is-${auth.backup.phase}`} aria-hidden="true" />
              </div>
              <p>{auth.backup.message ?? "Your collection is saved on this device. Kip keeps a copy with your account when a connection is available."}</p>
              {(auth.backup.claimsPending > 0 || auth.backup.photosPending > 0) && (
                <div className="account-pending" aria-live="polite">
                  {auth.backup.claimsPending > 0 && <span>{auth.backup.claimsPending} {auth.backup.claimsPending === 1 ? "badge" : "badges"} waiting</span>}
                  {auth.backup.photosPending > 0 && <span>{auth.backup.photosPending} {auth.backup.photosPending === 1 ? "photo" : "photos"} waiting</span>}
                </div>
              )}
              {auth.backup.message && auth.backup.phase !== "success" && <p className="account-help" role="status">{auth.backup.message}</p>}
              <button className="btn btn--sun btn--block" onClick={() => void auth.syncBackup()} disabled={busy || auth.backup.phase === "syncing"}>
                <Icon name={auth.backup.phase === "syncing" ? "download" : "refresh"} /> {auth.backup.phase === "syncing" ? "Backing up…" : "Back up now"}
              </button>
              <p className="account-privacy">Your collection and photos are private to this account. Switching accounts never moves a collection automatically.</p>
            </section>

            <section className="account-card card account-merge">
              <span className="eyebrow">This device</span>
              <h2>{guestClaims ? `${guestClaims} guest ${guestClaims === 1 ? "badge" : "badges"}` : "No guest badges to add"}</h2>
              <p>Guest badges stay separate until you choose to add them. The guest copy remains until the server confirms every saved badge and supported photo.</p>
              {!mergeConfirm ? (
                <button className="btn btn--paper btn--block" disabled={busy || guestClaims === 0} onClick={() => setMergeConfirm(true)}>Add this device’s collection</button>
              ) : (
                <div className="account-merge__confirm">
                  <strong>Attach {guestClaims} {guestClaims === 1 ? "badge" : "badges"} to {account.displayName || "this account"}?</strong>
                  <div><button className="btn btn--sun btn--sm" disabled={busy} onClick={() => void attachGuest()}>Confirm attach</button><button className="btn btn--paper btn--sm" onClick={() => setMergeConfirm(false)}>Keep separate</button></div>
                </div>
              )}
            </section>

            <section className="account-card card account-privacy-card">
              <span className="eyebrow">Privacy</span>
              <p>Signing out hides this account’s saved case on this device. It does not move badges into the guest case. Sign in again to see this account’s collection.</p>
              <button className="btn btn--paper btn--block" disabled={busy} onClick={() => void run(auth.signOut)}>Sign out on this device</button>
            </section>

            <section className="account-delete">
              <button className="account-delete__open" disabled={busy} onClick={() => { setDeleteStep("confirm"); setDeleteError(null); }}>
                Delete Kip account
              </button>
            </section>
          </>
        )}

        {signedIn && account && deleteStep !== "closed" && (
          <section className="account-card card account-delete-panel">
            <span className="eyebrow">Account deletion</span>
            {deleteStep === "confirm" ? (
              <>
                <h2>Delete this Kip account?</h2>
                <p>This removes the account and its server backup. Badges in the separate guest case stay on this device. First verify your account again.</p>
                {canPasswordReauth && (
                  <form className="account-form" onSubmit={(event) => void submitDeleteReauth(event)}>
                    <label className="fb-field"><span className="fb-label">Current password</span><input className="fb-input" type="password" autoComplete="current-password" minLength={12} maxLength={128} required value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} /></label>
                    <button className="btn btn--paper btn--block" disabled={busy}>{busy ? "Checking…" : "Verify with password"}</button>
                  </form>
                )}
                {canGoogleReauth && <div className="account-delete-panel__google">{renderGoogleButton("reauth", googleDeleteResetKey, busy, onDeleteReauthCredential, onDeleteGoogleError)}</div>}
                {!canPasswordReauth && !canGoogleReauth && <p className="account-help">No reauthentication method is available in this environment. Reconnect or use the provider linked to this account.</p>}
                <label className="fb-field account-delete-panel__phrase"><span className="fb-label">Type DELETE to continue</span><input className="fb-input" value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} autoComplete="off" /></label>
                <div className="account-delete-panel__actions"><button className="btn btn--paper btn--sm" onClick={() => setDeleteStep("closed")}>Cancel</button></div>
              </>
            ) : (
              <>
                <h2>One last check</h2>
                <p>Account verification is fresh for five minutes. Type DELETE, then continue.</p>
                <label className="fb-field"><span className="fb-label">Type DELETE to confirm</span><input className="fb-input" value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} autoComplete="off" /></label>
                <div className="account-delete-panel__actions">
                  <button className="btn btn--paper btn--sm" onClick={() => setDeleteStep("closed")}>Cancel</button>
                  <button className="btn btn--sun btn--sm" disabled={busy || deletePhrase !== "DELETE" || Date.now() - deleteVerifiedAt > 5 * 60 * 1000} onClick={() => void confirmDeletion()}>Delete account</button>
                </div>
              </>
            )}
            {deleteError && <p className="account-error" role="alert">{deleteError}</p>}
            <p className="account-privacy">If Kip returns a pending receipt, deletion is still in progress. Keep the receipt if you contact support.</p>
          </section>
        )}

        {auth.phase === "guest" && (
          <>
            {auth.startupError && (
              <section className="account-notice card is-error" role="status">
                <span>{auth.startupError}</span>
                <button className="btn btn--paper btn--sm" onClick={() => void auth.refresh()}>Try again</button>
              </section>
            )}
            <section className="account-card card account-form-card">
              {auth.pendingAction?.kind === "password_reset" ? (
                <>
                  <span className="eyebrow">Password reset</span>
                  <h2>Choose a new password</h2>
                  <form className="account-form" onSubmit={(event) => void handleAuthSubmit(event)}>
                    <label className="fb-field"><span className="fb-label">New password</span><input className="fb-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} /></label>
                    <p className="account-help">Use 12 to 128 characters. Your other sessions will be signed out.</p>
                    <button className="btn btn--sun btn--block" disabled={busy || !auth.config}>{busy ? "Saving…" : "Save new password"}</button>
                  </form>
                  <button className="account-text-button" onClick={auth.clearPendingAction}>Back to account sign-in</button>
                </>
              ) : mode === "reset" ? (
                <>
                  <span className="eyebrow">Account recovery</span>
                  <h2>Reset your password</h2>
                  <p>We’ll send a private reset link if this email can receive account messages.</p>
                  <form className="account-form" onSubmit={(event) => void handleAuthSubmit(event)}>
                    <label className="fb-field"><span className="fb-label">Email</span><input className="fb-input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                    <button className="btn btn--sun btn--block" disabled={busy || !canRequestEmail}>{busy ? "Sending…" : "Send reset link"}</button>
                    {!canRequestEmail && <p className="account-help">Password reset email is not enabled in this environment.</p>}
                  </form>
                  <button className="account-text-button" onClick={() => setMode("sign_in")}>Back to sign in</button>
                </>
              ) : (
                <>
                  <div className="account-form-card__heading">
                    <span className="eyebrow">{mode === "sign_up" ? "Start collecting" : "Keep your case safe"}</span>
                    <h2>{mode === "sign_up" ? "Create your Kip account" : "Sign in to Kip"}</h2>
                    <p>{mode === "sign_up" ? "Back up your badges and photos. Your guest case stays separate until you choose to attach it." : "Your badges and photos stay on this device until you sign in."}</p>
                  </div>
                  {googleAvailable && renderGoogleButton("sign_in", googleResetKey, busy, onGoogleCredential, onGoogleError)}
                  {googleAvailable && emailAvailable && <div className="account-or"><span>or use email</span></div>}
                  {auth.config && !googleAvailable && <p className="account-help">Google sign-in is not configured for this app yet.</p>}
                  <form className="account-form" onSubmit={(event) => void handleAuthSubmit(event)}>
                    {mode === "sign_up" && <label className="fb-field"><span className="fb-label">Display name</span><input className="fb-input" autoComplete="name" minLength={1} maxLength={80} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>}
                    <label className="fb-field"><span className="fb-label">Email</span><input className="fb-input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                    <label className="fb-field"><span className="fb-label">Password</span><input className="fb-input" type="password" autoComplete={mode === "sign_up" ? "new-password" : "current-password"} minLength={12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                    {mode === "sign_up" && <p className="account-help">Use 12 to 128 characters.</p>}
                    <button className="btn btn--sun btn--block" disabled={busy || !emailAvailable || !auth.config}>{busy ? "Working…" : mode === "sign_up" ? "Create account" : "Sign in"}</button>
                    {!emailAvailable && <p className="account-help">Email sign-in is not configured for this app yet.</p>}
                  </form>
                  {mode === "sign_in" && canRequestEmail && <button className="account-text-button" onClick={() => setMode("reset")}>Forgot password?</button>}
                  <div className="account-form-card__switch">
                    {mode === "sign_in" ? <><span>New to Kip?</span><button className="account-text-button" onClick={() => setMode("sign_up")}>Create account</button></> : <><span>Already have an account?</span><button className="account-text-button" onClick={() => setMode("sign_in")}>Sign in</button></>}
                  </div>
                </>
              )}
            </section>

            <section className="account-card card account-guest-note">
              <span className="eyebrow">Guest case</span>
              <p>Your badges stay on this device if you keep using Kip as a guest. Signing in does not merge them automatically.</p>
            </section>
          </>
        )}

        {(formError || formMessage) && auth.phase !== "authenticated" && (
          <section className={`account-notice card ${formError ? "is-error" : ""}`} role={formError ? "alert" : "status"}>
            <span>{formError ?? formMessage}</span>
            <button className="account-notice__close" onClick={() => { setFormError(null); setFormMessage(null); }} aria-label="Dismiss message"><Icon name="close" size={16} /></button>
          </section>
        )}

        {signedIn && (formError || formMessage) && (
          <section className={`account-notice card ${formError ? "is-error" : ""}`} role={formError ? "alert" : "status"}>
            <span>{formError ?? formMessage}</span>
            <button className="account-notice__close" onClick={() => { setFormError(null); setFormMessage(null); }} aria-label="Dismiss message"><Icon name="close" size={16} /></button>
          </section>
        )}

        {state.progressError && (
          <section className="account-notice card is-error" role="alert"><span>{state.progressError}</span></section>
        )}

      </div>
    </motion.main>
  );
}

function backupHeading(phase: string) {
  if (phase === "syncing") return "Backing up";
  if (phase === "success") return "Up to date";
  if (phase === "offline") return "Waiting for connection";
  if (phase === "pending" || phase === "error") return "Backup pending";
  return "Saved on this device";
}
