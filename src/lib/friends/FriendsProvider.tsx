import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../accounts/AuthProvider";
import { useFeatureFlag } from "../appConfig";
import {
  FriendsError,
  fetchFriendsBoard,
  friendsErrorMessage,
  removeFriend as sendRemoval,
  resetFriendCode as sendReset,
  sendFriendCode,
  type FriendsBoard,
  type FriendsErrorCode,
  type FriendSummary,
} from "./client";
import {
  flushOutbox,
  queueFriendCode,
  readCachedBoard,
  readOutbox,
  writeCachedBoard,
  type FlushOutcome,
  type PendingFriend,
  type PendingSource,
} from "./outbox";

/**
 * Friends state for the signed-in player (#64), behind the `friends` feature flag. The board is
 * online, with the last answer kept for offline viewing. Adding a friend works offline: the code
 * waits in the outbox and goes out after the next account sync, or as soon as the device is back
 * online.
 */

/** The add-a-friend sheet: closed, showing the player's code, or scanning a friend's. */
export type AddSheet = "closed" | "open" | "scan";
export type BoardStatus = "idle" | "loading" | "ready" | "offline" | "error" | "handle_required";
export type AddResult =
  | { kind: "added"; friend: FriendSummary }
  | { kind: "already_friends"; friend: FriendSummary }
  | { kind: "queued" }
  | { kind: "rejected"; code: FriendsErrorCode; message: string };

type FriendsContextValue = {
  enabled: boolean;
  /** The account friends belong to, signed in or offline. Null for guests. */
  accountId: string | null;
  /** True when requests can go out now. */
  online: boolean;
  board: FriendsBoard | null;
  /** When the board was fetched; older than this session when it came from the cache. */
  fetchedAt: string | null;
  status: BoardStatus;
  error: string | null;
  pending: PendingFriend[];
  /** A friend code that arrived by link and waits for the player to confirm. */
  incoming: string | null;
  openIncoming: (code: string) => void;
  clearIncoming: () => void;
  addSheet: AddSheet;
  setAddSheet: (sheet: AddSheet) => void;
  /** Results of codes sent in the background, not yet shown. */
  notices: FlushOutcome[];
  clearNotices: () => void;
  refresh: () => Promise<void>;
  add: (code: string, source: PendingSource) => Promise<AddResult>;
  remove: (handle: string) => Promise<void>;
  resetCode: () => Promise<void>;
};

const FriendsContext = createContext<FriendsContextValue | null>(null);

export function FriendsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const enabled = useFeatureFlag("friends");
  const accountId = enabled ? auth.ownerAccountId : null;
  const onlineAccount = enabled && auth.phase === "authenticated" ? (auth.account?.id ?? null) : null;
  const [board, setBoard] = useState<FriendsBoard | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<BoardStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingFriend[]>([]);
  const [incoming, setIncoming] = useState<string | null>(null);
  const [notices, setNotices] = useState<FlushOutcome[]>([]);
  const [addSheet, setAddSheet] = useState<AddSheet>("closed");
  const owner = useRef(accountId);
  owner.current = accountId;
  const onlineOwner = useRef(onlineAccount);
  onlineOwner.current = onlineAccount;
  const flushing = useRef<Promise<FlushOutcome[]> | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;

  // A different account, or signing out, swaps in that account's saved board and outbox.
  useEffect(() => {
    setNotices([]);
    setError(null);
    setAddSheet("closed");
    if (!accountId) {
      setBoard(null);
      setFetchedAt(null);
      setPending([]);
      setStatus("idle");
      return;
    }
    const cached = readCachedBoard(accountId);
    setBoard(cached?.board ?? null);
    setFetchedAt(cached?.fetchedAt ?? null);
    setPending(readOutbox(accountId));
    setStatus("idle");
  }, [accountId]);

  const refresh = useCallback(async () => {
    const id = onlineOwner.current;
    if (!id) {
      if (owner.current) setStatus("offline");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const next = await fetchFriendsBoard(id);
      if (onlineOwner.current !== id) return;
      const at = new Date();
      writeCachedBoard(id, next, at);
      setBoard(next);
      setFetchedAt(at.toISOString());
      setStatus("ready");
    } catch (caught) {
      if (onlineOwner.current !== id) return;
      const code = caught instanceof FriendsError ? caught.code : "unavailable";
      setStatus(code === "offline" ? "offline" : code === "handle_required" ? "handle_required" : "error");
      setError(friendsErrorMessage(caught));
    }
  }, []);

  /** Sends the outbox. Outcomes for `own` are returned only; the rest also become notices. */
  const flush = useCallback(
    async (own?: string): Promise<FlushOutcome[]> => {
      const id = onlineOwner.current;
      if (!id) return [];
      while (flushing.current) await flushing.current.catch(() => []);
      const work = (async () => {
        const { outcomes, remaining } = await flushOutbox(id, (code) => sendFriendCode(id, code));
        if (onlineOwner.current === id) {
          setPending(remaining);
          const background = outcomes.filter((outcome) => outcome.code !== own);
          if (background.length) setNotices((current) => [...current, ...background]);
        }
        return outcomes;
      })();
      flushing.current = work;
      try {
        const outcomes = await work;
        if (outcomes.some((outcome) => outcome.status === "added") && onlineOwner.current === id) void refresh();
        return outcomes;
      } finally {
        if (flushing.current === work) flushing.current = null;
      }
    },
    [refresh],
  );

  // The next sync sends waiting codes: after every account backup run, and when the device reconnects.
  useEffect(() => {
    if (!onlineAccount) return;
    void flush();
  }, [onlineAccount, auth.progressRevision, flush]);

  useEffect(() => {
    if (!onlineAccount) return;
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [onlineAccount, flush]);

  const add = useCallback(
    async (code: string, source: PendingSource): Promise<AddResult> => {
      const id = owner.current;
      if (!id) return { kind: "rejected", code: "unauthenticated", message: "Sign in to add friends." };
      if (boardRef.current?.code === code)
        return { kind: "rejected", code: "own_friend_code", message: friendsErrorMessage(new FriendsError("own_friend_code", 409)) };
      setPending(queueFriendCode(id, code, source, new Date()));
      if (!onlineOwner.current) return { kind: "queued" };
      const outcome = (await flush(code)).find((item) => item.code === code);
      if (!outcome) return { kind: "queued" };
      if (outcome.status === "rejected") return { kind: "rejected", code: outcome.error.code, message: outcome.error.message };
      return outcome.status === "added" ? { kind: "added", friend: outcome.friend } : { kind: "already_friends", friend: outcome.friend };
    },
    [flush],
  );

  const remove = useCallback(
    async (handle: string) => {
      const id = onlineOwner.current;
      if (!id) throw new FriendsError("offline", 0);
      try {
        await sendRemoval(id, handle);
      } catch (caught) {
        // Already gone is the outcome the player wanted.
        if (!(caught instanceof FriendsError && caught.code === "friend_not_found")) throw caught;
      }
      setBoard((current) => (current ? { ...current, players: current.players.filter((row) => row.handle !== handle) } : current));
      void refresh();
    },
    [refresh],
  );

  const resetCode = useCallback(async () => {
    const id = onlineOwner.current;
    if (!id) throw new FriendsError("offline", 0);
    const code = await sendReset(id);
    setBoard((current) => {
      if (!current) return current;
      const next = { ...current, code };
      writeCachedBoard(id, next, new Date());
      return next;
    });
  }, []);

  const value = useMemo<FriendsContextValue>(
    () => ({
      enabled,
      accountId,
      online: !!onlineAccount,
      board,
      fetchedAt,
      status,
      error,
      pending,
      incoming,
      openIncoming: (code) => setIncoming(code),
      clearIncoming: () => setIncoming(null),
      addSheet,
      setAddSheet,
      notices,
      clearNotices: () => setNotices([]),
      refresh,
      add,
      remove,
      resetCode,
    }),
    [enabled, accountId, onlineAccount, board, fetchedAt, status, error, pending, incoming, addSheet, notices, refresh, add, remove, resetCode],
  );

  return <FriendsContext.Provider value={value}>{children}</FriendsContext.Provider>;
}

export function useFriends() {
  const friends = useContext(FriendsContext);
  if (!friends) throw new Error("useFriends outside FriendsProvider");
  return friends;
}
