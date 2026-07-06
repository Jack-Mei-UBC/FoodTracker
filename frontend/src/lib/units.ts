// Unit normalization for price-per-amount display.
// NOTE: keep in sync with backend/src/units.ts

export type Dimension = 'mass' | 'volume' | 'count';

interface UnitDef {
  dimension: Dimension;
  toBase: number; // multiply an amount in this unit by toBase to get the base unit
}

const UNITS: Record<string, UnitDef> = {
  mg: { dimension: 'mass', toBase: 0.001 },
  g: { dimension: 'mass', toBase: 1 },
  gram: { dimension: 'mass', toBase: 1 },
  grams: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  oz: { dimension: 'mass', toBase: 28.3495 },
  lb: { dimension: 'mass', toBase: 453.592 },
  lbs: { dimension: 'mass', toBase: 453.592 },
  ml: { dimension: 'volume', toBase: 1 },
  l: { dimension: 'volume', toBase: 1000 },
  liter: { dimension: 'volume', toBase: 1000 },
  litre: { dimension: 'volume', toBase: 1000 },
  floz: { dimension: 'volume', toBase: 29.5735 },
  cup: { dimension: 'volume', toBase: 236.588 },
  pt: { dimension: 'volume', toBase: 473.176 },
  qt: { dimension: 'volume', toBase: 946.353 },
  gal: { dimension: 'volume', toBase: 3785.41 },
  each: { dimension: 'count', toBase: 1 },
  ct: { dimension: 'count', toBase: 1 },
  count: { dimension: 'count', toBase: 1 },
  pack: { dimension: 'count', toBase: 1 },
  dozen: { dimension: 'count', toBase: 12 },
  dz: { dimension: 'count', toBase: 12 },
};

const DISPLAY_BASIS: Record<Dimension, { qty: number; label: string }> = {
  mass: { qty: 100, label: '100g' },
  volume: { qty: 100, label: '100ml' },
  count: { qty: 1, label: 'item' },
};

// Units offered in the review-table dropdown ('each' first — the count default).
export const UNIT_OPTIONS: string[] = [
  'each', 'ct', 'dozen',
  'g', 'kg', 'mg', 'oz', 'lb',
  'ml', 'l', 'floz', 'cup', 'pt', 'qt', 'gal',
];

// Free-text unit tokens (incl. plurals/abbreviations) → canonical dropdown value.
const UNIT_ALIAS: Record<string, string> = {
  mg: 'mg', g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', liter: 'l', litre: 'l', liters: 'l', litres: 'l',
  floz: 'floz',
  cup: 'cup', cups: 'cup',
  pt: 'pt', pint: 'pt', pints: 'pt',
  qt: 'qt', quart: 'qt', quarts: 'qt',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  each: 'each', ea: 'each', unit: 'each', units: 'each',
  ct: 'ct', count: 'ct', pc: 'ct', pcs: 'ct', piece: 'ct', pieces: 'ct',
  pk: 'each', pack: 'each', // a pack is one purchasable unit
  dozen: 'dozen', dz: 'dozen', doz: 'dozen',
};

export function normalizeUnit(unit: string | null | undefined): UnitDef | null {
  if (!unit) return null;
  const key = unit.toLowerCase().replace(/[^a-z]/g, '');
  return UNITS[key] ?? null;
}

// Parse a free-typed amount like "600g", "2 lb", "1.5L", "12ct", or "5".
// Returns the numeric amount and the canonical unit token if a suffix was typed.
export function parseAmountInput(raw: string): { amount: number | null; unit: string | null } {
  const m = String(raw).trim().match(/^(\d*\.?\d*)\s*([a-zA-Z]+)?$/);
  if (!m) return { amount: null, unit: null };
  const numStr = m[1];
  const amount = numStr === '' || numStr === '.' ? null : parseFloat(numStr);
  let unit: string | null = null;
  if (m[2]) unit = UNIT_ALIAS[m[2].toLowerCase()] ?? null;
  return { amount: amount != null && isFinite(amount) ? amount : null, unit };
}

export interface UnitPriceResult {
  displayPrice: number; // price per display basis (per 100g / 100ml / item)
  displayLabel: string; // e.g. "100g"
}

// Returns null when the unit is unknown or the amount is non-positive.
export function computeUnitPrice(
  price: number,
  amount: number | null | undefined,
  amountUnit: string | null | undefined
): UnitPriceResult | null {
  const def = normalizeUnit(amountUnit);
  if (!def || !amount || amount <= 0 || !isFinite(price)) return null;

  const baseAmount = amount * def.toBase;
  if (baseAmount <= 0) return null;

  const basis = DISPLAY_BASIS[def.dimension];
  return {
    displayPrice: (price / baseAmount) * basis.qty,
    displayLabel: basis.label,
  };
}

// "$0.42/100g" style string, or null when not computable.
export function formatUnitPrice(
  price: number,
  amount: number | null | undefined,
  amountUnit: string | null | undefined
): string | null {
  const r = computeUnitPrice(price, amount, amountUnit);
  if (!r) return null;
  return `$${r.displayPrice.toFixed(2)}/${r.displayLabel}`;
}
