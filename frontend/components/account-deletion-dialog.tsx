"use client";

import { AlertTriangle, CheckCircle2, LoaderCircle, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { addNativeBackConsumer } from "@/lib/native-back";
import styles from "./account-deletion-dialog.module.css";

/** The short phrase a person types. The API's DELETE_ACCOUNT literal stays in the hook contract. */
export const ACCOUNT_DELETION_CONFIRMATION = "DELETE";

export type AccountDeletionResult = {
  photoCleanupPending: boolean;
  localCleanupPending?: boolean;
};

export type AccountDeletionDialogProps = {
  accountEmail: string;
  busy?: boolean;
  onClose: () => void;
  onDeleteAccount: () => Promise<AccountDeletionResult>;
  successResult?: AccountDeletionResult | null;
};

type DialogState = "confirm" | "pending" | "success" | "error";

export function AccountDeletionDialog({ accountEmail, busy = false, onClose, onDeleteAccount, successResult = null }: AccountDeletionDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<DialogState>(successResult ? "success" : busy ? "pending" : "confirm");
  const [error, setError] = useState("");
  const [photoCleanupPending, setPhotoCleanupPending] = useState(Boolean(successResult?.photoCleanupPending));
  const [localCleanupPending, setLocalCleanupPending] = useState(Boolean(successResult?.localCleanupPending));
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId().replace(/:/g, "");
  const descriptionId = `${titleId}-description`;
  const inputId = `${titleId}-confirmation`;
  const errorId = `${titleId}-error`;
  const displayedState: DialogState = successResult ? "success" : state;
  const displayedPhotoCleanupPending = successResult?.photoCleanupPending ?? photoCleanupPending;
  const displayedLocalCleanupPending = successResult?.localCleanupPending ?? localCleanupPending;
  const isWorking = displayedState === "pending" || busy;
  const canSubmit = confirmation === ACCOUNT_DELETION_CONFIRMATION && displayedState !== "success" && !isWorking;

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    const focusable = () => [...(node?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    const firstFocusable = focusable()[0];
    if (firstFocusable) firstFocusable.focus();
    else node?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isWorking) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        node?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [isWorking]);

  useEffect(() => addNativeBackConsumer(() => {
    if (!isWorking) closeRef.current();
  }), [isWorking]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setState("pending");
    setError("");
    try {
      const result = await onDeleteAccount();
      setPhotoCleanupPending(result.photoCleanupPending);
      setLocalCleanupPending(Boolean(result.localCleanupPending));
      setState("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete your account. Please try again.");
      setState("error");
    }
  }

  const title = displayedState === "success" ? "Account deleted" : "Delete your account?";
  const description = displayedState === "success"
    ? "Your account and signed-in session have been cleared."
    : "This permanently removes your account and its saved progress. This cannot be undone.";

  const modal = (
    <div className={styles.backdrop} role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !isWorking) closeRef.current(); }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <button className={styles.close} type="button" onClick={() => closeRef.current()} disabled={isWorking} aria-label="Close delete account dialog">
          <X size={20} aria-hidden="true" />
        </button>

        {displayedState === "success" ? <CheckCircle2 className={styles.successIcon} size={34} aria-hidden="true" /> : <AlertTriangle className={styles.warningIcon} size={34} aria-hidden="true" />}
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>

        {displayedState === "success" ? <>
          {displayedPhotoCleanupPending && <p className={styles.pendingNotice} role="status">Some private visit photos are queued for deletion.</p>}
          {displayedLocalCleanupPending && <p className={styles.pendingNotice} role="status">Some private device data still needs cleanup on this device.</p>}
          <button className={styles.primaryAction} type="button" onClick={() => closeRef.current()}>Done</button>
        </> : <form onSubmit={submit}>
          <div className={styles.warningBox}>
            <Trash2 size={18} aria-hidden="true" />
            <span>Private visit photos are included when your account is deleted.</span>
          </div>
          <label className={styles.label} htmlFor={inputId}>Type <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong> to continue</label>
          <input
            id={inputId}
            className={styles.input}
            value={confirmation}
            onChange={(event) => { setConfirmation(event.target.value); if (state === "error") setState("confirm"); }}
            autoComplete="off"
            spellCheck={false}
            disabled={isWorking}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          />
          {error && <p className={styles.error} id={errorId} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button className={styles.cancelAction} type="button" onClick={() => closeRef.current()} disabled={isWorking}>Keep my account</button>
            <button className={styles.deleteAction} type="submit" disabled={!canSubmit}>
              {isWorking ? <><LoaderCircle className={styles.spinner} size={17} aria-hidden="true" />Deleting account…</> : "Delete account"}
            </button>
          </div>
          {isWorking && <p className={styles.status} role="status" aria-live="polite">Waiting for the server to confirm deletion.</p>}
        </form>}
        {displayedState !== "success" && <p className={styles.accountEmail}>Signed in as {accountEmail}</p>}
      </div>
    </div>
  );
  return typeof document === "undefined" ? null : createPortal(modal, document.body);
}
