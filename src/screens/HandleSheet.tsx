import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { useState, type FormEvent } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { buzz, sfx } from "../lib/feedback";
import { GameError, handleProblem, normalizeHandle, type GamePlayer } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { handleFit } from "../lib/game/handleFit";
import { press, shake } from "../lib/motion";
import "../game.css";
import "../game-ui.css";

function saveErrorMessage(error: unknown, handle: string): string {
  if (!(error instanceof GameError)) return "Your handle couldn't be saved. Try again.";
  switch (error.code) {
    case "handle_taken":
      return `Someone already has @${handle}. Try another.`;
    case "handle_rejected":
      return "That handle can't be used. Try another.";
    case "invalid_handle":
      return "Use 3 to 20 letters, numbers or underscores.";
    case "offline":
      return "You need a connection to pick a handle. Try again when you're back online.";
    case "unauthenticated":
      return "Sign in again to pick a handle.";
    default:
      return error.message;
  }
}

/** Picks or changes the player's @handle and shows the flag that comes with the account. */
export function HandleSheet() {
  const game = useGame();
  const request = game.handleRequest;
  const existing = game.me?.player ?? null;
  // The server sends the account's flag seed before a handle exists, so the flag can show now.
  const previewSeed = existing?.flagSeed ?? game.me?.flagSeed ?? null;
  const [value, setValue] = useState(existing?.handle ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useAnimationControls();
  const [revealed, setRevealed] = useState<GamePlayer | null>(null);
  const handle = normalizeHandle(value);
  const problem = handleProblem(handle);
  const unchanged = !!existing && existing.handle === handle;

  const close = () => {
    if (busy) return;
    game.closeHandleSheet();
  };

  const finish = (player: GamePlayer) => {
    const onDone = request?.onDone;
    game.closeHandleSheet();
    onDone?.(player);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || busy) {
      if (problem) void field.start(shake);
      return;
    }
    if (unchanged && existing) {
      finish(existing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const player = await game.saveHandle(handle);
      sfx.pop();
      buzz([20, 40, 20]);
      // A first handle reveals the flag; a renamed player already knows theirs.
      if (existing) finish(player);
      else setRevealed(player);
    } catch (caught) {
      setError(saveErrorMessage(caught, handle));
      void field.start(shake);
      buzz([20, 30, 20]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <motion.div className="sheet-scrim handle-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.div
        className="sheet handle-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handle-title"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 320, damping: 32 }}
      >
        <div className="sheet__handle" />
        <button className="park-sheet__close handle-sheet__close" onClick={close} aria-label="Close" disabled={busy}>
          <Icon name="close" size={18} stroke={3} />
        </button>
        <AnimatePresence mode="wait" initial={false}>
          {revealed ? (
            <motion.div
              key="reveal"
              className="handle-sheet__body handle-reveal"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <span className="eyebrow">Your flag</span>
              <h2 id="handle-title" style={handleFit(revealed.handle)}>
                Meet your flag, @{revealed.handle}
              </h2>
              <motion.div
                className="handle-reveal__flag"
                initial={{ scale: 0.3, rotate: -14 }}
                animate={{ scale: 1, rotate: -3 }}
                transition={{ type: "spring", stiffness: 260, damping: 13 }}
              >
                <Flag seed={revealed.flagSeed} size={176} label={`Flag of @${revealed.handle}`} />
              </motion.div>
              <p className="handle-sheet__help">It's yours for good. Everyone sees it on the parks you hold.</p>
              <button className="btn btn--sun btn--block" onClick={() => finish(revealed)}>
                {request?.onDone ? "Plant your flag" : "Done"}
              </button>
            </motion.div>
          ) : (
            <motion.form
              key="pick"
              className="handle-sheet__body"
              onSubmit={(event) => void submit(event)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -10 }}
            >
              <span className="eyebrow">{existing ? "Your handle" : "Before you plant"}</span>
              <h2 id="handle-title">{existing ? "Change your handle" : "Pick your handle"}</h2>
              <div className="handle-sheet__preview" style={handleFit(handle || "yourname")}>
                <Flag seed={previewSeed} size={84} label={previewSeed ? "Your flag" : undefined} className={previewSeed ? "is-waving" : undefined} />
                <span>
                  <motion.strong
                    key={handle.length}
                    initial={{ scale: 1.08 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 600, damping: 20 }}
                  >
                    @{handle || "yourname"}
                  </motion.strong>
                  <em>{existing ? "Your flag stays the same." : previewSeed ? "This flag comes with it." : "Your flag comes with it."}</em>
                </span>
              </div>
              <label className="fb-label" htmlFor="handle-input">
                Handle
              </label>
              <motion.div className="handle-input" animate={field}>
                <span aria-hidden="true">@</span>
                <input
                  id="handle-input"
                  className="fb-input"
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError(null);
                  }}
                  onBlur={() => setTouched(true)}
                  maxLength={21}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="text"
                  aria-invalid={touched && !!problem}
                  aria-describedby="handle-help"
                  placeholder="yourname"
                  autoFocus
                />
              </motion.div>
              <p id="handle-help" className={`handle-sheet__help ${touched && problem ? "is-error" : ""}`}>
                {touched && problem ? problem : "3 to 20 letters, numbers or underscores. Friends see it on the map and the leaderboard."}
              </p>
              {error && (
                <p className="handle-sheet__error" role="alert">
                  {error}
                </p>
              )}
              <motion.button whileTap={press} className="btn btn--sun btn--block" type="submit" disabled={busy || (touched && !!problem)}>
                {busy ? "Saving…" : existing ? "Save handle" : "Use this handle"}
              </motion.button>
            </motion.form>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}
