import { describe, expect, it } from "vitest";
import { shouldReopenAccount, SignInGate } from "./signInGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A small model of AuthProvider's guard: every refresh and sign-in starts a new operation, and a
 * sign-in fails if the operation changed while it was still opening the account. The resume path
 * is the one AuthProvider runs when the page becomes visible again.
 */
function accountModel(gate: SignInGate | null) {
  let operation = 0;
  let open: string | null = null;
  const refreshes: string[] = [];
  const setup = deferred<void>();
  const signIn = async (accountId: string) => {
    const start = ++operation;
    const run = async () => {
      // Server sign-in done; local setup (guest claim reservation, backup status reads) pending.
      await setup.promise;
      if (operation !== start) throw new Error("The account session changed before this action finished.");
      open = accountId;
      return accountId;
    };
    return gate ? gate.run(run) : run();
  };
  const resume = async (serverAccountId: string) => {
    if (gate) await gate.settled();
    ++operation;
    refreshes.push(serverAccountId);
    if (shouldReopenAccount(open ? "authenticated" : "guest", open, serverAccountId)) open = serverAccountId;
  };
  return {
    signIn,
    resume,
    setup,
    refreshes,
    get open() {
      return open;
    },
  };
}

describe("sign-in and a resume racing it", () => {
  it("reproduces the bug without the gate: the resume cancels the sign-in", async () => {
    const model = accountModel(null);
    const signingIn = model.signIn("account-a").catch((error: Error) => error.message);
    await model.resume("account-a");
    model.setup.resolve();
    await expect(signingIn).resolves.toBe("The account session changed before this action finished.");
  });

  it("lets the sign-in finish when the page comes back mid-way, then refreshes once", async () => {
    const gate = new SignInGate();
    const model = accountModel(gate);
    const signingIn = model.signIn("account-a");
    const resuming = model.resume("account-a");
    await tick();
    expect(model.refreshes).toEqual([]);
    model.setup.resolve();
    await expect(signingIn).resolves.toBe("account-a");
    await resuming;
    expect(model.refreshes).toEqual(["account-a"]);
    expect(model.open).toBe("account-a");
  });

  it("still lets a later refresh open a different account", async () => {
    const gate = new SignInGate();
    const model = accountModel(gate);
    const signingIn = model.signIn("account-a");
    model.setup.resolve();
    await signingIn;
    await model.resume("account-b");
    expect(model.open).toBe("account-b");
  });
});

describe("sign-in gate", () => {
  it("settles after a failed sign-in too", async () => {
    const gate = new SignInGate();
    const failing = deferred<void>();
    const run = gate.run(() => failing.promise).catch(() => "failed");
    expect(gate.active).toBe(true);
    let settled = false;
    const waiting = gate.settled().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    failing.reject(new Error("bad password"));
    await waiting;
    await expect(run).resolves.toBe("failed");
    expect(gate.active).toBe(false);
  });

  it("waits for a second sign-in started while the first was settling", async () => {
    const gate = new SignInGate();
    const first = deferred<void>();
    const second = deferred<void>();
    void gate.run(() => first.promise);
    let settled = false;
    const waiting = gate.settled().then(() => {
      settled = true;
    });
    void gate.run(() => second.promise);
    first.resolve();
    await tick();
    expect(settled).toBe(false);
    second.resolve();
    await waiting;
    expect(settled).toBe(true);
  });

  it("returns at once when nothing is signing in", async () => {
    await expect(new SignInGate().settled()).resolves.toBeUndefined();
  });
});

describe("reopening an account on refresh", () => {
  it("keeps the open account's session when the server confirms the same account", () => {
    expect(shouldReopenAccount("authenticated", "AE172E85-A8AB-4E1D-A032-901100000001", "ae172e85-a8ab-4e1d-a032-901100000001")).toBe(false);
  });

  it("opens the account when it differs, or when nothing is signed in yet", () => {
    expect(shouldReopenAccount("authenticated", "account-a", "account-b")).toBe(true);
    expect(shouldReopenAccount("guest", null, "account-a")).toBe(true);
    expect(shouldReopenAccount("offline-account", null, "account-a")).toBe(true);
    expect(shouldReopenAccount("starting", null, "account-a")).toBe(true);
  });
});
