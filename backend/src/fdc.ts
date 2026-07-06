// USDA FoodData Central lookup (https://fdc.nal.usda.gov/api-guide).
// Maps FDC search results into ready-to-save per-serving nutrition facts in
// the food_nutrition shape. Values in FDC search results are per 100 g (or
// 100 ml for liquid Branded foods); when a Branded food declares a label
// serving in g/ml we rescale to it, otherwise facts are per 100 g.

const FDC_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// Nutrient numbers used by the search endpoint's abridged foodNutrients.
// FDC reports each in a fixed unit, matching our column units below.
const NUTRIENT_IDS = {
  kcal: 1008,          // Energy (KCAL)
  kcalAtwaterSpec: 2048,
  kcalAtwaterGen: 2047,
  protein: 1003,       // g
  fat: 1004,           // g
  carbs: 1005,         // g
  saturatedFat: 1258,  // g
  transFat: 1257,      // g
  cholesterol: 1253,   // mg
  sodium: 1093,        // mg
  fiber: 1079,         // g
  sugar: 2000,         // g
  addedSugar: 1235,    // g
  potassium: 1092,     // mg
  calcium: 1087,       // mg
  iron: 1089,          // mg
  vitaminA: 1106,      // Vitamin A, RAE (mcg)
  vitaminC: 1162,      // Vitamin C (mg)
  vitaminD: 1114,      // Vitamin D (D2 + D3) (mcg)
};

interface FdcSearchNutrient {
  nutrientId: number;
  value: number;
  unitName?: string;
}

interface FdcSearchFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  gtinUpc?: string;
  foodNutrients?: FdcSearchNutrient[];
}

export interface FdcCandidate {
  fdc_id: number;
  description: string;
  brand: string | null;
  data_type: string | null;
  barcode: string | null;
  serving_size: number;
  serving_unit: string;
  serving_text: string | null; // e.g. "2/3 cup" — display only
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  trans_fat_g: number | null;
  cholesterol_mg: number | null;
  sodium_mg: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
  potassium_mg: number | null;
  calcium_mg: number | null;
  iron_mg: number | null;
  vitamin_a_mcg: number | null;
  vitamin_c_mg: number | null;
  vitamin_d_mcg: number | null;
}

// FDC serving units we can express in the app's unit vocabulary.
const FDC_UNIT: Record<string, string> = {
  g: 'g', grm: 'g', gram: 'g', grams: 'g',
  ml: 'ml', mlt: 'ml',
};

function nutrientValue(food: FdcSearchFood, id: number): number | null {
  const hit = (food.foodNutrients ?? []).find(n => n.nutrientId === id);
  return hit && isFinite(hit.value) ? hit.value : null;
}

function kcalPer100(food: FdcSearchFood): number | null {
  return (
    nutrientValue(food, NUTRIENT_IDS.kcal) ??
    nutrientValue(food, NUTRIENT_IDS.kcalAtwaterSpec) ??
    nutrientValue(food, NUTRIENT_IDS.kcalAtwaterGen)
  );
}

function toCandidate(food: FdcSearchFood): FdcCandidate {
  // Default basis: the per-100g/ml values FDC reports.
  let servingSize = 100;
  let servingUnit = 'g';
  let factor = 1;

  const fdcUnit = FDC_UNIT[String(food.servingSizeUnit ?? '').toLowerCase().trim()];
  if (fdcUnit && food.servingSize && food.servingSize > 0) {
    servingSize = food.servingSize;
    servingUnit = fdcUnit;
    factor = food.servingSize / 100;
  } else if (FDC_UNIT[String(food.servingSizeUnit ?? '').toLowerCase().trim()] === undefined && food.servingSizeUnit) {
    // Unconvertible serving unit (e.g. "PIECES") — keep the 100 g basis.
  }

  const scaled = (v: number | null): number | null =>
    v === null ? null : Math.round(v * factor * 100) / 100;

  return {
    fdc_id: food.fdcId,
    description: food.description,
    brand: food.brandName || food.brandOwner || null,
    data_type: food.dataType ?? null,
    barcode: food.gtinUpc ?? null,
    serving_size: servingSize,
    serving_unit: servingUnit,
    serving_text: food.householdServingFullText ?? null,
    calories: scaled(kcalPer100(food)),
    protein_g: scaled(nutrientValue(food, NUTRIENT_IDS.protein)),
    carbs_g: scaled(nutrientValue(food, NUTRIENT_IDS.carbs)),
    fat_g: scaled(nutrientValue(food, NUTRIENT_IDS.fat)),
    saturated_fat_g: scaled(nutrientValue(food, NUTRIENT_IDS.saturatedFat)),
    trans_fat_g: scaled(nutrientValue(food, NUTRIENT_IDS.transFat)),
    cholesterol_mg: scaled(nutrientValue(food, NUTRIENT_IDS.cholesterol)),
    sodium_mg: scaled(nutrientValue(food, NUTRIENT_IDS.sodium)),
    fiber_g: scaled(nutrientValue(food, NUTRIENT_IDS.fiber)),
    sugar_g: scaled(nutrientValue(food, NUTRIENT_IDS.sugar)),
    added_sugar_g: scaled(nutrientValue(food, NUTRIENT_IDS.addedSugar)),
    potassium_mg: scaled(nutrientValue(food, NUTRIENT_IDS.potassium)),
    calcium_mg: scaled(nutrientValue(food, NUTRIENT_IDS.calcium)),
    iron_mg: scaled(nutrientValue(food, NUTRIENT_IDS.iron)),
    vitamin_a_mcg: scaled(nutrientValue(food, NUTRIENT_IDS.vitaminA)),
    vitamin_c_mg: scaled(nutrientValue(food, NUTRIENT_IDS.vitaminC)),
    vitamin_d_mcg: scaled(nutrientValue(food, NUTRIENT_IDS.vitaminD)),
  };
}

// Searches FDC by free text (a barcode works too — it matches gtinUpc on
// Branded foods). Returns candidates with usable calories, best matches first.
export async function searchFdc(query: string, apiKey: string): Promise<FdcCandidate[]> {
  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    pageSize: '10',
    dataType: 'Foundation,SR Legacy,Branded',
  });
  const res = await fetch(`${FDC_SEARCH_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`FoodData Central returned ${res.status}${res.status === 403 ? ' (check FDC_API_KEY)' : ''}`);
  }
  const data: any = await res.json();
  const foods: FdcSearchFood[] = data.foods ?? [];
  return foods.map(toCandidate).filter(c => c.calories !== null);
}
