// Display-only mirror of backend/src/nutrition.ts, used for live previews in
// the diary form. The backend recomputes the authoritative snapshot on commit.
// NOTE: keep the scaling semantics in sync with backend/src/nutrition.ts

import { normalizeUnit } from './units';

export interface NutritionFacts {
  serving_size: number | string;
  serving_unit: string;
  calories: number | string;
  protein_g?: number | string | null;
  carbs_g?: number | string | null;
  fat_g?: number | string | null;
  saturated_fat_g?: number | string | null;
  trans_fat_g?: number | string | null;
  cholesterol_mg?: number | string | null;
  sodium_mg?: number | string | null;
  fiber_g?: number | string | null;
  sugar_g?: number | string | null;
  added_sugar_g?: number | string | null;
  potassium_mg?: number | string | null;
  calcium_mg?: number | string | null;
  iron_mg?: number | string | null;
  vitamin_a_mcg?: number | string | null;
  vitamin_c_mg?: number | string | null;
  vitamin_d_mcg?: number | string | null;
}

// Display metadata for the macro + micronutrient fields, shared by the
// nutrition editor (dashboard), the saved-facts chips, and the diary's daily
// totals. Field names + order mirror backend/src/nutrition.ts NUTRIENT_FIELDS
// (minus calories, which is always shown on its own).
export interface NutrientMeta {
  field: string;
  label: string;
  unit: string;
}

export const MACRO_META: NutrientMeta[] = [
  { field: 'protein_g', label: 'Protein', unit: 'g' },
  { field: 'carbs_g', label: 'Carbs', unit: 'g' },
  { field: 'fat_g', label: 'Fat', unit: 'g' },
];

export const MICRO_META: NutrientMeta[] = [
  { field: 'saturated_fat_g', label: 'Saturated fat', unit: 'g' },
  { field: 'trans_fat_g', label: 'Trans fat', unit: 'g' },
  { field: 'cholesterol_mg', label: 'Cholesterol', unit: 'mg' },
  { field: 'sodium_mg', label: 'Sodium', unit: 'mg' },
  { field: 'fiber_g', label: 'Fiber', unit: 'g' },
  { field: 'sugar_g', label: 'Total sugars', unit: 'g' },
  { field: 'added_sugar_g', label: 'Added sugars', unit: 'g' },
  { field: 'potassium_mg', label: 'Potassium', unit: 'mg' },
  { field: 'calcium_mg', label: 'Calcium', unit: 'mg' },
  { field: 'iron_mg', label: 'Iron', unit: 'mg' },
  { field: 'vitamin_a_mcg', label: 'Vitamin A', unit: 'mcg' },
  { field: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg' },
  { field: 'vitamin_d_mcg', label: 'Vitamin D', unit: 'mcg' },
];

export interface ScaledNutrients {
  calories: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

// The diary-only unit: a multiple of the food's serving size.
export function isServingUnit(unit: string): boolean {
  const key = unit.toLowerCase().replace(/[^a-z]/g, '');
  return key === 'serving' || key === 'servings';
}

// Number of servings `amount amountUnit` represents, or null when the unit is
// unknown or its dimension doesn't match the serving unit's.
export function servingsFor(
  facts: NutritionFacts,
  amount: number,
  amountUnit: string
): number | null {
  if (!isFinite(amount) || amount <= 0) return null;
  if (isServingUnit(amountUnit)) return amount;

  const amountDef = normalizeUnit(amountUnit);
  const servingDef = normalizeUnit(facts.serving_unit);
  const servingSize = Number(facts.serving_size);
  if (!amountDef || !servingDef || !(servingSize > 0)) return null;
  if (amountDef.dimension !== servingDef.dimension) return null;

  return (amount * amountDef.toBase) / (servingSize * servingDef.toBase);
}

// ── Per-100 readout ───────────────────────────────────────────────────────────
// A label's serving ("55 g", "1 cup") isn't comparable between foods, so every
// surface that shows facts also shows them per 100 g (solid) / 100 ml (liquid) —
// the nutrition twin of the canonical per-kg price display in units.ts.
// The basis dimension comes from the serving unit, falling back to the food's
// own unit; anything not mass/volume (a serving counted in `each`) can't be
// converted and yields null, since 100 g of "1 each" is unknowable.

export interface Per100Basis {
  amount: 100;
  unit: 'g' | 'ml';
  label: '100 g' | '100 ml';
}

export function per100Basis(
  facts: NutritionFacts,
  foodUnit?: string | null
): Per100Basis | null {
  const dim = normalizeUnit(facts.serving_unit)?.dimension ?? normalizeUnit(foodUnit)?.dimension;
  if (dim === 'volume') return { amount: 100, unit: 'ml', label: '100 ml' };
  if (dim === 'mass') return { amount: 100, unit: 'g', label: '100 g' };
  return null;
}

// The facts scaled to 100 g / 100 ml, plus the basis label. Null when the
// serving unit isn't a mass/volume unit.
export function nutrientsPer100(
  facts: NutritionFacts,
  foodUnit?: string | null
): (ScaledNutrients & { label: string }) | null {
  const basis = per100Basis(facts, foodUnit);
  if (!basis) return null;
  const scaled = scaleNutrients(facts, basis.amount, basis.unit);
  return scaled ? { ...scaled, label: basis.label } : null;
}

// "455 kcal / 100 g", or null when not convertible.
export function formatCaloriesPer100(
  facts: NutritionFacts,
  foodUnit?: string | null
): string | null {
  const per100 = nutrientsPer100(facts, foodUnit);
  return per100 ? `${Math.round(per100.calories)} kcal / ${per100.label}` : null;
}

export function scaleNutrients(
  facts: NutritionFacts,
  amount: number,
  amountUnit: string
): ScaledNutrients | null {
  const servings = servingsFor(facts, amount, amountUnit);
  if (servings === null) return null;

  const scale = (v: number | string | null | undefined): number | null =>
    v === null || v === undefined ? null : Math.round(Number(v) * servings * 100) / 100;

  return {
    calories: scale(facts.calories) ?? 0,
    protein_g: scale(facts.protein_g),
    carbs_g: scale(facts.carbs_g),
    fat_g: scale(facts.fat_g),
  };
}
