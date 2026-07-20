# JSON contract for /scan responses.
# NOTE: keep in sync with frontend/src/types/scan.ts
from typing import Literal, Optional, Union

from pydantic import BaseModel, model_validator

CaptureType = Literal["receipt", "price_tag", "unknown"]


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


class UnknownData(BaseModel):
    reason: str


class ScanResponse(BaseModel):
    type: CaptureType
    confidence: float  # 0..1
    model: str  # model id that produced the result
    data: Union[ReceiptData, PriceTagData, UnknownData]
    # The model's raw output text (before JSON parsing). Surfaced to the UI on
    # failures so the user can copy-paste anything useful the model saw.
    raw_text: Optional[str] = None
