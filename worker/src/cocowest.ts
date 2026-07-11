// cocowest.ca "weekend update" post scraping — a WordPress blog that lists
// Costco BC/AB/SK/MB flyer sale items. Unlike Flipp there is no JSON API: each
// item is one <img> in the post body whose `alt` text carries the full record
// (item number, name, size, optional instant-savings + expiry, price) and
// whose `data-src` is the real product photo (the visible `src` is an inline
// SVG lazyload placeholder — ignored).
//
// Example markup for one item:
//   <img data-src="https://west.cocowest1.ca/2026/07/ORGANIKA_....jpeg"
//        alt="1905224 ORGANIKA ELECTROLYTES 45 X 3.5 G ($10.00 INSTANT
//              SAVINGS EXPIRES ON 2026-08-02) $29.99" />
//
// Parsed with regex rather than an HTML/DOM parser: it keeps the worker's
// plain node:20-slim image dependency-free, and is actually *more* robust
// here — some product names contain an unescaped `"` (e.g. `ACER 27"...`),
// which truncates the `alt` attribute in the real HTML too. Those items have
// no trailing `$price` after truncation and are skipped rather than guessed
// at (near-exclusively non-grocery electronics in practice).
//
// Amount/unit parsing and catalog fuzzy-matching are shared with flipp.ts via
// scrape-common.ts — this file only does the cocowest-specific fetch/parse.

export interface CocowestItem {
  item_number: string;
  name: string;
  price: number;
  savings?: number;
  expires_on?: string; // YYYY-MM-DD
  image_url: string; // full-size product photo
  page_url: string; // the cocowest post this item came from
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const attrRe = (attr: string) => new RegExp(`${attr}="([^"]*)"`, 'i');
const DATA_SRC_RE = attrRe('data-src');
const ALT_RE = attrRe('alt');

// "1905224 ORGANIKA ELECTROLYTES 45 X 3.5 G ($10.00 INSTANT SAVINGS EXPIRES ON 2026-08-02) $29.99"
// or, when there's no instant-savings clause:
// "1041712 MAXWELL & WILLIAMS DINNERWARE SET 12 PIECES $19.97"
const ITEM_ALT_RE =
  /^(\d{6,7})\s+(.+?)(?:\s*\(\$([\d,]+\.\d{2})\s+INSTANT SAVINGS EXPIRES ON (\d{4}-\d{2}-\d{2})\))?\s+\$([\d,]+\.\d{2})$/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ');
}

// Fetches a cocowest.ca post and extracts every parseable sale item from its
// product images. Unparseable images (non-product photos, truncated alt text)
// are silently skipped.
export async function fetchCocowestItems(url: string): Promise<CocowestItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`cocowest fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const items: CocowestItem[] = [];
  const seen = new Set<string>();
  for (const tagMatch of html.matchAll(IMG_TAG_RE)) {
    const tag = tagMatch[0];
    const dataSrcMatch = tag.match(DATA_SRC_RE);
    const altMatch = tag.match(ALT_RE);
    if (!dataSrcMatch || !altMatch) continue;

    const imageUrl = dataSrcMatch[1];
    if (!/\.(jpe?g|png)(\?.*)?$/i.test(imageUrl)) continue; // skip non-photo imgs (e.g. lazyload SVG placeholders)

    const alt = decodeEntities(altMatch[1]).replace(/\s+/g, ' ').trim();
    const parsed = alt.match(ITEM_ALT_RE);
    if (!parsed) continue; // truncated (inch-mark) or non-item image — skip

    const [, itemNumber, rawName, savings, expiresOn, rawPrice] = parsed;
    if (seen.has(itemNumber)) continue; // same item occasionally reappears (e.g. a "coming soon" teaser)
    seen.add(itemNumber);

    items.push({
      item_number: itemNumber,
      name: rawName.trim(),
      price: parseFloat(rawPrice.replace(/,/g, '')),
      savings: savings ? parseFloat(savings.replace(/,/g, '')) : undefined,
      expires_on: expiresOn || undefined,
      image_url: imageUrl,
      page_url: url,
    });
  }
  return items;
}

export function usableCocowestItems(items: CocowestItem[]): CocowestItem[] {
  return items.filter((item) => isFinite(item.price) && item.price > 0 && item.price < 100000 && !!item.name);
}
