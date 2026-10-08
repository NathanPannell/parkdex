import { useGame } from "../lib/game/GameProvider";
import { Flag } from "./Flag";
import { Icon } from "./Icon";
import "../game.css";

/** The account's game identity: its flag, its @handle, and the way to pick or change it. */
export function GameIdentityCard() {
  const game = useGame();
  const player = game.me?.player ?? null;
  const unavailable = game.status === "offline" || game.status === "error";

  return (
    <section className="account-card card account-section" aria-labelledby="game-identity-title">
      <span className="eyebrow" id="game-identity-title">Your flag</span>
      <div className="game-identity">
        <Flag seed={player?.flagSeed ?? null} size={72} label={player ? `Flag of @${player.handle}` : undefined} />
        <div className="game-identity__text">
          <strong>{player ? `@${player.handle}` : game.status === "loading" ? "Loading…" : "No handle yet"}</strong>
          <span>
            {player
              ? `${game.me?.score ?? 0} ${game.me?.score === 1 ? "point" : "points"} · ${game.me?.parks.length ?? 0} ${game.me?.parks.length === 1 ? "park" : "parks"} held`
              : unavailable
                ? game.status === "offline" ? "Connect to the internet to see your flag." : game.error ?? "Your flag is unavailable right now."
                : "Pick a handle to get your flag and start planting."}
          </span>
        </div>
      </div>
      {unavailable ? (
        <button className="btn btn--paper btn--sm" onClick={() => void game.refresh()}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      ) : game.status === "ready" && (
        <button className={`btn btn--sm ${player ? "btn--paper" : "btn--sun"}`} onClick={() => game.openHandleSheet()}>
          {player ? "Change handle" : "Pick your handle"}
        </button>
      )}
    </section>
  );
}
