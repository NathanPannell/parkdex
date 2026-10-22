import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { AboveNav } from "../components/DexPhoto";
import { FullscreenViewer } from "../components/FullscreenViewer";
import { Icon } from "../components/Icon";
import { ParkCover } from "../components/ParkCover";
import { useBackHandler } from "../lib/backStack";
import { visitCountLabel, type DexTile } from "../lib/dex/collection";

type Props = {
  tile: DexTile | null;
  onClose: () => void;
  onShowOnMap: (parkId: string) => void;
};

function dateLabel(at: string): string {
  return new Date(at).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Vancouver" });
}

/**
 * A park in My Dex (#174): its official photo, the founder's cover, and your visit dates. Tapping
 * the photo opens it full screen.
 */
export function DexParkSheet({ tile, onClose, onShowOnMap }: Props) {
  const [viewing, setViewing] = useState(false);
  useBackHandler(onClose, !!tile && !viewing);

  const park = tile?.park;
  const visit = tile?.visit ?? null;
  const cover = tile?.cover ?? null;

  return (
    <AboveNav>
      <AnimatePresence>
        {tile && park && (
          <motion.div key="dex-detail" className="dex-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button className="dex-detail__scrim" onClick={onClose} aria-label="Close" tabIndex={-1} />
            <motion.section
              className="dex-detail__sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="dex-detail-title"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <div className="sheet__handle" />
              <header className="dex-detail__head">
                <div>
                  <span className="eyebrow">{park.region}</span>
                  <h2 id="dex-detail-title">{park.name}</h2>
                </div>
                <button className="park-sheet__close dex-detail__close" onClick={onClose} aria-label="Close">
                  <Icon name="close" size={18} stroke={3} />
                </button>
              </header>

              <div className="dex-detail__body">
                <div className="dex-detail__hero">
                  {cover ? (
                    <button
                      className="viewer-open dex-detail__hero-open"
                      onClick={() => setViewing(true)}
                      aria-label={`Show the photo of ${park.name} full screen`}
                    >
                      <ParkCover park={park} url={cover} badgeSize={170} visited={!!visit} alt={`${park.name}, photographed by its founder`} />
                    </button>
                  ) : (
                    <ParkCover park={park} url={null} badgeSize={170} visited={!!visit} />
                  )}
                </div>

                {visit ? (
                  <dl className="dex-detail__visits">
                    <div>
                      <dt>Visits</dt>
                      <dd>{visitCountLabel(visit.days.length)}</dd>
                    </div>
                    <div>
                      <dt>First visit</dt>
                      <dd>{dateLabel(visit.firstVisitAt)}</dd>
                    </div>
                    <div>
                      <dt>Last visit</dt>
                      <dd>{dateLabel(visit.lastVisitAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="account-help">Not visited yet. Walk in and plant your flag to log it.</p>
                )}
              </div>

              <div className="dex-detail__cta">
                <button className="btn btn--block btn--xl" onClick={() => onShowOnMap(park.id)}>
                  <Icon name="map" /> Show on the map
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
      <FullscreenViewer
        slides={cover && park ? [{ key: "cover", src: cover, alt: `${park.name}, photographed by its founder` }] : []}
        index={tile && viewing ? 0 : null}
        onClose={() => setViewing(false)}
        label={`Photo of ${park?.name ?? "this park"}`}
      />
    </AboveNav>
  );
}
