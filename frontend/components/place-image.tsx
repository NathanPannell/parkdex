import Image from "next/image";
import { MapPin } from "lucide-react";
import type { Place } from "@/lib/places";
import { getPlaceImage } from "@/lib/place-images";

type PlaceImageProps = {
  place: Pick<Place, "id" | "name">;
  variant: "thumbnail" | "card";
  sizes?: string;
  preload?: boolean;
  className?: string;
};

export function PlaceImage({
  place,
  variant,
  sizes,
  preload = false,
  className = "",
}: PlaceImageProps) {
  const image = getPlaceImage(place.id);
  const rootClassName = `place-image place-image--${variant}${className ? ` ${className}` : ""}`;

  if (!image) {
    if (variant === "thumbnail") {
      return (
        <span
          className={`${rootClassName} place-image--fallback`}
          role="img"
          aria-label={`Photo unavailable for ${place.name}`}
        >
          <MapPin aria-hidden="true" />
          <span>Photo unavailable</span>
        </span>
      );
    }

    return (
      <div
        className={`${rootClassName} place-image--fallback`}
        role="img"
        aria-label={`Photo unavailable for ${place.name}`}
      >
        <MapPin aria-hidden="true" />
        <span>Photo unavailable</span>
      </div>
    );
  }

  const asset = variant === "thumbnail" ? image.thumbnail : image.detail;

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
      {variant === "card" ? (
        <figcaption className="place-image__credit">
          Photo by{" "}
          <a href={image.sourceUrl} target="_blank" rel="noreferrer">
            {image.creator}
          </a>
          {" · "}
          <a href={image.originalUrl} target="_blank" rel="noreferrer">
            Original
          </a>
          {" · "}
          <a href={image.licenseUrl} target="_blank" rel="noreferrer">
            {image.license}
          </a>
        </figcaption>
      ) : null}
    </figure>
  );
}
