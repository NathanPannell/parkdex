import { useId, useMemo } from "react";
import { blankFlagSvg, flagSvg, FLAG_HEIGHT, FLAG_WIDTH, weatherForDays } from "../lib/game/flag";

type Props = {
  /** The player's public flag seed; null draws an empty outline. */
  seed: string | null;
  /** Width in CSS pixels; the height follows the 3:2 cloth. */
  size?: number;
  /** Days the flag has flown, for the weathered look. */
  days?: number;
  label?: string;
  className?: string;
};

export function Flag({ seed, size = 48, days = 0, label, className }: Props) {
  const id = useId();
  const weather = weatherForDays(days);
  // The markup is generated from a fixed vocabulary of shapes and colours, never from user text.
  const markup = useMemo(() => (seed ? flagSvg(seed, { weather, idPrefix: `flag${id}` }) : blankFlagSvg()), [seed, weather, id]);
  const height = Math.round((size * (FLAG_HEIGHT + 2)) / (FLAG_WIDTH + 2));
  return (
    <span
      className={["flag", className].filter(Boolean).join(" ")}
      style={{ width: size, height }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
