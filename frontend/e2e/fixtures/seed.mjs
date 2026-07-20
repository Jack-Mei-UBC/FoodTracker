#!/usr/bin/env node
// Seeds the fixture catalog defined in ./seed-data.mjs into a running stack.
//
//   node e2e/fixtures/seed.mjs                 # seeds http://127.0.0.1:4000
//   API=http://host:4000 node e2e/fixtures/seed.mjs
//
// Writes through the backend REST API rather than raw SQL, deliberately: a
// price row is invisible to every catalog read without its `food_prices` join
// row, and `unit_price` normalization happens in the route handler. Raw INSERTs
// would produce fixtures that look correct in the database and wrong in the UI.
// Going through the API also means every seed exercises those endpoints.
//
// Idempotent: existing rows are matched by barcode (foods) / name (stores,
// meals) and reused, so re-running is a no-op rather than a pile of duplicates.
// Requires the stack to be up; run the readiness gate before this.

import {
  STORES, FOODS, MEALS, FIXTURE_TAG,
} from './seed-data.mjs';

const API = process.env.API || 'http://127.0.0.1:4000';

let created = 0;
let reused = 0;

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);
const put = (p, b) => req('PUT', p, b);

// ── Stores ──────────────────────────────────────────────────────────────────
async function seedStores() {
  const existing = await get('/api/stores');
  const byName = new Map(existing.map(s => [s.name, s]));
  const ids = {};

  for (const s of STORES) {
    let row = byName.get(s.name);
    if (row) {
      reused++;
    } else {
      row = await post('/api/stores', { name: s.name, location: s.location });
      created++;
    }
    ids[s.key] = row.id;

    // latitude/longitude are set through the dedicated endpoint — POST /api/stores
    // doesn't accept them.
    if (s.latitude != null && s.longitude != null && row.latitude == null) {
      await put(`/api/stores/${row.id}/location`, { latitude: s.latitude, longitude: s.longitude });
    }
  }
  return ids;
}

// ── Foods (+ aliases, nutrition, prices, archive state) ─────────────────────
async function seedFoods(storeIds) {
  // Include archived foods in the lookup so a re-run doesn't try to recreate the
  // archived fixture and collide on its UNIQUE barcode.
  const [active, archived] = await Promise.all([
    get('/api/foods'),
    get('/api/foods?deleted=1'),
  ]);
  const byBarcode = new Map(
    [...active, ...archived].filter(f => f.barcode).map(f => [f.barcode, f])
  );
  const ids = {};

  for (const f of FOODS) {
    let row = byBarcode.get(f.barcode);
    if (row) {
      reused++;
    } else {
      row = await post('/api/foods', {
        name: f.name,
        barcode: f.barcode,
        description: `${FIXTURE_TAG} seeded fixture`,
        category: f.category,
        unit: f.unit,
        usable_pct: f.usable_pct,
        ...(f.density != null ? { density: f.density } : {}),
      });
      created++;

      for (const alias of f.aliases) {
        await post(`/api/foods/${row.id}/aliases`, { alias });
      }

      if (f.nutrition) {
        await put(`/api/foods/${row.id}/nutrition`, { ...f.nutrition, source: 'manual' });
      }

      for (const p of f.prices) {
        await post(`/api/foods/${row.id}/prices`, {
          store_id: storeIds[p.store],
          price: p.price,
          amount: p.amount,
          amount_unit: p.amount_unit,
          is_sale: p.is_sale,
          source: 'manual',
          ...(p.sale_ends_at ? { sale_ends_at: p.sale_ends_at } : {}),
        });
      }

      // Archive last — the food and its rows must exist first.
      if (f.archived) {
        await post('/api/foods/bulk', { ids: [row.id], action: 'archive' });
      }
    }
    ids[f.key] = row.id;
  }
  return ids;
}

// ── Meals ───────────────────────────────────────────────────────────────────
async function seedMeals(foodIds) {
  const existing = await get('/api/meals');
  const byName = new Set(existing.map(m => m.name));

  for (const m of MEALS) {
    if (byName.has(m.name)) { reused++; continue; }
    await post('/api/meals', {
      name: m.name,
      servings: m.servings,
      notes: `${FIXTURE_TAG} ${m.notes}`,
      ingredients: m.ingredients.map(i => ({
        food_id: foodIds[i.food],
        amount: i.amount,
        amount_unit: i.amount_unit,
      })),
    });
    created++;
  }
}

async function main() {
  console.log(`seeding fixtures -> ${API}`);
  try {
    await get('/api/health');
  } catch {
    console.error(`backend not reachable at ${API} — is the stack up?`);
    process.exit(1);
  }

  const storeIds = await seedStores();
  const foodIds = await seedFoods(storeIds);
  await seedMeals(foodIds);

  console.log(`fixtures ready: ${created} created, ${reused} already present`);
}

main().catch(err => {
  console.error(`seed failed: ${err.message}`);
  process.exit(1);
});
