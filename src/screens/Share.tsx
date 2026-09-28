import { toBlob } from "html-to-image";
import { LayoutGroup, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { useEarnedSceneAsset } from "../components/EarnedBadge";
import { ContentGate } from "../components/ContentGate";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { sfx } from "../lib/feedback";
import { isNative, shareImage } from "../lib/native";
import { badgeTotal, PALETTES, RARITY, type Park } from "../lib/parks";
import { useStore, type Claim } from "../lib/store";
import { useContent } from "../lib/content/provider";

type Look = "polaroid" | "badge";

export function StoryCard({
  park,
  claim,
  number,
  look,
  totalBadges,
  cardRef,
  sceneHref,
  sceneMessage,
}: {
  park: Park;
  claim: Claim;
  number: number;
  look: Look;
  totalBadges: number;
  cardRef?: React.Ref<HTMLDivElement>;
  sceneHref?: string;
  sceneMessage?: string;
}) {
  const pal = PALETTES[park.biome];
  const date = new Date(claim.at).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
  return (
    <div ref={cardRef} className={`story story--${look}`} style={{ background: `linear-gradient(170deg, ${pal.skyTop} 0%, ${pal.skyBottom} 55%, ${pal.far} 100%)` }}>
      <div className="story__pattern" />
      <div className="story__brand">
        parkdex <span>· {park.region}</span>
      </div>
      <motion.div layout className="story__photo" transition={{ type: "spring", stiffness: 300, damping: 28 }}>
        <img src={claim.photo} alt="" />
        <span className="story__photo-caption">{date}</span>
      </motion.div>
      <motion.div layout className="story__badge" transition={{ type: "spring", stiffness: 300, damping: 24 }}>
        {park.scene && !sceneHref
          ? <div className="story-art-restoring" role="status">{sceneMessage ?? "Restoring badge art…"}</div>
          : <Badge park={park} size={look === "badge" ? 210 : 132} state="earned" sceneHref={sceneHref} />}
      </motion.div>
      <motion.div layout className="story__text" transition={{ type: "spring", stiffness: 300, damping: 28 }}>
        <span>I collected</span>
        <strong>{park.short}</strong>
        <em>
          Badge #{number} of {totalBadges.toLocaleString("en-CA")} · {RARITY[park.rarity].label}
        </em>
      </motion.div>
      <div className="story__kip">
        <Kip size={64} pose="wave" />
      </div>
    </div>
  );
}

export function Share() {
  const { state } = useStore();
  const content = useContent();
  const [pinned] = useState(() => {
    if (state.shareClaimId) {
      const entry = Object.entries(state.claims).find(([, claim]) => claim.claimId === state.shareClaimId);
      if (entry) return { ownerKey: state.progressOwnerKey, parkId: entry[0], claim: entry[1] };
    }
    const parkId = state.tripId ?? "";
    const claim = state.claims[parkId];
    return claim ? { ownerKey: state.progressOwnerKey, parkId, claim } : null;
  });
  if (!state.progressReady || !pinned || state.progressOwnerKey !== pinned.ownerKey) return <ContentGate />;
  const park = pinned.claim.parkSnapshot ?? content?.parkById.get(pinned.parkId);
  if (!park) return <ContentGate />;
  const number = Math.max(1, Object.keys(state.claims).indexOf(pinned.parkId) + 1);
  return <ShareReady park={park} claim={pinned.claim} number={number} />;
}

function ShareReady({ park, claim, number }: { park: Park; claim: Claim; number: number }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const content = useContent();
  const totalBadges = badgeTotal(content?.liveParks ?? [], Object.keys(state.claims));
  const [look, setLook] = useState<Look>("polaroid");
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  // html-to-image can't follow <image href> inside SVG, so embed the badge art up front.
  const [sceneHref, setSceneHref] = useState<string>();
  const { sceneHref: earnedSceneHref, contentDownloadAvailable, waitingForWifi } = useEarnedSceneAsset(park, claim);
  const sceneAsset = park.scene ? earnedSceneHref : undefined;
  const [sceneState, setSceneState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    let live = true;
    setSceneHref(undefined);
    if (!park.scene) {
      setSceneState("ready");
      return () => { live = false; };
    }
    if (!sceneAsset) {
      setSceneState("error");
      return () => { live = false; };
    }
    setSceneState("loading");
    fetch(sceneAsset)
      .then((r) => r.blob())
      .then((b) => new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("Badge artwork could not be embedded."));
        fr.readAsDataURL(b);
      }))
      .then((dataUrl) => {
        if (!live) return;
        setSceneHref(dataUrl);
        setSceneState("ready");
      })
      .catch(() => { if (live) setSceneState("error"); });
    return () => { live = false; };
  }, [park.id, park.scene, sceneAsset]);

  const sceneMessage = !claim.contentReleaseId
    ? "Archived badge art is not available for this claim."
    : waitingForWifi
      ? "Connect to Wi-Fi to restore the original badge art."
      : !contentDownloadAvailable
        ? "Go online to restore the original badge art."
        : sceneState === "error"
          ? "Badge art could not be loaded. Try again shortly."
          : "Restoring the original badge art…";
  const sceneReady = !park.scene || sceneState === "ready";

  const image = async () => {
    const blob = await toBlob(card.current!, { pixelRatio: 3, cacheBust: true });
    if (!blob) throw new Error("render failed");
    return new File([blob], `parkdex-${park.short.toLowerCase().replace(/\W+/g, "-")}.png`, { type: "image/png" });
  };

  const share = async () => {
    if (!sceneReady) return;
    setBusy(true);
    sfx.tap();
    try {
      const file = await image();
      const result = await shareImage(file, file.name, `I collected ${park.short} on Parkdex`);
      if (result === "unsupported") {
        download(file);
        toast("Saved! Post it to your story.", "moss");
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if ((e as Error).name !== "AbortError" && !/cancel/i.test(msg)) toast("Couldn't share that one. Try again.", "kip");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!sceneReady) return;
    setBusy(true);
    try {
      download(await image());
      sfx.pop();
      toast("Saved to your downloads", "moss");
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="screen share"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
    >
      <div className="share__top">
        <button className="btn btn--paper btn--icon btn--sm" onClick={() => dispatch({ type: "go", screen: "map" })} aria-label="Close">
          <Icon name="close" size={18} stroke={3} />
        </button>
        <h2>Show it off</h2>
        <span style={{ width: 48 }} />
      </div>

      <LayoutGroup>
        <motion.div className="share__preview" initial={{ scale: 0.8, rotate: 6, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 200, damping: 18, delay: 0.15 }}>
          <StoryCard park={park} claim={claim} number={number} look={look} totalBadges={totalBadges} cardRef={card} sceneHref={sceneHref} sceneMessage={sceneMessage} />
        </motion.div>
      </LayoutGroup>

      <div className="seg">
        {(["polaroid", "badge"] as Look[]).map((l) => (
          <button key={l} className={`seg__opt ${look === l ? "is-on" : ""}`} onClick={() => setLook(l)}>
            {look === l && <motion.span layoutId="seg" className="seg__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <span>{l === "polaroid" ? "Photo + badge" : "Badge hero"}</span>
          </button>
        ))}
      </div>

      <div className="share__actions">
        <button className="btn btn--block" onClick={share} disabled={busy || !sceneReady}>
          <Icon name="share" /> {busy ? "Getting it ready…" : "Share to story"}
        </button>
        {!isNative && (
          <div className="share__row">
            <button className="btn btn--paper btn--sm" onClick={save} disabled={busy || !sceneReady}>
              <Icon name="download" size={18} /> Save image
            </button>
          </div>
        )}
      </div>
      {!sceneReady && <p className="share-art-status" role="status">{sceneMessage}</p>}
    </motion.div>
  );
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
