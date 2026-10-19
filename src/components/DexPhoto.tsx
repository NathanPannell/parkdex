import { AnimatePresence } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../lib/backStack";
import { useSaveDexPhoto } from "../lib/dex/useDex";
import type { Park } from "../lib/parks";
import { cropImageStyle, type PhotoCrop } from "../lib/photoCrop";
import { PhotoCapture } from "./PhotoCapture";
import { PhotoCropper } from "./PhotoCropper";
import { useToast } from "./Toast";
import type { OriginalPhoto } from "../lib/photoEncode";

/** An object URL for a saved photo, released when the photo changes or the view goes. */
export function usePhotoUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/**
 * A saved photo shown through its 3:4 crop (#173) without re-encoding it. Without a crop it shows
 * the largest centred 3:4 fit, which is what `object-fit: cover` draws.
 */
export function CroppedPhoto({ blob, crop, alt, className = "" }: { blob: Blob; crop: PhotoCrop | null; alt: string; className?: string }) {
  const url = usePhotoUrl(blob);
  return (
    <span className={`cropped-photo ${className}`}>
      {url && <img src={url} alt={alt} draggable={false} style={crop ? cropImageStyle(crop) : undefined} className={crop ? "" : "is-centred"} />}
    </span>
  );
}

/** Full-screen steps sit above the bottom bar and outside any moving sheet. */
export function AboveNav({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector(".device") ?? document.body);
}

/**
 * "Add a photo" (#174): the phone camera and the 3:4 crop (#173), then the photo is saved as its
 * own claim for the park. There is no gallery upload.
 */
export function AddDexPhoto({ park, open, onClose, onSaved }: { park: Park; open: boolean; onClose: () => void; onSaved?: () => void }) {
  const save = useSaveDexPhoto();
  const toast = useToast();
  const name = park.short || park.name;
  return (
    <AboveNav>
      <AnimatePresence>
        {open && (
          <PhotoCapture
            key="dex-camera"
            place={name}
            hint="Take a photo of the park for your Dex."
            caption={`${name} · ${new Date().toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`}
            onClose={onClose}
            onUse={(captured) => {
              onClose();
              void save(park, captured).then(
                () => {
                  toast("Photo added to your Dex", "moss");
                  onSaved?.();
                },
                () => toast("Your photo couldn't be saved. Try again.", "kip"),
              );
            }}
          />
        )}
      </AnimatePresence>
    </AboveNav>
  );
}

/** Measures a saved photo, so the cropper can work on it without re-encoding. */
function useOriginal(blob: Blob | null): OriginalPhoto | null {
  const url = usePhotoUrl(blob);
  const [photo, setPhoto] = useState<OriginalPhoto | null>(null);
  useEffect(() => {
    setPhoto(null);
    if (!url || !blob) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setPhoto({ blob, dataUrl: url, width: image.naturalWidth, height: image.naturalHeight, bytes: blob.size });
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [blob, url]);
  return photo;
}

/** Re-crops a saved photo: the same 3:4 cropper, starting from its current crop. */
export function RecropPhoto({
  blob,
  crop,
  caption,
  onCancel,
  onSave,
}: {
  blob: Blob | null;
  crop: PhotoCrop | null;
  caption: string;
  onCancel: () => void;
  onSave: (crop: PhotoCrop) => void;
}) {
  const photo = useOriginal(blob);
  useBackHandler(onCancel, !!blob);
  return (
    <AboveNav>
      <AnimatePresence>
        {blob && photo && (
          <div className="screen camera found-camera dex-recrop" key="recrop">
            <PhotoCropper
              photo={photo}
              initialCrop={crop}
              caption={caption}
              busy={false}
              error={null}
              onRetake={onCancel}
              retakeLabel="Cancel"
              onUse={onSave}
            />
          </div>
        )}
      </AnimatePresence>
    </AboveNav>
  );
}
