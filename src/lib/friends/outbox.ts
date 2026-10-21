import { isFinalAddError, type AddFriendResponse, type FriendsBoard, type FriendsError } from "./client";

/**
 * Friend codes scanned or typed while offline (#64) wait here, per account, until the next sync
 * sends them. The last board is kept too, so the player's own code and QR still show offline.
 * Everything lives in localStorage: a few short codes and handles, never account secrets.
 */

export type PendingSource = "scan" | "typed" | "link";
export type PendingFriend = { code: string; queuedAt: string; source: PendingSource };
export type FlushOutcome =
  { code: string; status: "added" | "already_friends"; friend: AddFriendResponse["friend"] } | { code: string; status: "rejected"; error: FriendsError };
export type CachedBoard = { board: FriendsBoard; fetchedAt: string };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const OUTBOX_PREFIX = "parkdex.friends.outbox.v1.";
const BOARD_PREFIX = "parkdex.friends.board.v1.";
/** More than anyone types offline; older entries drop first. */
export const OUTBOX_LIMIT = 50;
const SOURCES = new Set<PendingSource>(["scan", "typed", "link"]);

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, store: Storage | null): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, store: Storage | null): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked storage keeps the in-memory state for this session.
  }
}

const outboxKey = (accountId: string) => `${OUTBOX_PREFIX}${accountId.toLowerCase()}`;
const boardKey = (accountId: string) => `${BOARD_PREFIX}${accountId.toLowerCase()}`;

export function readOutbox(accountId: string, store: Storage | null = storage()): PendingFriend[] {
  const value = read(outboxKey(accountId), store);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    return row && typeof row.code === "string" && typeof row.queuedAt === "string" && SOURCES.has(row.source as PendingSource)
      ? [{ code: row.code, queuedAt: row.queuedAt, source: row.source as PendingSource }]
      : [];
  });
}

function writeOutbox(accountId: string, pending: PendingFriend[], store: Storage | null): void {
  if (pending.length) write(outboxKey(accountId), pending, store);
  else {
    try {
      store?.removeItem(outboxKey(accountId));
    } catch {
      /* Nothing to clear. */
    }
  }
}

/** Adds a code once; a code already waiting keeps its place. Returns the outbox. */
export function queueFriendCode(accountId: string, code: string, source: PendingSource, now: Date, store: Storage | null = storage()): PendingFriend[] {
  const pending = readOutbox(accountId, store);
  if (pending.some((item) => item.code === code)) return pending;
  const next = [...pending, { code, queuedAt: now.toISOString(), source }].slice(-OUTBOX_LIMIT);
  writeOutbox(accountId, next, store);
  return next;
}

export function dropFriendCode(accountId: string, code: string, store: Storage | null = storage()): PendingFriend[] {
  const next = readOutbox(accountId, store).filter((item) => item.code !== code);
  writeOutbox(accountId, next, store);
  return next;
}

/**
 * Sends waiting codes oldest first. A sent code, or one the server refuses for good (unknown,
 * your own, over the limit), leaves the outbox. The first error that may pass (offline, server
 * trouble, signed out, no handle yet) stops the run and keeps the rest for the next sync.
 */
export async function flushOutbox(
  accountId: string,
  send: (code: string) => Promise<AddFriendResponse>,
  store: Storage | null = storage(),
): Promise<{ outcomes: FlushOutcome[]; remaining: PendingFriend[] }> {
  const outcomes: FlushOutcome[] = [];
  for (const item of readOutbox(accountId, store)) {
    try {
      const response = await send(item.code);
      outcomes.push({ code: item.code, status: response.status, friend: response.friend });
    } catch (error) {
      if (!isFinalAddError(error)) break;
      outcomes.push({ code: item.code, status: "rejected", error: error as FriendsError });
    }
    dropFriendCode(accountId, item.code, store);
  }
  return { outcomes, remaining: readOutbox(accountId, store) };
}

export function readCachedBoard(accountId: string, store: Storage | null = storage()): CachedBoard | null {
  const value = read(boardKey(accountId), store) as Partial<CachedBoard> | null;
  if (!value || typeof value.fetchedAt !== "string" || typeof value.board !== "object" || value.board === null) return null;
  const board = value.board as Partial<FriendsBoard>;
  if (typeof board.code !== "string" || !Array.isArray(board.players) || typeof board.week !== "object") return null;
  return { board: board as FriendsBoard, fetchedAt: value.fetchedAt };
}

export function writeCachedBoard(accountId: string, board: FriendsBoard, fetchedAt: Date, store: Storage | null = storage()): void {
  write(boardKey(accountId), { board, fetchedAt: fetchedAt.toISOString() }, store);
}
