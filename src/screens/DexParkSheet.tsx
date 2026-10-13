import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Badge } from "../components/Badge";
import { AboveNav, AddDexPhoto, CroppedPhoto, RecropPhoto } from "../components/DexPhoto";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { useBackHandler } from "../lib/backStack";
import { visitCountLabel, type DexPhoto, type DexTile } from "../lib/dex/collection";
import { sfx } from "../lib/feedback";
import type { PhotoCrop } from "../lib/photoCrop";

type Props = {
  tile: DexTile | null;
  onClose: () => void;
  onSetCover: (claimId: string) => Promise<void>;
  onRecrop: (claimId: string, crop: PhotoCrop | null) => Promise<void>;
  onRemove: (claimId: string) => Promise<void>;
  onSaved: () => void;
  onShowOnMap: (parkId: string) => void;
};

function dateLabel(at: string): string {
  return new Date(at).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Vancouver" });
}

/**
 * A park in My Dex (#174): your photos of it (tap one to make it the cover), re-crop or remove a
 * photo, add another, and your visit dates.
 */
export function DexParkSheet({ tile, onClose, onSetCover, onRecrop, onRemove, onSaved, onShowOnMap }: Props) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [recropping, setRecropping] = useState<DexPhoto | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useBackHandler(onClose, !!tile && !adding && !recropping);
  useEffect(() => setConfirmRemove(false), [tile?.park.id, tile?.cover?.claimId]);

  const park = tile?.park;
  const visit = tile?.visit ?? null;
  const cover = tile?.cover ?? null;
  const fail = () => toast("That didn't save. Try again.", "kip");

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
                  {cover
                    ? <CroppedPhoto blob={cover.blob} crop={cover.crop} alt={`Your photo of ${park.name}`} />
                    : <Badge park={park} size={170} state={visit ? "earned" : "silhouette"} remoteArt={false} />}
                </div>

                {cover && (
                  <div className="dex-detail__photo-actions">
                    <button className="btn btn--sm btn--paper" onClick={() => { sfx.tap(); setRecropping(cover); }}>
                      <Icon name="corners" size={16} /> Re-crop
                    </button>
                    <button
                      className={`btn btn--sm ${confirmRemove ? "btn--sun" : "btn--paper"}`}
                      onClick={() => {
                        if (!confirmRemove) { setConfirmRemove(true); return; }
                        setConfirmRemove(false);
                        void onRemove(cover.claimId).then(() => toast("Photo removed from your Dex", "ink"), fail);
                      }}
                    >
                      <Icon name="close" size={16} /> {confirmRemove ? "Tap again to remove" : "Remove"}
                    </button>
                  </div>
                )}

                {tile.photos.length > 1 && (
                  <div className="dex-detail__strip-wrap">
                    <h3>Your photos <span>Tap one to make it the cover</span></h3>
                    <ul className="dex-detail__strip">
                      {tile.photos.map((photo) => (
                        <li key={photo.claimId}>
                          <button
                            className={`dex-detail__thumb ${photo.claimId === cover?.claimId ? "is-cover" : ""}`}
                            aria-pressed={photo.claimId === cover?.claimId}
                            aria-label={`Photo from ${dateLabel(photo.claimedAt)}${photo.claimId === cover?.claimId ? ", the cover" : ""}`}
                            onClick={() => {
                              if (photo.claimId === cover?.claimId) return;
                              sfx.pop();
                              void onSetCover(photo.claimId).catch(fail);
                            }}
                          >
                            <CroppedPhoto blob={photo.blob} crop={photo.crop} alt="" />
                            {photo.claimId === cover?.claimId && <span className="dex-detail__cover-mark"><Icon name="check" size={14} stroke={3} /></span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {visit ? (
                  <dl className="dex-detail__visits">
                    <div><dt>Visits</dt><dd>{visitCountLabel(visit.days.length)}</dd></div>
                    <div><dt>First visit</dt><dd>{dateLabel(visit.firstVisitAt)}</dd></div>
                    <div><dt>Last visit</dt><dd>{dateLabel(visit.lastVisitAt)}</dd></div>
                  </dl>
                ) : (
                  <p className="account-help">You haven't visited this park yet. Go there and plant your flag to add it to your Dex.</p>
                )}
              </div>

              <div className="dex-detail__cta">
                {visit && (
                  <button className="btn btn--block btn--glow" onClick={() => { sfx.pop(); setAdding(true); }}>
                    <Icon name="camera" /> {tile.photos.length ? "Add another photo" : "Add a photo"}
                  </button>
                )}
                <button className={`btn ${visit ? "btn--paper btn--icon" : "btn--block"}`} onClick={() => onShowOnMap(park.id)} aria-label="Show on the map">
                  <Icon name="map" />{visit ? null : " Show on the map"}
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
      {park && <AddDexPhoto park={park} open={adding} onClose={() => setAdding(false)} onSaved={onSaved} />}
      <RecropPhoto
        blob={recropping?.blob ?? null}
        crop={recropping?.crop ?? null}
        caption={park ? park.short || park.name : ""}
        onCancel={() => setRecropping(null)}
        onSave={(crop) => {
          const target = recropping;
          setRecropping(null);
          if (target) void onRecrop(target.claimId, crop).catch(fail);
        }}
      />
    </AboveNav>
  );
}
