import Image from "next/image";
import type { Place } from "@/lib/places";
import { getPlaceImage } from "@/lib/place-images";

export const PLACE_PLACEHOLDER_SRC = "/places/place-placeholder.png";

type PlaceImageProps = {
  place: Pick<Place, "id" | "name">;
  variant: "thumbnail" | "card";
  sizes?: string;
  preload?: boolean;
  className?: string;
  showCredit?: boolean;
};

export function PlaceImage({
  place,
  variant,
  sizes,
  preload = false,
  className = "",
  showCredit = true,
}: PlaceImageProps) {
  const image = getPlaceImage(place.id);
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
      {variant === "card" && showCredit ? (
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
