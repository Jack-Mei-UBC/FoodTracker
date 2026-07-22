// Map an OCR ScanResponse to the RawItem[] the review UI consumes. Shared by the
// scanner (synchronous scan) and the inbox (background scan) so both paths turn a
// result into review rows the exact same way.
import type { Capture, CaptureData, ScanResponse } from '../types/scan';
import type { RawItem } from '../components/ReviewItems';

// Items from ONE capture's data, tagged with which capture they came from so
// the review grid can group a mixed scan's rows by region (receipt vs shelf
// tags vs a barcode) instead of flattening them into one undifferentiated list.
function captureDataToRawItems(type: string, data: CaptureData): RawItem[] {
  if (type === 'receipt') {
    const items = (data as any).items || [];
    return items.map((it: any) => ({
      ...it, amountUnit: it.amount_unit, isSale: it.is_sale, saleEndsAt: it.sale_ends_at ?? null,
      tags: it.tags ?? [], origin: 'receipt' as const,
    }));
  }
  if (type === 'price_tag') {
    const tagData = data as any;
    // A shelf photo can show several tags. Rows stored before the multi-tag change
    // hold ONE flat tag instead of items[] — fall back to it so old inbox jobs
    // still open (see the LEGACY note in types/scan.ts).
    const items = Array.isArray(tagData.items) && tagData.items.length > 0
      ? tagData.items
      : (tagData.name != null ? [tagData] : []);
    return items.map((t: any) => ({
      name: t.name, price: t.price, category: t.category, unit: t.unit,
      barcode: t.barcode, isSale: t.is_sale, saleEndsAt: t.sale_ends_at ?? null,
      amount: t.amount, amountUnit: t.amount_unit, tags: t.tags ?? [], origin: 'price_tag' as const,
    }));
  }
  if (type === 'barcode') {
    const items = (data as any).items || [];
    // A barcode capture may have no visible price (e.g. a photographed package
    // with no shelf tag) — defaults to 0 rather than being uncommittable; the
    // review grid still shows the row so the user can fill in a price by hand.
    return items.map((it: any) => ({
      name: it.name || it.barcode, price: it.price ?? 0, category: it.category,
      barcode: it.barcode, amount: it.amount, amountUnit: it.amount_unit,
      tags: it.tags ?? [], origin: 'barcode' as const,
    }));
  }
  return [];
}

function captureToRawItems(capture: Capture): RawItem[] {
  return captureDataToRawItems(capture.type, capture.data as CaptureData);
}

export function scanResultToRawItems(scan: ScanResponse | null | undefined): RawItem[] {
  if (!scan) return [];
  // Composite scans carry captures[] — one region per entry, possibly several
  // (a mixed photo's receipt AND price_tag regions both contribute rows).
  const captures = (scan as any).captures as Capture[] | undefined;
  if (Array.isArray(captures) && captures.length > 0) {
    return captures.flatMap(captureToRawItems);
  }
  // Rows written before `captures` existed: fall back to the single-type shape.
  return captureDataToRawItems(scan.type, scan.data as CaptureData);
}
