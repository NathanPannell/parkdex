import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Place } from "@/lib/places";
import { getPlaceImage, getPlaceImages } from "@/lib/place-images";

export const PLACE_PLACEHOLDER_SRC = "/places/place-placeholder.png";

type PlaceImageProps = {
  place: Pick<Place, "id" | "name">;
  variant: "thumbnail" | "card";
  sizes?: string;
  preload?: boolean;
  className?: string;
  showCredit?: boolean;
  gallery?: boolean;
  selectedIndex?: number;
  onSelectedIndexChange?: (index: number) => void;
};

export function PlaceImage({
  place,
  variant,
  sizes,
  preload = false,
  className = "",
  showCredit = true,
  gallery = false,
  selectedIndex = 0,
  onSelectedIndexChange,
}: PlaceImageProps) {
  const images = gallery && variant === "card" ? getPlaceImages(place.id) : [];
  const galleryIndex = Math.min(Math.max(selectedIndex, 0), Math.max(images.length - 1, 0));
  const image = images[galleryIndex] ?? getPlaceImage(place.id);
  const rootClassName = `place-image place-image--${variant}${className ? ` ${className}` : ""}`;

  if (!image) {
    if (variant === "thumbnail") {
      return (
        <span
          className={`${rootClassName} place-image--fallback`}
          role="img"
          aria-label={`Placeholder artwork for ${place.name}`}
        >
          <Image
            className="place-image__photo"
            src={PLACE_PLACEHOLDER_SRC}
            alt=""
            width={320}
            height={240}
            sizes={sizes ?? "72px"}
            {...(preload ? { preload: true } : { loading: "lazy" as const })}
          />
        </span>
      );
    }

    return (
      <figure className={`${rootClassName} place-image--fallback`} role="img" aria-label={`Placeholder artwork for ${place.name}`}>
        <Image
          className="place-image__photo"
          src={PLACE_PLACEHOLDER_SRC}
          alt=""
          width={960}
          height={720}
          sizes={sizes ?? "(max-width: 760px) calc(100vw - 40px), 520px"}
          {...(preload ? { preload: true } : { loading: "lazy" as const })}
        />
      </figure>
    );
  }

  const asset = variant === "thumbnail" ? image.thumbnail : image.detail;
  const showGalleryControls = gallery && variant === "card" && images.length > 1;
  const selectPrevious = () => onSelectedIndexChange?.((galleryIndex - 1 + images.length) % images.length);
  const selectNext = () => onSelectedIndexChange?.((galleryIndex + 1) % images.length);

  if (variant === "thumbnail") {
    return (
      <span className={rootClassName}>
        <Image
          className="place-image__photo"
          src={asset.src}
          alt={image.alt}
          width={asset.width}
          height={asset.height}
          sizes={sizes ?? "72px"}
          {...(preload ? { preload: true } : { loading: "lazy" as const })}
        />
      </span>
    );
  }

  return (
    <figure className={rootClassName}>
      <Image
        className="place-image__photo"
        src={asset.src}
        alt={image.alt}
        width={asset.width}
        height={asset.height}
        sizes={sizes ?? "(max-width: 760px) calc(100vw - 40px), 520px"}
        {...(preload ? { preload: true } : { loading: "lazy" as const })}
      />
      {showGalleryControls ? (
        <div className="place-image__gallery" aria-label={`${place.name} photo gallery`}>
          <button type="button" onClick={selectPrevious} aria-label={`Previous photo of ${place.name}`}>
            <ChevronLeft aria-hidden="true" size={20} />
          </button>
          <div className="place-image__gallery-position">
            <span aria-live="polite">{galleryIndex + 1} / {images.length}</span>
            <div role="group" aria-label="Choose a photo">
              {images.map((candidate, index) => (
                <button
                  key={`${candidate.detail.src}-${index}`}
                  type="button"
                  className={index === galleryIndex ? "is-selected" : ""}
                  aria-label={`Show photo ${index + 1} of ${images.length}`}
                  aria-pressed={index === galleryIndex}
                  onClick={() => onSelectedIndexChange?.(index)}
                />
              ))}
            </div>
          </div>
          <button type="button" onClick={selectNext} aria-label={`Next photo of ${place.name}`}>
            <ChevronRight aria-hidden="true" size={20} />
          </button>
        </div>
      ) : null}
      {variant === "card" && showCredit ? (
        <figcaption className="place-image__credit">
          Photo by{" "}
          <a href={image.sourceUrl} target="_blank" rel="noreferrer">
            {image.creator}
          </a>
          {" · "}
          <a href={image.originalUrl} target="_blank" rel="noreferrer">
            Source image
          </a>
          {" · "}
          <a href={image.licenseUrl} target="_blank" rel="noreferrer">
            {image.license}
          </a>
          {" · Changes: "}{image.changes}
        </figcaption>
      ) : null}
    </figure>
  );
}
