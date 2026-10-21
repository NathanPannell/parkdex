import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { useBackHandler } from "../lib/backStack";
import { friendsErrorMessage } from "../lib/friends/client";
import { useFriends } from "../lib/friends/FriendsProvider";
import type { LeaderboardRow } from "../lib/game/client";
import { handleFit } from "../lib/game/handleFit";
import { formatScore } from "../lib/game/visit";
import { press } from "../lib/motion";
import "../game.css";
import "../game-ui.css";
import "../social.css";

/** The leaderboard screen is its own layer, so the sheet goes above the bottom bar from the device root. */
function AboveNav({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector(".device") ?? document.body);
}

/**
 * With the `friends` flag on and an account, what the player can do about someone on the board
 * today: remove a friend, or open the add-a-friend sheet to scan their code or show their own.
 */
function FriendActions({ handle, onClose }: { handle: string; onClose: () => void }) {
  const friends = useFriends();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { board, online, refresh, status } = friends;
  const isFriend = !!board?.players.some((row) => !row.isMe && row.handle === handle);

  // Who counts as a friend comes from the friends board, which may not have loaded this session.
  useEffect(() => {
    if (!board && online && status === "idle") void refresh();
  }, [board, online, status, refresh]);

  if (isFriend)
    return (
      <div className="friend-actions player-sheet__friend">
        <span>
          {online ? `You and @${handle} are friends. Removing them takes you both off each other's board.` : "Connect to the internet to change your friends."}
        </span>
        <motion.button
          whileTap={press}
          type="button"
          className="btn btn--sm btn--paper friend-actions__remove"
          disabled={busy || !online}
          onClick={() => {
            setBusy(true);
            void friends
              .remove(handle)
              .then(() => {
                toast(`Removed @${handle}`);
                onClose();
              })
              .catch((caught: unknown) => toast(friendsErrorMessage(caught), "kip"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Removing…" : "Remove friend"}
        </motion.button>
      </div>
    );

  return (
    <>
      <motion.button
        whileTap={press}
        className="btn btn--sun btn--block"
        onClick={() => {
          onClose();
          friends.setAddSheet("open");
        }}
      >
        <Icon name="flagPlus" size={18} /> Add friend
      </motion.button>
      <p className="handle-sheet__help">Scan @{handle}'s Parkdex code, or show them yours.</p>
    </>
  );
}

/** A player tapped on the leaderboard: their flag, @handle, score and parks held. */
export function PlayerSheet({ player, mine, onClose }: { player: LeaderboardRow | null; mine: boolean; onClose: () => void }) {
  const friends = useFriends();
  useBackHandler(onClose, !!player);
  const showFriends = friends.enabled && !!friends.accountId && !mine;

  return (
    <AboveNav>
      <AnimatePresence>
        {player && (
          <>
            <motion.div
              key="player-scrim"
              className="sheet-scrim handle-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
            />
            <motion.div
              key="player-sheet"
              className="sheet handle-sheet player-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="player-sheet-title"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <div className="sheet__handle" />
              <button className="park-sheet__close handle-sheet__close" onClick={onClose} aria-label="Close">
                <Icon name="close" size={18} stroke={3} />
              </button>
              <div className="handle-sheet__body">
                <span className="eyebrow">{player.rank ? `Rank ${player.rank}` : "On the board"}</span>
                <div className="handle-sheet__preview">
                  <Flag seed={player.flagSeed} patches={player.patches} size={64} className="is-waving" />
                  <span>
                    <strong id="player-sheet-title" style={handleFit(mine ? `${player.handle} (you)` : player.handle)}>
                      @{player.handle}
                      {mine ? " (you)" : ""}
                    </strong>
                  </span>
                </div>
                <dl className="player-sheet__stats">
                  <div>
                    <dt>{player.score === 1 ? "Point" : "Points"}</dt>
                    <dd>{formatScore(player.score)}</dd>
                  </div>
                  <div>
                    <dt>{player.parksHeld === 1 ? "Park held" : "Parks held"}</dt>
                    <dd>{player.parksHeld}</dd>
                  </div>
                </dl>
                {showFriends && <FriendActions handle={player.handle} onClose={onClose} />}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </AboveNav>
  );
}
