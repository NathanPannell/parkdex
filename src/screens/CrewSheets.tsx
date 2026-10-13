import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { CrewList } from "../components/CrewList";
import { Icon } from "../components/Icon";
import { QrCode } from "../components/QrCode";
import { QrScanner, type QrScannerSource } from "../components/QrScanner";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/accounts/AuthProvider";
import { useBackHandler } from "../lib/backStack";
import { insidePark, parkContaining, useBoundaries } from "../lib/boundaries";
import { useContent } from "../lib/content/provider";
import { CREW_CODE_LENGTH, CREW_POINTS, crewCodeFromText, crewLink, formatMinutesLeft } from "../lib/game/crew";
import { useCrew, type CrewJoinTarget } from "../lib/game/CrewProvider";
import { useGame } from "../lib/game/GameProvider";
import { handleFit } from "../lib/game/handleFit";
import { useParkCrew, useScreenWakeLock, useServerClock } from "../lib/game/useParkCrew";
import { useVisit } from "../lib/game/useVisit";
import { isUsableGpsAccuracy } from "../lib/geo";
import { press } from "../lib/motion";
import { shareLink } from "../lib/native";
import { formatSocialCode } from "../lib/social/codes";
import { useStore, type Screen } from "../lib/store";
import "../game.css";
import "../social.css";

/**
 * Crew sheets (#171), behind the `crews` flag: the crew code sheet members show their friends,
 * the scanner, and the join card a scanned code or crew link opens.
 */

/** Screens the join card may cover. Sign-in, the plant screen and onboarding keep it waiting. */
const JOIN_CARD_SCREENS: readonly Screen[] = ["map", "parks", "leaderboard", "settings"];

export function CrewSheets() {
  const crew = useCrew();
  const { state } = useStore();
  const showJoin = !!crew.join && JOIN_CARD_SCREENS.includes(state.screen) && !crew.scanner;
  return (
    <>
      <AnimatePresence>{crew.codeSheet && <CrewCodeSheet key="crew-code" parkId={crew.codeSheet} onClose={crew.closeCodeSheet} />}</AnimatePresence>
      <AnimatePresence>{crew.scanner && <CrewScanner key="crew-scanner" parkId={crew.scanner.parkId} />}</AnimatePresence>
      <AnimatePresence>{showJoin && crew.join && <CrewJoinCard key={`join-${crew.join.code}`} target={crew.join} />}</AnimatePresence>
    </>
  );
}

function CrewScanner({ parkId }: { parkId: string | null }) {
  const crew = useCrew();
  const onCode = (text: string, source: QrScannerSource): string | null => {
    const target = crewCodeFromText(text);
    if (!target) return source === "scan" ? "That isn't a Parkdex crew code." : `Crew codes are ${CREW_CODE_LENGTH} letters and numbers.`;
    // A code scanned from a park's page is for that park unless its link names another.
    crew.offerJoin({ code: target.code, parkId: target.parkId ?? parkId, source });
    return null;
  };
  return (
    <QrScanner
      title="Scan crew code"
      hint="Point at the crew code on a crew member's phone"
      codeLength={CREW_CODE_LENGTH}
      onCode={onCode}
      onClose={crew.closeScanner}
    />
  );
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useBackHandler(onClose);
  return (
    <>
      <motion.div className="sheet-scrim handle-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="sheet handle-sheet crew-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={label}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 320, damping: 32 }}
      >
        <div className="sheet__handle" />
        <button className="park-sheet__close handle-sheet__close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} stroke={3} />
        </button>
        {children}
      </motion.div>
    </>
  );
}

/** A large QR and the 6-character code, for anyone in the crew to show during the protected hour. */
export function CrewCodeSheet({ parkId, onClose }: { parkId: string; onClose: () => void }) {
  const content = useContent();
  const game = useGame();
  const toast = useToast();
  const park = content?.parkById.get(parkId);
  const parkName = park?.short ?? park?.name ?? "this park";
  // Reading the crew records the code as shown, which is what opening this sheet does.
  const { status, crew } = useParkCrew(parkId, true);
  const code = crew?.code ?? null;
  const until = crew?.codeExpiresAt ?? crew?.protectedUntil ?? null;
  const now = useServerClock(!!code);
  const live = !!code && !!until && Date.parse(until) > now;
  useScreenWakeLock(live);
  const link = code ? crewLink(code, parkId) : null;

  const share = async () => {
    if (!link) return;
    try {
      const shared = await shareLink(link, `Join my crew at ${parkName} on Parkdex`);
      if (shared === "copied") toast("Link copied");
      else if (shared === "unsupported") toast("Sharing isn't available here", "kip");
    } catch {
      // The player closed the share sheet.
    }
  };

  return (
    <Sheet label="crew-code-title" onClose={onClose}>
      <div className="handle-sheet__body crew-code">
        <span className="eyebrow">Crew code · {parkName}</span>
        <h2 id="crew-code-title">Bring your crew</h2>
        {live && code && link && until ? (
          <>
            <div className="add-friend__mine crew-code__card">
              <QrCode value={link} size={232} label={`Crew code ${code.split("").join(" ")} as a QR code`} />
              <span className="crew-code__code" aria-label={`Crew code ${code.split("").join(" ")}`}>{formatSocialCode(code)}</span>
              <span className="crew-code__timer" role="timer"><Icon name="shield" size={16} /> {formatMinutesLeft(until, now)} left</span>
            </div>
            <p className="handle-sheet__help">Anyone in the crew can show this code. Friends scan it with Parkdex or their phone's camera inside {parkName}.</p>
            <motion.button whileTap={press} className="btn btn--paper btn--block" onClick={() => void share()}>
              <Icon name="share" size={18} /> Share the link
            </motion.button>
          </>
        ) : status === "loading" || status === "idle" ? (
          <p className="handle-sheet__help" aria-busy="true">Getting the crew code…</p>
        ) : status === "error" ? (
          <p className="handle-sheet__help">The crew code needs a connection. Try again in a moment.</p>
        ) : (
          <p className="handle-sheet__help">The protected hour is over, so this crew can't take new people.</p>
        )}
        <button type="button" className="add-friend__link" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

/** "Join @tom's crew at Beacon Hill · +2": the crew's flags, with Join and Cancel. */
// The card keeps its target as a prop, so it can still render while it animates away after a join.
function CrewJoinCard({ target }: { target: CrewJoinTarget }) {
  const crewUi = useCrew();
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const content = useContent();
  const bounds = useBoundaries();
  const visit = useVisit();
  const game = useGame();
  const accuracy = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy) ? state.accuracy ?? 0 : 0;
  const here = parkContaining(state.user, content?.parks ?? [], bounds?.byId, accuracy);
  // The link names the park; a bare code from a park's page is for that page; otherwise the park you stand in.
  const parkId = target.parkId ?? here?.id ?? null;
  const park = parkId ? content?.parkById.get(parkId) : undefined;
  const parkName = park?.short ?? park?.name ?? null;
  const inside = !!park && insidePark(state.user, bounds?.byId.get(park.id), accuracy);
  const signedIn = visit.signedIn;
  const { status, crew } = useParkCrew(parkId, signedIn && auth.phase === "authenticated");
  const now = useServerClock(!!crew?.protectedUntil, 15_000);
  const over = status === "ready" && (!crew || !crew.protectedUntil || Date.parse(crew.protectedUntil) <= now);
  const already = !!crew?.member;
  const leader = crew?.leader.handle ?? null;
  const title = `Join ${leader ? `@${leader}'s crew` : "this crew"}${parkName ? ` at ${parkName}` : ""} · +${CREW_POINTS.join}`;

  const blocker = !signedIn
    ? null
    : already
      ? "You're already in this crew."
      : over
        ? "This crew's protected hour is over, so it can't take new people."
        : !inside
          ? `Get inside ${park?.name ?? "the crew's park"} to join.`
          : null;
  const canJoin = signedIn ? !blocker && !!park : true;

  const onJoin = () => {
    if (!signedIn) {
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "account" });
      return;
    }
    if (park) visit.startJoin(park.id, target.code);
  };

  return (
    <Sheet label="crew-join-title" onClose={crewUi.dismissJoin}>
      <div className="handle-sheet__body crew-join">
        <span className="eyebrow">Crew code {formatSocialCode(target.code)}</span>
        <h2 id="crew-join-title" style={handleFit(leader ? `${leader}'s` : null)}>{title}</h2>
        {crew && crew.members.length > 0 ? (
          <CrewList members={crew.members} flagSince={crew.flagSince} myHandle={game.me?.player?.handle} />
        ) : (
          <p className="handle-sheet__help">
            {signedIn ? (status === "loading" ? "Looking up the crew…" : "You hold the park together, and every one of you earns its hours.") : "Sign in to join. You hold the park together, and every one of you earns its hours."}
          </p>
        )}
        {blocker && <p className="crew-join__blocker" role="status"><Icon name="pin" size={16} /> {blocker}</p>}
        <motion.button whileTap={press} className="btn btn--sun btn--block" disabled={!canJoin} onClick={onJoin}>
          {signedIn ? <><Icon name="flag" size={20} /> Join</> : "Sign in to join"}
        </motion.button>
        <button type="button" className="btn btn--paper btn--block" onClick={crewUi.dismissJoin}>Cancel</button>
      </div>
    </Sheet>
  );
}
