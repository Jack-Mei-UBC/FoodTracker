import base64
import json
import logging
import re

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from .config import settings
from .models import (
    PriceTagData,
    ReceiptData,
    ScanResponse,
    UnknownData,
)
from .prompts import RETRY_PROMPT, SYSTEM_PROMPT, USER_PROMPT

logger = logging.getLogger("ocr-service")

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)

_DATA_MODELS = {
    "receipt": ReceiptData,
    "price_tag": PriceTagData,
    "unknown": UnknownData,
}


def _build_messages(image_jpeg: bytes) -> list[dict]:
    b64 = base64.b64encode(image_jpeg).decode("ascii")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": USER_PROMPT},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                },
            ],
        },
    ]


def _parse_scan_response(content: str) -> ScanResponse:
    cleaned = _FENCE_RE.sub("", content).strip()
    payload = json.loads(cleaned)

    # Validate the data payload against the model matching the declared type,
    # so a receipt with a malformed item fails here rather than silently
    # coercing to the wrong union member.
    capture_type = payload.get("type")
    data_model = _DATA_MODELS.get(capture_type)
    if data_model is None:
        raise ValueError(f"unknown capture type: {capture_type!r}")

    return ScanResponse(
        type=capture_type,
        confidence=float(payload.get("confidence", 0)),
        model=settings.ocr_model,
        data=data_model.model_validate(payload.get("data", {})),
    )


async def _chat(client: httpx.AsyncClient, messages: list[dict]) -> str:
    response = await client.post(
        f"{settings.openrouter_base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://foodtracker.local",
            "X-Title": "FoodTracker OCR Service",
        },
        json={
            "model": settings.ocr_model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 4000,
            "response_format": {"type": "json_object"},
        },
    )
    if response.status_code >= 400:
        logger.error("OpenRouter error %s: %s", response.status_code, response.text[:500])
        raise HTTPException(status_code=502, detail=f"LLM API error ({response.status_code})")

    data = response.json()
    return data.get("choices", [{}])[0].get("message", {}).get("content") or ""


async def scan_image(image_jpeg: bytes) -> ScanResponse:
    messages = _build_messages(image_jpeg)

    try:
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
            content = await _chat(client, messages)

            if not content.strip():
                # Model refused or returned nothing — not a hard error for the UI
                return ScanResponse(
                    type="unknown",
                    confidence=0,
                    model=settings.ocr_model,
                    data=UnknownData(reason="The model returned no usable output for this image."),
                )

            try:
                return _parse_scan_response(content)
            except (json.JSONDecodeError, ValidationError, ValueError, TypeError) as first_err:
                logger.warning("First parse failed (%s), retrying once", first_err)
                retry_messages = messages + [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": RETRY_PROMPT},
                ]
                retry_content = await _chat(client, retry_messages)
                try:
                    return _parse_scan_response(retry_content)
                except (json.JSONDecodeError, ValidationError, ValueError, TypeError):
                    logger.error("Unparseable LLM output after retry: %s", retry_content[:500])
                    raise HTTPException(
                        status_code=502,
                        detail=f"LLM returned unparseable output: {retry_content[:200]}",
                    )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="LLM request timed out")
    except httpx.HTTPError as err:
        logger.error("OpenRouter connection error: %s", err)
        raise HTTPException(status_code=502, detail="Could not reach the LLM API")
