import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBackHandler } from "../lib/backStack";
import { closeKipTip, currentKipTip, noteKipTipShown, setKipTipsPaused, subscribeKipTips, type KipTipClose, type ShownKipTip } from "../lib/kipTips";
import { press } from "../lib/motion";
import { Kip } from "./Kip";
import "../kip-tips.css";

/**
 * Shows the waiting Kip's Tip over whatever screen is up. It never pauses anything underneath:
 * timers and countdowns behind it keep running, and Skip, back or a tap outside closes it.
 */
export function KipTipHost({ paused }: { paused: boolean }) {
  useEffect(() => setKipTipsPaused(paused), [paused]);
  const current = useSyncExternalStore(subscribeKipTips, currentKipTip, currentKipTip);
  return <AnimatePresence>{current && <KipTipCard key={current.token} shown={current} />}</AnimatePresence>;
}

function KipTipCard({ shown }: { shown: ShownKipTip }) {
  const { tip, token } = shown;
  const [page, setPage] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const primary = useRef<HTMLButtonElement>(null);
  const last = page === tip.pages.length - 1;
  const content = tip.pages[page] ?? tip.pages[0];
  const close = (how: KipTipClose) => closeKipTip(token, how, pageRef.current);

  useEffect(() => {
    noteKipTipShown(token);
    primary.current?.focus({ preventScroll: true });
  }, [token]);

  useBackHandler(() => close("back"));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The tip is on top, so it takes Escape before any screen underneath sees it.
      event.stopPropagation();
      close("back");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      <motion.div className="kip-tip-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => close("outside")} />
      <motion.section
        className="kip-tip card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`kip-tip-title-${token}`}
        aria-describedby={`kip-tip-body-${token}`}
        initial={{ y: 40, opacity: 0, scale: 0.94 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 30, opacity: 0, scale: 0.96 }}
        transition={{ type: "spring", stiffness: 420, damping: 30 }}
      >
        <div className="kip-tip__kip" aria-hidden="true">
          <Kip key={content.pose} pose={content.pose} size={92} />
        </div>
        <button className="kip-tip__skip" onClick={() => close("skip")}>
          Skip
        </button>
        <span className="eyebrow">Kip's Tips</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page}
            className="kip-tip__text"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -24, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <h2 id={`kip-tip-title-${token}`}>{content.title}</h2>
            <p id={`kip-tip-body-${token}`}>{content.body}</p>
          </motion.div>
        </AnimatePresence>
        <div className="kip-tip__foot">
          {tip.pages.length > 1 ? (
            <span className="kip-tip__dots" aria-label={`Page ${page + 1} of ${tip.pages.length}`}>
              {tip.pages.map((_, index) => (
                <span key={index} className={index === page ? "is-current" : undefined} />
              ))}
            </span>
          ) : (
            <span />
          )}
          <motion.button ref={primary} whileTap={press} className="btn btn--sm btn--sun" onClick={() => (last ? close("done") : setPage((value) => value + 1))}>
            {last ? "Got it" : "Next"}
          </motion.button>
        </div>
      </motion.section>
    </>
  );
}
