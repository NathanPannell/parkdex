import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Flag, FlagPin } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { fetchGameLeaderboard, gameErrorMessage, isOfflineError, type LeaderboardRow } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { useFriends } from "../lib/friends/FriendsProvider";
import { formatScore } from "../lib/game/visit";
import { handleFit } from "../lib/game/handleFit";
import { bouncy, listItem, listParent, press, tabPage } from "../lib/motion";
import { useStore } from "../lib/store";
import { FriendsBoard } from "./FriendsBoard";
import { PlayerSheet } from "./PlayerSheet";
import "../game.css";
import "../game-ui.css";

type Board = { status: "loading" | "ready" | "offline" | "error"; players: LeaderboardRow[]; message: string | null };

// Podium order on screen: second, first, third. With fewer players only their steps show,
// centred, so one or two players don't leave an empty step.
const PODIUM = [1, 0, 2];
const PODIUM_HEIGHT = [92, 64, 44];

function Podium({ players, myHandle, onPick }: { players: LeaderboardRow[]; myHandle: string | null; onPick: (row: LeaderboardRow) => void }) {
  const places = PODIUM.filter((place) => players[place]);
  return (
    <div className="game-podium-stand">
      <div className={`game-podium game-podium--${places.length}`} aria-label="Top players">
        {places.map((place, column) => {
          const row = players[place];
          const mine = row.handle === myHandle;
          return (
            <motion.button
              type="button"
              key={row.handle}
              className={`game-podium__spot ${place === 0 ? "is-first" : ""} ${mine ? "is-me" : ""}`}
              onClick={() => onPick(row)}
              aria-label={`Rank ${row.rank || place + 1}, @${row.handle}${mine ? " (you)" : ""}, ${formatScore(row.score)} ${row.score === 1 ? "point" : "points"}`}
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ ...bouncy, delay: 0.1 + column * 0.08 + (place === 0 ? 0.15 : 0) }}
            >
              <span className="game-podium__flag">
                <FlagPin
                  seed={row.flagSeed}
                  patches={row.patches}
                  size={place === 0 ? 70 : 56}
                  showAge={false}
                  className="is-waving-pin"
                  label={`Flag of @${row.handle}`}
                />
              </span>
              <strong className="game-podium__handle" style={handleFit(row.handle)}>
                @{row.handle}
              </strong>
              <span className="game-podium__score">
                {formatScore(row.score)} {row.score === 1 ? "pt" : "pts"}
              </span>
              <motion.span
                className={`game-podium__block game-podium__block--${place + 1}`}
                initial={{ height: 0 }}
                animate={{ height: PODIUM_HEIGHT[place] }}
                transition={{ ...bouncy, delay: 0.05 + column * 0.08 }}
              >
                {place + 1}
              </motion.span>
            </motion.button>
          );
        })}
      </div>
      <span className="game-podium__base" aria-hidden="true" />
    </div>
  );
}

type BoardTab = "everyone" | "friends";

/**
 * Every player ranked by total score. Online only: nothing is kept between visits. With the
 * `friends` flag on, a second tab ranks the player and their friends by parks visited this week.
 */
export function Leaderboard() {
  const { dispatch } = useStore();
  const game = useGame();
  const friends = useFriends();
  const [board, setBoard] = useState<Board>({ status: "loading", players: [], message: null });
  const [tab, setTab] = useState<BoardTab>(friends.enabled && friends.incoming ? "friends" : "everyone");
  const [picked, setPicked] = useState<LeaderboardRow | null>(null);
  const myHandle = game.me?.player?.handle ?? null;
  const showFriends = friends.enabled && tab === "friends";

  // A friend link opens the friends tab.
  useEffect(() => {
    if (friends.enabled && friends.incoming) setTab("friends");
  }, [friends.enabled, friends.incoming]);

  const load = useCallback(async () => {
    setBoard((current) => ({ ...current, status: "loading", message: null }));
    try {
      const response = await fetchGameLeaderboard();
      setBoard({ status: "ready", players: response.players, message: null });
    } catch (error) {
      setBoard({ status: isOfflineError(error) ? "offline" : "error", players: [], message: gameErrorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rest = board.players.slice(3);

  return (
    <motion.main className="screen account-screen account-screen--tabbed game-screen scroll" {...tabPage} aria-labelledby="leaderboard-title">
      <header className="account-head">
        <div className="account-head__title">
          <span className="eyebrow">{showFriends ? "You and your friends" : "Everyone playing"}</span>
          <h1 id="leaderboard-title">Leaders</h1>
        </div>
        <motion.button
          whileTap={{ rotate: 180, scale: 0.9 }}
          className="btn btn--paper btn--icon game-refresh"
          onClick={() => void (showFriends ? friends.refresh() : load())}
          aria-label="Refresh"
          disabled={showFriends ? friends.status === "loading" : board.status === "loading"}
        >
          <Icon name="refresh" size={20} />
        </motion.button>
      </header>

      <div className="account-body">
        {friends.enabled && (
          <div className="board-tabs" role="tablist" aria-label="Leaders">
            {(["everyone", "friends"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`board-tab-${name}`}
                aria-selected={tab === name}
                aria-controls="board-panel"
                className={`board-tabs__tab ${tab === name ? "is-on" : ""}`}
                onClick={() => setTab(name)}
              >
                {name === "everyone" ? "Everyone" : "Friends"}
                {tab === name && (
                  <motion.span layoutId="board-tab-pill" className="board-tabs__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />
                )}
              </button>
            ))}
          </div>
        )}
        {showFriends ? (
          <div id="board-panel" role="tabpanel" aria-labelledby="board-tab-friends" className="board-panel">
            <FriendsBoard />
          </div>
        ) : board.status === "offline" || board.status === "error" ? (
          <section className="account-card card game-empty" role="alert">
            <Kip size={64} pose="think" />
            <h2>{board.status === "offline" ? "The leaderboard needs a connection" : "The leaderboard didn't load"}</h2>
            <p className="account-help">{board.status === "offline" ? "Connect to the internet to see who's ahead." : board.message}</p>
            <motion.button whileTap={press} className="btn btn--paper btn--block" onClick={() => void load()}>
              <Icon name="refresh" /> Try again
            </motion.button>
          </section>
        ) : board.status === "loading" && board.players.length === 0 ? (
          <section className="account-card card account-loading" aria-live="polite">
            <Kip size={64} pose="think" />
            <div>
              <strong>Counting flags…</strong>
            </div>
          </section>
        ) : board.players.length === 0 ? (
          <section className="account-card card game-empty">
            <Kip size={72} pose="cheer" />
            <h2>No flags yet</h2>
            <p className="account-help">Be the first to plant a flag and top the board.</p>
            <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => dispatch({ type: "go", screen: "map" })}>
              <Icon name="map" size={18} /> Find a park
            </motion.button>
          </section>
        ) : (
          <>
            <Podium players={board.players} myHandle={myHandle} onPick={setPicked} />
            {rest.length === 0 && (
              <section className="account-card card game-empty game-board-more">
                <Kip size={56} pose="wave" />
                <p className="account-help">More players show up here as they plant flags.</p>
              </section>
            )}
            {rest.length > 0 && (
              <motion.ol className="game-list game-board" aria-label="Everyone else by score" variants={listParent} initial="hidden" animate="show" start={4}>
                {rest.map((row, index) => {
                  const mine = row.handle === myHandle;
                  return (
                    <motion.li key={row.handle} variants={listItem}>
                      <button
                        type="button"
                        className={`game-row card ${mine ? "is-me" : ""}`}
                        aria-current={mine ? "true" : undefined}
                        onClick={() => setPicked(row)}
                      >
                        <span className={`game-row__rank ${row.rank === 1 ? "is-first" : ""}`} aria-label={`Rank ${row.rank || index + 4}`}>
                          {row.rank || index + 4}
                        </span>
                        <Flag seed={row.flagSeed} patches={row.patches} size={40} />
                        <span className="game-row__name">
                          <strong style={handleFit(mine ? `${row.handle} (you)` : row.handle)}>
                            @{row.handle}
                            {mine ? " (you)" : ""}
                          </strong>
                          <span>
                            {row.parksHeld} {row.parksHeld === 1 ? "park" : "parks"} held
                          </span>
                        </span>
                        <span className="game-row__score">
                          <strong>{formatScore(row.score)}</strong>
                          <span>{row.score === 1 ? "point" : "points"}</span>
                        </span>
                      </button>
                    </motion.li>
                  );
                })}
              </motion.ol>
            )}
          </>
        )}
      </div>
      <PlayerSheet player={showFriends ? null : picked} mine={!!picked && picked.handle === myHandle} onClose={() => setPicked(null)} />
    </motion.main>
  );
}
