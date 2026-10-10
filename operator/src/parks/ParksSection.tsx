import "./parks.css";
import { CreateFromOsm } from "./CreateFromOsm";
import { ParkManager } from "./ParkManager";
import { ParkPage } from "./ParkPage";

/**
 * Parks section: /parks is the map-first park manager, /parks/<id> one park, and
 * /parks/osm/<type>-<id> creates a park from an OpenStreetMap outline.
 */
export function ParksSection({ path }: { path: string }) {
  const osm = /^\/parks\/osm\/([^/]+)$/.exec(path);
  if (osm) return <CreateFromOsm key={osm[1]} refKey={decodeURIComponent(osm[1])} />;
  const match = /^\/parks\/([^/]+)$/.exec(path);
  if (match) return <ParkPage key={match[1]} id={decodeURIComponent(match[1])} />;
  return <ParkManager />;
}
