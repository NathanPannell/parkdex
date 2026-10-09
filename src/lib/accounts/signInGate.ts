/**
 * Keeps a sign-in the person started from being cancelled by background account work.
 *
 * Signing in with Google opens a popup (a new tab on Android). When it closes, the page becomes
 * visible again and the app's resume path refreshes the account. That refresh starts a new auth
 * operation, and a sign-in still finishing its local setup then sees the operation change and
 * stops with "The account session changed before this action finished.", even though nothing
 * changed but the page's visibility. Resume and reconnect refreshes wait here for an interactive
 * sign-in to settle instead. A real account change (another tab, sign-out) still cancels it.
 */
export class SignInGate {
  private flight: Promise<unknown> | null = null;

  get active(): boolean {
    return this.flight !== null;
  }

  /** Run an interactive sign-in; background refreshes wait for it to settle. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const flight = task();
    this.flight = flight;
    const clear = () => {
      if (this.flight === flight) this.flight = null;
    };
    flight.then(clear, clear);
    return flight;
  }

  /** Resolves once no interactive sign-in is running, whether it succeeded or failed. */
  async settled(): Promise<void> {
    while (this.flight) {
      const flight = this.flight;
      await flight.then(() => undefined, () => undefined);
      if (this.flight === flight) this.flight = null;
    }
  }
}

/**
 * A refresh that confirms the account already open on this device does not need to open it
 * again. Re-opening starts a new session generation, which cancels the backup sync that the
 * sign-in just started. A different account, or any state other than signed in, still opens.
 */
export function shouldReopenAccount(phase: string, openAccountId: string | null | undefined, confirmedAccountId: string): boolean {
  if (phase !== "authenticated" || !openAccountId) return true;
  return openAccountId.toLowerCase() !== confirmedAccountId.toLowerCase();
}
