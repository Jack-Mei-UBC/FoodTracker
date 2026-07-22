# JSON contract for /scan responses.
# NOTE: keep in sync with frontend/src/types/scan.ts
from typing import Literal, Optional, Union

from pydantic import BaseModel, model_validator

# Per-capture classification. "mixed" is NEVER used here — it only ever appears
# as the top-level ScanResponse.type when a photo produced more than one
# distinct capture type (see ScanResponse below).
CaptureType = Literal["receipt", "price_tag", "barcode", "unknown"]
TopLevelType = Literal["receipt", "price_tag", "barcode", "unknown", "mixed"]


class ReceiptItem(BaseModel):
    name: str
    price: float  # line total
    quantity: float = 1
    category: str = "Grocery"
    unit: str = "each"
    unit_price: Optional[float] = None
    # Package size printed on the line, if any, e.g. "8OZ" -> amount=8, amount_unit="oz"
    amount: Optional[float] = None
    amount_unit: Optional[str] = None
    # Sale/discount pricing. `sale_ends_at` is the printed last day the price is
    # valid (ISO YYYY-MM-DD); receipts rarely print one, price tags often do.
    # When is_sale is true and no date was found, the backend applies the
    # configured default sale length (app_settings.default_sale_days).
    is_sale: bool = False
    sale_ends_at: Optional[str] = None
    # Catalog tag names this item was matched against, constrained to the
    # vocabulary offered in the request (see worker's tags_vocab). Empty when
    # none fit or no vocabulary was supplied.
    tags: list[str] = []


class ReceiptData(BaseModel):
    store_name: Optional[str] = None
    purchase_date: Optional[str] = None  # ISO YYYY-MM-DD
    total: Optional[float] = None
    items: list[ReceiptItem] = []


class PriceTagItem(BaseModel):
    """One product's shelf tag. A single photo often shows several side by side."""

    name: str
    price: float
    unit_price: Optional[float] = None
    unit: str = "each"
    category: str = "Grocery"
    barcode: Optional[str] = None
    is_sale: bool = False
    # Last day the sale price is valid, as printed on the tag ("SALE ENDS 07/20",
    # "Valid until ...") in ISO YYYY-MM-DD. See ReceiptItem.sale_ends_at.
    sale_ends_at: Optional[str] = None
    # Net weight / pack size printed on the tag, e.g. "4.54 kg / 10 lb" ->
    # amount=4.54, amount_unit="kg"; "1.5L" -> 1.5 + "l"; "12 CT" -> 12 + "ct".
    amount: Optional[float] = None
    amount_unit: Optional[str] = None
    # See ReceiptItem.tags.
    tags: list[str] = []


class PriceTagData(BaseModel):
    """Every shelf tag legible in one photo (a shelf shot commonly has 2+)."""

    store_name: Optional[str] = None
    items: list[PriceTagItem] = []

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_single_tag(cls, value):
        # Back-compat: this payload used to be ONE flat tag object. Old rows in
        # scan_jobs.result still hold that shape, and a model can ignore the
        # multi-tag instruction and answer the old way — normalize both into
        # items[] so nothing has to special-case it downstream.
        if isinstance(value, dict) and "items" not in value and "name" in value:
            tag = dict(value)
            store = tag.pop("store_name", None)
            return {"store_name": store, "items": [tag]}
        return value


class BarcodeItem(BaseModel):
    """A product identified by its barcode — e.g. a photo of a box/package back,
    with or without a shelf price attached. Distinct from PriceTagItem.barcode,
    which is a barcode incidentally printed on a SHELF tag; this is the capture
    for a photo whose main subject IS a barcode/package."""

    barcode: str
    name: Optional[str] = None
    brand: Optional[str] = None
    price: Optional[float] = None  # shelf price, if one is visible; else null
    category: str = "Grocery"
    # Net weight / pack size printed on the package, same convention as
    # PriceTagItem.amount/amount_unit.
    amount: Optional[float] = None
    amount_unit: Optional[str] = None
    tags: list[str] = []


class BarcodeData(BaseModel):
    """Every barcode/package legible in one photo (rare to have >1, but a flat
    lay of several products is possible — same items[] convention as tags)."""

    items: list[BarcodeItem] = []


class UnknownData(BaseModel):
    reason: str


CaptureData = Union[ReceiptData, PriceTagData, BarcodeData, UnknownData]


class Capture(BaseModel):
    """One classified region of a photo. A single image can contain several —
    e.g. a receipt AND a shelf tag in frame together — so ScanResponse carries
    a list of these rather than assuming one capture per photo."""

    type: CaptureType
    confidence: float  # 0..1
    data: CaptureData


# Rank used to pick which capture the legacy top-level type/data mirror on
# ScanResponse reflects, when there's more than one. Receipts are the richest
# signal (usually the whole trip), then price tags, then a bare barcode.
_CAPTURE_RANK = {"receipt": 0, "price_tag": 1, "barcode": 2, "unknown": 3}


class ScanResponse(BaseModel):
    # `type`/`data` are the PRIMARY capture (ranked by _CAPTURE_RANK) — kept so
    # every reader written before `captures[]` existed keeps working unchanged.
    # `type` is "mixed" when captures contains more than one distinct non-unknown
    # type; new code should read `captures` and treat type/data as a convenience
    # summary, not the source of truth.
    type: TopLevelType
    confidence: float  # 0..1
    model: str  # model id that produced the result
    data: CaptureData
    # Every region the model found in the photo. Absent/empty on responses
    # constructed before this field existed (or from a body missing it) — the
    # validator below synthesizes a one-element list from type/data in that case.
    captures: list[Capture] = []
    # The model's raw output text (before JSON parsing). Surfaced to the UI on
    # failures so the user can copy-paste anything useful the model saw.
    raw_text: Optional[str] = None
    # Hash of the system prompt used for this call (prompts.PROMPT_VERSION), so
    # scan_runs history can tell a prompt change apart from a model change.
    prompt_version: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _sync_captures_and_primary(cls, value):
        # Runs on both directions so a caller only ever has to supply ONE side:
        #   - legacy/simple body (type + data, no captures): synthesize captures
        #     so new readers (the future multi-capture UI) don't special-case it.
        #   - new body (captures[], no type/data): derive the primary type/data
        #     mirror so every existing reader (worker item-counting, ReviewItems,
        #     the inbox receipt-context check) keeps working unchanged.
        # Both present: left as-is (caller knows what it's doing).
        if not isinstance(value, dict):
            return value
        value = dict(value)
        captures = value.get("captures")
        if not captures:
            if value.get("type") and value.get("type") != "mixed":
                value["captures"] = [{
                    "type": value["type"],
                    "confidence": value.get("confidence", 0),
                    "data": value.get("data", {}),
                }]
            return value

        ordered = sorted(captures, key=lambda c: _CAPTURE_RANK.get((c or {}).get("type"), 9))
        primary = ordered[0] if ordered else None
        distinct_types = {(c or {}).get("type") for c in captures if (c or {}).get("type") not in (None, "unknown")}
        if primary is not None:
            value["type"] = "mixed" if len(distinct_types) > 1 else primary.get("type", "unknown")
            value["data"] = primary.get("data", {})
            value.setdefault("confidence", primary.get("confidence", 0))
        return value
