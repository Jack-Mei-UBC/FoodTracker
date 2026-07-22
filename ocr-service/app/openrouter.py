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
from .prompts import PROMPT_VERSION, RETRY_PROMPT, SYSTEM_PROMPT, USER_PROMPT

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


def _first_wins(pairs: list[tuple]) -> dict:
    """Keep the FIRST value for a duplicated key instead of the last.

    This is load-bearing, not a nicety. Free vision models often answer correctly
    and then loop, re-emitting "type"/"confidence"/"data" several times inside the
    SAME object until they hit max_tokens mid-repeat. Python's default is last-wins,
    which would hand back the truncated final repeat and discard the good answer the
    model gave first. First-wins takes the complete one.
    """
    out: dict = {}
    for key, value in pairs:
        if key not in out:
            out[key] = value
    return out


def _decoder() -> json.JSONDecoder:
    return json.JSONDecoder(object_pairs_hook=_first_wins)


def _repair_truncated_json(text: str, start: int) -> dict | None:
    """Recover the usable prefix of a reply the model never finished.

    When a model runs out of tokens the object is left unclosed, so nothing parses
    at all — even though every item up to the cut-off point was read fine. Walk the
    text noting each position where a value ends cleanly, then from the latest such
    point backwards, close whatever containers are still open and try to parse. The
    first candidate that parses is the longest recoverable prefix.

    Everything here still goes to human review, so a receipt recovered with its last
    few lines missing is a strictly better starting point than an empty result.
    """
    cuts: list[int] = []
    stack = 0
    in_str = esc = False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
                cuts.append(i + 1)
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack += 1
        elif ch in "}]":
            stack -= 1
            cuts.append(i + 1)

    # Try the longest prefixes first; cap the search so a pathological reply can't
    # spin (a truncated object only ever needs the last handful of cut points).
    for cut in list(reversed(cuts))[:300]:
        prefix = text[start:cut]
        depth = 0
        s = e = False
        for ch in prefix:
            if s:
                if e:
                    e = False
                elif ch == "\\":
                    e = True
                elif ch == '"':
                    s = False
                continue
            if ch == '"':
                s = True
            elif ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
        if depth <= 0:
            continue
        # Closers are appended blind: we tracked only the depth, so reconstruct by
        # letting the decoder reject a wrong guess and falling through to the next cut.
        for closers in ("}" * depth, "]" + "}" * (depth - 1) if depth else ""):
            if not closers:
                continue
            candidate = prefix.rstrip().rstrip(",") + closers
            try:
                obj = _decoder().decode(candidate)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(obj, dict) and obj.get("type"):
                return obj
    return None


def _extract_json_object(content: str) -> dict:
    """Pull the usable JSON object out of a model's reply.

    Vision models do not reliably stop after the object we asked for: they append
    stray keys, restart the whole structure, or trail off mid-repeat when they hit
    max_tokens. A plain json.loads() over the whole reply raises "Extra data" (or
    "Unterminated string") and throws away a response that was perfectly good up to
    that point — which is exactly how a fully-readable receipt ended up degraded to
    type=unknown with its only copy sitting unused in raw_text.

    Strategy: strip any fence, seek the first '{', raw_decode() from there (parses
    one value and ignores trailing chatter), and if the model never closed the
    object, fall back to repairing the truncated prefix.
    """
    cleaned = _FENCE_RE.sub("", content).strip()
    start = cleaned.find("{")
    if start == -1:
        raise ValueError("no JSON object found in model output")

    try:
        payload, end = _decoder().raw_decode(cleaned, start)
        if not isinstance(payload, dict):
            raise ValueError(f"expected a JSON object, got {type(payload).__name__}")
        trailing = len(cleaned) - end
        if trailing > 0:
            logger.info("Ignored %d trailing chars after the JSON object", trailing)
        return payload
    except json.JSONDecodeError as err:
        repaired = _repair_truncated_json(cleaned, start)
        if repaired is None:
            raise
        logger.warning("Recovered a truncated model reply (%s)", err)
        return repaired


def _parse_scan_response(content: str, model: str) -> ScanResponse:
    payload = _extract_json_object(content)

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
        model=model,
        data=data_model.model_validate(payload.get("data", {})),
        raw_text=content,
        prompt_version=PROMPT_VERSION,
    )


async def _chat(client: httpx.AsyncClient, messages: list[dict], model: str) -> str:
    response = await client.post(
        f"{settings.openrouter_base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://foodtracker.local",
            "X-Title": "FoodTracker OCR Service",
        },
        json={
            "model": model,
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


async def scan_image(image_jpeg: bytes, model: str | None = None) -> ScanResponse:
    # The worker owns model selection (the multi-model pool + retries live there
    # — see worker/src/modelPool.ts), so it passes exactly one model per call and
    # this service is a dumb executor. `model` falls back to OCR_MODEL only for
    # direct /scan calls (host curl / manual tests) that don't specify one.
    model = model or settings.ocr_model
    messages = _build_messages(image_jpeg)

    try:
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
            content = await _chat(client, messages, model)

            if not content.strip():
                # Model refused or returned nothing — not a hard error for the UI
                return ScanResponse(
                    type="unknown",
                    confidence=0,
                    model=model,
                    data=UnknownData(reason="The model returned no usable output for this image."),
                    raw_text=content,
                    prompt_version=PROMPT_VERSION,
                )

            try:
                return _parse_scan_response(content, model)
            except (json.JSONDecodeError, ValidationError, ValueError, TypeError) as first_err:
                logger.warning("First parse failed (%s), retrying once", first_err)
                retry_messages = messages + [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": RETRY_PROMPT},
                ]
                retry_content = await _chat(client, retry_messages, model)
                try:
                    return _parse_scan_response(retry_content, model)
                except (json.JSONDecodeError, ValidationError, ValueError, TypeError):
                    # Don't hard-fail: return the raw text as an 'unknown' result so
                    # the UI can show it for copy-paste / manual entry instead of a 502.
                    logger.warning("Unparseable LLM output after retry; returning as unknown")
                    return ScanResponse(
                        type="unknown",
                        confidence=0,
                        model=model,
                        data=UnknownData(
                            reason="The model's output could not be parsed as structured data — its raw text is shown below."
                        ),
                        # Prefer the retry's text, but never end up with nothing:
                        # a retry that returns empty would otherwise discard the
                        # first attempt's output, which is what the inbox shows.
                        raw_text=retry_content or content,
                        prompt_version=PROMPT_VERSION,
                    )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="LLM request timed out")
    except httpx.HTTPError as err:
        logger.error("OpenRouter connection error: %s", err)
        raise HTTPException(status_code=502, detail="Could not reach the LLM API")
