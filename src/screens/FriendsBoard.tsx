import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/accounts/AuthProvider";
import { friendsErrorMessage, type FriendRow } from "../lib/friends/client";
import { sinceLabel, weekLabel } from "../lib/friends/format";
import { useFriends } from "../lib/friends/FriendsProvider";
import { useGame } from "../lib/game/GameProvider";
import { handleFit } from "../lib/game/handleFit";
import { listItem, listParent, press } from "../lib/motion";
import { formatSocialCode } from "../lib/social/codes";
import { useStore } from "../lib/store";
import "../social.css";

const parksText = (count: number) => `${count} ${count === 1 ? "park" : "parks"} this week`;

function FriendRowItem({ row, open, onToggle, onRemove, canRemove }: { row: FriendRow; open: boolean; onToggle: () => void; onRemove: () => Promise<void>; canRemove: boolean }) {
  const [busy, setBusy] = useState(false);
  const content = (
    <>
      <span className={`game-row__rank ${row.rank === 1 ? "is-first" : ""}`} aria-label={`Rank ${row.rank}`}>{row.rank}</span>
      <Flag seed={row.flagSeed} size={40} />
      <span className="game-row__name">
        <strong style={handleFit(row.isMe ? `${row.handle} (you)` : row.handle)}>@{row.handle}{row.isMe ? " (you)" : ""}</strong>
        <span>{parksText(row.uniqueParks)}</span>
      </span>
      <span className="game-row__score">
        <strong>{row.uniqueParks}</strong>
        <span>{row.uniqueParks === 1 ? "park" : "parks"}</span>
      </span>
    </>
  );
  if (row.isMe) return <div className="game-row card is-me" aria-current="true">{content}</div>;
  return (
    <>
      <button type="button" className="game-row card" onClick={onToggle} aria-expanded={open}>{content}</button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="friend-actions" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <span>{canRemove ? `Remove @${row.handle} from your friends? You'll both stop seeing each other here.` : "Connect to the internet to change your friends."}</span>
            <motion.button
              whileTap={press}
              type="button"
              className="btn btn--sm btn--paper friend-actions__remove"
              disabled={busy || !canRemove}
              onClick={() => {
                setBusy(true);
                void onRemove().finally(() => setBusy(false));
              }}
            >
              {busy ? "Removing…" : "Remove friend"}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** The friends tab of the leaderboard: this week's distinct parks among friends, and adding friends. */
export function FriendsBoard() {
  const friends = useFriends();
  const auth = useAuth();
  const game = useGame();
  const toast = useToast();
  const { dispatch } = useStore();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const signedIn = auth.phase === "authenticated" || auth.phase === "offline-account";
  const needsHandle = auth.phase === "authenticated" && (friends.status === "handle_required" || (game.status === "ready" && !game.me?.player));
  const { refresh, online } = friends;

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, online, game.me?.player?.handle, refresh]);

  const confirmIncoming = async (code: string) => {
    setAdding(true);
    try {
      const result = await friends.add(code, "link");
      friends.clearIncoming();
      if (result.kind === "added") toast(`You and @${result.friend.handle} are friends`, "moss");
      else if (result.kind === "already_friends") toast(`You and @${result.friend.handle} are already friends`);
      else if (result.kind === "queued") toast("Saved. It goes out next time you're online.");
      else toast(result.message, "kip");
    } finally {
      setAdding(false);
    }
  };

  if (!signedIn) {
    return (
      <section className="account-card card game-empty friends-empty">
        <Kip size={72} pose="wave" />
        <h2>Play with friends</h2>
        <p className="account-help">Sign in to add friends by QR code and see who visits the most parks each week. Playing on your own never needs an account.</p>
        {friends.incoming && <p className="friends-incoming__code">Friend code {formatSocialCode(friends.incoming)} is waiting.</p>}
        <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => dispatch({ type: "go", screen: "account" })}>Sign in</motion.button>
      </section>
    );
  }

  if (needsHandle) {
    return (
      <section className="account-card card game-empty friends-empty">
        <Kip size={72} pose="point" />
        <h2>Pick a handle first</h2>
        <p className="account-help">Friends see your @handle and flag on the weekly board.</p>
        <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => game.openHandleSheet({ onDone: () => void refresh() })}>Pick a handle</motion.button>
      </section>
    );
  }

  const board = friends.board;
  const others = board?.players.filter((row) => !row.isMe) ?? [];

  return (
    <>
      <AnimatePresence initial={false}>
        {friends.incoming && (
          <motion.section key="incoming" className="account-card card friends-incoming" initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} aria-labelledby="friends-incoming-title">
            <span className="eyebrow">Friend link</span>
            <h2 id="friends-incoming-title">Add this friend?</h2>
            <p className="friends-incoming__code">{formatSocialCode(friends.incoming)}</p>
            <div className="friends-incoming__actions">
              <motion.button whileTap={press} className="btn btn--sun btn--sm" disabled={adding} onClick={() => void confirmIncoming(friends.incoming!)}>
                {adding ? "Adding…" : "Add friend"}
              </motion.button>
              <button type="button" className="btn btn--paper btn--sm" disabled={adding} onClick={friends.clearIncoming}>Not now</button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <section className="account-card card friends-week">
        <div className="friends-week__text">
          <span className="eyebrow">Parks this week</span>
          <strong>{board ? weekLabel(board.week) : "This week"}</strong>
        </div>
        <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => friends.setAddSheet("open")}>
          <Icon name="flagPlus" size={18} /> Add friend
        </motion.button>
      </section>

      {friends.status === "offline" && (
        <p className="friends-note" role="status">
          {board && friends.fetchedAt ? `You're offline. This board is from ${sinceLabel(friends.fetchedAt, Date.now())}.` : "You're offline. Your friends show up when you reconnect."}
        </p>
      )}
      {friends.status === "error" && (
        <p className="friends-note friends-note--error" role="alert">
          {friends.error ?? friendsErrorMessage(null)} <button type="button" className="friends-note__retry" onClick={() => void refresh()}>Try again</button>
        </p>
      )}

      {friends.pending.length > 0 && (
        <section className="account-card card friends-pending" aria-labelledby="friends-pending-title">
          <h2 id="friends-pending-title">Waiting to send</h2>
          <ul>
            {friends.pending.map((item) => <li key={item.code}>{formatSocialCode(item.code)}</li>)}
          </ul>
          <p className="account-help">These friend codes go out the next time you're online.</p>
        </section>
      )}

      {!board && friends.status === "loading" ? (
        <section className="account-card card account-loading" aria-live="polite">
          <Kip size={64} pose="think" />
          <div><strong>Finding your friends…</strong></div>
        </section>
      ) : board && others.length === 0 ? (
        <section className="account-card card game-empty friends-empty">
          <Kip size={72} pose="cheer" />
          <h2>Add your first friend</h2>
          <p className="account-help">Scan their Parkdex code, or show them yours. Then see who visits the most parks this week.</p>
        </section>
      ) : null}

      {board && board.players.length > 0 && (others.length > 0) && (
        <motion.ol className="game-list game-board" aria-label="You and your friends by parks visited this week" variants={listParent} initial="hidden" animate="show">
          {board.players.map((row) => (
            <motion.li key={row.handle} variants={listItem}>
              <FriendRowItem
                row={row}
                open={openRow === row.handle}
                onToggle={() => setOpenRow((current) => (current === row.handle ? null : row.handle))}
                canRemove={friends.online}
                onRemove={async () => {
                  try {
                    await friends.remove(row.handle);
                    setOpenRow(null);
                    toast(`Removed @${row.handle}`);
                  } catch (caught) {
                    toast(friendsErrorMessage(caught), "kip");
                  }
                }}
              />
            </motion.li>
          ))}
        </motion.ol>
      )}
    </>
  );
}
