export type PendingVisit = { visited: boolean; revision: number };

export class VisitOutbox {
  private entries: Record<string, PendingVisit> = {};
  private latestIntent: Record<string, PendingVisit> = {};
  private active = new Map<string, Promise<void>>();
  private revision = 0;

  hydrate(entries: Record<string, PendingVisit | boolean>) {
    for (const [id, value] of Object.entries(entries)) {
      const entry = typeof value === "boolean" ? { visited: value, revision: ++this.revision } : value;
      this.entries[id] = entry;
      this.latestIntent[id] = entry;
      this.revision = Math.max(this.revision, entry.revision);
    }
  }

  setDesired(id: string, visited: boolean) {
    const entry = { visited, revision: ++this.revision };
    this.entries[id] = entry;
    this.latestIntent[id] = entry;
  }

  checkpoint(): number { return this.revision; }

  applyTo(remote: Iterable<string>, afterRevision = Number.POSITIVE_INFINITY): Set<string> {
    const rebased = new Set(remote);
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.visited) rebased.add(id); else rebased.delete(id);
    }
    for (const [id, entry] of Object.entries(this.latestIntent)) {
      if (entry.revision <= afterRevision) continue;
      if (entry.visited) rebased.add(id); else rebased.delete(id);
    }
    return rebased;
  }

  snapshot(): Record<string, PendingVisit> { return { ...this.entries }; }
  hasPending(): boolean { return Object.keys(this.entries).length > 0; }

  drain(id: string, send: (id: string, visited: boolean) => Promise<void>): Promise<void> {
    const existing = this.active.get(id);
    if (existing) return existing;
    const task = (async () => {
      while (this.entries[id]) {
        const attempt = this.entries[id];
        await send(id, attempt.visited);
        if (this.entries[id]?.revision === attempt.revision) delete this.entries[id];
      }
    })().finally(() => { this.active.delete(id); });
    this.active.set(id, task);
    return task;
  }

  async drainAll(send: (id: string, visited: boolean) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(Object.keys(this.entries).map((id) => this.drain(id, send)));
    if (results.some((result) => result.status === "rejected")) throw new Error("Some visits did not sync");
  }
}
