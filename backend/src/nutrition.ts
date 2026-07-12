// Scales per-serving nutrition facts to a consumed amount.
//
// Amounts flow through the same unit vocabulary as prices (units.ts), plus one
// diary-only unit: 'serving' / 'servings', where the amount is a multiple of
// the food's serving size directly. 'serving' is deliberately NOT added to
// units.ts — it is meaningless for price normalization and units.ts is a
// hand-synced contract with the frontend copy.

import { normalizeUnit } from './units';

// Every nutrient stored per-serving on food_nutrition and snapshotted onto
// consumption_logs. They all scale linearly with the number of servings.
// This list is the single source of truth for the nutrient columns: server.ts
// builds its INSERT / UPDATE / SUM column lists from it, so adding a nutrient
// is a schema migration + one entry here.
// NOTE: keep in sync with the columns in db/schema.sql and the display metadata
// in frontend/src/lib/nutrition.ts.
export const NUTRIENT_FIELDS = [
  'calories',
  'protein_g', 'carbs_g', 'fat_g',
  'saturated_fat_g', 'trans_fat_g', 'cholesterol_mg', 'sodium_mg',
  'fiber_g', 'sugar_g', 'added_sugar_g',
  'potassium_mg', 'calcium_mg', 'iron_mg',
  'vitamin_a_mcg', 'vitamin_c_mg', 'vitamin_d_mcg',
] as const;

export type NutrientField = typeof NUTRIENT_FIELDS[number];

export interface NutritionFacts {
  serving_size: number | string;
  serving_unit: string;
  // calories is required in practice; the rest are optional per-serving values.
  [field: string]: number | string | null | undefined;
}

export type ScaledNutrients = Record<NutrientField, number | null>;

export function isServingUnit(unit: string): boolean {
  const key = unit.toLowerCase().replace(/[^a-z]/g, '');
  return key === 'serving' || key === 'servings';
}

// Returns the number of servings `amount amountUnit` represents for the given
// facts, or null when the unit is unknown or its dimension doesn't match the
// serving unit's (e.g. grams consumed vs. a per-ml serving).
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

// Scales every nutrient field to the consumed amount. Null when servings can't
// be derived. calories falls back to 0 (never null) so a logged entry always
// carries a number; other fields stay null when the facts don't include them.
export function scaleNutrients(
  facts: NutritionFacts,
  amount: number,
  amountUnit: string
): ScaledNutrients | null {
  const servings = servingsFor(facts, amount, amountUnit);
  if (servings === null) return null;

  const out = {} as ScaledNutrients;
  for (const field of NUTRIENT_FIELDS) {
    const v = facts[field];
    out[field] = v === null || v === undefined ? null : Math.round(Number(v) * servings * 100) / 100;
  }
  if (out.calories === null) out.calories = 0;
  return out;
}
