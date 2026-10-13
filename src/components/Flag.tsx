import { useId, useMemo } from "react";
import { blankFlagSvg, flagPinSvg, flagSvg, FLAG_HEIGHT, FLAG_WIDTH, formatFlagAge, PIN_HEIGHT, PIN_WIDTH, weatherForDays } from "../lib/game/flag";

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

/**
 * A flag on its pole with an age tag, or an empty pole for a park nobody holds. The tag reads
 * `ageMs` (35m, 3h, 2d); without it, the whole days.
 */
export function FlagPin({ seed, days = 0, ageMs, size = 48, showAge = true, label, className }: Props & { showAge?: boolean; ageMs?: number }) {
  const id = useId();
  const weather = weatherForDays(days);
  const age = seed && showAge ? formatFlagAge(ageMs ?? days * 86_400_000) : undefined;
  const markup = useMemo(
    () => flagPinSvg(seed, { weather, idPrefix: `pin${id}`, label: age }),
    [seed, weather, id, age],
  );
  return (
    <span
      className={["flag", "flag-pin", className].filter(Boolean).join(" ")}
      style={{ width: size, height: Math.round((size * PIN_HEIGHT) / PIN_WIDTH) }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
