// Source-agnostic helpers shared by every scraper module (flipp.ts, cocowest.ts):
// amount/unit parsing from a free-text item name, and fuzzy name matching
// against the food catalog. Kept separate so a new scrape source only needs
// its own fetch + item-shape code, not a second copy of this logic.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Units here must stay within the vocabulary the backend's units.ts
// normalizes (it lowercases and strips punctuation before lookup).
const MASS_VOLUME_UNITS = 'kg|g|ml|l|lb|lbs|oz';
// Sizes embedded in words ("MILK2GO") must not match, hence the lookbehind;
// a trailing letter ("5 gal**lo**n" is fine, "60 g**els**" is not) is blocked
// by the lookahead.
const SIZE_RE = new RegExp(`(?<![a-z0-9])(\\d+(?:\\.\\d+)?)\\s*(${MASS_VOLUME_UNITS})(?![a-z])`, 'i');
const MULTIPACK_RE = new RegExp(`(?<![a-z0-9])(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*(${MASS_VOLUME_UNITS})(?![a-z])`, 'i');
const COUNT_RE = /(?<![a-z0-9])(\d+)\s*(ct|pk|pack|dozen|dz)\b/i;
// "PACK OF 18" phrasing (cocowest favors this over "18 PK").
const PACK_OF_RE = /\bpack of\s*(\d+)\b/i;
// Per-amount pricing ("/lb", "per 100g") — the price buys that amount, whatever
// pack size the artwork mentions.
const PER_AMOUNT_RE = new RegExp(`(?:per|/)\\s*(\\d+(?:\\.\\d+)?)?\\s*(${MASS_VOLUME_UNITS})\\b`, 'i');

export interface ParsedAmount {
  amount: number;
  unit: string;
  multiBuy: boolean; // "2/$5"-style deal — treat as a sale
}

// Best-effort read of what the price buys, from a free-text item name plus an
// optional post-price affix ("/lb") and a multi-buy quantity ("2/" -> 2).
// Falls back to 1 each so every logged price stays valid.
export function parseAmount(name: string, opts?: { postPriceText?: string; qty?: number }): ParsedAmount {
  const post = opts?.postPriceText || '';
  const qty = opts?.qty ?? 1;
  const multiBuy = qty > 1;

  const per = post.match(PER_AMOUNT_RE) || name.match(PER_AMOUNT_RE);
  if (per) {
    return { amount: per[1] ? parseFloat(per[1]) : 1, unit: per[2].toLowerCase(), multiBuy };
  }

  const pack = name.match(MULTIPACK_RE);
  if (pack) {
    return { amount: qty * parseInt(pack[1], 10) * parseFloat(pack[2]), unit: pack[3].toLowerCase(), multiBuy };
  }

  const size = name.match(SIZE_RE);
  if (size) {
    return { amount: qty * parseFloat(size[1]), unit: size[2].toLowerCase(), multiBuy };
  }

  const count = name.match(COUNT_RE);
  if (count) {
    return { amount: qty * parseInt(count[1], 10), unit: count[2].toLowerCase(), multiBuy };
  }

  const packOf = name.match(PACK_OF_RE);
  if (packOf) {
    return { amount: qty * parseInt(packOf[1], 10), unit: 'pack', multiBuy };
  }

  return { amount: qty, unit: 'each', multiBuy };
}

// Pack sizes ("1G", "473mL") are stripped before tokenizing — catalog names
// often carry them but scraped item names phrase them differently.
function tokens(name: string): string[] {
  const stripped = name.replace(new RegExp(SIZE_RE.source, 'gi'), ' ');
  return norm(stripped).split(' ').filter((t) => t.length >= 2);
}

const tokenHit = (t: string, pool: string[]) =>
  pool.some((w) => w === t || (t.length >= 4 && w.startsWith(t)) || (w.length >= 4 && t.startsWith(w)));

// Fraction of the target name's tokens found in the scraped item's name (exact
// token or a >=4-char prefix, so "bananas" matches "banana"). Recall-only:
// right for catalog mode, where the item came from a search for this exact
// food and just needs to cover the food's words.
export function nameMatchScore(targetName: string, itemName: string): number {
  const targetTokens = tokens(targetName);
  if (targetTokens.length === 0) return 0;
  const itemTokens = tokens(itemName);
  const hits = targetTokens.filter((t) => tokenHit(t, itemTokens)).length;
  return hits / targetTokens.length;
}

// Symmetric score (harmonic mean of coverage both ways) for deciding whether a
// scraped item IS an existing catalog food. One shared word out of many ("milk"
// in "Thai Coco coconut milk drink" vs "Whole Milk") must not count as a
// match, or every dairy-adjacent deal collapses onto one food.
export function symmetricMatchScore(targetName: string, itemName: string): number {
  const a = tokens(targetName);
  const b = tokens(itemName);
  if (a.length === 0 || b.length === 0) return 0;
  const recall = a.filter((t) => tokenHit(t, b)).length / a.length;
  const precision = b.filter((t) => tokenHit(t, a)).length / b.length;
  if (recall + precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision);
}
