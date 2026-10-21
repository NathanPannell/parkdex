import { useGame } from "../lib/game/GameProvider";
import { handleFit } from "../lib/game/handleFit";
import { formatPoints } from "../lib/game/visit";
import { useState } from "react";
import { Flag } from "./Flag";
import { MyFlagViewer } from "./FlagViewer";
import { Icon } from "./Icon";
import "../game.css";

/** The account's game identity: its flag, its @handle, and the way to pick or change it. */
export function GameIdentityCard() {
  const game = useGame();
  const player = game.me?.player ?? null;
  const unavailable = game.status === "offline" || game.status === "error";
  const [viewingFlag, setViewingFlag] = useState(false);

  return (
    <section className="account-card card account-section" aria-labelledby="game-identity-title" style={handleFit(player?.handle)}>
      <span className="eyebrow" id="game-identity-title">
        Your flag
      </span>
      <div className="game-identity">
        {player ? (
          <button className="viewer-open" onClick={() => setViewingFlag(true)} aria-label={`Show the flag of @${player.handle} full screen`}>
            <Flag seed={player.flagSeed} size={72} patches={game.me?.flagPatches} />
          </button>
        ) : (
          <Flag seed={game.me?.flagSeed ?? null} size={72} />
        )}
        <div className="game-identity__text">
          <strong>{player ? `@${player.handle}` : game.status === "loading" ? "Loading…" : "No handle yet"}</strong>
          <span>
            {player
              ? `${formatPoints(game.me?.score ?? 0)} · ${game.me?.parks.length ?? 0} ${game.me?.parks.length === 1 ? "park" : "parks"} held`
              : unavailable
                ? game.status === "offline"
                  ? "Connect to the internet to see your flag."
                  : (game.error ?? "Your flag is unavailable right now.")
                : "Pick a handle to get your flag and start planting."}
          </span>
        </div>
      </div>
      {unavailable ? (
        <button className="btn btn--paper btn--sm" onClick={() => void game.refresh()}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      ) : (
        game.status === "ready" && (
          <button className={`btn btn--sm ${player ? "btn--paper" : "btn--sun"}`} onClick={() => game.openHandleSheet()}>
            {player ? "Change handle" : "Pick your handle"}
          </button>
        )
      )}
      <MyFlagViewer open={viewingFlag} onClose={() => setViewingFlag(false)} />
    </section>
  );
}
