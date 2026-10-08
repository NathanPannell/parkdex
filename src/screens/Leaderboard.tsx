import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { fetchGameLeaderboard, gameErrorMessage, isOfflineError, type LeaderboardRow } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { useStore } from "../lib/store";
import "../game.css";

type Board = { status: "loading" | "ready" | "offline" | "error"; players: LeaderboardRow[]; message: string | null };

/** Every player ranked by total score. Online only: nothing is kept between visits. */
export function Leaderboard() {
  const { dispatch } = useStore();
  const game = useGame();
  const [board, setBoard] = useState<Board>({ status: "loading", players: [], message: null });
  const myHandle = game.me?.player?.handle ?? null;

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

  return (
    <motion.main
      className="screen account-screen account-screen--tabbed game-screen scroll"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      aria-labelledby="leaderboard-title"
    >
      <header className="account-head">
        <div className="account-head__title">
          <span className="eyebrow">Everyone playing</span>
          <h1 id="leaderboard-title">Leaderboard</h1>
        </div>
        <button className="btn btn--paper btn--icon game-refresh" onClick={() => void load()} aria-label="Refresh" disabled={board.status === "loading"}>
          <Icon name="refresh" size={20} />
        </button>
      </header>

      <div className="account-body">
        {board.status === "offline" || board.status === "error" ? (
          <section className="account-card card game-empty" role="alert">
            <Kip size={64} pose="think" />
            <h2>{board.status === "offline" ? "The leaderboard needs a connection" : "The leaderboard didn't load"}</h2>
            <p className="account-help">{board.status === "offline" ? "Connect to the internet to see who's ahead." : board.message}</p>
            <button className="btn btn--paper btn--block" onClick={() => void load()}><Icon name="refresh" /> Try again</button>
          </section>
        ) : board.status === "loading" && board.players.length === 0 ? (
          <section className="account-card card account-loading" aria-live="polite">
            <Kip size={64} pose="think" />
            <div><strong>Counting flags…</strong></div>
          </section>
        ) : board.players.length === 0 ? (
          <section className="account-card card game-empty">
            <Kip size={72} pose="cheer" />
            <h2>No flags yet</h2>
            <p className="account-help">Be the first to plant a flag and top the board.</p>
            <button className="btn btn--sun btn--sm" onClick={() => dispatch({ type: "go", screen: "map" })}><Icon name="map" size={18} /> Find a park</button>
          </section>
        ) : (
          <ol className="game-list game-board" aria-label="Players by score">
            {board.players.map((row, index) => {
              const mine = row.handle === myHandle;
              return (
                <motion.li key={row.handle} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: Math.min(index * 0.03, 0.4) }}>
                  <div className={`game-row card ${mine ? "is-me" : ""}`} aria-current={mine ? "true" : undefined}>
                    <span className="game-row__rank" aria-label={`Rank ${row.rank || index + 1}`}>{row.rank || index + 1}</span>
                    <Flag seed={row.flagSeed} size={40} />
                    <span className="game-row__name">
                      <strong>@{row.handle}{mine ? " (you)" : ""}</strong>
                      <span>{row.parksHeld} {row.parksHeld === 1 ? "park" : "parks"} held</span>
                    </span>
                    <span className="game-row__score">
                      <strong>{row.score}</strong>
                      <span>{row.score === 1 ? "point" : "points"}</span>
                    </span>
                  </div>
                </motion.li>
              );
            })}
          </ol>
        )}
      </div>
    </motion.main>
  );
}
