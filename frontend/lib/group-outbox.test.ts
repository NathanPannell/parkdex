import { describe, expect, it } from "vitest";
import { GroupOutbox } from "./group-outbox";

describe("GroupOutbox", () => {
  it("coalesces repeated taps into one final desired membership", () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", true);
    outbox.setDesired("coast", "park-1", false);
    outbox.setDesired("coast", "park-1", true);

    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.snapshot().coast["park-1"]).toMatchObject({ included: true });
  });

  it("applies pending membership to a fresh server snapshot", () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", true);

    expect(outbox.applyTo([{ id: "coast", placeIds: [] }])).toEqual([{ id: "coast", placeIds: ["park-1"] }]);
  });

  it("removes an entry only after its send succeeds", async () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", true);
    let release!: () => void;
    const draining = outbox.drain("coast", "park-1", async () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    expect(outbox.pendingCount()).toBe(1);
    release();
    await draining;
    expect(outbox.pendingCount()).toBe(0);
  });

  it("retains a failed entry for a later retry", async () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", false);
    await expect(outbox.drain("coast", "park-1", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.snapshot().coast["park-1"]).toMatchObject({ included: false });
  });

  it("discards only the exact revision rejected as permanently invalid", async () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", true);
    let reject!: (error: Error) => void;
    const draining = outbox.drain(
      "coast",
      "park-1",
      async () => new Promise<void>((_resolve, fail) => { reject = fail; }),
      { discardOnError: () => true },
    );
    await Promise.resolve();

    // Even an identical newer intent is distinct user input and must not be
    // erased by the response to the older request.
    outbox.setDesired("coast", "park-1", true);
    reject(new Error("gone"));

    await expect(draining).rejects.toThrow("gone");
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.snapshot().coast["park-1"]).toMatchObject({ included: true, revision: 2 });
  });

  it("discards a permanently invalid revision but retains transient failures", async () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("gone", "park-1", true);
    outbox.setDesired("retry", "park-1", true);

    await expect(outbox.drainAll(
      async (groupId) => { throw new Error(groupId === "gone" ? "permanent" : "transient"); },
      { discardOnError: (error) => error instanceof Error && error.message === "permanent" },
    )).rejects.toThrow();

    expect(outbox.snapshot().gone).toBeUndefined();
    expect(outbox.snapshot().retry["park-1"]).toMatchObject({ included: true });
  });

  it("sends a newer desired state after an older request completes", async () => {
    const outbox = new GroupOutbox();
    outbox.setDesired("coast", "park-1", true);
    const sent: boolean[] = [];
    let release!: () => void;
    const draining = outbox.drain("coast", "park-1", async (_groupId, _placeId, included) => {
      sent.push(included);
      if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    });
    await Promise.resolve();
    outbox.setDesired("coast", "park-1", false);
    release();
    await draining;
    expect(sent).toEqual([true, false]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("hydrates each account's compact persisted shape independently", () => {
    const first = new GroupOutbox();
    first.hydrate({ coast: { "park-1": { included: true, revision: 9 } } });
    const second = new GroupOutbox();
    second.hydrate({ coast: { "park-1": { included: false, revision: 4 } } });

    expect(first.snapshot().coast["park-1"]).toMatchObject({ included: true, revision: 9 });
    expect(second.snapshot().coast["park-1"]).toMatchObject({ included: false, revision: 4 });
  });
});
