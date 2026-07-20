// Map an OCR ScanResponse to the RawItem[] the review UI consumes. Shared by the
// scanner (synchronous scan) and the inbox (background scan) so both paths turn a
// result into review rows the exact same way.
import type { ScanResponse } from '../types/scan';
import type { RawItem } from '../components/ReviewItems';

export function scanResultToRawItems(scan: ScanResponse | null | undefined): RawItem[] {
  if (!scan) return [];
  if (scan.type === 'receipt') {
    return scan.data.items.map(it => ({
      ...it, amountUnit: it.amount_unit, isSale: it.is_sale, saleEndsAt: it.sale_ends_at ?? null,
    }));
  }
  if (scan.type === 'price_tag') {
    const tag = scan.data;
    // A shelf photo can show several tags. Rows stored before the multi-tag change
    // hold ONE flat tag instead of items[] — fall back to it so old inbox jobs
    // still open (see the LEGACY note in types/scan.ts).
    const tags = Array.isArray(tag.items) && tag.items.length > 0
      ? tag.items
      : (tag.name != null ? [tag as any] : []);
    return tags.map(t => ({
      name: t.name, price: t.price, category: t.category, unit: t.unit,
      barcode: t.barcode, isSale: t.is_sale, saleEndsAt: t.sale_ends_at ?? null,
      amount: t.amount, amountUnit: t.amount_unit,
    }));
  }
  return [];
}
