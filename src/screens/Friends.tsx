import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { Icon } from "../components/Icon";
import { QrScanner } from "../components/QrScanner";
import { useAuth } from "../lib/accounts/AuthProvider";
import { getAuthLinkOrigin } from "../lib/accounts/nativeIdentity";
import {
  GUEST_OWNER,
  addFriend,
  adoptGuestFriends,
  fetchLeaderboard,
  fetchProfile,
  flushPendingFriends,
  friendLink,
  isPermanentFriendError,
  parseFriendLink,
  readPendingFriends,
  readSocialCache,
  removeFriend,
  rotateFriendCode,
  saveDisplayName,
  saveFriend,
  writeSocialCache,
  type LeaderboardRow,
  type PendingFriend,
  type SocialCache,
} from "../lib/social/client";
import { useStore } from "../lib/store";
import "../friends.css";

type Period = "month" | "all";

function FriendQr({ value }: { value: string }) {
  const path = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return { d, size: qr.size };
  }, [value]);
  return (
    <svg className="friends-qr" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="Your friend QR code" shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#1d2b22" />
    </svg>
  );
}

function updatedLabel(fetchedAt: string | null): string {
  if (!fetchedAt) return "";
  const minutes = Math.round((Date.now() - Date.parse(fetchedAt)) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `Updated ${hours} h ago` : `Updated ${new Date(fetchedAt).toLocaleDateString()}`;
}

function monthName(monthStart: string | undefined): string {
  const date = monthStart ? new Date(monthStart) : new Date();
  return date.toLocaleDateString(undefined, { month: "long", timeZone: "America/Vancouver" });
}

function rank(rows: LeaderboardRow[], period: Period): LeaderboardRow[] {
  const score = (row: LeaderboardRow) => (period === "month" ? row.parksThisMonth : row.totalParks);
  const other = (row: LeaderboardRow) => (period === "month" ? row.totalParks : row.parksThisMonth);
  return [...rows].sort((a, b) => score(b) - score(a) || other(b) - other(a) || a.displayName.localeCompare(b.displayName));
}

function Leaderboard({ rows, period, onRemove }: { rows: LeaderboardRow[]; period: Period; onRemove(row: LeaderboardRow): void }) {
  if (rows.length <= 1) {
    return <p className="account-help">Scan a friend's code to start comparing parks.</p>;
  }
  return (
    <ol className="friends-board">
      {rank(rows, period).map((row, index) => {
        const score = period === "month" ? row.parksThisMonth : row.totalParks;
        return (
          <li key={row.accountId} className={row.isMe ? "friends-board__row is-me" : "friends-board__row"}>
            <span className="friends-board__rank" aria-label={`Rank ${index + 1}`}>{index + 1}</span>
            <span className="friends-board__name">
              <strong>{row.isMe ? `${row.displayName} (you)` : row.displayName}</strong>
              <span>{period === "month" ? `${row.totalParks} all time` : `${row.parksThisMonth} this month`}</span>
            </span>
            <span className="friends-board__score">
              <strong>{score}</strong>
              <span>{score === 1 ? "park" : "parks"}</span>
            </span>
            {!row.isMe && (
              <button className="account-text-button friends-board__remove" onClick={() => onRemove(row)} aria-label={`Remove ${row.displayName}`}>
                <Icon name="close" size={16} />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SavedFriends({ friends, guest }: { friends: PendingFriend[]; guest: boolean }) {
  if (!friends.length) return null;
  return (
    <ul className="friends-saved">
      {friends.map((friend) => (
        <li key={friend.code}>
          <Icon name="friends" size={18} />
          <span>{friend.name ?? "A Parkdex friend"}</span>
          <span className="friends-saved__state">{guest ? "Needs your account" : "Adds when online"}</span>
        </li>
      ))}
    </ul>
  );
}

/** Friends and the leaderboard. Guests can scan and save friends; an account sends them. */
export function Friends() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const accountId = auth.account?.id ?? auth.ownerAccountId ?? null;
  const online = auth.phase === "authenticated";
  const guest = !accountId;
  const owner = accountId ?? GUEST_OWNER;
  const [cache, setCache] = useState<SocialCache>(() => (accountId ? readSocialCache(accountId) : { profile: null, board: null, fetchedAt: null }));
  const [pending, setPending] = useState<PendingFriend[]>(() => readPendingFriends(owner));
  const [period, setPeriod] = useState<Period>("month");
  const [scanning, setScanning] = useState(false);
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = useCallback((next: SocialCache) => {
    setCache(next);
    if (accountId) writeSocialCache(accountId, next);
  }, [accountId]);

  const refresh = useCallback(async () => {
    setPending(readPendingFriends(owner));
    if (!accountId || !online) return;
    try {
      adoptGuestFriends(accountId);
      const flushed = await flushPendingFriends(accountId);
      setPending(readPendingFriends(accountId));
      if (flushed.rejected.length) {
        const { friend, message: reason } = flushed.rejected[0];
        setMessage({ text: `${friend.name ?? "A saved friend"}: ${reason}`, error: true });
      }
      const [profile, board] = await Promise.all([fetchProfile(accountId), fetchLeaderboard(accountId)]);
      save({ profile, board, fetchedAt: new Date().toISOString() });
    } catch {
      setMessage({ text: "Couldn't reach Parkdex. Showing your last saved board.", error: true });
    }
  }, [accountId, online, owner, save]);

  useEffect(() => { void refresh(); }, [refresh]);

  const scanned = async (text: string) => {
    setScanning(false);
    const friend = parseFriendLink(text);
    if (!friend) {
      setMessage({ text: "That isn't a Parkdex friend code.", error: true });
      return;
    }
    if (friend.code === cache.profile?.friendCode) {
      setMessage({ text: "That's your own code.", error: true });
      return;
    }
    const name = friend.name ?? "your friend";
    if (!accountId || !online) {
      saveFriend(owner, friend);
      setPending(readPendingFriends(owner));
      setMessage({ text: guest ? `Saved ${name}. Make an account to become friends.` : `Saved ${name}. You'll be friends once you're back online.` });
      return;
    }
    setBusy(true);
    try {
      const added = await addFriend(accountId, friend.code);
      setMessage({ text: `You and ${added.displayName} are now friends.` });
      await refresh();
    } catch (error) {
      if (isPermanentFriendError(error)) {
        setMessage({ text: error instanceof Error ? error.message : "That code didn't work.", error: true });
      } else {
        saveFriend(owner, friend);
        setPending(readPendingFriends(owner));
        setMessage({ text: `Saved ${name}. You'll be friends once you're back online.` });
      }
    } finally {
      setBusy(false);
    }
  };

  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    if (!accountId || nameInput === null) return;
    setBusy(true);
    try {
      const profile = await saveDisplayName(accountId, nameInput);
      save({ ...cache, profile });
      setNameInput(null);
      await refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Couldn't save your name.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const newCode = async () => {
    if (!accountId || !window.confirm("Make a new QR code? Your old one will stop working. Friends you already have stay.")) return;
    setBusy(true);
    try {
      save({ ...cache, profile: await rotateFriendCode(accountId) });
    } catch {
      setMessage({ text: "Couldn't make a new code right now.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: LeaderboardRow) => {
    if (!accountId || !window.confirm(`Remove ${row.displayName} from your friends?`)) return;
    try {
      await removeFriend(accountId, row.accountId);
      await refresh();
    } catch {
      setMessage({ text: "Couldn't remove them right now.", error: true });
    }
  };

  const signIn = () => dispatch({ type: "go", screen: "account" });

  return (
    <motion.main
      className="screen account-screen scroll"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
      aria-labelledby="friends-title"
    >
      <header className="account-head">
        <button className="btn btn--paper btn--icon account-back" onClick={() => dispatch({ type: "go", screen: "settings" })} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
        <div className="account-head__title">
          <span className="eyebrow">Parkdex</span>
          <h1 id="friends-title">Friends</h1>
        </div>
      </header>

      <div className="account-body">
        {message && (
          <div className={message.error ? "account-notice card is-error" : "account-notice card"} role="status">
            <span>{message.text}</span>
            <button className="account-notice__close" onClick={() => setMessage(null)} aria-label="Dismiss"><Icon name="close" size={16} /></button>
          </div>
        )}

        {guest && (
          <section className="account-card card account-section friends-signin">
            <strong>{pending.length ? `${pending[0].name ?? "A friend"}${pending.length > 1 ? ` and ${pending.length - 1} more are` : " is"} waiting for you` : "Play with friends"}</strong>
            <p className="account-help">
              {pending.length
                ? "Make a free account to become friends and see who's visited the most parks. Your Dex comes with you."
                : "Scan a friend's code now, even offline. Make a free account when you're ready to join the board."}
            </p>
            <button className="btn btn--sun btn--block" onClick={signIn}>Make an account</button>
          </section>
        )}

        {!guest && (
          <section className="account-card card account-section" aria-labelledby="friends-board-title">
            <div className="friends-section-head">
              <h2 id="friends-board-title">Leaderboard</h2>
              <span className="account-help">{updatedLabel(cache.fetchedAt)}</span>
            </div>
            <div className="friends-tabs" role="tablist" aria-label="Leaderboard period">
              {(["month", "all"] as const).map((value) => (
                <button key={value} role="tab" aria-selected={period === value} className={period === value ? "is-active" : ""} onClick={() => setPeriod(value)}>
                  {value === "month" ? monthName(cache.board?.monthStart) : "All time"}
                </button>
              ))}
            </div>
            {cache.board ? (
              <Leaderboard rows={cache.board.rows} period={period} onRemove={(row) => void remove(row)} />
            ) : (
              <p className="account-help">{online ? "Loading your board..." : "Your board shows here once you've been online."}</p>
            )}
          </section>
        )}

        <section className="account-card card account-section" aria-labelledby="friends-add-title">
          <h2 id="friends-add-title">Add a friend</h2>
          <p className="account-help">Scan the QR code on their Friends screen. Their phone camera can scan yours too.</p>
          <button className="btn btn--sun btn--block" onClick={() => setScanning(true)} disabled={busy}>
            <Icon name="qr" size={18} /> Scan their code
          </button>
          <SavedFriends friends={pending} guest={guest} />
        </section>

        {!guest && (
          <section className="account-card card account-section friends-me" aria-labelledby="friends-me-title">
            <h2 id="friends-me-title">Your code</h2>
            {cache.profile ? (
              <>
                <FriendQr value={friendLink(getAuthLinkOrigin(), cache.profile.friendCode, cache.profile.displayName)} />
                {nameInput === null ? (
                  <p className="account-help">
                    Friends see you as <strong>{cache.profile.displayName ?? "Park explorer"}</strong>.{" "}
                    <button className="account-text-button" onClick={() => setNameInput(cache.profile?.displayName ?? "")}>Change</button>
                  </p>
                ) : (
                  <form className="friends-code-form" onSubmit={(event) => void submitName(event)}>
                    <input className="fb-input" value={nameInput} maxLength={40} onChange={(event) => setNameInput(event.target.value)} aria-label="Name friends see" autoFocus />
                    <button className="btn btn--paper btn--sm" type="submit" disabled={busy || !nameInput.trim()}>Save</button>
                  </form>
                )}
                <button className="account-text-button" onClick={() => void newCode()} disabled={busy || !online}>Make a new code</button>
              </>
            ) : (
              <p className="account-help">{online ? "Loading your code..." : "Your code shows here once you've been online."}</p>
            )}
          </section>
        )}
      </div>

      {scanning && <QrScanner onClose={() => setScanning(false)} onResult={(text) => void scanned(text)} />}
    </motion.main>
  );
}
