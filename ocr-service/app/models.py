# JSON contract for /scan responses.
# NOTE: keep in sync with frontend/src/types/scan.ts
from typing import Literal, Optional, Union

from pydantic import BaseModel

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


class ReceiptData(BaseModel):
    store_name: Optional[str] = None
    purchase_date: Optional[str] = None  # ISO YYYY-MM-DD
    total: Optional[float] = None
    items: list[ReceiptItem] = []


class PriceTagData(BaseModel):
    name: str
    price: float
    unit_price: Optional[float] = None
    unit: str = "each"
    category: str = "Grocery"
    barcode: Optional[str] = None
    store_name: Optional[str] = None
    is_sale: bool = False
    # Package size shown on the tag, if any, e.g. "1.5L" -> amount=1.5, amount_unit="l"
    amount: Optional[float] = None
    amount_unit: Optional[str] = None


class UnknownData(BaseModel):
    reason: str


class ScanResponse(BaseModel):
    type: CaptureType
    confidence: float  # 0..1
    model: str  # model id that produced the result
    data: Union[ReceiptData, PriceTagData, UnknownData]
