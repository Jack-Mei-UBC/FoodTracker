// JSON contract for /api/scan responses (proxied from ocr-service).
// NOTE: keep in sync with ocr-service/app/models.py

export interface ReceiptItem {
  name: string;
  price: number; // line total
  quantity: number;
  category: string;
  unit: string;
  unit_price: number | null;
  amount: number | null; // package size, e.g. 8 for "8OZ"
  amount_unit: string | null; // e.g. "oz"
}

export interface ReceiptData {
  store_name: string | null;
  purchase_date: string | null; // ISO YYYY-MM-DD
  total: number | null;
  items: ReceiptItem[];
}

export interface PriceTagData {
  name: string;
  price: number;
  unit_price: number | null;
  unit: string;
  category: string;
  barcode: string | null;
  store_name: string | null;
  is_sale: boolean;
  amount: number | null; // package size, e.g. 1.5 for "1.5L"
  amount_unit: string | null; // e.g. "l"
}

export interface UnknownData {
  reason: string;
}

export type ScanResponse =
  | { type: 'receipt'; confidence: number; model: string; data: ReceiptData }
  | { type: 'price_tag'; confidence: number; model: string; data: PriceTagData }
  | { type: 'unknown'; confidence: number; model: string; data: UnknownData };
