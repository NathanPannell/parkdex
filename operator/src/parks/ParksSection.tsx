import "./parks.css";
import { CreateFromOsm } from "./CreateFromOsm";
import { ParkManager } from "./ParkManager";
import { ParkPage } from "./ParkPage";
import { ReviewPage } from "./ReviewPage";

/**
 * Parks section: /parks is the map-first park manager, /parks/<id> one park,
 * /parks/osm/<type>-<id> creates a park from an OpenStreetMap outline, and /parks/review
 * decides players' requests for a manual review of a founding photo.
 */
export function ParksSection({ path }: { path: string }) {
  if (path === "/parks/review") return <ReviewPage />;
  const osm = /^\/parks\/osm\/([^/]+)$/.exec(path);
  if (osm) return <CreateFromOsm key={osm[1]} refKey={decodeURIComponent(osm[1])} />;
  const match = /^\/parks\/([^/]+)$/.exec(path);
  if (match) return <ParkPage key={match[1]} id={decodeURIComponent(match[1])} />;
  return <ParkManager />;
}
