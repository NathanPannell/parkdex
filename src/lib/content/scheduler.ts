import { canDownloadContent, requiresContentWifi, type Connectivity, type DownloadPurpose } from "./contracts";

export type DownloadPolicy = {
  foreground: boolean;
  connectivity: Connectivity;
};

export type ScheduledDownload = {
  key: string;
  path: string;
  purpose: DownloadPurpose;
  priority: number;
  run(signal: AbortSignal): Promise<void>;
};

type Waiter = {
  resolve(): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type Task = ScheduledDownload & {
  order: number;
  controller: AbortController;
  waiters: Set<Waiter>;
  state: "queued" | "running";
  requeueOnAbort: boolean;
};

function abortError() {
  if (typeof DOMException !== "undefined") return new DOMException("Download request was cancelled", "AbortError");
  const error = new Error("Download request was cancelled");
  error.name = "AbortError";
  return error;
}

export function isDownloadAllowed(_purpose: DownloadPurpose, path: string, policy: DownloadPolicy): boolean {
  return policy.foreground && canDownloadContent(policy.connectivity) &&
    (!requiresContentWifi(path) || policy.connectivity.wifi);
}

function isMapWork(task: Pick<ScheduledDownload, "path" | "purpose">): boolean {
  return task.purpose === "bulk" || /^map\//.test(task.path);
}

/** A foreground-only queue that deduplicates byte downloads by immutable hash. */
export class ContentDownloadScheduler {
  private policy: DownloadPolicy;
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private active = 0;
  private nextOrder = 0;
  private disposed = false;

  constructor(policy: DownloadPolicy, private readonly concurrency = 3) {
    this.policy = policy;
  }

  get pendingCount() {
    return this.queue.length + this.active;
  }

  setPolicy(policy: DownloadPolicy) {
    this.policy = policy;
    for (const task of this.tasks.values()) {
      if (task.state === "running" && !isDownloadAllowed(task.purpose, task.path, policy)) {
        task.requeueOnAbort = true;
        task.controller.abort();
      }
    }
    this.pump();
  }

  enqueue(request: ScheduledDownload, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Content download scheduler is stopped"));
    if (signal?.aborted) return Promise.reject(abortError());
    let task = this.tasks.get(request.key);
    if (!task) {
      task = {
        ...request,
        order: this.nextOrder++,
        controller: new AbortController(),
        waiters: new Set(),
        state: "queued",
        requeueOnAbort: false,
      };
      this.tasks.set(task.key, task);
      this.queue.push(task);
    } else if (request.priority < task.priority) {
      task.priority = request.priority;
      task.purpose = request.purpose;
      task.path = request.path;
      this.sortQueue();
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          task!.waiters.delete(waiter);
          reject(abortError());
          if (task!.waiters.size === 0) this.cancelTask(task!);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      task!.waiters.add(waiter);
      this.sortQueue();
      this.pump();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.tasks.values()) {
      task.controller.abort();
      this.finishWaiters(task, new Error("Content download scheduler is stopped"));
    }
    this.tasks.clear();
    this.queue.length = 0;
  }

  private sortQueue() {
    this.queue.sort((left, right) => left.priority - right.priority || left.order - right.order);
  }

  private cancelTask(task: Task) {
    if (task.state === "queued") {
      const index = this.queue.indexOf(task);
      if (index >= 0) this.queue.splice(index, 1);
      this.tasks.delete(task.key);
      return;
    }
    task.requeueOnAbort = true;
    task.controller.abort();
  }

  private finishWaiters(task: Task, error?: unknown) {
    for (const waiter of task.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve();
    }
    task.waiters.clear();
  }

  private pump() {
    if (this.disposed) return;
    while (this.active < this.concurrency) {
      this.sortQueue();
      const mapLimit = Math.max(1, this.concurrency - 1);
      const activeMap = [...this.tasks.values()].filter((task) => task.state === "running" && isMapWork(task)).length;
      const nextIndex = this.queue.findIndex((task) => task.waiters.size > 0 &&
        (!isMapWork(task) || activeMap < mapLimit) && isDownloadAllowed(task.purpose, task.path, this.policy));
      if (nextIndex < 0) return;
      const [task] = this.queue.splice(nextIndex, 1);
      if (!task || task.state !== "queued") continue;
      task.state = "running";
      this.active++;
      task.requeueOnAbort = false;
      void Promise.resolve().then(() => task.run(task.controller.signal)).then(
        () => {
          if (!task.requeueOnAbort) this.finishWaiters(task);
        },
        (error) => {
          if (!task.requeueOnAbort) this.finishWaiters(task, error);
        },
      ).finally(() => {
        this.active--;
        if (task.requeueOnAbort && !this.disposed && task.waiters.size > 0 && this.tasks.get(task.key) === task) {
          task.requeueOnAbort = false;
          task.controller = new AbortController();
          task.state = "queued";
          this.queue.push(task);
        } else if (this.tasks.get(task.key) === task) {
          this.tasks.delete(task.key);
        }
        this.pump();
      });
    }
  }
}
