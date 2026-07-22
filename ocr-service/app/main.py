import logging
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile

from .config import settings
from .imaging import prepare_image
from .models import ScanResponse
from .openrouter import scan_image

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="FoodTracker OCR Service", version="1.0.0")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "model": settings.ocr_model}


@app.post("/scan", response_model=ScanResponse)
async def scan(
    image: UploadFile = File(...),
    # The worker's model pool selects one model per request and passes it here;
    # omitted (direct host/manual calls) falls back to OCR_MODEL. `use_paid` is
    # accepted for symmetry/logging but the worker already resolves the model.
    model: Optional[str] = Form(None),
    use_paid: Optional[str] = Form(None),
    # Catalog tag vocabulary, comma-separated (the worker fetches it from
    # GET /api/tags per job). Omitted for direct/manual calls — the model then
    # always returns an empty tags array per item.
    tags: Optional[str] = Form(None),
) -> ScanResponse:
    raw = await image.read()
    jpeg = prepare_image(raw)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    return await scan_image(jpeg, model=model, tags=tag_list)
