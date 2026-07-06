import io

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import settings


def prepare_image(raw: bytes) -> bytes:
    """Validate, EXIF-rotate, downscale and re-encode an uploaded image as JPEG."""
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds maximum upload size")

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="File is not a readable image")

    # Phone cameras store orientation in EXIF; apply it before the model sees the pixels
    img = ImageOps.exif_transpose(img)

    if max(img.size) > settings.max_image_dimension:
        img.thumbnail((settings.max_image_dimension, settings.max_image_dimension))

    if img.mode != "RGB":
        img = img.convert("RGB")

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()
