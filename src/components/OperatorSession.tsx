import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Kip } from "./Kip";
import { fetchOperatorApi } from "../lib/operatorApiTransport";
import "../feedback-review.css";

export class OperatorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** JSON request to the operator API on this page's own origin, with the API's message on failure. */
export async function operatorRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const response = await fetchOperatorApi(path, { ...init, headers }, globalThis.fetch, {
    pageOrigin: window.location.origin,
    allowLoopbackHttp: import.meta.env.DEV,
  });
  if (!response.ok) {
    let message = response.status === 401 ? "Your operator session has expired." : "The request could not be completed.";
    try {
      const body = await response.json() as { message?: unknown };
      if (typeof body.message === "string" && body.message.trim()) message = body.message.slice(0, 240);
    } catch {
      // Keep the generic message.
    }
    throw new OperatorError(response.status, message);
  }
  return await response.json() as T;
}

export type OperatorAuth = "checking" | "signed-out" | "signed-in";

/**
 * Shared operator sign-in state. `load` fetches the page's data; a 401 from it signs the page out.
 */
export function useOperatorSession(load: () => Promise<void>) {
  const [auth, setAuth] = useState<OperatorAuth>("checking");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      await load();
      setAuth("signed-in");
    } catch (error) {
      if (error instanceof OperatorError && error.status === 401) setAuth("signed-out");
      else setNotice(error instanceof Error ? error.message : "Could not load this page.");
    }
  }, [load]);

  useEffect(() => {
    operatorRequest<{ authenticated?: boolean }>("/api/operator/session")
      .then((session) => (session.authenticated ? refresh() : setAuth("signed-out")))
      .catch(() => setAuth("signed-out"));
  }, [refresh]);

  const signIn = useCallback(async (password: string) => {
    setNotice(null);
    try {
      await operatorRequest("/api/operator/login", { method: "POST", body: JSON.stringify({ password }) });
      await refresh();
      return true;
    } catch (error) {
      setNotice(error instanceof OperatorError && error.status === 401 ? "That password did not match. Try again." : "Could not sign in.");
      return false;
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await operatorRequest("/api/operator/logout", { method: "POST" });
    } catch {
      // The session cookie expires on its own; show the sign-in form either way.
    } finally {
      setAuth("signed-out");
    }
  }, []);

  return { auth, notice, setNotice, refresh, signIn, signOut };
}

/** The checking spinner and sign-in form every operator page shows before the session is confirmed. */
export function OperatorGate({ auth, notice, signIn, copy, children }: {
  auth: OperatorAuth;
  notice: string | null;
  signIn: (password: string) => Promise<boolean>;
  copy: string;
  children: ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    if (await signIn(password)) setPassword("");
    setBusy(false);
  }

  if (auth === "checking") {
    return (
      <main className="fr-review fr-review--center" aria-live="polite">
        <div className="fr-state-card"><span className="fr-spinner" aria-hidden="true" /><p>Checking operator access...</p></div>
      </main>
    );
  }

  if (auth === "signed-out") {
    return (
      <main className="fr-review fr-review--auth">
        <section className="fr-auth-panel" aria-labelledby="operator-auth-title">
          <div className="fr-auth-mark"><Kip pose="think" size={62} /></div>
          <h1 id="operator-auth-title">Operator sign in</h1>
          <p className="fr-auth-copy">{copy}</p>
          {notice && <p className="fr-auth-notice" role="status">{notice}</p>}
          <form className="fr-login-form" onSubmit={submit}>
            <label htmlFor="operator-password">Operator password</label>
            <input id="operator-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
            <button className="fr-button fr-button--primary fr-button--wide" type="submit" disabled={!password.trim() || busy}>Sign in</button>
          </form>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
