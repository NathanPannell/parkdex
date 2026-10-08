import type { Transition, Variants } from "motion/react";

/**
 * Shared motion for the flag game screens, so tabs, lists, sheets and celebrations move the
 * same way everywhere. MotionConfig in App respects the system's reduced motion setting.
 */

export const spring: Transition = { type: "spring", stiffness: 420, damping: 28 };
export const softSpring: Transition = { type: "spring", stiffness: 300, damping: 30 };
export const bouncy: Transition = { type: "spring", stiffness: 520, damping: 15 };

/** Tab pages fade up in place; they never slide sideways like pushed pages. */
export const tabPage = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8, transition: { duration: 0.15 } },
  transition: softSpring,
};

/** A list whose rows arrive one after another. */
export const listParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.08 } },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: spring },
};

/** Buttons and rows dip slightly when pressed. */
export const press = { scale: 0.96 };

/** A field shakes side to side when what was typed is rejected. */
export const shake = { x: [0, -10, 9, -6, 4, 0], transition: { duration: 0.4 } };
