import "./parks.css";
import { LiveParkEditor } from "./LiveParkEditor";
import { LiveParksPage } from "./LiveParksPage";

/**
 * Parks section: /parks lists the live catalogue and /parks/<id> edits one park. The map-first
 * park manager from #135 replaces both.
 */
export function ParksSection({ path }: { path: string }) {
  const match = /^\/parks\/([^/]+)$/.exec(path);
  if (match) return <LiveParkEditor key={match[1]} id={decodeURIComponent(match[1])} />;
  return <LiveParksPage />;
}
