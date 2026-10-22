import { useState } from "react";
import type { Park } from "../lib/parks";
import { Badge } from "./Badge";

/**
 * A park's official photo, its founder's public cover (docs/park-founders.md), filling its frame.
 * Without one, or when it can't load (offline), the park's badge frame stands in.
 */
export function ParkCover({ park, url, badgeSize, visited, alt = "" }: { park: Park; url: string | null; badgeSize: number; visited: boolean; alt?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <Badge park={park} size={badgeSize} state={visited ? "earned" : "silhouette"} remoteArt={false} />;
  return (
    <span className="park-cover">
      <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(url)} />
    </span>
  );
}
