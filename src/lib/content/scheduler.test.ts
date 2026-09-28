import { describe, expect, it } from "vitest";
import type { DownloadPurpose } from "./contracts";
import { ContentDownloadScheduler, isDownloadAllowed, type DownloadPolicy, type ScheduledDownload } from "./scheduler";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function request(
  key: string,
  path: string,
  purpose: DownloadPurpose,
  priority: number,
  run: ScheduledDownload["run"],
): ScheduledDownload {
  return { key, path, purpose, priority, run };
}

const wifi: DownloadPolicy = { foreground: true, connectivity: { connected: true, wifi: true } };
const cellular: DownloadPolicy = { foreground: true, connectivity: { connected: true, wifi: false } };

describe("ContentDownloadScheduler policy transitions", () => {
  it("allows an online browser policy without treating it as physical Wi-Fi", () => {
    const browser: DownloadPolicy = {
      foreground: true,
      connectivity: { connected: true, wifi: false, contentDownloadAllowed: true },
    };

    expect(isDownloadAllowed("core", "data/parks.json", browser)).toBe(true);
  });

  it("keeps an Android Wi-Fi-only policy blocked when native Wi-Fi is not confirmed", () => {
    const androidCellular: DownloadPolicy = {
      foreground: true,
      connectivity: { connected: true, wifi: false, contentDownloadAllowed: false },
    };

    expect(isDownloadAllowed("core", "data/parks.json", androidCellular)).toBe(false);
  });

  it("aborts a bulk fetch on WiFi loss, keeps deduped waiters, and restores queue priority on resume", async () => {
    const scheduler = new ContentDownloadScheduler(wifi, 1);
    const attempts: { signal: AbortSignal; gate: ReturnType<typeof deferred> }[] = [];
    const starts: string[] = [];
    const bulkRun: ScheduledDownload["run"] = (signal) => {
      const gate = deferred();
      attempts.push({ signal, gate });
      if (signal.aborted) gate.reject(new DOMException("aborted", "AbortError"));
      else signal.addEventListener("abort", () => gate.reject(new DOMException("aborted", "AbortError")), { once: true });
      return gate.promise;
    };
    const nearbyGate = deferred();
    const queuedGate = deferred();
    const firstWaiter = scheduler.enqueue(request("shared-hash", "map/island/001.bin", "bulk", 5, bulkRun));
    let firstResult = "pending";
    void firstWaiter.then(() => { firstResult = "resolved"; }, () => { firstResult = "rejected"; });
    const dedupedWaiter = scheduler.enqueue(request("shared-hash", "map/island/001.bin", "bulk", 1, bulkRun));
    let dedupedResult = "pending";
    void dedupedWaiter.then(() => { dedupedResult = "resolved"; }, () => { dedupedResult = "rejected"; });
    const nearby = scheduler.enqueue(request("nearby", "art/nearby.webp", "nearby", 3, () => {
      starts.push("nearby");
      return nearbyGate.promise;
    }));
    const queued = scheduler.enqueue(request("queued", "art/queued.webp", "nearby", 2, () => {
      starts.push("queued");
      return queuedGate.promise;
    }));
    void nearby;
    void queued;

    await flushMicrotasks();
    expect(attempts).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(3);

    scheduler.setPolicy(cellular);
    expect(attempts[0].signal.aborted).toBe(true);
    await flushMicrotasks();

    expect(firstResult).toBe("pending");
    expect(dedupedResult).toBe("pending");
    expect(attempts).toHaveLength(1);
    expect(starts).toEqual([]);

    scheduler.setPolicy(wifi);
    await flushMicrotasks();

    expect(attempts).toHaveLength(2);
    expect(attempts[1].signal.aborted).toBe(false);
    expect(starts).toEqual([]);
    attempts[1].gate.resolve();
    await flushMicrotasks();

    expect(firstResult).toBe("resolved");
    expect(dedupedResult).toBe("resolved");
    expect(starts).toEqual(["queued"]);
    queuedGate.resolve();
    await flushMicrotasks();
    expect(starts).toEqual(["queued", "nearby"]);
    nearbyGate.resolve();
    await flushMicrotasks();
    await Promise.all([firstWaiter, dedupedWaiter, nearby, queued]);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.dispose();
  });

  it("holds a running map update while backgrounded and resumes it in foreground", async () => {
    const scheduler = new ContentDownloadScheduler(wifi, 1);
    const attempts: { signal: AbortSignal; gate: ReturnType<typeof deferred> }[] = [];
    const run: ScheduledDownload["run"] = (signal) => {
      const gate = deferred();
      attempts.push({ signal, gate });
      if (signal.aborted) gate.reject(new DOMException("aborted", "AbortError"));
      else signal.addEventListener("abort", () => gate.reject(new DOMException("aborted", "AbortError")), { once: true });
      return gate.promise;
    };
    const pending = scheduler.enqueue(request("map-chunk", "map/island/001.bin", "update", 0, run));
    let result = "pending";
    void pending.then(() => { result = "resolved"; }, () => { result = "rejected"; });
    await flushMicrotasks();
    expect(attempts).toHaveLength(1);

    scheduler.setPolicy({ foreground: false, connectivity: wifi.connectivity });
    expect(attempts[0].signal.aborted).toBe(true);
    await flushMicrotasks();
    expect(result).toBe("pending");
    expect(attempts).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.setPolicy(wifi);
    await flushMicrotasks();
    expect(attempts).toHaveLength(2);
    attempts[1].gate.resolve();
    await pending;
    await flushMicrotasks();
    expect(result).toBe("resolved");
    expect(scheduler.pendingCount).toBe(0);
    scheduler.dispose();
  });

  it("rejects only a cancelled waiter while preserving a deduped running download", async () => {
    const scheduler = new ContentDownloadScheduler(wifi, 1);
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const run: ScheduledDownload["run"] = (currentSignal) => {
      signal = currentSignal;
      return gate.promise;
    };
    const cancellation = new AbortController();
    const cancelledWaiter = scheduler.enqueue(request("same", "art/same.webp", "core", 0, run), cancellation.signal);
    const remainingWaiter = scheduler.enqueue(request("same", "art/same.webp", "core", 0, run));
    await flushMicrotasks();
    cancellation.abort();

    await expect(cancelledWaiter).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(false);
    gate.resolve();
    await remainingWaiter;
    await flushMicrotasks();
    expect(scheduler.pendingCount).toBe(0);
    scheduler.dispose();
  });
});
