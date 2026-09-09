from io import BytesIO

from PIL import Image
import pytest

from backend.app.claim_photos import MAX_OUTPUT_BYTES, PhotoInputError, normalize_photo


def image_bytes(size=(2400, 1800), *, fmt="PNG", color=(20, 120, 80, 180)):
    image = Image.new("RGBA", size, color)
    output = BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()


def test_photo_is_oriented_flattened_stripped_and_bounded():
    normalized = normalize_photo(image_bytes())
    assert normalized.content_type == "image/jpeg"
    assert max(normalized.width, normalized.height) <= 1600
    assert len(normalized.content) <= MAX_OUTPUT_BYTES
    with Image.open(BytesIO(normalized.content)) as result:
        assert result.format == "JPEG"
        assert result.mode == "RGB"
        assert not result.getexif()


def test_invalid_and_animated_images_are_rejected():
    with pytest.raises(PhotoInputError):
        normalize_photo(b"not an image")
    frames = [Image.new("RGB", (10, 10), color) for color in ("red", "blue")]
    output = BytesIO()
    frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:])
    with pytest.raises(PhotoInputError, match="Animated"):
        normalize_photo(output.getvalue())
