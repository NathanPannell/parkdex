import { toBlob } from "html-to-image";
import { LayoutGroup, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { sfx } from "../lib/feedback";
import { isNative, shareImage } from "../lib/native";
import { PALETTES, PARK_BY_ID, RARITY, sceneUrl, TOTAL_BADGES, type Park } from "../lib/parks";
import { useStore, type Claim } from "../lib/store";

type Look = "polaroid" | "badge";

export function StoryCard({
  park,
  claim,
  number,
  look,
  cardRef,
  sceneHref,
}: {
  park: Park;
  claim: Claim;
  number: number;
  look: Look;
  cardRef?: React.Ref<HTMLDivElement>;
  sceneHref?: string;
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
        <Badge park={park} size={look === "badge" ? 210 : 132} state="earned" sceneHref={sceneHref} />
      </motion.div>
      <motion.div layout className="story__text" transition={{ type: "spring", stiffness: 300, damping: 28 }}>
        <span>I collected</span>
        <strong>{park.short}</strong>
        <em>
          Badge #{number} of {TOTAL_BADGES.toLocaleString("en-CA")} · {RARITY[park.rarity].label}
        </em>
      </motion.div>
      <div className="story__kip">
        <Kip size={64} pose="wave" />
      </div>
    </div>
  );
}

export function Share() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  // Pinned at mount: exit animations keep this screen rendering after the trip is cleared.
  const [park] = useState(() => PARK_BY_ID.get(state.tripId ?? "")!);
  const claim = state.claims[park.id];
  const number = Object.keys(state.claims).indexOf(park.id) + 1;
  const [look, setLook] = useState<Look>("polaroid");
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  // html-to-image can't follow <image href> inside SVG, so embed the badge art up front.
  const [sceneHref, setSceneHref] = useState<string>();
  useEffect(() => {
    if (!park.scene) return;
    fetch(sceneUrl(park.scene))
      .then((r) => r.blob())
      .then((b) => new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(b);
      }))
      .then(setSceneHref)
      .catch(() => {});
  }, [park.scene]);

  const image = async () => {
    const blob = await toBlob(card.current!, { pixelRatio: 3, cacheBust: true });
    if (!blob) throw new Error("render failed");
    return new File([blob], `parkdex-${park.short.toLowerCase().replace(/\W+/g, "-")}.png`, { type: "image/png" });
  };

  const share = async () => {
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
    setBusy(true);
    try {
      download(await image());
      sfx.pop();
      toast("Saved to your downloads", "moss");
    } finally {
      setBusy(false);
    }
  };

  if (!claim) return null;

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
          <StoryCard park={park} claim={claim} number={number} look={look} cardRef={card} sceneHref={sceneHref} />
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
        <button className="btn btn--block" onClick={share} disabled={busy}>
          <Icon name="share" /> {busy ? "Getting it ready…" : "Share to story"}
        </button>
        {!isNative && (
          <div className="share__row">
            <button className="btn btn--paper btn--sm" onClick={save} disabled={busy}>
              <Icon name="download" size={18} /> Save image
            </button>
          </div>
        )}
      </div>
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
