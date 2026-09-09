from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 1_000_000
MAX_EDGE_PIXELS = 1600
Image.MAX_IMAGE_PIXELS = 40_000_000


class PhotoInputError(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedPhoto:
    content: bytes
    content_type: str
    width: int
    height: int
    sha256_hex: str


def normalize_photo(payload: bytes) -> NormalizedPhoto:
    if not payload:
        raise PhotoInputError("Photo is empty")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise PhotoInputError("Photo upload must be 8 MB or smaller")
    try:
        with Image.open(BytesIO(payload)) as source:
            if getattr(source, "n_frames", 1) != 1:
                raise PhotoInputError("Animated photos are not supported")
            source.verify()
        with Image.open(BytesIO(payload)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((MAX_EDGE_PIXELS, MAX_EDGE_PIXELS), Image.Resampling.LANCZOS)
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")
            encoded = _encode_under_limit(image)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise PhotoInputError("Photo is not a supported safe image") from exc
    return NormalizedPhoto(
        content=encoded,
        content_type="image/jpeg",
        width=image.width,
        height=image.height,
        sha256_hex=sha256(encoded).hexdigest(),
    )


def _encode_under_limit(image: Image.Image) -> bytes:
    current = image
    while True:
        for quality in (85, 75, 65, 55):
            output = BytesIO()
            current.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
            encoded = output.getvalue()
            if len(encoded) <= MAX_OUTPUT_BYTES:
                if current is not image:
                    image.thumbnail(current.size, Image.Resampling.LANCZOS)
                return encoded
        if max(current.size) <= 640:
            raise PhotoInputError("Photo cannot be normalized below 1 MB")
        next_size = (max(1, round(current.width * 0.8)), max(1, round(current.height * 0.8)))
        current = current.resize(next_size, Image.Resampling.LANCZOS)
