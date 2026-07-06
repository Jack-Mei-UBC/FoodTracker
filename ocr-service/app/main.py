import logging

from fastapi import FastAPI, File, UploadFile

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
async def scan(image: UploadFile = File(...)) -> ScanResponse:
    raw = await image.read()
    jpeg = prepare_image(raw)
    return await scan_image(jpeg)
