import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/accounts/AuthProvider";
import { GUEST_OWNER, adoptGuestFriends, flushPendingFriends, saveFriend } from "../lib/social/client";
import { friendsEnabled } from "../lib/social/flag";
import { listenForFriendLinks } from "../lib/social/links";
import { useStore } from "../lib/store";
import { useToast } from "./Toast";

/**
 * Background half of Friends: catches friend links opened from the phone camera, hands a
 * guest's saved friends to their new account, and sends saved friends whenever the app is online.
 */
export function FriendsSync() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const toast = useToast();
  const accountId = auth.phase === "authenticated" ? auth.account?.id ?? null : null;
  const owner = useRef<string>(GUEST_OWNER);
  owner.current = auth.account?.id ?? auth.ownerAccountId ?? GUEST_OWNER;
  const [openFriends, setOpenFriends] = useState(false);
  const enabled = friendsEnabled();

  useEffect(() => {
    if (!enabled || auth.phase === "starting") return;
    let stop = () => {};
    let live = true;
    void listenForFriendLinks((friend) => {
      saveFriend(owner.current, friend);
      setOpenFriends(true);
    }).then((remove) => (live ? (stop = remove) : remove()));
    return () => { live = false; stop(); };
  }, [enabled, auth.phase === "starting"]);

  // Wait for onboarding to finish before taking someone to Friends.
  useEffect(() => {
    if (!openFriends || !state.startupReady || !state.onboarded || state.screen === "splash" || state.screen === "onboarding") return;
    setOpenFriends(false);
    dispatch({ type: "go", screen: "friends" });
  }, [dispatch, openFriends, state.onboarded, state.screen, state.startupReady]);

  useEffect(() => {
    if (!enabled || !accountId) return;
    let live = true;
    void (async () => {
      adoptGuestFriends(accountId);
      try {
        const result = await flushPendingFriends(accountId);
        if (!live) return;
        if (result.added.length) {
          const names = result.added.map((friend) => friend.displayName).join(" and ");
          toast(`You and ${names} are now friends`, "moss");
        }
      } catch {
        // Saved friends stay on the phone and are tried again next time.
      }
    })();
    return () => { live = false; };
  }, [accountId, enabled, toast]);

  return null;
}
