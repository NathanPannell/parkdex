import { useMemo } from "react";
import type { CrewMember } from "../lib/game/client";
import { crewMemberNote } from "../lib/game/crew";
import { pennantSvg } from "../lib/game/mapPins";
import { Flag } from "./Flag";
import "../crews.css";

/** A crew (#171): each member's flag, @handle, and "planted" or "joined +12 min". */
export function CrewList({ members, flagSince, myHandle, className }: { members: readonly CrewMember[]; flagSince: string; myHandle?: string | null; className?: string }) {
  return (
    <ul className={["crew-list", className].filter(Boolean).join(" ")} aria-label="Crew">
      {members.map((member) => (
        <li key={member.handle} className={member.handle === myHandle ? "is-me" : undefined}>
          <Flag seed={member.flagSeed} size={38} patches={member.patches} />
          <strong>@{member.handle}{member.handle === myHandle ? " (you)" : ""}</strong>
          <em>{crewMemberNote(member, flagSince)}</em>
        </li>
      ))}
    </ul>
  );
}

/** A member's pennant in their flag colours, for the join scene. */
export function Pennant({ seed, size = 50, className }: { seed: string; size?: number; className?: string }) {
  // Generated from the seed with a fixed vocabulary of shapes, never from user text.
  const markup = useMemo(() => pennantSvg(seed), [seed]);
  return (
    <span
      className={["pennant", className].filter(Boolean).join(" ")}
      style={{ width: size, height: Math.round((size * 32) / 50) }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
