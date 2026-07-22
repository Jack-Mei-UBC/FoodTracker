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
  // Catalog tag names this item was matched against, constrained to the
  // vocabulary offered in the request. Empty when none fit or none was supplied.
  tags: string[];
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
  tags: string[]; // see ReceiptItem.tags
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

// A product identified by its barcode — a photo of a box/package back, with or
// without a shelf price attached. Distinct from PriceTagItem.barcode (a barcode
// incidentally printed on a shelf tag); this is the capture for a photo whose
// main subject IS a barcode/package. items[] for the rare multi-product shot,
// same convention as PriceTagData.
export interface BarcodeItem {
  barcode: string;
  name: string | null;
  brand: string | null;
  price: number | null; // shelf price if visible, else null
  category: string;
  amount: number | null;
  amount_unit: string | null;
  tags: string[];
}

export interface BarcodeData {
  items: BarcodeItem[];
}

export interface UnknownData {
  reason: string;
}

export type CaptureData = ReceiptData | PriceTagData | BarcodeData | UnknownData;

// One classified region of a photo. A single image can contain several — e.g. a
// receipt AND a shelf tag in frame together — so ScanResponse.captures is a list
// of these rather than assuming one capture per photo.
export type Capture =
  | { type: 'receipt'; confidence: number; data: ReceiptData }
  | { type: 'price_tag'; confidence: number; data: PriceTagData }
  | { type: 'barcode'; confidence: number; data: BarcodeData }
  | { type: 'unknown'; confidence: number; data: UnknownData };

// `raw_text` is the model's raw output (before JSON parsing); present mainly on
// failures so the UI can show it for copy-paste. `prompt_version` is a hash of
// the system prompt in force for this call (ocr-service prompts.PROMPT_VERSION),
// logged per scan_runs row so a later re-process can tell a prompt change apart
// from a model change.
//
// `type`/`data` are the PRIMARY capture (receipt > price_tag > barcode > unknown
// — see models.py _CAPTURE_RANK), kept so every reader written before `captures`
// existed keeps working unchanged; `type` is `'mixed'` when the photo produced
// more than one distinct non-unknown capture type. `captures` is every region
// the model found — new code should read it and treat type/data as a summary,
// not the source of truth. Absent/empty on scan_jobs.result rows written before
// this field existed; readers must tolerate that (see lib/scanResult.ts).
// Keep in sync with models.py.
export type ScanResponse =
  | { type: 'receipt'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: ReceiptData; captures?: Capture[] }
  | { type: 'price_tag'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: PriceTagData; captures?: Capture[] }
  | { type: 'barcode'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: BarcodeData; captures?: Capture[] }
  | { type: 'mixed'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: CaptureData; captures?: Capture[] }
  | { type: 'unknown'; confidence: number; model: string; raw_text?: string | null; prompt_version?: string | null; data: UnknownData; captures?: Capture[] };
