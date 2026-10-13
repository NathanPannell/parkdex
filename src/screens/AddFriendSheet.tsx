import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { QrCode } from "../components/QrCode";
import { QrScanner, type QrScannerSource } from "../components/QrScanner";
import { useToast } from "../components/Toast";
import { useBackHandler } from "../lib/backStack";
import { friendsErrorMessage, type FriendSummary } from "../lib/friends/client";
import { useFriends, type AddResult } from "../lib/friends/FriendsProvider";
import { friendCodeFromText, friendLink } from "../lib/friends/links";
import { useGame } from "../lib/game/GameProvider";
import { press } from "../lib/motion";
import { shareLink } from "../lib/native";
import { FRIEND_CODE_LENGTH, formatSocialCode } from "../lib/social/codes";
import "../game.css";
import "../social.css";

function addToast(result: AddResult): { text: string; tone: "ink" | "kip" | "moss" } {
  if (result.kind === "added") return { text: `You and @${result.friend.handle} are friends`, tone: "moss" };
  if (result.kind === "already_friends") return { text: `You and @${result.friend.handle} are already friends`, tone: "ink" };
  if (result.kind === "queued") return { text: "Saved. It goes out next time you're online.", tone: "ink" };
  return { text: result.message, tone: "kip" };
}

/** The player's own QR and code to show a friend, and the way into the scanner. */
function AddFriendBody({ onScan, onClose }: { onScan: () => void; onClose: () => void }) {
  const friends = useFriends();
  const game = useGame();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const code = friends.board?.code ?? null;
  const player = game.me?.player ?? null;
  const link = code ? friendLink(code) : null;

  const share = async () => {
    if (!link) return;
    try {
      const shared = await shareLink(link, player ? `Add @${player.handle} on Parkdex` : "Add me on Parkdex");
      if (shared === "copied") toast("Link copied");
      else if (shared === "unsupported") toast("Sharing isn't available here", "kip");
    } catch {
      // The player closed the share sheet.
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await friends.resetCode();
      setConfirmReset(false);
      toast("New code ready. The old one no longer works.");
    } catch (caught) {
      toast(friendsErrorMessage(caught), "kip");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="handle-sheet__body add-friend">
      <span className="eyebrow">Add a friend</span>
      <h2 id="add-friend-title">Scan or share</h2>
      <motion.button whileTap={press} className="btn btn--sun btn--block" onClick={onScan}>
        <Icon name="camera" size={20} /> Scan a friend's code
      </motion.button>
      <div className="add-friend__mine">
        {code && link ? (
          <>
            <QrCode value={link} size={196} label={`Your friend code, ${formatSocialCode(code)}, as a QR code`} />
            <div className="add-friend__who">
              {player && <Flag seed={player.flagSeed} size={34} />}
              <span>
                <strong>{player ? `@${player.handle}` : "Your code"}</strong>
                <span className="add-friend__code" aria-label={`Friend code ${code.split("").join(" ")}`}>{formatSocialCode(code)}</span>
              </span>
            </div>
            <p className="handle-sheet__help">Your friend scans this with Parkdex or their phone's camera, or types the code.</p>
          </>
        ) : (
          <p className="handle-sheet__help">Your code shows here once you've been online. You can still scan a friend's code now.</p>
        )}
      </div>
      {link && (
        <motion.button whileTap={press} className="btn btn--paper btn--block" onClick={() => void share()}>
          <Icon name="share" size={18} /> Share your link
        </motion.button>
      )}
      {code && (
        confirmReset ? (
          <div className="add-friend__reset" role="group" aria-label="Get a new code">
            <p>Your old code, QR and links stop working. Your friends stay.</p>
            <div>
              <button type="button" className="btn btn--sm btn--paper" disabled={busy} onClick={() => setConfirmReset(false)}>Keep this code</button>
              <button type="button" className="btn btn--sm btn--ink" disabled={busy || !friends.online} onClick={() => void reset()}>{busy ? "Changing…" : "Get a new code"}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="add-friend__link" onClick={() => setConfirmReset(true)} disabled={!friends.online}>
            Get a new code
          </button>
        )
      )}
      <button type="button" className="add-friend__link" onClick={onClose}>Done</button>
    </div>
  );
}

/** The add-a-friend sheet and its scanner, above the tabs. Opened from the friends board. */
export function AddFriendSheet() {
  const friends = useFriends();
  const toast = useToast();
  const open = friends.addSheet !== "closed";
  const close = () => friends.setAddSheet("closed");

  const onCode = async (text: string, source: QrScannerSource): Promise<string | null> => {
    const code = friendCodeFromText(text);
    if (!code) return source === "scan" ? "That isn't a Parkdex friend code." : `Friend codes are ${FRIEND_CODE_LENGTH} letters and numbers.`;
    const result = await friends.add(code, source);
    if (result.kind === "rejected") return result.message;
    const { text: message, tone } = addToast(result);
    toast(message, tone);
    close();
    return null;
  };

  return (
    <>
      <AnimatePresence>
        {open && friends.addSheet === "open" && <SheetFrame key="add-friend" onClose={close}><AddFriendBody onScan={() => friends.setAddSheet("scan")} onClose={close} /></SheetFrame>}
      </AnimatePresence>
      <AnimatePresence>
        {friends.addSheet === "scan" && (
          <QrScanner
            key="friend-scanner"
            title="Scan a friend's code"
            hint="Point at a friend's Parkdex code"
            codeLength={FRIEND_CODE_LENGTH}
            onCode={onCode}
            onClose={() => friends.setAddSheet("open")}
          />
        )}
      </AnimatePresence>
      <FriendNotices />
    </>
  );
}

function SheetFrame({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useBackHandler(onClose);
  return (
    <>
      <motion.div className="sheet-scrim handle-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="sheet handle-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-friend-title"
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

/** Toasts for codes that went out in the background, such as after a sync. */
function FriendNotices() {
  const friends = useFriends();
  const toast = useToast();
  const shown = useRef(0);
  const { notices, clearNotices } = friends;

  useEffect(() => {
    if (!notices.length) {
      shown.current = 0;
      return;
    }
    const fresh = notices.slice(shown.current);
    shown.current = notices.length;
    const added = fresh.filter((notice): notice is Extract<typeof notice, { friend: FriendSummary }> => notice.status === "added");
    const rejected = fresh.filter((notice) => notice.status === "rejected");
    if (added.length === 1) toast(`You and @${added[0].friend.handle} are friends`, "moss");
    else if (added.length > 1) toast(`${added.length} new friends added`, "moss");
    if (rejected.length) toast(rejected.length === 1 ? `Friend code ${formatSocialCode(rejected[0].code)} didn't work` : `${rejected.length} friend codes didn't work`, "kip");
    clearNotices();
  }, [notices, clearNotices, toast]);

  return null;
}
