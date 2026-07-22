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
  is_sale: boolean;
  // Printed last day the sale price is valid (ISO YYYY-MM-DD). Null when none was
  // shown — the backend then applies app_settings.default_sale_days.
  sale_ends_at: string | null;
}

export interface ReceiptData {
  store_name: string | null;
  purchase_date: string | null; // ISO YYYY-MM-DD
  total: number | null;
  items: ReceiptItem[];
}

// One shelf tag. A single photo commonly shows several side by side.
export interface PriceTagItem {
  name: string;
  price: number;
  unit_price: number | null;
  unit: string;
  category: string;
  barcode: string | null;
  is_sale: boolean;
  sale_ends_at: string | null; // printed sale end date, ISO YYYY-MM-DD
  amount: number | null; // net weight / pack size, e.g. 4.54 for "4.54 kg / 10 lb"
  amount_unit: string | null; // e.g. "kg"
}

export interface PriceTagData {
  store_name: string | null; // applies to every tag in the photo
  items: PriceTagItem[];
  // LEGACY: this payload used to be ONE flat tag. Rows written before the
  // multi-tag change still hold that shape in scan_jobs.result, so readers must
  // tolerate it (see lib/scanResult.ts). Never write this shape.
  name?: string;
  price?: number;
  unit?: string;
  category?: string;
  barcode?: string | null;
  is_sale?: boolean;
  amount?: number | null;
  amount_unit?: string | null;
}

export interface UnknownData {
  reason: string;
}

// `raw_text` is the model's raw output (before JSON parsing); present mainly on
// failures so the UI can show it for copy-paste. `prompt_version` is a hash of
// the system prompt in force for this call (ocr-service prompts.PROMPT_VERSION),
// logged per scan_runs row so a later re-process can tell a prompt change apart
// from a model change. Keep in sync with models.py.
export type ScanResponse =
  | { type: 'receipt'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: ReceiptData }
  | { type: 'price_tag'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: PriceTagData }
  | { type: 'unknown'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: UnknownData };
