// Live meal (recipe) math: per-ingredient nutrient scaling and cost from the
// food's latest tracked price, plus meal totals and per-serving figures.
// Nothing here is stored — a meal's numbers always reflect the foods' current
// facts and prices.

import { normalizeUnit } from './units';
import {
  scaleNutrients,
  isServingUnit,
  NutritionFacts,
  NUTRIENT_FIELDS,
  NutrientField,
} from './nutrition';

// Latest non-deleted price for an ingredient's food, as selected by the meal
// queries in server.ts (only rows with a usable unit_price are considered).
export interface LatestPrice {
  price: number | string;
  unit_price: number | string;
  amount: number | string | null;
  amount_unit: string | null;
  scraped_at: string;
  is_sale: boolean;
  store_name: string | null;
}

export interface IngredientRow {
  id: number;
  food_id: number;
  food_name: string;
  amount: number | string;
  amount_unit: string;
  sort_order: number;
  density: number | string; // foods.density (kg/L), for volume<->mass cost conversion
  nutrition: NutritionFacts | null;
  latest_price: LatestPrice | null;
}

// Converts the ingredient's amount to (dimension, base amount). 'serving'
// resolves through the food's serving size; unknown units return null.
function toBaseAmount(
  amount: number,
  amountUnit: string,
  facts: NutritionFacts | null
): { dimension: string; baseAmount: number } | null {
  if (!(amount > 0)) return null;
  if (isServingUnit(amountUnit)) {
    if (!facts) return null;
    const servingDef = normalizeUnit(facts.serving_unit);
    const servingSize = Number(facts.serving_size);
    if (!servingDef || !(servingSize > 0)) return null;
    return { dimension: servingDef.dimension, baseAmount: amount * servingSize * servingDef.toBase };
  }
  const def = normalizeUnit(amountUnit);
  if (!def) return null;
  return { dimension: def.dimension, baseAmount: amount * def.toBase };
}

// Cost of `amount amountUnit` of a food at its latest price, or null when the
// units can't be reconciled. Mass<->volume mismatches convert through the
// food's density (kg/L, i.e. g/ml) — the same rule as the canonical dashboard
// display. Count can't convert to mass/volume (no per-item weight). Uses the
// raw price; usable_pct is deliberately not applied (see CLAUDE.md).
export function ingredientCost(
  amount: number,
  amountUnit: string,
  facts: NutritionFacts | null,
  price: LatestPrice | null,
  density: number
): number | null {
  if (!price) return null;
  const unitPrice = Number(price.unit_price);
  const priceDef = normalizeUnit(price.amount_unit);
  if (!priceDef || !isFinite(unitPrice)) return null;

  const base = toBaseAmount(amount, amountUnit, facts);
  if (!base) return null;

  if (base.dimension === priceDef.dimension) return unitPrice * base.baseAmount;
  const d = Number(density) > 0 ? Number(density) : 1;
  if (base.dimension === 'mass' && priceDef.dimension === 'volume') {
    return unitPrice * (base.baseAmount / d); // grams -> ml
  }
  if (base.dimension === 'volume' && priceDef.dimension === 'mass') {
    return unitPrice * (base.baseAmount * d); // ml -> grams
  }
  return null; // count vs mass/volume
}

export interface MealSummary {
  totals: Record<string, number | null>; // every NUTRIENT_FIELD + cost
  per_serving: Record<string, number | null>;
  nutrition_complete: boolean; // every ingredient's nutrients were computable
  cost_complete: boolean; // every ingredient had a usable price
  ingredients: any[]; // input rows + { nutrients, cost }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Computes per-ingredient scaled nutrients + cost and aggregates them. Totals
// sum only what's known (a missing ingredient leaves the flags false rather
// than nulling the whole meal); fields nobody reported stay null.
export function summarizeMeal(ingredients: IngredientRow[], servings: number): MealSummary {
  const totals: Record<string, number | null> = {};
  for (const f of NUTRIENT_FIELDS) totals[f] = null;
  totals.cost = null;
  let nutritionComplete = true;
  let costComplete = true;

  const detailed = ingredients.map((ing) => {
    const amount = Number(ing.amount);
    const facts = ing.nutrition && ing.nutrition.serving_size != null ? ing.nutrition : null;
    const nutrients = facts ? scaleNutrients(facts, amount, String(ing.amount_unit)) : null;
    if (!nutrients) nutritionComplete = false;
    else {
      for (const f of NUTRIENT_FIELDS) {
        const v = nutrients[f as NutrientField];
        if (v !== null) totals[f] = (totals[f] ?? 0) + v;
      }
    }

    const cost = ingredientCost(amount, String(ing.amount_unit), facts, ing.latest_price, Number(ing.density));
    if (cost === null) costComplete = false;
    else totals.cost = (totals.cost ?? 0) + cost;

    return { ...ing, nutrients, cost: cost === null ? null : round2(cost) };
  });

  const perServing: Record<string, number | null> = {};
  const s = servings > 0 ? servings : 1;
  for (const key of Object.keys(totals)) {
    const v = totals[key];
    if (v !== null) totals[key] = round2(v);
    perServing[key] = v === null ? null : round2(v / s);
  }

  return {
    totals,
    per_serving: perServing,
    nutrition_complete: ingredients.length > 0 && nutritionComplete,
    cost_complete: ingredients.length > 0 && costComplete,
    ingredients: detailed,
  };
}

// Validates one ingredient spec from a request body. Returns an error message
// or null when valid. 'serving' is accepted alongside the shared unit vocab.
export function validateIngredient(ing: any): string | null {
  if (!ing || !Number.isInteger(Number(ing.food_id))) return 'each ingredient needs a food_id';
  if (!(Number(ing.amount) > 0)) return 'each ingredient needs an amount > 0';
  const unit = String(ing.amount_unit ?? '').trim();
  if (!unit || (!isServingUnit(unit) && !normalizeUnit(unit))) {
    return `unknown amount_unit '${unit}' (use g/kg/oz/lb, ml/l/cup/..., each/ct/dozen, or 'serving')`;
  }
  return null;
}
