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

  return (
    <figure className={rootClassName}>
      <Image
        className="place-image__photo"
        src={image.src}
        alt={image.alt}
        width={image.width}
        height={image.height}
        sizes={sizes ?? (variant === "thumbnail" ? "72px" : "(max-width: 760px) calc(100vw - 40px), 520px")}
        {...(preload ? { preload: true } : { loading: "lazy" as const })}
      />
      {variant === "card" ? (
        <figcaption className="place-image__credit">
          Photo: <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.creator}</a>
          {" · "}
          <a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a>
        </figcaption>
      ) : null}
    </figure>
  );
}
