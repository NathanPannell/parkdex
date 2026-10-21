import { useId, useMemo } from "react";
import { useFeatureFlag } from "../lib/appConfig";
import { blankFlagSvg, flagPinSvg, flagSvg, FLAG_HEIGHT, FLAG_WIDTH, formatFlagAge, PIN_HEIGHT, PIN_WIDTH, weatherForDays } from "../lib/game/flag";
import { flagPatchesMarkup, pinPatchesMarkup, withPatches } from "../lib/game/patches";

type Props = {
  /** The player's public flag seed; null draws an empty outline. */
  seed: string | null;
  /** Width in CSS pixels; the height follows the 3:2 cloth. */
  size?: number;
  /** Days the flag has flown, for the weathered look. */
  days?: number;
  label?: string;
  className?: string;
  /**
   * Badges sewn on this flag (#175), drawn on top of it when the flag is big enough. Never changes
   * the flag itself. Ignored while the `badges` flag is off, whatever the server sent.
   */
  patches?: readonly string[];
};

/** The patches to draw, as a cache key: none at all while the `badges` flag is off. */
function usePatchKey(patches: readonly string[] | undefined): string {
  const badges = useFeatureFlag("badges");
  return badges ? (patches?.join(",") ?? "") : "";
}

export function Flag({ seed, size = 48, days = 0, label, className, patches }: Props) {
  const id = useId();
  const weather = weatherForDays(days);
  const patchKey = usePatchKey(patches);
  // The markup is generated from a fixed vocabulary of shapes and colours, never from user text;
  // patches only ever name badges from the bundled list.
  const markup = useMemo(
    () =>
      seed
        ? withPatches(
            flagSvg(seed, { weather, idPrefix: `flag${id}` }),
            flagPatchesMarkup(patchKey ? patchKey.split(",") : [], { sizePx: size, idPrefix: `flag${id}` }),
          )
        : blankFlagSvg(),
    [seed, weather, id, patchKey, size],
  );
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
export function FlagPin({ seed, days = 0, ageMs, size = 48, showAge = true, label, className, patches }: Props & { showAge?: boolean; ageMs?: number }) {
  const id = useId();
  const weather = weatherForDays(days);
  const age = seed && showAge ? formatFlagAge(ageMs ?? days * 86_400_000) : undefined;
  const patchKey = usePatchKey(patches);
  const markup = useMemo(() => {
    const pin = flagPinSvg(seed, { weather, idPrefix: `pin${id}`, label: age });
    return seed ? withPatches(pin, pinPatchesMarkup(patchKey ? patchKey.split(",") : [], { sizePx: size, idPrefix: `pin${id}` })) : pin;
  }, [seed, weather, id, age, patchKey, size]);
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
