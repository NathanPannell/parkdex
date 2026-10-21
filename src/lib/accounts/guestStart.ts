import { readLocalHandle } from "../game/localHandle";

type GuestStarter = { phase: string; config: unknown; startGuest: () => Promise<unknown> };

let attempted = false;

/**
 * Opens a guest account when a @handle picked at onboarding is waiting on this device and nobody
 * is signed in, so the player can plant without Google. The game then claims the handle for the
 * guest account (`lib/game/localHandle.ts`).
 *
 * It tries once per app launch, and once more right after onboarding saves a new handle
 * (`allowGuestStart`). It never retries on its own, so a refused or offline start can't race a
 * sign-in the player starts themselves. Signing out clears the local handle, so leaving an account
 * never turns straight back into a new guest.
 */
export function startGuestForLocalHandle(auth: GuestStarter): Promise<unknown> | null {
  if (attempted || auth.phase !== "guest" || !auth.config || !readLocalHandle()) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  attempted = true;
  return auth.startGuest().catch(() => undefined);
}

/** Onboarding saved a new handle: the next check may start a guest again. */
export function allowGuestStart() {
  attempted = false;
}
