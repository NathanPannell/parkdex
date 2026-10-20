import { motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "../components/Badge";
import { BadgeShelf } from "../components/BadgeShelf";
import { CroppedPhoto } from "../components/DexPhoto";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { sfx } from "../lib/feedback";
import { useContent } from "../lib/content/provider";
import { buildCollection, tileImage, visitCountLabel, visitedLabel, type DexRegion, type DexTile } from "../lib/dex/collection";
import { dexStartSegment, openDexOn, readCollapsed, readOnlyMine, writeCollapsed, writeOnlyMine, type DexSegment } from "../lib/dex/prefs";
import { useDex } from "../lib/dex/useDex";
import { press, tabPage } from "../lib/motion";
import { useStore } from "../lib/store";
import { DexParkSheet } from "./DexParkSheet";
import { YourParks } from "./YourParks";
import "../game.css";
import "../game-ui.css";
import "../dex.css";

const SEGMENTS: Array<{ id: DexSegment; label: string }> = [
  { id: "collection", label: "Collection" },
  { id: "flags", label: "Your flags" },
];

/**
 * My Dex (#174): the "Your parks" tab. Collection shows the parks you visited, by province and
 * region, with your own photos; Your flags is the flag list that was this tab before.
 */
export function MyDex() {
  const [segment, setSegment] = useState<DexSegment>(dexStartSegment);
  // Planting a flag can open this tab on Your flags once; after that it opens on Collection.
  useEffect(() => openDexOn("collection"), []);
  const toolbar = (
    <div className="dex-segments" role="tablist" aria-label="My Dex">
      {SEGMENTS.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={segment === item.id}
          className={`dex-segments__tab ${segment === item.id ? "is-on" : ""}`}
          onClick={() => {
            if (item.id === segment) return;
            sfx.tap();
            setSegment(item.id);
          }}
        >
          {segment === item.id && (
            <motion.span layoutId="dex-segment-pill" className="dex-segments__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />
          )}
          <span className="dex-segments__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
  return segment === "flags" ? (
    <YourParks key="flags" title="My Dex" toolbar={toolbar} />
  ) : (
    <DexCollection key="collection" toolbar={toolbar} shelf={<BadgeShelf />} />
  );
}

/**
 * The collection. `shelf` is the slot at the top for the badge shelf (#175).
 */
export function DexCollection({ toolbar, shelf }: { toolbar?: ReactNode; shelf?: ReactNode }) {
  const { dispatch } = useStore();
  const content = useContent();
  const dex = useDex(true);
  const [onlyMine, setOnlyMine] = useState(readOnlyMine);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [openPark, setOpenPark] = useState<string | null>(null);

  const collection = useMemo(
    () => buildCollection({ parks: content?.parks ?? [], visits: dex.visits, photos: dex.photos, onlyMine }),
    [content?.parks, dex.visits, dex.photos, onlyMine],
  );
  const loading = dex.status === "loading" && dex.visits.size === 0;
  // The first time My Dex opens, Kip explains it (#172).

  const toggleOnlyMine = () => {
    sfx.tap();
    setOnlyMine((value) => {
      writeOnlyMine(!value);
      return !value;
    });
  };
  const toggleRegion = (key: string) => {
    sfx.tap();
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(next);
      return next;
    });
  };
  const openTile = (parkId: string) => {
    sfx.pop();
    setOpenPark(parkId);
  };
  const tile = openPark
    ? (collection.provinces
        .flatMap((province) => province.regions)
        .flatMap((region) => region.tiles)
        .find((item) => item.park.id === openPark) ?? null)
    : null;
  const empty = !loading && collection.visited === 0 && dex.visits.size === 0;

  return (
    <motion.main className="screen account-screen account-screen--tabbed game-screen dex-screen scroll" {...tabPage} aria-labelledby="my-dex-title">
      <header className="account-head">
        <div className="account-head__title">
          <span className="eyebrow">Parkdex</span>
          <h1 id="my-dex-title">My Dex</h1>
        </div>
      </header>
      {toolbar}

      <div className="account-body">
        {/* #175: the badge shelf, above the summary. */}
        {shelf}

        <section className="account-card card dex-summary" aria-live="polite">
          <div className="dex-summary__count">
            <strong>{collection.visited.toLocaleString("en-CA")}</strong>
            <span>{collection.visited === 1 ? "park visited" : "parks visited"}</span>
          </div>
          <div className="dex-summary__detail">
            <span>{visitCountLabel(collection.visits)}</span>
            <span>of {collection.total.toLocaleString("en-CA")} parks</span>
          </div>
          <label className="dex-only-mine">
            <span>Only my visits</span>
            <input type="checkbox" role="switch" className="account-switch" checked={onlyMine} onChange={toggleOnlyMine} />
          </label>
        </section>
        {!dex.signedIn && dex.status !== "loading" && (
          <p className="account-help dex-note">
            Showing parks saved on this device.{" "}
            <button className="fb-link" onClick={() => dispatch({ type: "go", screen: "account" })}>
              Sign in
            </button>{" "}
            to add the parks where you planted flags.
          </p>
        )}
        {dex.serverStale && (
          <p className="account-help game-stale" role="status">
            Offline. Showing what Parkdex knew a moment ago.
          </p>
        )}

        {loading ? (
          <section className="account-card card account-loading" aria-live="polite">
            <Kip size={64} pose="think" />
            <div>
              <strong>Loading your Dex…</strong>
            </div>
          </section>
        ) : empty && onlyMine ? (
          <section className="account-card card game-empty">
            <Bubble side="down" style={{ position: "relative" }}>
              Your Dex is empty. Go visit a park!
            </Bubble>
            <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
              <Kip pose="map" size={84} />
            </motion.div>
            <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => dispatch({ type: "go", screen: "map" })}>
              <Icon name="map" size={18} /> Find a park near me
            </motion.button>
          </section>
        ) : (
          collection.provinces.map((province) => (
            <section key={province.name} className="dex-province" aria-label={province.name}>
              <h2 className="dex-province__title">
                <span>{province.name}</span>
                <em>{visitedLabel(province.visited, province.total)}</em>
              </h2>
              {province.regions.map((region) => (
                <RegionView
                  key={region.key}
                  region={region}
                  collapsed={collapsed.has(region.key)}
                  onToggle={() => toggleRegion(region.key)}
                  onOpen={openTile}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <DexParkSheet
        tile={tile}
        onClose={() => setOpenPark(null)}
        onSetCover={dex.setCover}
        onRecrop={dex.recrop}
        onRemove={dex.remove}
        onSaved={dex.reload}
        onShowOnMap={(parkId) => {
          setOpenPark(null);
          dispatch({ type: "focus", id: parkId });
          dispatch({ type: "go", screen: "map" });
        }}
      />
    </motion.main>
  );
}

function RegionView({
  region,
  collapsed,
  onToggle,
  onOpen,
}: {
  region: DexRegion;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (parkId: string) => void;
}) {
  const id = `dex-region-${region.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <section className={`dex-region ${collapsed ? "is-collapsed" : ""}`}>
      <button className="dex-region__head" onClick={onToggle} aria-expanded={!collapsed} aria-controls={id}>
        <span className="dex-region__name">{region.name}</span>
        <span className="dex-region__count">{visitedLabel(region.visited, region.total)}</span>
        <Icon name="next" size={16} />
      </button>
      {!collapsed && <LazyTiles id={id} tiles={region.tiles} onOpen={onOpen} />}
    </section>
  );
}

const TILE_ROW_PX = 244;

/**
 * Draws a region's tiles once it scrolls near the screen. With "Only my visits" off a region can
 * hold hundreds of parks, and drawing every badge at once would stall the tab.
 */
function LazyTiles({ id, tiles, onOpen }: { id: string; tiles: DexTile[]; onOpen: (parkId: string) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(tiles.length <= 12 || typeof IntersectionObserver !== "function");
  useEffect(() => {
    if (near || !holder.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [near]);
  if (!near)
    return <div ref={holder} id={id} className="dex-grid dex-grid--waiting" style={{ height: Math.ceil(tiles.length / 2) * TILE_ROW_PX }} aria-busy="true" />;
  return (
    <ul id={id} className="dex-grid">
      {tiles.map((item) => (
        <TileView key={item.park.id} tile={item} onOpen={onOpen} />
      ))}
    </ul>
  );
}

const TileView = memo(function TileView({ tile, onOpen }: { tile: DexTile; onOpen: (parkId: string) => void }) {
  const image = tileImage(tile);
  const visited = !!tile.visit;
  const name = tile.park.short || tile.park.name;
  return (
    <li>
      <button
        className={`dex-tile ${visited ? "is-visited" : "is-unvisited"}`}
        onClick={() => onOpen(tile.park.id)}
        aria-label={`${tile.park.name}, ${visited ? visitCountLabel(tile.visit!.days.length) : "not visited yet"}`}
      >
        <span className="dex-tile__art">
          {image.kind === "photo" ? (
            <CroppedPhoto blob={image.photo.blob} crop={image.photo.crop} alt="" />
          ) : (
            <Badge park={tile.park} size={104} state={visited ? "earned" : "silhouette"} remoteArt={false} />
          )}
          {tile.photos.length > 1 && <span className="dex-tile__more">{tile.photos.length}</span>}
        </span>
        <span className="dex-tile__name">{name}</span>
        <span className="dex-tile__visits">{visited ? visitCountLabel(tile.visit!.days.length) : "Not visited"}</span>
      </button>
    </li>
  );
});
