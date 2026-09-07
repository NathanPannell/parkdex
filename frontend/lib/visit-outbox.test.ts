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
});
