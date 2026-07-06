// Fuzzy matching of scanned product names against the existing food catalog.
// Dependency-free: name normalization + a token_set_ratio (à la fuzzywuzzy)
// built on Levenshtein distance. Good at typos, word order, and extra size
// tokens ("BANANAS 2LB" vs "Organic Bananas"); not semantics.

// Common grocery/receipt abbreviations -> canonical word.
const ABBREVIATIONS: Record<string, string> = {
  whl: 'whole', wht: 'wheat', wh: 'whole',
  chs: 'cheese', chz: 'cheese', chdr: 'cheddar', mozz: 'mozzarella',
  mlk: 'milk', brd: 'bread', yog: 'yogurt', ygrt: 'yogurt',
  chkn: 'chicken', ckn: 'chicken', bf: 'beef', grnd: 'ground', gr: 'ground',
  bnls: 'boneless', sknls: 'skinless', org: 'organic', orgnc: 'organic',
  veg: 'vegetable', vegs: 'vegetables', frzn: 'frozen', frsh: 'fresh',
  lg: 'large', sm: 'small', med: 'medium', xl: 'large',
  swt: 'sweet', ptato: 'potato', tom: 'tomato', ban: 'banana', bnna: 'banana',
};

// Size / unit tokens to strip so packaging noise doesn't hurt the match.
const UNIT_WORDS = new Set([
  'g', 'kg', 'mg', 'oz', 'lb', 'lbs', 'ml', 'l', 'floz', 'gal', 'qt', 'pt',
  'ct', 'pk', 'pack', 'dozen', 'dz', 'count', 'each', 'ea', 'x', 'ct',
]);

// A token is size-like if it's a bare number, a number glued to a unit
// ("2lb", "8oz", "1.5l"), or a standalone unit word.
function isSizeToken(tok: string): boolean {
  if (/^\d+(\.\d+)?$/.test(tok)) return true;
  if (/^\d+(\.\d+)?[a-z]+$/.test(tok)) return true;
  if (UNIT_WORDS.has(tok)) return true;
  return false;
}

export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter(tok => !isSizeToken(tok))
    .map(tok => ABBREVIATIONS[tok] ?? tok)
    .filter(tok => tok.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Normalized similarity of two strings, 0..100.
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return Math.round((1 - levenshtein(a, b) / maxLen) * 100);
}

// fuzzywuzzy-style token_set_ratio: compares the shared tokens against each
// side's leftovers, so word order and extra tokens are largely forgiven.
function tokenSetRatio(t1: string[], t2: string[]): number {
  const s1 = new Set(t1);
  const s2 = new Set(t2);
  const intersection = Array.from(s1).filter(t => s2.has(t)).sort();
  const diff1 = Array.from(s1).filter(t => !s2.has(t)).sort();
  const diff2 = Array.from(s2).filter(t => !s1.has(t)).sort();

  const inter = intersection.join(' ');
  const combined1 = intersection.concat(diff1).join(' ').trim();
  const combined2 = intersection.concat(diff2).join(' ').trim();

  return Math.max(
    ratio(inter, combined1),
    ratio(inter, combined2),
    ratio(combined1, combined2)
  );
}

export interface CatalogMatch<T> {
  food: T;
  score: number; // 0..100
}

// Returns the best catalog entry at or above `threshold`, else null.
// Scores against the primary name AND any learned aliases (verified past
// matches), taking the best — so "BANANAS 2LB" hits "Organic Bananas" at 100%
// once the alias is remembered.
export function bestCatalogMatch<T extends { name: string; aliases?: { alias: string }[] | null }>(
  scannedName: string,
  catalog: T[],
  threshold = 80
): CatalogMatch<T> | null {
  const query = tokenize(scannedName);
  if (query.length === 0) return null;

  let best: CatalogMatch<T> | null = null;
  for (const food of catalog) {
    const names = [food.name, ...(food.aliases ?? []).map(a => a.alias)];
    for (const name of names) {
      const cand = tokenize(name);
      if (cand.length === 0) continue;
      const score = tokenSetRatio(query, cand);
      if (!best || score > best.score) best = { food, score };
    }
  }

  return best && best.score >= threshold ? best : null;
}
