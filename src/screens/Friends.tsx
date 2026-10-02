import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { Icon } from "../components/Icon";
import { QrScanner } from "../components/QrScanner";
import { useAuth } from "../lib/accounts/AuthProvider";
import {
  addFriend,
  fetchLeaderboard,
  fetchProfile,
  flushPendingCodes,
  formatFriendCode,
  friendLink,
  isPermanentFriendError,
  parseFriendCode,
  queueFriendCode,
  readPendingCodes,
  readSocialCache,
  removeFriend,
  rotateFriendCode,
  saveDisplayName,
  writeSocialCache,
  type LeaderboardRow,
  type SocialCache,
} from "../lib/social/client";
import { useStore } from "../lib/store";
import "../friends.css";

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

function Leaderboard({ rows, onRemove }: { rows: LeaderboardRow[]; onRemove(row: LeaderboardRow): void }) {
  if (rows.length <= 1) {
    return <p className="account-help">Add a friend to start a weekly race. Unique parks claimed since Monday count.</p>;
  }
  return (
    <ol className="friends-board">
      {rows.map((row, index) => (
        <li key={row.accountId} className={row.isMe ? "friends-board__row is-me" : "friends-board__row"}>
          <span className="friends-board__rank" aria-label={`Rank ${index + 1}`}>{index + 1}</span>
          <span className="friends-board__name">
            <strong>{row.isMe ? `${row.displayName} (you)` : row.displayName}</strong>
            <span>{row.totalParks} {row.totalParks === 1 ? "park" : "parks"} all time</span>
          </span>
          <span className="friends-board__score">
            <strong>{row.parksThisWeek}</strong>
            <span>this week</span>
          </span>
          {!row.isMe && (
            <button className="account-text-button friends-board__remove" onClick={() => onRemove(row)} aria-label={`Remove ${row.displayName}`}>
              <Icon name="close" size={16} />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Friends and the weekly leaderboard. Needs an account; shows the last saved answer offline. */
export function Friends() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const accountId = auth.account?.id ?? auth.ownerAccountId ?? null;
  const online = auth.phase === "authenticated";
  const [cache, setCache] = useState<SocialCache>(() => (accountId ? readSocialCache(accountId) : { profile: null, board: null, fetchedAt: null }));
  const [pending, setPending] = useState<string[]>(() => (accountId ? readPendingCodes(accountId) : []));
  const [scanning, setScanning] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = useCallback((next: SocialCache) => {
    setCache(next);
    if (accountId) writeSocialCache(accountId, next);
  }, [accountId]);

  const refresh = useCallback(async () => {
    if (!accountId || !online) return;
    try {
      const flushed = await flushPendingCodes(accountId);
      setPending(readPendingCodes(accountId));
      if (flushed.added.length) setMessage({ text: `Added ${flushed.added.map((friend) => friend.displayName).join(", ")}.` });
      if (flushed.rejected.length) setMessage({ text: `${formatFriendCode(flushed.rejected[0].code)}: ${flushed.rejected[0].message}`, error: true });
      const [profile, board] = await Promise.all([fetchProfile(accountId), fetchLeaderboard(accountId)]);
      save({ profile, board, fetchedAt: new Date().toISOString() });
    } catch {
      setMessage({ text: "Couldn't reach Parkdex. Showing your last saved board.", error: true });
    }
  }, [accountId, online, save]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submitCode = async (raw: string) => {
    if (!accountId) return;
    const code = parseFriendCode(raw);
    if (!code) {
      setMessage({ text: "That doesn't look like a Parkdex friend code.", error: true });
      return;
    }
    if (code === cache.profile?.friendCode) {
      setMessage({ text: "That's your own code.", error: true });
      return;
    }
    setCodeInput("");
    if (!online) {
      queueFriendCode(accountId, code);
      setPending(readPendingCodes(accountId));
      setMessage({ text: `Saved ${formatFriendCode(code)}. They'll be added when you're back online.` });
      return;
    }
    setBusy(true);
    try {
      const friend = await addFriend(accountId, code);
      setMessage({ text: `${friend.displayName} is now your friend.` });
      await refresh();
    } catch (error) {
      if (isPermanentFriendError(error)) {
        setMessage({ text: error instanceof Error ? error.message : "That code didn't work.", error: true });
      } else {
        queueFriendCode(accountId, code);
        setPending(readPendingCodes(accountId));
        setMessage({ text: `Saved ${formatFriendCode(code)}. They'll be added when you're back online.` });
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
    if (!accountId || !window.confirm("Make a new code? Your old QR code will stop working. Friends you already have stay.")) return;
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

  const back = () => dispatch({ type: "go", screen: "settings" });
  const signedOut = auth.phase === "guest" || !accountId;

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
        <button className="btn btn--paper btn--icon account-back" onClick={back} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
        <div className="account-head__title">
          <span className="eyebrow">Parkdex</span>
          <h1 id="friends-title">Friends</h1>
        </div>
      </header>

      <div className="account-body">
        {signedOut ? (
          <section className="account-card card account-section friends-signin">
            <strong>Sign in to add friends</strong>
            <p className="account-help">Friends and the weekly leaderboard need a Parkdex account. You can keep exploring solo without one.</p>
            <button className="btn btn--sun btn--block" onClick={() => dispatch({ type: "go", screen: "account" })}>Sign in</button>
          </section>
        ) : (
          <>
            {message && (
              <div className={message.error ? "account-notice card is-error" : "account-notice card"} role="status">
                <span>{message.text}</span>
                <button className="account-notice__close" onClick={() => setMessage(null)} aria-label="Dismiss"><Icon name="close" size={16} /></button>
              </div>
            )}

            <section className="account-card card account-section" aria-labelledby="friends-board-title">
              <div className="friends-section-head">
                <h2 id="friends-board-title">This week</h2>
                <span className="account-help">{updatedLabel(cache.fetchedAt)}</span>
              </div>
              {cache.board ? (
                <Leaderboard rows={cache.board.rows} onRemove={(row) => void remove(row)} />
              ) : (
                <p className="account-help">{online ? "Loading your board..." : "Your board shows here once you've been online."}</p>
              )}
            </section>

            <section className="account-card card account-section" aria-labelledby="friends-add-title">
              <h2 id="friends-add-title">Add a friend</h2>
              <button className="btn btn--sun btn--block" onClick={() => setScanning(true)} disabled={busy}>
                <Icon name="qr" size={18} /> Scan their code
              </button>
              <form className="friends-code-form" onSubmit={(event) => { event.preventDefault(); void submitCode(codeInput); }}>
                <input
                  className="fb-input"
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
                  placeholder="Or type a code, like ABCD-EFGH"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Friend code"
                />
                <button className="btn btn--paper btn--sm" type="submit" disabled={busy || !codeInput.trim()}>Add</button>
              </form>
              {pending.length > 0 && (
                <p className="account-help">
                  Waiting to add when you're online: {pending.map(formatFriendCode).join(", ")}
                </p>
              )}
            </section>

            <section className="account-card card account-section friends-me" aria-labelledby="friends-me-title">
              <h2 id="friends-me-title">Your code</h2>
              {cache.profile ? (
                <>
                  <FriendQr value={friendLink(cache.profile.friendCode)} />
                  <p className="friends-me__code">{formatFriendCode(cache.profile.friendCode)}</p>
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
          </>
        )}
      </div>

      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => { setScanning(false); void submitCode(text); }}
        />
      )}
    </motion.main>
  );
}
