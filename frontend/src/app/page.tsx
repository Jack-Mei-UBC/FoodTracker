"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { NutritionFacts, nutrientsPer100 } from '../lib/nutrition';
import { canonicalUnitPrice, normalizeUnit } from '../lib/units';
import PriceEditor from '../components/PriceEditor';
import MacroEditor from '../components/MacroEditor';
import Modal from '../components/Modal';
import FoodIconPicker from '../components/FoodIconPicker';

// Interfaces based on database schema
interface LatestPrice {
  price: number;
  unit_price: number;
  amount: number | string | null;
  amount_unit: string | null;
  scraped_at: string;
  is_sale: boolean;
  store_name: string;
  store_id: number;
}

interface FoodAlias {
  id: number;
  alias: string;
}

interface FoodItem {
  id: number;
  name: string;
  barcode: string | null;
  description: string | null;
  category: string;
  unit: string;
  usable_pct: number | string;
  density: number | string;
  image_id: number | null;
  display_image_id: number | null;
  latest_prices: LatestPrice[] | null;
  aliases: FoodAlias[] | null;
  nutrition: (NutritionFacts & { source: string }) | null;
}

interface Store {
  id: number;
  name: string;
  location: string | null;
  logo_url: string | null;
}

interface PriceHistoryLog {
  id: number;
  price: number | string;
  amount: number | string | null;
  amount_unit: string | null;
  is_sale: boolean;
  store_id: number | null;
  store_name: string;
  scraped_at: string;
}

interface PriceEfficiency {
  food_id: number;
  food_name: string;
  category: string;
  unit: string;
  min_price: string;
  max_price: string;
  avg_price: string;
  spread: string;
  savings_percent: number;
  best_store: string;
  worst_store: string;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// The catalog is loaded ONCE per page load (GET /api/foods with no `limit` →
// the full array) and then sorted/filtered/paged entirely client-side. Measured
// at ~575 B/food, so a few thousand foods is a few hundred KB — cheap next to
// the round-trip-per-keystroke alternative, and it's the only way column sorting
// can be honest: server-side paging would sort just the rows already on screen.
const PAGE_SIZES = [25, 50, 100, 0] as const; // 0 = show all

// Sortable columns. `get` returns a comparable primitive (or null to sort last).
type SortKey = 'name' | 'category' | 'price' | 'stores' | 'kcal' | 'updated';

// A clickable, sort-indicating column header. The arrow shows only on the active
// column; inactive ones show a dimmed one on hover so the affordance is findable.
function SortHeader({ label, col, sortKey, sortDir, onSort, className = '', numeric = false }: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  className?: string;
  numeric?: boolean;
}) {
  const active = sortKey === col;
  return (
    <th className={`py-2.5 font-semibold ${className}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`group inline-flex items-center gap-1 uppercase tracking-wider text-[10px] transition ${
          active ? 'text-violet-300' : 'text-slate-500 hover:text-slate-300'
        } ${numeric ? 'justify-end' : ''}`}
      >
        {label}
        <span className={active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}>
          {active && sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

export default function Dashboard() {
  const router = useRouter();
  // State
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [efficiencies, setEfficiencies] = useState<PriceEfficiency[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [isLoading, setIsLoading] = useState(true);
  const [iconPickerFood, setIconPickerFood] = useState<FoodItem | null>(null);
  // Client-side table controls (see the PAGE_SIZES note above).
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState(0);
  // Extra filters the old card grid couldn't express.
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [onlySale, setOnlySale] = useState(false);

  // Forms State
  const [newFood, setNewFood] = useState({ name: '', barcode: '', description: '', category: 'Grocery', unit: 'each' });
  const [newStore, setNewStore] = useState({ name: '', location: '', logo_url: '' });
  const [scrapeRequest, setScrapeRequest] = useState({ storeId: '', query: '', postalCode: '' });
  const [cocowestRequest, setCocowestRequest] = useState({ storeId: '', url: '' });
  
  // Active selected food for detailed price history modal
  const [selectedFoodDetails, setSelectedFoodDetails] = useState<FoodItem | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceHistoryLog[]>([]);

  // The two shared popups (also used by diary/history/inbox).
  const [pricePopup, setPricePopup] = useState<{ log: PriceHistoryLog | null } | null>(null);
  const [showMacro, setShowMacro] = useState(false);

  // Known Names manager state (inside the food detail modal)
  const [editingChip, setEditingChip] = useState<'primary' | number | null>(null);
  const [chipDraft, setChipDraft] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [usableDraft, setUsableDraft] = useState(''); // editing selected food's usable_pct
  const [densityDraft, setDensityDraft] = useState(''); // editing selected food's density (kg/L)
  const [dragAliasId, setDragAliasId] = useState<number | null>(null);

  // Feedback notifications
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Trigger notification toast
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Stores + price-efficiency spreads: fetched once on mount, not paginated.
  const fetchStoresAndEfficiency = async () => {
    try {
      const storesRes = await fetch(`${API_BASE_URL}/api/stores`);
      const efficiencyRes = await fetch(`${API_BASE_URL}/api/prices/efficiency`);
      if (storesRes.ok) setStores(await storesRes.json());
      if (efficiencyRes.ok) setEfficiencies(await efficiencyRes.json());
    } catch (err) {
      console.error("Backend API not reachable:", err);
      showToast("Backend API not reachable. Failed to load dashboard data.", "error");
    }
  };

  // Load the WHOLE catalog once; searching/sorting/paging all happen locally.
  // Called again after any mutation (add food, price edit, icon change) to
  // refresh the cache.
  const fetchFoods = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods`);
      if (res.ok) setFoods(await res.json());
    } catch (err) {
      console.error("Backend API not reachable:", err);
      showToast("Backend API not reachable. Failed to load dashboard data.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStoresAndEfficiency();
  }, []);

  // Catalog is fetched once on mount (and after mutations) — no refetch on
  // filter/sort/page changes; those are all local now. No search debounce needed
  // either, since nothing hits the network as you type.
  useEffect(() => {
    fetchFoods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(0);
  }, [searchQuery, selectedCategory, onlyPriced, onlySale, pageSize, sortKey, sortDir]);

  // ── Derived table data (cache → filter → sort → page) ─────────────────────

  // Precompute the sortable/searchable fields once per catalog load so the
  // filter+sort passes stay cheap even at a few thousand rows.
  interface Row {
    food: FoodItem;
    best: { value: number; label: string } | null; // cheapest canonical unit price
    storeCount: number;
    hasSale: boolean;
    kcal: number | null;      // per 100 g/ml when convertible, else per serving
    kcalLabel: string;        // the basis that kcal is expressed in
    updated: number | null; // most recent price timestamp
    haystack: string;       // lowercased name + barcode + description + aliases
  }

  const rows = useMemo<Row[]>(() => foods.map(food => {
    const prices = food.latest_prices ?? [];
    let best: { value: number; label: string } | null = null;
    let updated: number | null = null;
    for (const p of prices) {
      const c = canonicalUnitPrice(
        Number(p.price),
        p.amount != null ? Number(p.amount) : null,
        p.amount_unit,
        food.density,
      );
      if (c && (best == null || c.value < best.value)) best = c;
      const t = new Date(p.scraped_at).getTime();
      if (!isNaN(t) && (updated == null || t > updated)) updated = t;
    }
    // The column reads per 100 g / 100 ml so rows are comparable regardless of
    // each label's serving; a serving that can't be converted (counted in
    // `each`) falls back to per-serving and says so in its title.
    const per100 = food.nutrition ? nutrientsPer100(food.nutrition, food.unit) : null;
    return {
      food,
      best,
      storeCount: new Set(prices.map(p => p.store_id)).size,
      hasSale: prices.some(p => p.is_sale),
      kcal: per100 ? per100.calories : food.nutrition ? Number(food.nutrition.calories) : null,
      kcalLabel: per100
        ? per100.label
        : food.nutrition
          ? `${Number(food.nutrition.serving_size)} ${food.nutrition.serving_unit}`
          : '',
      updated,
      haystack: [
        food.name, food.barcode ?? '', food.description ?? '',
        ...(food.aliases ?? []).map(a => a.alias),
      ].join(' ').toLowerCase(),
    };
  }), [foods]);

  // Category chips reflect what's actually in the loaded catalog.
  const categoryChips = useMemo(
    () => ['All'].concat(Array.from(new Set(foods.map(f => f.category).filter(Boolean))).sort()),
    [foods]
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter(r => {
      if (selectedCategory !== 'All' && r.food.category !== selectedCategory) return false;
      if (onlyPriced && r.storeCount === 0) return false;
      if (onlySale && !r.hasSale) return false;
      if (q && !r.haystack.includes(q)) return false;
      return true;
    });
  }, [rows, searchQuery, selectedCategory, onlyPriced, onlySale]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const value = (r: Row): string | number | null => {
      switch (sortKey) {
        case 'name': return r.food.name.toLowerCase();
        case 'category': return (r.food.category ?? '').toLowerCase();
        case 'price': return r.best ? r.best.value : null;
        case 'stores': return r.storeCount;
        case 'kcal': return r.kcal;
        case 'updated': return r.updated;
      }
    };
    // Copy before sorting — never mutate the memoized filter output.
    return [...filteredRows].sort((a, b) => {
      const av = value(a), bv = value(b);
      // Missing values always sort last, regardless of direction, so flipping a
      // column never fills the top of the table with blanks.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [filteredRows, sortKey, sortDir]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = pageSize === 0
    ? sortedRows
    : sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  // Clicking a header sorts by it; clicking the active one flips direction.
  // Text columns start ascending (A→Z); numeric ones start descending
  // (most expensive / most stores / newest first), which is what you usually want.
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(key);
    setSortDir(key === 'name' || key === 'category' ? 'asc' : 'desc');
  };

  // Fetch price details when food is selected
  const fetchPriceHistory = async (food: FoodItem) => {
    setSelectedFoodDetails(food);
    setPricePopup(null);
    setShowMacro(false);
    setNewAlias('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${food.id}/prices`);
      if (res.ok) {
        setPriceHistory(await res.json());
      } else {
        throw new Error("Failed to load price history");
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to retrieve price history.", "error");
      setPriceHistory([]);
    }
  };

  // ── Known Names (alias) management ────────────────────────────────────────

  // Refresh the current page + the open modal in sync after a name/fact mutation.
  // The two hit independent endpoints, so run them concurrently.
  const refreshSelectedFood = async (foodId: number) => {
    const [detail] = await Promise.all([
      fetch(`${API_BASE_URL}/api/foods/${foodId}`).then(res => (res.ok ? res.json() : null)).catch(() => null),
      fetchFoods(),
    ]);
    if (detail) setSelectedFoodDetails(detail);
  };

  const makePrimary = async (foodId: number, aliasId: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases/${aliasId}/make-primary`, { method: 'POST' });
      if (!res.ok) throw new Error();
      showToast('Primary name updated.');
      refreshSelectedFood(foodId);
    } catch { showToast('Failed to swap names.', 'error'); }
  };

  const saveChipRename = async (foodId: number) => {
    const text = chipDraft.trim();
    if (!text) { setEditingChip(null); return; }
    try {
      if (editingChip === 'primary') {
        const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: text }),
        });
        if (!res.ok) throw new Error();
      } else if (typeof editingChip === 'number') {
        const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases/${editingChip}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias: text }),
        });
        if (!res.ok) throw new Error();
      }
      setEditingChip(null);
      showToast('Name updated.');
      refreshSelectedFood(foodId);
    } catch { showToast('Rename failed.', 'error'); }
  };

  const deleteAlias = async (foodId: number, aliasId: number) => {
    try {
      await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases/${aliasId}`, { method: 'DELETE' });
      refreshSelectedFood(foodId);
    } catch { showToast('Failed to delete alias.', 'error'); }
  };

  const addAlias = async (foodId: number) => {
    const alias = newAlias.trim();
    if (!alias) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias }),
      });
      if (!res.ok) throw new Error();
      setNewAlias('');
      showToast('Name added.');
      refreshSelectedFood(foodId);
    } catch { showToast('Failed to add name.', 'error'); }
  };

  // ── Usable portion (foods.usable_pct) ─────────────────────────────────────
  // Keep the input in sync with the open food.
  useEffect(() => {
    if (selectedFoodDetails) setUsableDraft(String(Number(selectedFoodDetails.usable_pct ?? 100)));
  }, [selectedFoodDetails?.id, selectedFoodDetails?.usable_pct]);

  // Keep the density input in sync with the open food.
  useEffect(() => {
    if (selectedFoodDetails) setDensityDraft(String(Number(selectedFoodDetails.density ?? 1)));
  }, [selectedFoodDetails?.id, selectedFoodDetails?.density]);

  const saveUsablePct = async (foodId: number) => {
    const pct = Number(usableDraft);
    if (!(pct > 0)) { showToast('Usable % must be greater than 0.', 'error'); return; }
    if (selectedFoodDetails && pct === Number(selectedFoodDetails.usable_pct)) return; // no-op
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usable_pct: pct }),
      });
      if (!res.ok) throw new Error();
      showToast('Usable % updated.');
      refreshSelectedFood(foodId);
    } catch { showToast('Failed to update usable %.', 'error'); }
  };

  const saveDensity = async (foodId: number) => {
    const d = Number(densityDraft);
    if (!(d > 0)) { showToast('Density must be greater than 0.', 'error'); return; }
    if (selectedFoodDetails && d === Number(selectedFoodDetails.density)) return; // no-op
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ density: d }),
      });
      if (!res.ok) throw new Error();
      showToast('Density updated.');
      refreshSelectedFood(foodId);
    } catch { showToast('Failed to update density.', 'error'); }
  };

  // Nutrition facts are edited through the shared <MacroEditor> popup.

  // Add a food item via POST
  const handleAddFood = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFood.name) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/foods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newFood)
      });
      if (res.ok) {
        showToast(`Product "${newFood.name}" added successfully!`);
        setNewFood({ name: '', barcode: '', description: '', category: 'Grocery', unit: 'each' });
        fetchFoods();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to add food', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to add food. Connection error.", "error");
    }
  };

  // Add a store via POST
  const handleAddStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStore.name) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/stores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newStore)
      });
      if (res.ok) {
        showToast(`Store "${newStore.name}" registered successfully!`);
        setNewStore({ name: '', location: '', logo_url: '' });
        fetchStoresAndEfficiency();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to add store', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to register store. Connection error.", "error");
    }
  };

  // Trigger Flipp Flyer Scrape Job via POST
  const handleTriggerScraper = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scrapeRequest.storeId) {
      showToast('Please select a store to scrape', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/scrape/${scrapeRequest.storeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: scrapeRequest.query.trim() || undefined,
          postal_code: scrapeRequest.postalCode.trim() || undefined,
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Flyer scrape queued! Opening live progress…');
        setScrapeRequest({ storeId: '', query: '', postalCode: '' });
        // Jump to the progress page and auto-expand this run to watch it live.
        router.push(`/scrapes?job=${data.scrapeJobId}`);
      } else {
        showToast(data.error || 'Failed to queue scraper job', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to queue scraper job. Connection error.", "error");
    }
  };

  // Trigger a cocowest.ca Costco sale-post import via POST
  const handleTriggerCocowest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cocowestRequest.storeId || !cocowestRequest.url.trim()) {
      showToast('Choose a store and paste a cocowest.ca post URL', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/scrape-cocowest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: cocowestRequest.storeId,
          url: cocowestRequest.url.trim(),
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Costco sale post import queued! Opening live progress…');
        setCocowestRequest({ storeId: '', url: '' });
        router.push(`/scrapes?job=${data.scrapeJobId}`);
      } else {
        showToast(data.error || 'Failed to queue cocowest import', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to queue cocowest import. Connection error.", "error");
    }
  };

  // Static category list for the quick-add form (works even on an empty/fresh DB).
  const categories = ['All', 'Fruits', 'Vegetables', 'Dairy', 'Bakery', 'Pantry', 'Meat', 'Beverages', 'Other'];

  return (
    <div data-loc="page.dashboard" className="space-y-8 relative">

      {/* Toast Notification */}
      {notification && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 transition duration-300 transform translate-y-0 ${
          notification.type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'
        }`}>
          <div className={`w-2 h-2 rounded-full ${notification.type === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-sm font-semibold">{notification.message}</span>
        </div>
      )}

      {/* ═══ Section: Hero banner ═══ */}
      <div data-loc="dashboard.hero" className="card rounded-3xl p-6 lg:p-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-violet-600/10 rounded-full blur-3xl -z-10" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl -z-10" />
        
        <div className="max-w-2xl space-y-3">
          <h1 className="text-3xl lg:text-5xl font-extrabold tracking-tight bg-linear-to-r from-white via-slate-100 to-indigo-300 bg-clip-text text-transparent">
            Grocery Intelligence Panel
          </h1>
          <p className="text-slate-400 text-sm lg:text-base leading-relaxed">
            Monitor real-time grocery prices across multiple physical stores, audit historical changes, calculate unit efficiency spreads, and pull Flipp flyer deals to find maximum savings.
          </p>
        </div>
      </div>

      {/* ═══ Section: Summary Cards ═══ */}
      <div data-loc="dashboard.summary-cards" className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card p-6 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold uppercase text-slate-500 tracking-wider">Tracked Foods</span>
            <h3 className="text-3xl font-extrabold text-white mt-1">{foods.length}</h3>
            <p className="text-xs text-slate-400 mt-2">Active database items</p>
          </div>
          <div className="p-3 bg-violet-500/10 text-violet-400 rounded-xl">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
          </div>
        </div>

        <div className="card p-6 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold uppercase text-slate-500 tracking-wider">Stores Tracked</span>
            <h3 className="text-3xl font-extrabold text-white mt-1">{stores.length}</h3>
            <p className="text-xs text-slate-400 mt-2">Different supermarkets</p>
          </div>
          <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
        </div>

        <div className="card p-6 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold uppercase text-slate-500 tracking-wider">Average Spread Savings</span>
            <h3 className="text-3xl font-extrabold text-emerald-400 mt-1">
              {efficiencies.length > 0
                ? (efficiencies.reduce((acc, curr) => acc + parseFloat(curr.savings_percent as any), 0) / efficiencies.length).toFixed(1)
                : '42.4'}%
            </h3>
            <p className="text-xs text-slate-400 mt-2">Available price difference</p>
          </div>
          <div className="p-3 bg-amber-500/10 text-amber-400 rounded-xl">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* ═══ Section: Main grid — left = scrapers · efficiency · admin, right = inventory ═══ */}
      <div data-loc="dashboard.main-grid" className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* Left Column (Scraper controller and high discrepancy highlights) */}
        <div className="lg:col-span-1 space-y-8">

          {/* Dispatch Web Scraper Pipeline */}
          <div data-loc="dashboard.scraper-flipp" className="card p-6 space-y-4">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
              <h2 className="text-lg font-bold text-white">Scrape Flyer Deals</h2>
            </div>
            <p className="text-xs text-slate-400">
              Pulls the store&apos;s current Flipp flyer prices for your postal code. Leave the search blank to match every tracked food against the flyer.
            </p>
            
            <form onSubmit={handleTriggerScraper} className="space-y-3 pt-2">
              <div>
                <label className="field-label">Target Supermarket</label>
                <select 
                  value={scrapeRequest.storeId} 
                  onChange={(e) => setScrapeRequest({ ...scrapeRequest, storeId: e.target.value })}
                  className="field-input"
                >
                  <option value="">-- Choose a store --</option>
                  {stores.map(store => (
                    <option key={store.id} value={store.id}>{store.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">Flyer Search <span className="normal-case font-normal text-slate-500">(optional)</span></label>
                <input
                  type="text"
                  value={scrapeRequest.query}
                  onChange={(e) => setScrapeRequest({ ...scrapeRequest, query: e.target.value })}
                  placeholder="e.g. milk — blank scans all tracked foods"
                  className="field-input"
                />
              </div>

              <div>
                <label className="field-label">Postal Code <span className="normal-case font-normal text-slate-500">(optional)</span></label>
                <input
                  type="text"
                  value={scrapeRequest.postalCode}
                  onChange={(e) => setScrapeRequest({ ...scrapeRequest, postalCode: e.target.value })}
                  placeholder="V5A 3J2 (server default)"
                  className="field-input"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full py-2 duration-200"
              >
                Dispatch Flyer Scrape
              </button>
            </form>
            <a href="/scrapes" className="block text-center text-[11px] font-semibold text-violet-400 hover:text-violet-300 transition pt-1">
              View scraper activity →
            </a>
          </div>

          {/* Import a cocowest.ca Costco Sale Post */}
          <div data-loc="dashboard.scraper-cocowest" className="card p-6 space-y-4">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <h2 className="text-lg font-bold text-white">Import Costco Sale Post</h2>
            </div>
            <p className="text-xs text-slate-400">
              Paste a cocowest.ca &quot;weekend update&quot; post URL to log every sale item it lists against a Costco store.
            </p>

            <form onSubmit={handleTriggerCocowest} className="space-y-3 pt-2">
              <div>
                <label className="field-label">Store</label>
                <select
                  value={cocowestRequest.storeId}
                  onChange={(e) => setCocowestRequest({ ...cocowestRequest, storeId: e.target.value })}
                  className="field-input focus:border-emerald-500"
                >
                  <option value="">-- Choose a store --</option>
                  {stores.map(store => (
                    <option key={store.id} value={store.id}>{store.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">cocowest.ca Post URL</label>
                <input
                  type="text"
                  value={cocowestRequest.url}
                  onChange={(e) => setCocowestRequest({ ...cocowestRequest, url: e.target.value })}
                  placeholder="https://cocowest.ca/2026/07/weekend-update-..."
                  className="field-input focus:border-emerald-500"
                />
              </div>

              <button
                type="submit"
                className="w-full bg-linear-to-r from-emerald-600 to-teal-600 text-white rounded-xl py-2 text-sm font-semibold hover:shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98] transition duration-200"
              >
                Import Sale Post
              </button>
            </form>
          </div>

          {/* Price Efficiency Index Widget */}
          <div data-loc="dashboard.efficiency" className="card p-6 space-y-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              Price Efficiency Spread
            </h2>
            <p className="text-xs text-slate-400">
              Discrepancy audit. Save by buying these items at the optimized store.
            </p>

            <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
              {efficiencies.length === 0 ? (
                <div className="text-center text-xs text-slate-500 py-6">No price spreads found yet. Add price logs for multiple stores.</div>
              ) : (
                efficiencies.map(eff => (
                  <div key={eff.food_id} className="panel p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between items-start">
                      <span className="font-semibold text-slate-200">{eff.food_name}</span>
                      <span className="px-1.5 py-0.5 rounded-sm bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold font-mono">
                        +{parseFloat(eff.savings_percent as any).toFixed(0)}% Spread
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 pt-1">
                      <div className="bg-emerald-950/20 p-1.5 rounded-sm border border-emerald-500/10">
                        <span className="block text-slate-500 font-medium">BEST PRICE</span>
                        <span className="font-semibold text-emerald-400 font-mono">${parseFloat(eff.min_price).toFixed(2)}</span>
                        <span className="block text-slate-400 truncate">{eff.best_store}</span>
                      </div>
                      <div className="bg-rose-950/20 p-1.5 rounded-sm border border-rose-500/10">
                        <span className="block text-slate-500 font-medium">WORST PRICE</span>
                        <span className="font-semibold text-rose-400 font-mono">${parseFloat(eff.max_price).toFixed(2)}</span>
                        <span className="block text-slate-400 truncate">{eff.worst_store}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          
          {/* Quick Add Forms panels */}
          <div data-loc="dashboard.admin" className="card p-6 space-y-4">
            <h2 className="text-lg font-bold text-white">Administration</h2>
            
            <div className="border-t border-white/5 pt-3">
              <span className="text-xs font-semibold text-violet-400 block mb-2">Register New Store</span>
              <form onSubmit={handleAddStore} className="space-y-2">
                <input 
                  type="text" 
                  value={newStore.name} 
                  onChange={(e) => setNewStore({ ...newStore, name: e.target.value })}
                  placeholder="Store Name" 
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-hidden" 
                />
                <input 
                  type="text" 
                  value={newStore.location} 
                  onChange={(e) => setNewStore({ ...newStore, location: e.target.value })}
                  placeholder="Location / Neighborhood" 
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-hidden" 
                />
                <button type="submit" className="w-full bg-white/5 border border-white/10 rounded-lg py-1.5 text-xs font-semibold hover:bg-white/10 transition text-white">
                  Add Store
                </button>
              </form>
            </div>
          </div>

        </div>

        {/* Right Column: Inventory database logs */}
        <div data-loc="dashboard.inventory" className="lg:col-span-2 space-y-6">
          
          {/* Filtering and search header */}
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            {/* Search Input */}
            <div className="relative w-full sm:max-w-xs">
              <svg className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search name, barcode, alias..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900 border border-white/5 rounded-2xl pl-10 pr-8 py-2.5 text-sm text-white focus:outline-hidden focus:border-violet-500 transition"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-sm"
                >
                  ×
                </button>
              )}
            </div>

            {/* Quick filters the card grid couldn't express */}
            <div className="flex items-center gap-3 shrink-0">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" checked={onlyPriced} onChange={e => setOnlyPriced(e.target.checked)} className="accent-violet-500" />
                Has price
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" checked={onlySale} onChange={e => setOnlySale(e.target.checked)} className="accent-amber-500" />
                On sale
              </label>
            </div>

            {/* Category Filter */}
            <div className="flex items-center space-x-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
              {categoryChips.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
                    selectedCategory === cat
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-slate-900/50 border-white/5 text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Add Food Input */}
          <form onSubmit={handleAddFood} className="p-4 bg-slate-900/40 border border-white/5 rounded-2xl flex flex-col md:flex-row gap-3">
            <input 
              type="text" 
              placeholder="Add product (e.g. Fresh Gala Apples)" 
              value={newFood.name}
              onChange={(e) => setNewFood({ ...newFood, name: e.target.value })}
              className="flex-1 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden"
            />
            <input 
              type="text" 
              placeholder="Barcode (Optional)" 
              value={newFood.barcode}
              onChange={(e) => setNewFood({ ...newFood, barcode: e.target.value })}
              className="w-full md:w-32 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden"
            />
            <select
              value={newFood.category}
              onChange={(e) => setNewFood({ ...newFood, category: e.target.value })}
              className="bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden"
            >
              {categories.filter(c => c !== 'All').map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input 
              type="text" 
              placeholder="Unit (e.g. lb)" 
              value={newFood.unit}
              onChange={(e) => setNewFood({ ...newFood, unit: e.target.value })}
              className="w-full md:w-20 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden"
            />
            <button type="submit" className="bg-violet-600 hover:bg-violet-500 text-white rounded-xl px-4 py-2 text-xs font-semibold transition">
              Quick Add
            </button>
          </form>

          {/* ═══ Section: Inventory table ═══ */}
          <div data-loc="dashboard.inventory-table" className="card rounded-2xl overflow-hidden">
            {isLoading ? (
              <div className="text-center text-slate-500 py-12">Loading catalog…</div>
            ) : sortedRows.length === 0 ? (
              <div className="text-center text-slate-500 py-12">
                {foods.length === 0 ? 'No foods in the catalog yet.' : 'No foods match these filters.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-slate-950/95 backdrop-blur-sm z-10">
                    <tr className="text-slate-500 border-b border-white/10">
                      <th className="py-2.5 pl-4 pr-2 w-12" />
                      <SortHeader label="Product" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="pr-3" />
                      <SortHeader label="Category" col="category" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 hidden sm:table-cell" />
                      <SortHeader label="Best price" col="price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3" numeric />
                      <SortHeader label="Stores" col="stores" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 hidden md:table-cell" numeric />
                      <SortHeader label="kcal /100" col="kcal" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 hidden lg:table-cell" numeric />
                      <SortHeader label="Last price" col="updated" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 hidden lg:table-cell" numeric />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map(({ food, best, storeCount, hasSale, kcal, kcalLabel, updated }) => {
                      const cheapest = (food.latest_prices ?? []).find(p => {
                        const c = canonicalUnitPrice(Number(p.price), p.amount != null ? Number(p.amount) : null, p.amount_unit, food.density);
                        return best != null && c != null && c.value === best.value;
                      });
                      return (
                        <tr
                          key={food.id}
                          onClick={() => fetchPriceHistory(food)}
                          className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition"
                        >
                          {/* Icon — click opens the picker, not the row detail */}
                          <td className="py-2 pl-4 pr-2">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setIconPickerFood(food); }}
                              title="Change icon"
                              className="w-9 h-9 rounded-lg overflow-hidden border border-white/10 bg-slate-800/50 flex items-center justify-center hover:border-violet-500/50 transition"
                            >
                              {food.display_image_id ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={`${API_BASE_URL}/api/images/${food.display_image_id}`} alt="" loading="lazy" className="w-full h-full object-cover" />
                              ) : (
                                <svg className="w-4 h-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </td>

                          {/* Product */}
                          <td className="py-2 pr-3 min-w-[180px]">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-white truncate max-w-[240px]">{food.name}</span>
                              {hasSale && (
                                <span className="badge text-[9px] text-amber-400 bg-amber-500/10 border-amber-500/20 shrink-0">sale</span>
                              )}
                              {Number(food.usable_pct) !== 100 && (
                                <span className="badge text-[9px] text-amber-400 bg-amber-500/10 border-amber-500/20 shrink-0" title="Usable portion of what you buy">
                                  {Number(food.usable_pct)}%
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[240px] sm:hidden">{food.category}</div>
                          </td>

                          {/* Category */}
                          <td className="px-3 hidden sm:table-cell">
                            <span className="badge text-[9px] text-violet-400 bg-violet-500/10 border-violet-500/20">{food.category}</span>
                          </td>

                          {/* Best (cheapest canonical) price */}
                          <td className="px-3 whitespace-nowrap">
                            {best ? (
                              <>
                                <span className="font-mono font-bold text-white">${best.value.toFixed(2)}</span>
                                <span className="text-slate-500">/{best.label}</span>
                                {cheapest && <div className="text-[10px] text-slate-500 truncate max-w-[130px]">{cheapest.store_name}</div>}
                              </>
                            ) : (food.latest_prices?.length ? (
                              <span className="font-mono text-slate-400">${Number(food.latest_prices[0].price).toFixed(2)}<span className="text-slate-600">/{food.unit}</span></span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            ))}
                          </td>

                          {/* Stores */}
                          <td className="px-3 hidden md:table-cell font-mono text-slate-300">{storeCount || <span className="text-slate-600">—</span>}</td>

                          {/* kcal — per 100 g/ml where convertible (see rows memo) */}
                          <td className="px-3 hidden lg:table-cell font-mono text-slate-300">
                            {kcal != null ? (
                              <span title={`${Math.round(kcal)} kcal per ${kcalLabel}`}>
                                {Math.round(kcal)}
                                <span className="text-[9px] text-slate-600"> /{kcalLabel.replace(/^100 /, '')}</span>
                              </span>
                            ) : <span className="text-slate-600">—</span>}
                          </td>

                          {/* Last price date */}
                          <td className="px-3 hidden lg:table-cell text-[10px] text-slate-500 whitespace-nowrap">
                            {updated != null ? new Date(updated).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ═══ Section: Table footer — result count, page size, paging ═══ */}
          {!isLoading && sortedRows.length > 0 && (
            <div data-loc="dashboard.table-footer" className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <span className="text-xs text-slate-500">
                {sortedRows.length === foods.length
                  ? `${foods.length} foods`
                  : `${sortedRows.length} of ${foods.length} foods`}
                {pageSize !== 0 && totalPages > 1 && ` · page ${safePage + 1} of ${totalPages}`}
              </span>
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={e => setPageSize(Number(e.target.value))}
                  className="bg-slate-900 border border-white/5 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-hidden focus:border-violet-500"
                >
                  {PAGE_SIZES.map(s => (
                    <option key={s} value={s}>{s === 0 ? 'Show all' : `${s} / page`}</option>
                  ))}
                </select>
                {pageSize !== 0 && totalPages > 1 && (
                  <>
                    <button
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={safePage === 0}
                      className="px-3 py-1 rounded-lg text-xs font-medium border border-white/5 bg-slate-900/50 text-slate-300 hover:bg-white/5 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={safePage >= totalPages - 1}
                      className="px-3 py-1 rounded-lg text-xs font-medium border border-white/5 bg-slate-900/50 text-slate-300 hover:bg-white/5 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

        </div>

      </div>

      {/* ═══ Section: Food detail modal (data-loc="modal.price-history") — price history + SVG trend + known names + facts ═══ */}
      {selectedFoodDetails && (
        <Modal
          onClose={() => setSelectedFoodDetails(null)}
          maxWidth="max-w-2xl"
          dataLoc="modal.price-history"
        >
            <div className="flex items-start gap-4">
              {/* Food photo — same display_image_id the dashboard row shows;
                  click opens the shared icon picker, as it does in the table. */}
              <button
                type="button"
                onClick={() => setIconPickerFood(selectedFoodDetails)}
                title="Change icon"
                className="w-20 h-20 shrink-0 rounded-2xl overflow-hidden border border-white/10 bg-slate-800/50 flex items-center justify-center hover:border-violet-500/50 transition"
              >
                {selectedFoodDetails.display_image_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`${API_BASE_URL}/api/images/${selectedFoodDetails.display_image_id}`} alt="" loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <svg className="w-7 h-7 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
              <div className="min-w-0">
                <span className="badge text-[10px] text-violet-400 bg-violet-500/10 border-violet-500/20">
                  {selectedFoodDetails.category}
                </span>
                <h2 className="text-2xl font-extrabold text-white mt-1.5">{selectedFoodDetails.name}</h2>
                <p className="text-xs text-slate-400 mt-1">Barcode: {selectedFoodDetails.barcode || 'N/A'}</p>
              </div>
            </div>

            {/* Known Names: primary + learned aliases. Drag an alias onto the
                primary chip to make it the primary name; click any chip to rename. */}
            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Known Names <span className="normal-case font-normal">— drag to front to make primary · click to rename</span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {/* Primary chip (drop target) */}
                {editingChip === 'primary' ? (
                  <input
                    autoFocus
                    value={chipDraft}
                    onChange={e => setChipDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveChipRename(selectedFoodDetails.id); if (e.key === 'Escape') setEditingChip(null); }}
                    onBlur={() => saveChipRename(selectedFoodDetails.id)}
                    className="bg-slate-900 border border-violet-500/50 text-white text-xs font-bold rounded-full px-3 py-1 focus:outline-hidden w-44"
                  />
                ) : (
                  <button
                    onClick={() => { setEditingChip('primary'); setChipDraft(selectedFoodDetails.name); }}
                    onDragOver={e => { if (dragAliasId != null) { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-violet-400'); } }}
                    onDragLeave={e => e.currentTarget.classList.remove('ring-2', 'ring-violet-400')}
                    onDrop={e => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('ring-2', 'ring-violet-400');
                      if (dragAliasId != null) makePrimary(selectedFoodDetails.id, dragAliasId);
                      setDragAliasId(null);
                    }}
                    title="Primary name — click to rename, or drop an alias here to swap"
                    className="text-xs font-bold text-white bg-violet-600/40 border border-violet-500/50 rounded-full px-3 py-1 hover:bg-violet-600/60 transition cursor-text"
                  >
                    ★ {selectedFoodDetails.name}
                  </button>
                )}

                {/* Alias chips (draggable) */}
                {(selectedFoodDetails.aliases ?? []).map(a => (
                  editingChip === a.id ? (
                    <input
                      key={a.id}
                      autoFocus
                      value={chipDraft}
                      onChange={e => setChipDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveChipRename(selectedFoodDetails.id); if (e.key === 'Escape') setEditingChip(null); }}
                      onBlur={() => saveChipRename(selectedFoodDetails.id)}
                      className="bg-slate-900 border border-sky-500/50 text-white text-xs rounded-full px-3 py-1 focus:outline-hidden w-40"
                    />
                  ) : (
                    <span
                      key={a.id}
                      draggable
                      onDragStart={() => setDragAliasId(a.id)}
                      onDragEnd={() => setDragAliasId(null)}
                      className="group flex items-center gap-1.5 text-xs text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-full px-3 py-1 cursor-grab active:cursor-grabbing hover:bg-sky-500/20 transition"
                    >
                      <button onClick={() => { setEditingChip(a.id); setChipDraft(a.alias); }} className="cursor-text" title="Click to rename">
                        {a.alias}
                      </button>
                      <button
                        onClick={() => deleteAlias(selectedFoodDetails.id, a.id)}
                        title="Forget this name"
                        className="text-sky-500/50 hover:text-rose-400 transition"
                      >
                        ×
                      </button>
                    </span>
                  )
                ))}
                {(selectedFoodDetails.aliases ?? []).length === 0 && (
                  <span className="text-[10px] text-slate-600">No learned aliases yet — verified scan matches are remembered here.</span>
                )}
              </div>
              {/* Add a new known name directly from the dashboard */}
              <div className="flex gap-2 pt-1">
                <input
                  value={newAlias}
                  onChange={e => setNewAlias(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addAlias(selectedFoodDetails.id); }}
                  placeholder="Add another name for this food…"
                  className="flex-1 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-hidden focus:border-sky-500"
                />
                <button onClick={() => addAlias(selectedFoodDetails.id)} className="px-3 py-1.5 rounded-lg bg-sky-600/20 border border-sky-500/30 text-sky-300 text-xs font-semibold hover:bg-sky-600/30 transition">
                  Add Name
                </button>
              </div>
            </div>

            {/* Nutrition Facts — edited via the shared MacroEditor popup */}
            <div className="panel rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">
                  Nutrition Facts <span className="text-slate-600 font-normal">— per serving, feeds the Food Diary</span>
                </span>
                <button
                  onClick={() => setShowMacro(true)}
                  className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition"
                >
                  {selectedFoodDetails.nutrition ? 'Edit Facts' : '+ Add Facts'}
                </button>
              </div>
              {selectedFoodDetails.nutrition ? (
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono font-bold">
                    {Math.round(Number(selectedFoodDetails.nutrition.calories))} kcal
                    <span className="font-normal text-emerald-400/60"> / {Number(selectedFoodDetails.nutrition.serving_size)} {selectedFoodDetails.nutrition.serving_unit}</span>
                  </span>
                  {/* Comparable basis: per 100 g (solid) / 100 ml (liquid) */}
                  {(() => {
                    const per100 = nutrientsPer100(selectedFoodDetails.nutrition, selectedFoodDetails.unit);
                    if (!per100) return null;
                    return (
                      <span className="px-2.5 py-1 rounded-lg bg-slate-500/10 border border-white/10 text-slate-300 font-mono font-bold" title="Comparable basis across foods">
                        {Math.round(per100.calories)} kcal
                        <span className="font-normal text-slate-500"> / {per100.label}</span>
                      </span>
                    );
                  })()}
                  {selectedFoodDetails.nutrition.source === 'usda' && (
                    <span className="px-2.5 py-1 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 text-[10px] font-bold uppercase tracking-wider" title="Fetched from USDA FoodData Central">
                      USDA
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-slate-600">
                  No nutrition facts yet — add the label values so this food can be logged in the Food Diary by amount.
                </p>
              )}
            </div>

            {/* Usable portion — scales prices into an effective cost per usable unit */}
            <div className="panel rounded-2xl p-4 space-y-2">
              <span className="text-xs font-semibold text-slate-400 block">
                Usable Portion <span className="text-slate-600 font-normal">— % of what you buy that's actually usable</span>
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="number" min="1" step="1"
                  value={usableDraft}
                  onChange={e => setUsableDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveUsablePct(selectedFoodDetails.id); }}
                  onBlur={() => saveUsablePct(selectedFoodDetails.id)}
                  className="w-24 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-hidden focus:border-violet-500"
                />
                <span className="text-xs text-slate-500">% usable</span>
                <span className="text-[10px] text-slate-600">e.g. 70 = 30% bone/waste · &gt;100 for dry goods that expand</span>
              </div>
            </div>

            {/* Density — only for foods sold by volume; converts per-volume prices to per-kg */}
            {normalizeUnit(selectedFoodDetails.unit)?.dimension === 'volume' && (
              <div className="panel rounded-2xl p-4 space-y-2">
                <span className="text-xs font-semibold text-slate-400 block">
                  Density <span className="text-slate-600 font-normal">— kg per litre, to show volume prices per kg</span>
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="number" min="0.01" step="0.01"
                    value={densityDraft}
                    onChange={e => setDensityDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveDensity(selectedFoodDetails.id); }}
                    onBlur={() => saveDensity(selectedFoodDetails.id)}
                    className="w-24 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-hidden focus:border-violet-500"
                  />
                  <span className="text-xs text-slate-500">kg/L</span>
                  <span className="text-[10px] text-slate-600">water ≈ 1 · oil ≈ 0.92 · honey ≈ 1.42</span>
                </div>
              </div>
            )}

            {/* Price Trend Graphic: Custom SVG visualization */}
            <div className="panel rounded-2xl p-4">
              <span className="text-xs font-semibold text-slate-400 block mb-3">Price Trend History</span>
              
              {priceHistory.length > 1 ? (
                <div className="relative h-40 w-full pt-6">
                  {/* Grid Lines */}
                  <div className="absolute inset-0 flex flex-col justify-between text-[9px] text-slate-600 pointer-events-none">
                    <div className="border-b border-white/5 w-full pb-1">High Price</div>
                    <div className="border-b border-white/5 w-full" />
                    <div className="border-b border-white/5 w-full" />
                    <div className="w-full pt-1">Low Price</div>
                  </div>

                  {/* Draw an SVG chart based on price points */}
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.4"/>
                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.0"/>
                      </linearGradient>
                    </defs>
                    {(() => {
                      const prices = priceHistory.map(p => Number(p.price));
                      const min = Math.min(...prices) * 0.9;
                      const max = Math.max(...prices) * 1.1;
                      const range = max - min || 1;

                      const points = priceHistory.map((p, idx) => {
                        const x = (idx / (priceHistory.length - 1)) * 100;
                        const y = 100 - ((Number(p.price) - min) / range) * 80 - 10; // offset slightly
                        return `${x},${y}`;
                      }).join(' ');

                      const areaPoints = `0,100 ${points} 100,100`;

                      return (
                        <>
                          <polygon points={areaPoints} fill="url(#chartGrad)" />
                          <polyline points={points} fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
                          
                          {/* Data points dots */}
                          {priceHistory.map((p, idx) => {
                            const x = (idx / (priceHistory.length - 1)) * 100;
                            const y = 100 - ((Number(p.price) - min) / range) * 80 - 10;
                            return (
                              <circle key={idx} cx={x} cy={y} r="2" fill="#a78bfa" className="cursor-pointer hover:r-3 transition-all" />
                            );
                          })}
                        </>
                      );
                    })()}
                  </svg>

                  {/* Dates label overlay */}
                  <div className="absolute bottom-1 left-0 right-0 flex justify-between text-[8px] text-slate-500 px-1 font-mono">
                    <span>Older Scrapes</span>
                    <span>Recent Scrapes</span>
                  </div>
                </div>
              ) : (
                <div className="h-40 flex items-center justify-center text-xs text-slate-500 font-mono bg-slate-950/20 rounded-xl">
                  Not enough historical price points to render trend line.
                </div>
              )}
            </div>

            {/* Price log table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Historical Log Readings</h4>
                <button onClick={() => setPricePopup({ log: null })} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition">+ Add Price</button>
              </div>

              <div className="max-h-56 overflow-y-auto pr-1">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-500">
                      <th className="py-2">Supermarket</th>
                      <th className="py-2">Price</th>
                      <th className="py-2">Scraped At</th>
                      <th className="py-2 text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceHistory.map(log => (
                      <tr key={log.id} className="border-b border-white/5 hover:bg-white/5 text-slate-300">
                        <td className="py-2.5 font-medium">{log.store_name}</td>
                        <td className="py-2.5 font-mono font-bold text-white">${parseFloat(log.price as any).toFixed(2)}</td>
                        <td className="py-2.5 text-[10px] text-slate-500">{new Date(log.scraped_at).toLocaleDateString()} at {new Date(log.scraped_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                        <td className="py-2.5 text-right">
                          <button onClick={() => setPricePopup({ log })} className="text-[11px] font-bold text-violet-400 hover:text-violet-300">Edit</button>
                        </td>
                      </tr>
                    ))}
                    {priceHistory.length === 0 && (
                      <tr><td colSpan={4} className="py-4 text-center text-slate-600">No price logs for this food.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => setSelectedFoodDetails(null)}
                className="w-full bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl py-2.5 text-xs text-white font-semibold transition"
              >
                Close Audit Dialog
              </button>
            </div>
        </Modal>
      )}

      {/* Shared price popup (add or edit) */}
      {pricePopup && selectedFoodDetails && (
        <PriceEditor
          foodId={selectedFoodDetails.id}
          foodName={selectedFoodDetails.name}
          log={pricePopup.log}
          stores={stores}
          usablePct={selectedFoodDetails.usable_pct}
          density={selectedFoodDetails.density}
          onClose={() => setPricePopup(null)}
          onSaved={() => { setPricePopup(null); fetchPriceHistory(selectedFoodDetails); fetchFoods(); }}
          onDeleted={() => { setPricePopup(null); fetchPriceHistory(selectedFoodDetails); fetchFoods(); }}
        />
      )}

      {/* Shared macros popup */}
      {showMacro && selectedFoodDetails && (
        <MacroEditor
          foodId={selectedFoodDetails.id}
          foodName={selectedFoodDetails.name}
          barcode={selectedFoodDetails.barcode}
          nutrition={selectedFoodDetails.nutrition}
          onClose={() => setShowMacro(false)}
          onSaved={() => { setShowMacro(false); refreshSelectedFood(selectedFoodDetails.id); fetchFoods(); }}
        />
      )}

      {/* Food icon picker (pick saved image / upload, then crop) */}
      {iconPickerFood && (
        <FoodIconPicker
          foodId={iconPickerFood.id}
          foodName={iconPickerFood.name}
          ownImageId={iconPickerFood.image_id}
          onClose={() => setIconPickerFood(null)}
          onSaved={() => {
            const id = iconPickerFood.id;
            setIconPickerFood(null);
            // Refresh the open detail modal too, so its photo updates in place.
            if (selectedFoodDetails?.id === id) refreshSelectedFood(id); else fetchFoods();
          }}
        />
      )}

    </div>
  );
}
