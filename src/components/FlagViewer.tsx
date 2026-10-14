import { useFeatureFlag } from "../lib/appConfig";
import { useGame } from "../lib/game/GameProvider";
import { formatPoints } from "../lib/game/visit";
import { flagViewSize } from "../lib/viewer";
import { Flag } from "./Flag";
import { FullscreenViewer, type ViewerSlide } from "./FullscreenViewer";

/**
 * "My flag", full screen: your flag drawn big as crisp SVG with its sewn badge patches (with the
 * `badges` flag on), and your
 * @handle and score under it. Opened from the score chip on the map, the score card in My Dex and
 * the flag card in Account. Shows nothing until you have a handle and a flag.
 */
export function MyFlagViewer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const player = game.me?.player ?? null;
  const badges = useFeatureFlag("badges");
  const patches = badges ? game.me?.flagPatches ?? [] : [];
  const score = game.me?.score ?? 0;
  const slides: ViewerSlide[] = player
    ? [{
      key: "my-flag",
      alt: `Flag of @${player.handle}${patches.length ? ` with ${patches.length} ${patches.length === 1 ? "badge" : "badges"}` : ""}`,
      render: (stage) => (
        <div className="flag-view">
          <Flag seed={player.flagSeed} size={flagViewSize(stage)} patches={patches} />
          <div className="flag-view__name">
            <strong>@{player.handle}</strong>
            <span>{formatPoints(score)}</span>
          </div>
        </div>
      ),
    }]
    : [];
  return <FullscreenViewer slides={slides} index={open ? 0 : null} onClose={onClose} label="Your flag" />;
}
