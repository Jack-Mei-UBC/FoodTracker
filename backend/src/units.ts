// Unit normalization for price-per-amount calculations.
// NOTE: keep in sync with frontend/src/lib/units.ts
//
// Every supported unit belongs to one dimension (mass / volume / count) and
// converts to that dimension's base unit: grams, millilitres, or "each".

export type Dimension = 'mass' | 'volume' | 'count';

interface UnitDef {
  dimension: Dimension;
  toBase: number; // multiply an amount in this unit by toBase to get the base unit
}

// Keys are lowercased, punctuation-stripped unit tokens.
const UNITS: Record<string, UnitDef> = {
  // mass -> grams
  mg: { dimension: 'mass', toBase: 0.001 },
  g: { dimension: 'mass', toBase: 1 },
  gram: { dimension: 'mass', toBase: 1 },
  grams: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  oz: { dimension: 'mass', toBase: 28.3495 },
  lb: { dimension: 'mass', toBase: 453.592 },
  lbs: { dimension: 'mass', toBase: 453.592 },
  // volume -> millilitres
  ml: { dimension: 'volume', toBase: 1 },
  l: { dimension: 'volume', toBase: 1000 },
  liter: { dimension: 'volume', toBase: 1000 },
  litre: { dimension: 'volume', toBase: 1000 },
  floz: { dimension: 'volume', toBase: 29.5735 },
  cup: { dimension: 'volume', toBase: 236.588 },
  pt: { dimension: 'volume', toBase: 473.176 },
  qt: { dimension: 'volume', toBase: 946.353 },
  gal: { dimension: 'volume', toBase: 3785.41 },
  // count -> each
  each: { dimension: 'count', toBase: 1 },
  ct: { dimension: 'count', toBase: 1 },
  count: { dimension: 'count', toBase: 1 },
  pack: { dimension: 'count', toBase: 1 },
  dozen: { dimension: 'count', toBase: 12 },
  dz: { dimension: 'count', toBase: 12 },
};

const BASE_UNIT: Record<Dimension, string> = { mass: 'g', volume: 'ml', count: 'each' };
// Readable divisor for display: price per 100g / 100ml / 1 item.
const DISPLAY_BASIS: Record<Dimension, { qty: number; label: string }> = {
  mass: { qty: 100, label: '100g' },
  volume: { qty: 100, label: '100ml' },
  count: { qty: 1, label: 'item' },
};

export function normalizeUnit(unit: string | null | undefined): UnitDef | null {
  if (!unit) return null;
  const key = unit.toLowerCase().replace(/[^a-z]/g, '');
  return UNITS[key] ?? null;
}

export interface UnitPriceResult {
  unitPrice: number; // price per one base unit (per gram / ml / each)
  baseAmount: number; // amount expressed in the base unit
  dimension: Dimension;
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

  const unitPrice = price / baseAmount;
  const basis = DISPLAY_BASIS[def.dimension];
  return {
    unitPrice,
    baseAmount,
    dimension: def.dimension,
    displayPrice: unitPrice * basis.qty,
    displayLabel: basis.label,
  };
}
