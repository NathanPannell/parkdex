import { describe, expect, it } from "vitest";
import { VisitOutbox } from "./visit-outbox";

describe("VisitOutbox", () => {
  it("serializes a delayed check then undo and preserves the newest intent", async () => {
    const outbox = new VisitOutbox();
    const releases: Array<() => void> = [];
    const sent: boolean[] = [];
    const send = (_id: string, visited: boolean) => {
      sent.push(visited);
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    outbox.setDesired("park", true);
    const draining = outbox.drain("park", send);
    await Promise.resolve();
    outbox.setDesired("park", false);
    releases.shift()?.();
    await Promise.resolve();
    expect(sent).toEqual([true, false]);
    releases.shift()?.();
    await draining;
    expect(outbox.snapshot()).toEqual({});
  });

  it("keeps failed work for a later retry", async () => {
    const outbox = new VisitOutbox();
    outbox.setDesired("park", true);
    await expect(outbox.drain("park", async () => { throw new Error("offline"); })).rejects.toThrow();
    expect(outbox.applyTo([])).toEqual(new Set(["park"]));
  });

  it("rebases an acknowledged tap made during a stale initial request", async () => {
    const outbox = new VisitOutbox();
    const requestStartedAt = outbox.checkpoint();
    outbox.setDesired("park", true);
    await outbox.drain("park", async () => {});
    expect(outbox.snapshot()).toEqual({});
    expect(outbox.applyTo([], requestStartedAt)).toEqual(new Set(["park"]));
  });

  it("clears queued intent and waits for an active write before a reset", async () => {
    const outbox = new VisitOutbox();
    let release!: () => void;
    const sent: boolean[] = [];
    outbox.setDesired("park", true);
    const draining = outbox.drain("park", (_id, visited) => {
      sent.push(visited);
      return new Promise<void>((resolve) => { release = resolve; });
    });
    await Promise.resolve();
    outbox.setDesired("park", false);

    let cleared = false;
    const clearing = outbox.clearAndWait().then(() => { cleared = true; });
    await Promise.resolve();
    expect(cleared).toBe(false);
    expect(outbox.snapshot()).toEqual({});

    release();
    await Promise.all([draining, clearing]);
    expect(sent).toEqual([true]);
    expect(outbox.applyTo([])).toEqual(new Set());
  });

  it("discards only the matching revision when an acknowledgement is applied", () => {
    const outbox = new VisitOutbox();
    outbox.setDesired("park", true);
    outbox.discard("park", false);
    expect(outbox.snapshot()).toEqual({ park: { visited: true, revision: 1 } });
    outbox.discard("park", true);
    expect(outbox.snapshot()).toEqual({});
  });

  it("preserves a newer same-valued intent when discarding a failed attempt", () => {
    const outbox = new VisitOutbox();
    outbox.setDesired("park", true);
    const failedRevision = outbox.snapshot().park.revision;
    outbox.setDesired("park", true);

    outbox.discardRevision("park", failedRevision);

    expect(outbox.snapshot().park.visited).toBe(true);
    expect(outbox.snapshot().park.revision).not.toBe(failedRevision);
  });

  it("preserves a sender's structured error through drainAll", async () => {
    const outbox = new VisitOutbox();
    outbox.setDesired("park", true);
    const error = Object.assign(new Error("A current location claim is required"), {
      code: "location_claim_required",
    });

    await expect(outbox.drainAll(async () => { throw error; }))
      .rejects.toMatchObject({ code: "location_claim_required" });
  });
});
