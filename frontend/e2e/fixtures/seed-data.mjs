// Static fixture data — the single source of truth for the seeded dev/CI catalog.
//
// Both the seeder (./seed.mjs) and the Playwright tests import THIS file, so a
// test's expectations can never drift from the data that was inserted. Change a
// value here and both sides follow.
//
// These are development/CI fixtures. Never load them into a production volume.
//
// The set is chosen to cover every display branch the UI has, so the smoke tests
// and the visual snapshots exercise real code paths rather than one happy case:
//   - mass / volume (with density) / count units
//   - a food with nutrition facts, and one without
//   - usable_pct != 100 (the "usable" price suffix)
//   - an alias (fuzzy match + dashboard search by alias)
//   - an archived food (must be hidden from the catalog, visible under ?deleted=1)
//   - an ACTIVE sale and an EXPIRED sale (the ACTIVE_PRICE_SQL invariant)

/** Marker written into every fixture's description so a seed is identifiable. */
export const FIXTURE_TAG = '[fixture]';

const iso = (daysFromNow) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

/** Sale windows, relative to the run date so they never go stale. */
export const SALE_ACTIVE_ENDS = iso(14);
export const SALE_EXPIRED_ENDS = iso(-14);

export const STORES = [
  // latitude/longitude present so the GPS store auto-match path has data.
  { key: 'westside', name: 'Fixture Westside Market', location: 'Vancouver, BC', latitude: 49.2827, longitude: -123.1207 },
  { key: 'eastside', name: 'Fixture Eastside Grocer', location: 'Burnaby, BC', latitude: null, longitude: null },
];

export const FOODS = [
  {
    key: 'oats',
    name: 'Fixture Rolled Oats',
    barcode: '0000000000017',
    category: 'Pantry',
    unit: 'g',
    density: null,
    usable_pct: 100,
    aliases: ['FIXT RLD OATS'], // exercises alias search + fuzzy match
    nutrition: {
      serving_size: 40, serving_unit: 'g', calories: 150,
      protein_g: 5, carbs_g: 27, fat_g: 3, fiber_g: 4, sodium_mg: 0,
    },
    prices: [
      { store: 'westside', price: 4.99, amount: 1, amount_unit: 'kg', is_sale: false },
      { store: 'eastside', price: 5.49, amount: 1, amount_unit: 'kg', is_sale: false },
    ],
  },
  {
    key: 'oliveoil',
    name: 'Fixture Olive Oil',
    barcode: '0000000000024',
    category: 'Pantry',
    unit: 'ml',
    density: 0.92, // volume food → canonical per-kg display goes through density
    usable_pct: 100,
    aliases: [],
    nutrition: {
      serving_size: 15, serving_unit: 'ml', calories: 120,
      protein_g: 0, carbs_g: 0, fat_g: 14, saturated_fat_g: 2,
    },
    prices: [
      { store: 'westside', price: 12.99, amount: 1, amount_unit: 'l', is_sale: false },
    ],
  },
  {
    key: 'eggs',
    name: 'Fixture Free Run Eggs',
    barcode: '0000000000031',
    category: 'Dairy & Eggs',
    unit: 'each',
    density: null,
    usable_pct: 100,
    aliases: [],
    // No nutrition: covers the "count unit, per-100 not computable" branch,
    // where the kcal column must fall back rather than print a bare number.
    nutrition: null,
    prices: [
      { store: 'westside', price: 6.49, amount: 12, amount_unit: 'each', is_sale: false },
    ],
  },
  {
    key: 'drumsticks',
    name: 'Fixture Chicken Drumsticks',
    barcode: '0000000000048',
    category: 'Meat',
    unit: 'g',
    density: null,
    usable_pct: 70, // 30% bone → the " usable" price suffix
    aliases: [],
    nutrition: {
      serving_size: 100, serving_unit: 'g', calories: 172,
      protein_g: 18, carbs_g: 0, fat_g: 11,
    },
    prices: [
      // ACTIVE sale — must appear as a current price.
      { store: 'westside', price: 7.99, amount: 1, amount_unit: 'kg', is_sale: true, sale_ends_at: SALE_ACTIVE_ENDS },
    ],
  },
  {
    key: 'yogurt',
    name: 'Fixture Greek Yogurt',
    barcode: '0000000000055',
    category: 'Dairy & Eggs',
    unit: 'g',
    density: null,
    usable_pct: 100,
    aliases: [],
    nutrition: {
      serving_size: 175, serving_unit: 'g', calories: 100,
      protein_g: 17, carbs_g: 6, fat_g: 0, calcium_mg: 200,
    },
    prices: [
      // EXPIRED sale — must NOT be quoted as a current price. This is the row
      // the ACTIVE_PRICE_SQL smoke assertion is really testing.
      { store: 'eastside', price: 3.49, amount: 650, amount_unit: 'g', is_sale: true, sale_ends_at: SALE_EXPIRED_ENDS },
      { store: 'eastside', price: 5.99, amount: 650, amount_unit: 'g', is_sale: false },
    ],
  },
  {
    key: 'archived',
    name: 'Fixture Archived Widget',
    barcode: '0000000000062',
    category: 'Scraped',
    unit: 'each',
    density: null,
    usable_pct: 100,
    aliases: [],
    nutrition: null,
    prices: [],
    archived: true, // must be hidden from GET /api/foods, listed by ?deleted=1
  },
];

export const MEALS = [
  {
    key: 'porridge',
    name: 'Fixture Morning Porridge',
    servings: 2,
    notes: 'Seeded fixture meal.',
    ingredients: [
      { food: 'oats', amount: 80, amount_unit: 'g' },
      { food: 'yogurt', amount: 175, amount_unit: 'g' },
    ],
  },
];

/** Foods expected to be visible in the default (non-archived) catalog read. */
export const ACTIVE_FOOD_NAMES = FOODS.filter(f => !f.archived).map(f => f.name);

/** Convenience lookups for tests. */
export const foodByKey = (key) => FOODS.find(f => f.key === key);
export const storeByKey = (key) => STORES.find(s => s.key === key);
