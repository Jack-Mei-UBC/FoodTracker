// Flipp flyer scraping via backflipp.wishabi.com — the JSON backend the
// flipp.com web app itself uses. One GET per search query returns structured
// flyer items (merchant, price, validity window, item name with pack size), so
// no browser/Playwright is involved.
//
// The API is unofficial: field presence is treated as optional everywhere and
// anything unparseable is skipped rather than guessed at.
//
// Amount-parsing and catalog-matching are source-agnostic and shared with
// cocowest.ts via scrape-common.ts — this file only does the Flipp-specific
// fetch/shape/filter work.

import { ParsedAmount, parseAmount } from './scrape-common';

export interface FlippItem {
  flyer_item_id?: number;
  id?: number;
  flyer_id?: number; // the flyer this item belongs to (for the item deep link)
  item_type?: string; // 'flyer' for flyer items
  merchant_name?: string;
  name?: string;
  current_price?: number | string | null;
  original_price?: number | string | null;
  pre_price_text?: string | null; // e.g. "2/" on multi-buy deals ("2/$5")
  post_price_text?: string | null; // e.g. "each", "/lb", "/100g"
  sale_story?: string | null;
  valid_from?: string;
  valid_to?: string;
  // The flyer artwork for this item — the "source image" we save per scraped price.
  clipping_image_url?: string | null;
  clean_image_url?: string | null;
}

// Canonical Flipp share link that opens the flyer to this exact item — the
// "relevant page" the item was clipped from.
export function flippItemUrl(item: FlippItem): string | null {
  const id = item.flyer_item_id ?? item.id;
  return id ? `https://flipp.com/en-ca/item/${id}` : null;
}

const FLIPP_SEARCH_URL = 'https://backflipp.wishabi.com/flipp/items/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export async function searchFlipp(postalCode: string, query: string): Promise<FlippItem[]> {
  const params = new URLSearchParams({
    locale: 'en-ca',
    postal_code: postalCode.replace(/\s+/g, '').toUpperCase(),
    q: query,
  });
  const res = await fetch(`${FLIPP_SEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Flipp search for "${query}" failed: HTTP ${res.status}`);
  }
  const body: any = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Store "Walmart" should match Flipp merchant "Walmart Canada", etc. Loose
// containment either way on normalized names.
export function merchantMatches(storeName: string, merchantName: string | null | undefined): boolean {
  if (!merchantName) return false;
  const a = norm(storeName);
  const b = norm(merchantName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export { ParsedAmount, nameMatchScore, symmetricMatchScore } from './scrape-common';

// Best-effort read of what the price buys, from the flyer item's name and
// price-affix texts. Falls back to 1 each so every logged price stays valid.
export function parseFlippAmount(item: FlippItem): ParsedAmount {
  const pre = item.pre_price_text || '';
  // Multi-buy quantity ("2/" -> 2 for the shown price).
  const multi = pre.match(/^\s*(\d+)\s*\//);
  const qty = multi ? parseInt(multi[1], 10) : 1;
  return parseAmount(item.name || '', { postPriceText: item.post_price_text || '', qty });
}

// Keep only usable flyer items for this store: current, priced, merchant-matched.
export function usableItems(items: FlippItem[], storeName: string): FlippItem[] {
  const now = Date.now();
  return items.filter((item) => {
    if (item.item_type && item.item_type !== 'flyer') return false;
    if (!merchantMatches(storeName, item.merchant_name)) return false;
    const price = Number(item.current_price);
    if (!isFinite(price) || price <= 0 || price >= 500) return false;
    if (item.valid_from && Date.parse(item.valid_from) > now) return false;
    if (item.valid_to && Date.parse(item.valid_to) < now) return false;
    return !!item.name;
  });
}
