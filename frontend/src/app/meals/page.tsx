"use client";

// Meal plans: compose meals from catalog foods, see live macros + cost per
// serving, clone/edit, log portions to the diary, and draft meals with AI.
// The server computes the authoritative totals (GET /api/meals[/:id]); the
// builder's live preview mirrors the same rules client-side (display-only).

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Modal from '../../components/Modal';
import FoodDetailModal from '../../components/FoodDetailModal';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import NutritionSearch, { SavedFood } from '../../components/NutritionSearch';
import { UNIT_OPTIONS, parseAmountInput, normalizeUnit } from '../../lib/units';
import { scaleNutrients, isServingUnit, NutritionFacts } from '../../lib/nutrition';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface CatalogFood {
  id: number;
  name: string;
  category: string;
  unit: string;
  density: string | number;
  aliases: { id: number; alias: string }[] | null;
  nutrition: (NutritionFacts & { food_id: number }) | null;
  latest_prices: {
    price: string; unit_price: string | null; amount: string | null;
    amount_unit: string | null; scraped_at: string; is_sale: boolean; store_name: string;
  }[] | null;
}

interface MealTotals { [field: string]: number | null }

interface MealListItem {
  id: number;
  name: string;
  notes: string | null;
  servings: string;
  updated_at: string;
  ingredient_count: number;
  totals: MealTotals;
  per_serving: MealTotals;
  nutrition_complete: boolean;
  cost_complete: boolean;
}

interface IngredientDetail {
  id: number;
  food_id: number;
  food_name: string;
  amount: string;
  amount_unit: string;
  nutrition: NutritionFacts | null;
  latest_price: {
    price: string; unit_price: string; amount: string | null; amount_unit: string | null;
    scraped_at: string; is_sale: boolean; store_name: string | null;
  } | null;
  nutrients: { [field: string]: number | null } | null;
  cost: number | null;
}

interface MealDetail extends MealListItem {
  ingredients: IngredientDetail[];
}

interface BuilderRow {
  food_id: number;
  food_name: string;
  amount: string;
  unit: string;
}

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const INGREDIENT_UNITS = ['serving'].concat(UNIT_OPTIONS);

const pad = (n: number) => String(n).padStart(2, '0');
const nowLocalTimestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const fmtKcal = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}`);
const fmtG = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}g`);
const fmtCost = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);
const fmtDate = (ts: string) => ts.slice(0, 10);

// Display-only mirror of backend ingredientCost (backend/src/meals.ts):
// latest unit_price × amount in base units, density-converting mass<->volume.
function previewCost(amount: number, unit: string, food: CatalogFood | undefined): number | null {
  if (!food || !(amount > 0)) return null;
  const price = (food.latest_prices ?? []).find(p => p.unit_price != null);
  if (!price) return null;
  const unitPrice = Number(price.unit_price);
  const priceDef = normalizeUnit(price.amount_unit);
  if (!priceDef || !isFinite(unitPrice)) return null;

  let dimension: string;
  let baseAmount: number;
  if (isServingUnit(unit)) {
    const facts = food.nutrition;
    const servingDef = facts ? normalizeUnit(facts.serving_unit) : null;
    if (!facts || !servingDef || !(Number(facts.serving_size) > 0)) return null;
    dimension = servingDef.dimension;
    baseAmount = amount * Number(facts.serving_size) * servingDef.toBase;
  } else {
    const def = normalizeUnit(unit);
    if (!def) return null;
    dimension = def.dimension;
    baseAmount = amount * def.toBase;
  }

  if (dimension === priceDef.dimension) return unitPrice * baseAmount;
  const density = Number(food.density) > 0 ? Number(food.density) : 1;
  if (dimension === 'mass' && priceDef.dimension === 'volume') return unitPrice * (baseAmount / density);
  if (dimension === 'volume' && priceDef.dimension === 'mass') return unitPrice * (baseAmount * density);
  return null;
}

export default function MealsPage() {
  const [meals, setMeals] = useState<MealListItem[]>([]);
  const [foods, setFoods] = useState<CatalogFood[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MealDetail | null>(null);

  // Builder (create / edit / AI draft)
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editMealId, setEditMealId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [servings, setServings] = useState('1');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<BuilderRow[]>([]);
  const [rationale, setRationale] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Ingredient search inside the builder — from the catalog, or from USDA (which
  // only saves the item you actually pick, not every search result).
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [ingredientSource, setIngredientSource] = useState<'catalog' | 'usda'>('catalog');
  // Food whose prices/names/macros are being edited via the shared FoodDetailModal
  // (which launches the shared PriceEditor / MacroEditor popups).
  const [detailFoodId, setDetailFoodId] = useState<number | null>(null);

  // Log-to-diary popup
  const [logMeal, setLogMeal] = useState<MealListItem | null>(null);
  const [logSlot, setLogSlot] = useState('dinner');
  const [logPortions, setLogPortions] = useState('1');
  const [isLogging, setIsLogging] = useState(false);

  // AI generation panel
  const [aiOpen, setAiOpen] = useState(false);
  const [aiFoodIds, setAiFoodIds] = useState<number[]>([]);
  const [aiTargets, setAiTargets] = useState({ calories: '', protein_g: '', carbs_g: '', fat_g: '' });
  const [aiNotes, setAiNotes] = useState('');
  const [aiQuery, setAiQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const fetchMeals = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals`);
      if (!res.ok) throw new Error();
      setMeals(await res.json());
    } catch {
      showToast('Failed to load meals.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Reload the catalog — also called after a FoodDetailModal edit so the builder's
  // live macro/cost preview picks up newly added facts or prices.
  const fetchFoods = useCallback(() => {
    fetch(`${API_BASE_URL}/api/foods`)
      .then(r => (r.ok ? r.json() : []))
      .then(setFoods)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchMeals();
    fetchFoods();
    // Prefill AI targets from the daily goals (rough per-meal defaults).
    fetch(`${API_BASE_URL}/api/goals`)
      .then(r => (r.ok ? r.json() : null))
      .then(g => {
        if (!g) return;
        setAiTargets({
          calories: g.daily_calories ? String(Math.round(Number(g.daily_calories) / 3)) : '',
          protein_g: g.protein_g ? String(Math.round(Number(g.protein_g) / 3)) : '',
          carbs_g: g.carbs_g ? String(Math.round(Number(g.carbs_g) / 3)) : '',
          fat_g: g.fat_g ? String(Math.round(Number(g.fat_g) / 3)) : '',
        });
      })
      .catch(() => {});
  }, []);

  const foodById = useMemo(() => {
    const m = new Map<number, CatalogFood>();
    for (const f of foods) m.set(f.id, f);
    return m;
  }, [foods]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return foods
      .filter(f =>
        f.name.toLowerCase().indexOf(q) !== -1 ||
        (f.aliases ?? []).some(a => a.alias.toLowerCase().indexOf(q) !== -1)
      )
      .slice(0, 40);
  }, [query, foods]);

  // Live builder preview: kcal + macros per ingredient (client-side scaling)
  // and estimated cost. The server recomputes the authoritative figures.
  const builderPreview = useMemo(() => {
    let calories = 0, protein = 0, carbs = 0, fat = 0, cost = 0;
    let nutritionComplete = rows.length > 0;
    let costComplete = rows.length > 0;
    const perRow = rows.map(row => {
      const food = foodById.get(row.food_id);
      const amt = parseFloat(row.amount);
      const scaled = food?.nutrition && isFinite(amt) && amt > 0
        ? scaleNutrients(food.nutrition, amt, row.unit)
        : null;
      if (scaled) {
        calories += scaled.calories;
        protein += scaled.protein_g ?? 0;
        carbs += scaled.carbs_g ?? 0;
        fat += scaled.fat_g ?? 0;
      } else nutritionComplete = false;
      const c = isFinite(amt) ? previewCost(amt, row.unit, food) : null;
      if (c === null) costComplete = false;
      else cost += c;
      return { scaled, cost: c };
    });
    return { calories, protein, carbs, fat, cost, nutritionComplete, costComplete, perRow };
  }, [rows, foodById]);

  const servingsNum = parseFloat(servings) > 0 ? parseFloat(servings) : 1;

  const resetBuilder = () => {
    setBuilderOpen(false);
    setEditMealId(null);
    setName('');
    setServings('1');
    setNotes('');
    setRows([]);
    setRationale(null);
    setQuery('');
  };

  const openCreate = () => {
    resetBuilder();
    setBuilderOpen(true);
    setAiOpen(false);
  };

  const openEdit = async (meal: MealListItem) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals/${meal.id}`);
      if (!res.ok) throw new Error();
      const d: MealDetail = await res.json();
      setEditMealId(d.id);
      setName(d.name);
      setServings(String(Number(d.servings)));
      setNotes(d.notes ?? '');
      setRows(d.ingredients.map(ing => ({
        food_id: ing.food_id,
        food_name: ing.food_name,
        amount: String(Number(ing.amount)),
        unit: ing.amount_unit,
      })));
      setRationale(null);
      setBuilderOpen(true);
      setAiOpen(false);
    } catch {
      showToast('Failed to load meal for editing.', 'error');
    }
  };

  // Default a new ingredient row to the food's serving *weight* (e.g. 28 g) when it
  // has nutrition facts — concrete and editable, rather than an abstract "1 serving"
  // (both scale to the same macros). Falls back to 1 serving / the food's own unit.
  // Shared by the Catalog and USDA add paths so they stay consistent.
  const rowDefaults = (f: { nutrition?: NutritionFacts | null; unit?: string }): { amount: string; unit: string } => {
    const n = f?.nutrition;
    if (n && Number(n.serving_size) > 0 && n.serving_unit) {
      return { amount: String(Number(n.serving_size)), unit: n.serving_unit };
    }
    return { amount: '1', unit: n ? 'serving' : (f?.unit || 'each') };
  };

  const addRow = (f: CatalogFood) => {
    const d = rowDefaults(f);
    setRows(rows.concat({ food_id: f.id, food_name: f.name, amount: d.amount, unit: d.unit }));
    setQuery('');
    setShowSuggestions(false);
  };

  // Keep a just-saved USDA food in the local catalog list so the live preview can
  // scale it (functional update so several picked in a row don't clobber each other).
  const registerSavedFood = (f: SavedFood) => {
    const cf = f as unknown as CatalogFood;
    setFoods(prev => (prev.some(x => x.id === cf.id) ? prev : prev.concat(cf)));
  };

  // The user picked a USDA result (NutritionSearch already saved just that one to the
  // catalog): register it for the preview and drop it into the meal at its serving weight.
  const addSavedFoodToMeal = (f: SavedFood) => {
    const cf = f as unknown as CatalogFood;
    registerSavedFood(f);
    const d = rowDefaults(cf);
    setRows(prev => prev.concat({ food_id: cf.id, food_name: cf.name, amount: d.amount, unit: d.unit }));
  };

  const saveMeal = async () => {
    if (!name.trim()) { showToast('Give the meal a name.', 'error'); return; }
    if (rows.length === 0) { showToast('Add at least one ingredient.', 'error'); return; }
    const body = {
      name: name.trim(),
      servings: servingsNum,
      notes: notes.trim() || null,
      ingredients: rows.map((r, i) => ({
        food_id: r.food_id,
        amount: parseFloat(r.amount),
        amount_unit: r.unit,
        sort_order: i,
      })),
    };
    for (const ing of body.ingredients) {
      if (!(ing.amount > 0)) { showToast('Every ingredient needs an amount > 0.', 'error'); return; }
    }
    setIsSaving(true);
    try {
      const url = editMealId ? `${API_BASE_URL}/api/meals/${editMealId}` : `${API_BASE_URL}/api/meals`;
      const res = await fetch(url, {
        method: editMealId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save meal');
      showToast(editMealId ? 'Meal updated.' : `Saved "${data.name}".`);
      resetBuilder();
      setExpandedId(null);
      setDetail(null);
      fetchMeals();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const cloneMeal = async (meal: MealListItem) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals/${meal.id}/clone`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Clone failed');
      showToast(`Cloned as "${data.name}".`);
      fetchMeals();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const deleteMeal = async (meal: MealListItem) => {
    if (!confirm(`Delete "${meal.name}"? Diary entries logged from it keep their snapshot.`)) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals/${meal.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      showToast('Meal deleted.');
      if (expandedId === meal.id) { setExpandedId(null); setDetail(null); }
      fetchMeals();
    } catch {
      showToast('Failed to delete meal.', 'error');
    }
  };

  const toggleExpand = async (meal: MealListItem) => {
    if (expandedId === meal.id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(meal.id);
    setDetail(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals/${meal.id}`);
      if (!res.ok) throw new Error();
      setDetail(await res.json());
    } catch {
      showToast('Failed to load meal detail.', 'error');
      setExpandedId(null);
    }
  };

  const submitLog = async () => {
    if (!logMeal) return;
    const portions = parseFloat(logPortions);
    if (!(portions > 0)) { showToast('Portions must be > 0.', 'error'); return; }
    setIsLogging(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/meals/${logMeal.id}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal: logSlot, portions, consumed_at: nowLocalTimestamp() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to log meal');
      showToast(`Logged ${portions} serving${portions === 1 ? '' : 's'} of ${logMeal.name} — ${fmtKcal(Number(data.calories))} kcal.`);
      setLogMeal(null);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsLogging(false);
    }
  };

  // Foods eligible for AI generation: must have nutrition facts.
  const aiCandidates = useMemo(() => {
    const q = aiQuery.trim().toLowerCase();
    return foods
      .filter(f => f.nutrition)
      .filter(f => !q || f.name.toLowerCase().indexOf(q) !== -1)
      .slice(0, 30);
  }, [foods, aiQuery]);

  const toggleAiFood = (id: number) => {
    setAiFoodIds(ids => (ids.indexOf(id) !== -1 ? ids.filter(x => x !== id) : ids.concat(id)));
  };

  const generate = async () => {
    if (aiFoodIds.length === 0) { showToast('Pick at least one fridge ingredient.', 'error'); return; }
    setIsGenerating(true);
    try {
      const targets: any = {};
      for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g'] as const) {
        const v = parseFloat(aiTargets[k]);
        if (isFinite(v) && v > 0) targets[k] = v;
      }
      const res = await fetch(`${API_BASE_URL}/api/meals/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food_ids: aiFoodIds, targets, notes: aiNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      // Load the unsaved draft into the builder for review — nothing is saved
      // until the user hits Save.
      const draft = data.draft;
      setEditMealId(null);
      setName(draft.name);
      setServings(String(draft.servings));
      setNotes('');
      setRows(draft.ingredients.map((ing: any) => ({
        food_id: ing.food_id,
        food_name: ing.food_name ?? foodById.get(ing.food_id)?.name ?? `Food #${ing.food_id}`,
        amount: String(ing.amount),
        unit: ing.amount_unit,
      })));
      setRationale(draft.rationale);
      setAiOpen(false);
      setBuilderOpen(true);
      showToast('Draft ready — review and save it.');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const inputCls = "bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-hidden focus:border-emerald-500 transition";

  return (
    <div data-loc="page.meals" className="space-y-8 relative">
      {notification && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 ${
          notification.type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'
        }`}>
          <div className={`w-2 h-2 rounded-full ${notification.type === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-sm font-semibold">{notification.message}</span>
        </div>
      )}

      {/* ═══ Section: Header ═══ */}
      <div data-loc="meals.header" className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-linear-to-r from-white via-slate-100 to-emerald-300 bg-clip-text text-transparent">
            Meal Plans
          </h1>
          <p className="text-sm text-slate-400 mt-1">Recipes with live macros and cost from your latest tracked prices.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAiOpen(!aiOpen); setBuilderOpen(false); }}
            className="px-4 py-2 rounded-xl bg-violet-600/20 border border-violet-500/30 text-violet-300 text-sm font-semibold hover:bg-violet-600/30 transition"
          >
            ✨ Generate with AI
          </button>
          <button
            onClick={openCreate}
            className="px-4 py-2 rounded-xl bg-linear-to-r from-emerald-600 to-teal-600 text-white text-sm font-semibold hover:shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98] transition"
          >
            + New Meal
          </button>
        </div>
      </div>

      {/* ═══ Section: AI generation panel ═══ */}
      {aiOpen && (
        <Card data-loc="meals.ai-panel" className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
            <h2 className="text-sm font-bold text-white">Draft a meal from your fridge</h2>
          </div>
          <p className="text-xs text-slate-400">
            Pick the ingredients you have (only foods with nutrition facts are listed), set per-serving macro
            targets, and the model proposes a meal. Nothing is saved until you review it in the builder.
          </p>

          <input
            type="text"
            value={aiQuery}
            onChange={e => setAiQuery(e.target.value)}
            placeholder="Filter foods…"
            className={`w-full sm:w-64 ${inputCls}`}
          />
          <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
            {aiCandidates.map(f => {
              const selected = aiFoodIds.indexOf(f.id) !== -1;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleAiFood(f.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                    selected
                      ? 'bg-violet-600/30 border-violet-400/50 text-violet-200'
                      : 'bg-slate-950/60 border-white/10 text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {selected ? '✓ ' : ''}{f.name}
                </button>
              );
            })}
            {aiCandidates.length === 0 && (
              <p className="text-xs text-slate-600">No foods with nutrition facts match. Add facts from the Dashboard first.</p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {([['calories', 'kcal'], ['protein_g', 'Protein g'], ['carbs_g', 'Carbs g'], ['fat_g', 'Fat g']] as const).map(pair => (
              <div key={pair[0]}>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">{pair[1]}</label>
                <input
                  type="number" step="any" min="0"
                  value={aiTargets[pair[0]]}
                  onChange={e => setAiTargets({ ...aiTargets, [pair[0]]: e.target.value })}
                  className={`w-20 text-right font-mono ${inputCls}`}
                />
              </div>
            ))}
            <input
              type="text"
              value={aiNotes}
              onChange={e => setAiNotes(e.target.value)}
              placeholder="Extra instructions (e.g. high-protein dinner, no dairy)…"
              className={`flex-1 min-w-48 ${inputCls}`}
            />
            <button
              onClick={generate}
              disabled={isGenerating}
              className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition disabled:opacity-50"
            >
              {isGenerating ? 'Generating…' : 'Generate draft'}
            </button>
          </div>
          <p className="text-[10px] text-slate-500">Targets are per serving of the meal, prefilled as ⅓ of your daily goals.</p>
        </Card>
      )}

      {/* ═══ Section: Builder ═══ */}
      {builderOpen && (
        <Card data-loc="meals.builder" className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <h2 className="text-sm font-bold text-white">{editMealId ? 'Edit Meal' : 'New Meal'}</h2>
          </div>
          {rationale && (
            <div className="rounded-xl p-3 bg-violet-950/40 border border-violet-500/20 text-xs text-violet-200">
              <span className="font-bold">AI rationale:</span> {rationale}
              <span className="block text-violet-400/70 mt-1">This is an unsaved draft — adjust anything, then Save.</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Meal name (e.g. Chicken & Rice Bowl)"
              className={`flex-1 ${inputCls}`}
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400 whitespace-nowrap">Makes</label>
              <input
                type="number" step="any" min="0.25"
                value={servings}
                onChange={e => setServings(e.target.value)}
                className={`w-20 text-right font-mono ${inputCls}`}
              />
              <span className="text-xs text-slate-400">servings</span>
            </div>
          </div>

          {/* Ingredient search — from the catalog, or from USDA. The USDA tab is
              save-on-pick: nothing is added to the catalog until you press "Add to
              meal" on a specific result (a recipe ingredient must reference a food). */}
          <div className="space-y-2">
            <div className="flex gap-1 text-[11px] font-semibold">
              <button type="button" onClick={() => setIngredientSource('catalog')}
                className={`px-3 py-1 rounded-lg border transition ${ingredientSource === 'catalog' ? 'text-violet-200 bg-violet-500/15 border-violet-500/30' : 'text-slate-400 border-white/10 hover:bg-white/5'}`}>
                Catalog
              </button>
              <button type="button" onClick={() => setIngredientSource('usda')}
                className={`px-3 py-1 rounded-lg border transition ${ingredientSource === 'usda' ? 'text-sky-200 bg-sky-500/15 border-sky-500/30' : 'text-slate-400 border-white/10 hover:bg-white/5'}`}>
                USDA database
              </button>
            </div>

            {ingredientSource === 'catalog' ? (
              <div className="relative">
                <input
                  type="text"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setShowSuggestions(true); }}
                  onFocus={() => setShowSuggestions(true)}
                  placeholder="Add an ingredient from the catalog…"
                  className={`w-full ${inputCls}`}
                />
                {showSuggestions && query.trim() && (
                  <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto overflow-x-hidden scrolling-touch bg-[#0b101f] border border-white/10 rounded-xl shadow-2xl">
                    {suggestions.map(f => (
                      <div key={f.id} className="flex items-center hover:bg-white/5 transition">
                        <button
                          type="button"
                          onClick={() => addRow(f)}
                          className="flex-1 min-w-0 text-left px-3 py-2 text-xs text-slate-200 flex justify-between items-center gap-2"
                        >
                          <span className="truncate">{f.name} <span className="text-slate-500">· {f.category}</span></span>
                          <span className="flex items-center gap-2 shrink-0">
                            {f.nutrition ? (
                              <span className="font-mono text-emerald-400">{fmtKcal(Number(f.nutrition.calories))} kcal/serv</span>
                            ) : (
                              <span className="text-[10px] text-amber-500">no facts</span>
                            )}
                            {!(f.latest_prices ?? []).length && <span className="text-[10px] text-slate-600">no price</span>}
                          </span>
                        </button>
                        {/* Add facts/price to this food before adding it as an ingredient */}
                        <button
                          type="button"
                          onClick={() => setDetailFoodId(f.id)}
                          title="Edit this food's prices, names & nutrition facts"
                          className="shrink-0 px-2.5 py-2 text-slate-500 hover:text-violet-300 transition"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                      </div>
                    ))}
                    {suggestions.length === 0 && (
                      <p className="px-3 py-2 text-xs text-slate-500">No catalog match — try the USDA database tab, or add the food from the Dashboard.</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <NutritionSearch category="USDA" pickLabel="Add to meal"
                onSaved={registerSavedFood} onPick={addSavedFoodToMeal} notify={showToast} />
            )}
          </div>

          {/* Ingredient rows */}
          {rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((row, i) => {
                const food = foodById.get(row.food_id);
                const rowPreview = builderPreview.perRow[i];
                const price = (food?.latest_prices ?? []).find(p => p.unit_price != null);
                return (
                  <div key={`${row.food_id}-${i}`} className="bg-muted/50 border rounded-lg flex flex-wrap items-center gap-2 p-2.5 text-xs">
                    <span className="font-semibold text-slate-200 flex-1 min-w-32 truncate">{row.food_name}</span>
                    <input
                      type="text" inputMode="text"
                      value={row.amount}
                      onChange={e => {
                        const { amount: a, unit: u } = parseAmountInput(e.target.value);
                        const next = rows.slice();
                        if (u) next[i] = { ...row, amount: a != null ? String(a) : '', unit: u };
                        else next[i] = { ...row, amount: e.target.value };
                        setRows(next);
                      }}
                      title="Type a number with a unit (e.g. 600g, 2lb) to auto-fill both fields"
                      className="w-16 bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white text-right font-mono focus:outline-hidden focus:border-emerald-500"
                    />
                    <select
                      value={row.unit}
                      onChange={e => {
                        const next = rows.slice();
                        next[i] = { ...row, unit: e.target.value };
                        setRows(next);
                      }}
                      className="bg-slate-950 border border-white/10 rounded-lg px-1.5 py-1 text-white focus:outline-hidden"
                    >
                      {INGREDIENT_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <span className="font-mono text-slate-400 w-20 text-right">
                      {rowPreview?.scaled ? `${fmtKcal(rowPreview.scaled.calories)} kcal` : <span className="text-amber-500/80">no facts</span>}
                    </span>
                    <span className="font-mono text-slate-400 w-16 text-right" title={price ? `${fmtCost(Number(price.price))} at ${price.store_name} (${fmtDate(price.scraped_at)})` : 'No tracked price'}>
                      {rowPreview && rowPreview.cost !== null ? fmtCost(rowPreview.cost) : <span className="text-slate-600">no price</span>}
                    </span>
                    {/* Fix a missing price / missing facts without leaving the builder */}
                    <button
                      type="button"
                      onClick={() => setDetailFoodId(row.food_id)}
                      title="Edit this food's prices, names & nutrition facts"
                      className="text-slate-500 hover:text-violet-300 transition"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      title="Remove ingredient"
                      className="text-slate-500 hover:text-rose-400 transition"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Live totals */}
          {rows.length > 0 && (
            <div className="bg-muted/50 border rounded-lg p-3 flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
              <span className="text-slate-300">
                Meal: <span className="font-bold text-white">{fmtKcal(builderPreview.calories)} kcal</span>
                <span className="text-slate-500"> · P {Math.round(builderPreview.protein)} C {Math.round(builderPreview.carbs)} F {Math.round(builderPreview.fat)}</span>
                {builderPreview.costComplete && <span className="text-emerald-400"> · {fmtCost(builderPreview.cost)}</span>}
              </span>
              <span className="text-slate-300">
                Per serving (÷{servingsNum}): <span className="font-bold text-emerald-300">{fmtKcal(builderPreview.calories / servingsNum)} kcal</span>
                <span className="text-slate-500"> · P {Math.round(builderPreview.protein / servingsNum)} C {Math.round(builderPreview.carbs / servingsNum)} F {Math.round(builderPreview.fat / servingsNum)}</span>
                {builderPreview.costComplete && <span className="text-emerald-400"> · {fmtCost(builderPreview.cost / servingsNum)}</span>}
              </span>
              {!builderPreview.nutritionComplete && <span className="text-amber-500/90 font-sans">Some ingredients lack facts — totals are understated.</span>}
              {!builderPreview.costComplete && <span className="text-slate-500 font-sans">Cost shown only for priced ingredients.</span>}
            </div>
          )}

          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes / method (optional)…"
            rows={2}
            className={`w-full ${inputCls}`}
          />

          <div className="flex gap-2">
            <button
              onClick={saveMeal}
              disabled={isSaving}
              className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : editMealId ? 'Save changes' : 'Save meal'}
            </button>
            <Button
              onClick={resetBuilder}
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* ═══ Section: Meal list ═══ */}
      {isLoading ? (
        <div className="text-center text-slate-500 py-12">Loading meals…</div>
      ) : meals.length === 0 ? (
        <Card className="text-center py-16">
          <p className="text-slate-400 font-semibold">No meals yet.</p>
          <p className="text-xs text-slate-600 mt-1">Build one from your catalog foods, or let the AI draft one from your fridge.</p>
        </Card>
      ) : (
        <div data-loc="meals.list" className="space-y-3">
          {meals.map(meal => {
            const ps = meal.per_serving;
            const expanded = expandedId === meal.id;
            return (
              <Card key={meal.id} className="overflow-hidden">
                <div className="p-4 flex flex-wrap items-center gap-3">
                  <button onClick={() => toggleExpand(meal)} className="flex-1 min-w-48 text-left group">
                    <span className="font-bold text-white group-hover:text-emerald-300 transition flex items-center gap-2">
                      <svg className={`w-3 h-3 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                      {meal.name}
                    </span>
                    <span className="block text-[10px] text-slate-500 ml-5">
                      {meal.ingredient_count} ingredient{meal.ingredient_count === 1 ? '' : 's'} · makes {Number(meal.servings)} serving{Number(meal.servings) === 1 ? '' : 's'} · updated {fmtDate(meal.updated_at)}
                    </span>
                  </button>

                  <div className="flex items-center gap-4 text-xs font-mono">
                    <span title="Per serving">
                      <span className="font-bold text-white">{fmtKcal(ps.calories)}</span>
                      <span className="text-slate-500"> kcal</span>
                      <span className="text-slate-500"> · P {fmtG(ps.protein_g)} C {fmtG(ps.carbs_g)} F {fmtG(ps.fat_g)}</span>
                    </span>
                    <span className={`font-bold ${ps.cost !== null ? 'text-emerald-400' : 'text-slate-600'}`} title={meal.cost_complete ? 'Cost per serving from latest tracked prices' : 'Partial — some ingredients have no tracked price'}>
                      {fmtCost(ps.cost)}{ps.cost !== null && '/serv'}{!meal.cost_complete && ps.cost !== null && '*'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => { setLogMeal(meal); setLogPortions('1'); }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold hover:bg-emerald-600/30 transition"
                    >
                      Log to diary
                    </button>
                    <button onClick={() => openEdit(meal)} title="Edit" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                    <button onClick={() => cloneMeal(meal)} title="Clone (copy to edit)" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </button>
                    <button onClick={() => deleteMeal(meal)} title="Delete" className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-white/5 transition">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </div>

                {/* Expanded ingredient detail */}
                {expanded && (
                  <div className="border-t border-white/5 p-4 bg-slate-950/40">
                    {!detail ? (
                      <p className="text-xs text-slate-500">Loading…</p>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wider text-slate-500 text-left">
                                <th className="pb-2 pr-3 font-semibold">Ingredient</th>
                                <th className="pb-2 pr-3 font-semibold text-right">Amount</th>
                                <th className="pb-2 pr-3 font-semibold text-right">kcal</th>
                                <th className="pb-2 pr-3 font-semibold text-right">P / C / F</th>
                                <th className="pb-2 pr-3 font-semibold text-right">Cost</th>
                                <th className="pb-2 font-semibold">Last price</th>
                              </tr>
                            </thead>
                            <tbody className="font-mono">
                              {detail.ingredients.map(ing => (
                                <tr key={ing.id} className="border-t border-white/5">
                                  <td className="py-2 pr-3 font-sans font-semibold text-slate-200">{ing.food_name}</td>
                                  <td className="py-2 pr-3 text-right text-slate-300">{Number(ing.amount)} {ing.amount_unit}</td>
                                  <td className="py-2 pr-3 text-right text-white">{ing.nutrients ? fmtKcal(ing.nutrients.calories) : <span className="text-amber-500/80">—</span>}</td>
                                  <td className="py-2 pr-3 text-right text-slate-400">
                                    {ing.nutrients ? `${Math.round(ing.nutrients.protein_g ?? 0)} / ${Math.round(ing.nutrients.carbs_g ?? 0)} / ${Math.round(ing.nutrients.fat_g ?? 0)}` : '—'}
                                  </td>
                                  <td className="py-2 pr-3 text-right text-emerald-400">{fmtCost(ing.cost)}</td>
                                  <td className="py-2 text-slate-500 font-sans">
                                    {ing.latest_price ? (
                                      <>${Number(ing.latest_price.price).toFixed(2)}
                                        {ing.latest_price.amount && ` / ${Number(ing.latest_price.amount)} ${ing.latest_price.amount_unit}`}
                                        {ing.latest_price.store_name && ` @ ${ing.latest_price.store_name}`}
                                        {` · ${fmtDate(ing.latest_price.scraped_at)}`}
                                        {ing.latest_price.is_sale && <span className="text-rose-400 font-semibold"> SALE</span>}
                                      </>
                                    ) : (
                                      <span className="text-slate-600">no tracked price</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="font-mono">
                              <tr className="border-t border-white/10 text-slate-200">
                                <td className="py-2 pr-3 font-sans font-bold">Meal total</td>
                                <td />
                                <td className="py-2 pr-3 text-right font-bold text-white">{fmtKcal(detail.totals.calories)}</td>
                                <td className="py-2 pr-3 text-right">{`${Math.round(detail.totals.protein_g ?? 0)} / ${Math.round(detail.totals.carbs_g ?? 0)} / ${Math.round(detail.totals.fat_g ?? 0)}`}</td>
                                <td className="py-2 pr-3 text-right font-bold text-emerald-400">{fmtCost(detail.totals.cost)}</td>
                                <td />
                              </tr>
                              <tr className="text-emerald-300/90">
                                <td className="py-1 pr-3 font-sans font-bold">Per serving (÷{Number(detail.servings)})</td>
                                <td />
                                <td className="py-1 pr-3 text-right font-bold">{fmtKcal(detail.per_serving.calories)}</td>
                                <td className="py-1 pr-3 text-right">{`${Math.round(detail.per_serving.protein_g ?? 0)} / ${Math.round(detail.per_serving.carbs_g ?? 0)} / ${Math.round(detail.per_serving.fat_g ?? 0)}`}</td>
                                <td className="py-1 pr-3 text-right font-bold">{fmtCost(detail.per_serving.cost)}</td>
                                <td />
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                        {detail.notes && <p className="text-xs text-slate-400 italic">{detail.notes}</p>}
                        {!detail.nutrition_complete && (
                          <p className="text-[10px] text-amber-500/90">Some ingredients have no nutrition facts (or an unconvertible unit) — macro totals are understated.</p>
                        )}
                        {!detail.cost_complete && (
                          <p className="text-[10px] text-slate-500">* Cost covers only ingredients with a tracked, unit-priced purchase.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ═══ Section: Log-to-diary popup (data-loc="modal.meal-log") ═══ */}
      {logMeal && (
        <Modal onClose={() => setLogMeal(null)} maxWidth="max-w-sm" dataLoc="modal.meal-log">
            <h3 className="text-sm font-bold text-white">Log “{logMeal.name}” to today's diary</h3>
            <p className="text-xs text-slate-400">
              One diary entry with the meal's per-serving nutrients × portions
              ({fmtKcal(logMeal.per_serving.calories)} kcal/serving{!logMeal.nutrition_complete && ', partial facts'}).
            </p>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Meal</label>
                <select value={logSlot} onChange={e => setLogSlot(e.target.value)} className={`w-full ${inputCls}`}>
                  {MEAL_SLOTS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Portions</label>
                <input
                  type="number" step="any" min="0.25"
                  value={logPortions}
                  onChange={e => setLogPortions(e.target.value)}
                  className={`w-24 text-right font-mono ${inputCls}`}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={submitLog}
                disabled={isLogging}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl py-2 text-sm font-semibold transition disabled:opacity-50"
              >
                {isLogging ? 'Logging…' : 'Log it'}
              </button>
              <Button
                onClick={() => setLogMeal(null)}
                variant="secondary"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
        </Modal>
      )}

      {/* Shared food editor (prices / names / macros) — launched from the ingredient
          rows and the catalog picker, so a missing price or missing facts can be
          fixed without leaving the builder. Refetch the catalog on change so the
          live macro/cost preview updates immediately. */}
      {detailFoodId !== null && (
        <FoodDetailModal
          foodId={detailFoodId}
          onChange={fetchFoods}
          onClose={() => { setDetailFoodId(null); fetchFoods(); }}
        />
      )}
    </div>
  );
}
