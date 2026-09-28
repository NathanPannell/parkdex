import { motion } from "motion/react";
import { useEffect } from "react";
import { Kip } from "../components/Kip";
import { useStore } from "../lib/store";

const WORD = "parkdex".split("");

export function Splash() {
  const { state, dispatch } = useStore();
  const next = () => dispatch({ type: "go", screen: state.onboarded ? "map" : "onboarding" });

  useEffect(() => {
    const t = setTimeout(next, 2600);
    return () => clearTimeout(t);
  }, [state.onboarded]);

  return (
    <motion.div
      className="screen splash"
      onClick={next}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.08, filter: "blur(6px)" }}
      transition={{ duration: 0.45 }}
    >
      <motion.div
        className="splash__sun"
        initial={{ scale: 0 }}
        animate={{ scale: 1, rotate: 90 }}
        transition={{ scale: { type: "spring", stiffness: 120, damping: 14 }, rotate: { duration: 12, ease: "linear" } }}
      />
      <motion.div
        className="splash__kip"
        initial={{ y: -420, rotate: -30 }}
        animate={{ y: 0, rotate: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 13, delay: 0.25 }}
      >
        <Kip pose="wave" size={190} />
      </motion.div>
      <h1 className="splash__word" aria-label="parkdex">
        {WORD.map((ch, i) => (
          <motion.span
            key={i}
            initial={{ y: 60, opacity: 0, rotate: i % 2 ? 12 : -12 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 16, delay: 0.7 + i * 0.06 }}
          >
            {ch}
          </motion.span>
        ))}
      </h1>
      <motion.p className="splash__tag" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.35 }}>
        Go outside. Find new badges.
      </motion.p>
    </motion.div>
  );
}
