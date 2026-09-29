export type PendingGroupMembership = {
  included: boolean;
  revision: number;
};

/**
 * The persisted shape is intentionally small: one final desired value per
 * group/place pair. A boolean is accepted when hydrating for forwards and
 * backwards compatibility with hand-written/local test data.
 */
export type GroupOutboxSnapshot = Record<string, Record<string, PendingGroupMembership | boolean>>;

type GroupMembershipTarget = {
  id: string;
  placeIds?: string[];
  places?: Array<{ id: string }>;
};

type GroupOutboxDrainOptions = {
  /**
   * Permanently rejected intents are removed only when the rejected revision
   * is still the queued revision. A newer tap for the same value must survive.
   */
  discardOnError?: (error: unknown) => boolean;
};

function keyFor(groupId: string, placeId: string) {
  return JSON.stringify([groupId, placeId]);
}

function idsFor(group: GroupMembershipTarget): string[] {
  const ids = group.placeIds ?? group.places?.map((place) => place.id) ?? [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export class GroupOutbox {
  private entries: Record<string, Record<string, PendingGroupMembership>> = {};
  private latestIntent: Record<string, Record<string, PendingGroupMembership>> = {};
  private active = new Map<string, Promise<void>>();
  private revision = 0;

  hydrate(snapshot: GroupOutboxSnapshot | unknown) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    for (const [groupId, rawGroup] of Object.entries(snapshot)) {
      if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
      for (const [placeId, rawEntry] of Object.entries(rawGroup)) {
        const included = typeof rawEntry === "boolean"
          ? rawEntry
          : rawEntry && typeof rawEntry === "object" && "included" in rawEntry && typeof rawEntry.included === "boolean"
            ? rawEntry.included
            : null;
        if (included === null) continue;
        const revision = rawEntry && typeof rawEntry === "object" && "revision" in rawEntry && validRevision(rawEntry.revision)
          ? rawEntry.revision
          : ++this.revision;
        const entry = { included, revision };
        (this.entries[groupId] ??= {})[placeId] = entry;
        (this.latestIntent[groupId] ??= {})[placeId] = entry;
        this.revision = Math.max(this.revision, revision);
      }
    }
  }

  setDesired(groupId: string, placeId: string, included: boolean) {
    const entry = { included, revision: ++this.revision };
    (this.entries[groupId] ??= {})[placeId] = entry;
    (this.latestIntent[groupId] ??= {})[placeId] = entry;
  }

  has(groupId: string, placeId: string) {
    return Boolean(this.entries[groupId]?.[placeId]);
  }

  checkpoint(): number {
    return this.revision;
  }

  /** Apply pending and post-checkpoint intents to a server snapshot. */
  applyTo<T extends GroupMembershipTarget>(groups: readonly T[], afterRevision = Number.POSITIVE_INFINITY): T[] {
    return groups.map((group) => {
      const nextIds = new Set(idsFor(group));
      const pending = this.entries[group.id] ?? {};
      for (const [placeId, entry] of Object.entries(pending)) {
        if (entry.included) nextIds.add(placeId); else nextIds.delete(placeId);
      }
      const latest = this.latestIntent[group.id] ?? {};
      for (const [placeId, entry] of Object.entries(latest)) {
        if (entry.revision <= afterRevision) continue;
        if (entry.included) nextIds.add(placeId); else nextIds.delete(placeId);
      }
      const placeIds = [...nextIds];
      return { ...group, placeIds };
    });
  }

  snapshot(): GroupOutboxSnapshot {
    return Object.fromEntries(Object.entries(this.entries).map(([groupId, entries]) => [
      groupId,
      Object.fromEntries(Object.entries(entries).map(([placeId, entry]) => [placeId, { ...entry }])),
    ]));
  }

  pendingCount(): number {
    return Object.values(this.entries).reduce((count, entries) => count + Object.keys(entries).length, 0);
  }

  hasPending(): boolean {
    return this.pendingCount() > 0;
  }

  /** Remove all pending intents for a group that was successfully deleted. */
  clearGroup(groupId: string) {
    delete this.entries[groupId];
    delete this.latestIntent[groupId];
  }

  async clearAndWait(): Promise<void> {
    this.entries = {};
    this.latestIntent = {};
    await this.waitForActive();
  }

  async waitForActive(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  drain(
    groupId: string,
    placeId: string,
    send: (groupId: string, placeId: string, included: boolean) => Promise<void>,
    options: GroupOutboxDrainOptions = {},
  ): Promise<void> {
    const key = keyFor(groupId, placeId);
    const existing = this.active.get(key);
    if (existing) return existing;
    const task = (async () => {
      while (this.entries[groupId]?.[placeId]) {
        const attempt = this.entries[groupId][placeId];
        try {
          await send(groupId, placeId, attempt.included);
        } catch (error) {
          if (options.discardOnError?.(error) && this.entries[groupId]?.[placeId]?.revision === attempt.revision) {
            delete this.entries[groupId][placeId];
            if (Object.keys(this.entries[groupId]).length === 0) delete this.entries[groupId];
          }
          throw error;
        }
        // A new tap made while the request was in flight must survive and be
        // sent next. Only a response for this exact revision is an ack.
        if (this.entries[groupId]?.[placeId]?.revision === attempt.revision) {
          delete this.entries[groupId][placeId];
          if (Object.keys(this.entries[groupId]).length === 0) delete this.entries[groupId];
        }
      }
    })().finally(() => { this.active.delete(key); });
    this.active.set(key, task);
    return task;
  }

  async drainAll(
    send: (groupId: string, placeId: string, included: boolean) => Promise<void>,
    options: GroupOutboxDrainOptions = {},
  ): Promise<void> {
    let keys = Object.entries(this.entries).flatMap(([groupId, entries]) => Object.keys(entries).map((placeId) => [groupId, placeId] as const));
    while (keys.length) {
      const results = await Promise.allSettled(keys.map(([groupId, placeId]) => this.drain(groupId, placeId, send, options)));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason instanceof Error ? failed.reason : new Error("Some group memberships did not sync");
      const processed = new Set(keys.map(([groupId, placeId]) => keyFor(groupId, placeId)));
      keys = Object.entries(this.entries)
        .flatMap(([groupId, entries]) => Object.keys(entries).map((placeId) => [groupId, placeId] as const))
        .filter(([groupId, placeId]) => !processed.has(keyFor(groupId, placeId)));
    }
  }
}
