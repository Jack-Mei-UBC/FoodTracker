"use client";

import React, { useState, useEffect } from 'react';
import { NutritionFacts } from '../lib/nutrition';
import PriceEditor from '../components/PriceEditor';
import MacroEditor from '../components/MacroEditor';

// Interfaces based on database schema
interface LatestPrice {
  price: number;
  unit_price: number;
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

export default function Dashboard() {
  // State
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [efficiencies, setEfficiencies] = useState<PriceEfficiency[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [isLoading, setIsLoading] = useState(true);

  // Forms State
  const [newFood, setNewFood] = useState({ name: '', barcode: '', description: '', category: 'Grocery', unit: 'each' });
  const [newStore, setNewStore] = useState({ name: '', location: '', logo_url: '' });
  const [scrapeRequest, setScrapeRequest] = useState({ storeId: '', url: '' });
  
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
  const [dragAliasId, setDragAliasId] = useState<number | null>(null);

  // Feedback notifications
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Trigger notification toast
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Fetch all dashboard data
  const fetchData = async () => {
    setIsLoading(true);
    try {
      // Fetch foods, stores and price spreads
      const foodsRes = await fetch(`${API_BASE_URL}/api/foods`);
      const storesRes = await fetch(`${API_BASE_URL}/api/stores`);
      const efficiencyRes = await fetch(`${API_BASE_URL}/api/prices/efficiency`);

      if (foodsRes.ok) setFoods(await foodsRes.json());
      if (storesRes.ok) setStores(await storesRes.json());
      if (efficiencyRes.ok) setEfficiencies(await efficiencyRes.json());
    } catch (err) {
      console.error("Backend API not reachable:", err);
      showToast("Backend API not reachable. Failed to load dashboard data.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

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

  // Refresh the foods list and keep the open modal in sync after a name mutation.
  const refreshSelectedFood = async (foodId: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods`);
      if (!res.ok) return;
      const list: FoodItem[] = await res.json();
      setFoods(list);
      const fresh = list.find(f => f.id === foodId);
      if (fresh) setSelectedFoodDetails(fresh);
    } catch { /* transient */ }
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
        fetchData();
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
        fetchData();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to add store', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to register store. Connection error.", "error");
    }
  };

  // Trigger Scraper Job via POST
  const handleTriggerScraper = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scrapeRequest.storeId || !scrapeRequest.url) {
      showToast('Please select a store and enter a valid URL', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/scrape/${scrapeRequest.storeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeRequest.url })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Scrape job queued! Job ID: ${data.jobId}`);
        setScrapeRequest({ storeId: '', url: '' });
        // Auto-refresh in 4s to see new logs
        setTimeout(fetchData, 4000);
      } else {
        showToast(data.error || 'Failed to queue scraper job', 'error');
      }
    } catch (err: any) {
      console.error(err);
      showToast("Failed to queue scraper job. Connection error.", "error");
    }
  };

  // Categories list
  const categories = ['All', 'Fruits', 'Vegetables', 'Dairy', 'Bakery', 'Pantry', 'Meat', 'Beverages', 'Other'];

  // Filter foods list
  const filteredFoods = foods.filter(food => {
    const matchesSearch = food.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          (food.description && food.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (food.barcode && food.barcode.includes(searchQuery));
    const matchesCategory = selectedCategory === 'All' || food.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="space-y-8 animate-slide-up relative">
      
      {/* Toast Notification */}
      {notification && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 transition duration-300 transform translate-y-0 ${
          notification.type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'
        }`}>
          <div className={`w-2 h-2 rounded-full ${notification.type === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-sm font-semibold">{notification.message}</span>
        </div>
      )}

      {/* Hero Welcome banner */}
      <div className="rounded-3xl p-6 lg:p-10 relative overflow-hidden glass-panel border border-white/5">
        <div className="absolute top-0 right-0 w-80 h-80 bg-violet-600/10 rounded-full blur-3xl -z-10" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl -z-10" />
        
        <div className="max-w-2xl space-y-3">
          <h1 className="text-3xl lg:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-100 to-indigo-300 bg-clip-text text-transparent">
            Grocery Intelligence Panel
          </h1>
          <p className="text-slate-400 text-sm lg:text-base leading-relaxed">
            Monitor real-time grocery prices across multiple physical stores, audit historical changes, calculate unit efficiency spreads, and dispatch Playwright scraping pipelines to find maximum savings.
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="rounded-2xl p-6 glass-panel glass-panel-hover flex items-center justify-between">
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

        <div className="rounded-2xl p-6 glass-panel glass-panel-hover flex items-center justify-between">
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

        <div className="rounded-2xl p-6 glass-panel glass-panel-hover flex items-center justify-between">
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

      {/* Main Grid: Left = Scraper & Price Efficiency, Right = Main inventory search list */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Column (Scraper controller and high discrepancy highlights) */}
        <div className="lg:col-span-1 space-y-8">
          
          {/* Dispatch Web Scraper Pipeline */}
          <div className="rounded-2xl p-6 glass-panel border border-white/5 space-y-4">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
              <h2 className="text-lg font-bold text-white">Scrape Store Prices</h2>
            </div>
            <p className="text-xs text-slate-400">
              Schedule a Playwright crawler. Input a grocery catalog URL to extract listings and update DB values.
            </p>
            
            <form onSubmit={handleTriggerScraper} className="space-y-3 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Target Supermarket</label>
                <select 
                  value={scrapeRequest.storeId} 
                  onChange={(e) => setScrapeRequest({ ...scrapeRequest, storeId: e.target.value })}
                  className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 transition"
                >
                  <option value="">-- Choose a store --</option>
                  {stores.map(store => (
                    <option key={store.id} value={store.id}>{store.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Catalog URL</label>
                <input 
                  type="text" 
                  value={scrapeRequest.url}
                  onChange={(e) => setScrapeRequest({ ...scrapeRequest, url: e.target.value })}
                  placeholder="e.g. https://supermarket.com/offers"
                  className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 placeholder-slate-600 transition"
                />
              </div>

              <button 
                type="submit"
                className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl py-2 text-sm font-semibold hover:shadow-lg hover:shadow-indigo-500/20 active:scale-[0.98] transition duration-200"
              >
                Dispatch Crawler Job
              </button>
            </form>
          </div>

          {/* Price Efficiency Index Widget */}
          <div className="rounded-2xl p-6 glass-panel border border-white/5 space-y-4">
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
                  <div key={eff.food_id} className="p-3 bg-slate-950/60 rounded-xl border border-white/5 space-y-1.5 text-xs">
                    <div className="flex justify-between items-start">
                      <span className="font-semibold text-slate-200">{eff.food_name}</span>
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold font-mono">
                        +{parseFloat(eff.savings_percent as any).toFixed(0)}% Spread
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 pt-1">
                      <div className="bg-emerald-950/20 p-1.5 rounded border border-emerald-500/10">
                        <span className="block text-slate-500 font-medium">BEST PRICE</span>
                        <span className="font-semibold text-emerald-400 font-mono">${parseFloat(eff.min_price).toFixed(2)}</span>
                        <span className="block text-slate-400 truncate">{eff.best_store}</span>
                      </div>
                      <div className="bg-rose-950/20 p-1.5 rounded border border-rose-500/10">
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
          <div className="rounded-2xl p-6 glass-panel border border-white/5 space-y-4">
            <h2 className="text-lg font-bold text-white">Administration</h2>
            
            <div className="border-t border-white/5 pt-3">
              <span className="text-xs font-semibold text-violet-400 block mb-2">Register New Store</span>
              <form onSubmit={handleAddStore} className="space-y-2">
                <input 
                  type="text" 
                  value={newStore.name} 
                  onChange={(e) => setNewStore({ ...newStore, name: e.target.value })}
                  placeholder="Store Name" 
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none" 
                />
                <input 
                  type="text" 
                  value={newStore.location} 
                  onChange={(e) => setNewStore({ ...newStore, location: e.target.value })}
                  placeholder="Location / Neighborhood" 
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none" 
                />
                <button type="submit" className="w-full bg-white/5 border border-white/10 rounded-lg py-1.5 text-xs font-semibold hover:bg-white/10 transition text-white">
                  Add Store
                </button>
              </form>
            </div>
          </div>

        </div>

        {/* Right Column: Inventory database logs */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Filtering and search header */}
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            {/* Search Input */}
            <div className="relative w-full sm:max-w-xs">
              <svg className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input 
                type="text"
                placeholder="Search food items, barcode..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900 border border-white/5 rounded-2xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition"
              />
            </div>

            {/* Category Filter */}
            <div className="flex items-center space-x-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
              {categories.slice(0, 6).map(cat => (
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
              className="flex-1 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
            />
            <input 
              type="text" 
              placeholder="Barcode (Optional)" 
              value={newFood.barcode}
              onChange={(e) => setNewFood({ ...newFood, barcode: e.target.value })}
              className="w-full md:w-32 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
            />
            <select
              value={newFood.category}
              onChange={(e) => setNewFood({ ...newFood, category: e.target.value })}
              className="bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
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
              className="w-full md:w-20 bg-slate-950 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
            />
            <button type="submit" className="bg-violet-600 hover:bg-violet-500 text-white rounded-xl px-4 py-2 text-xs font-semibold transition">
              Quick Add
            </button>
          </form>

          {/* Foods list cards */}
          {isLoading ? (
            <div className="text-center text-slate-500 py-12">Querying database...</div>
          ) : filteredFoods.length === 0 ? (
            <div className="text-center text-slate-500 py-12">No foods match search criteria.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredFoods.map(food => (
                <div 
                  key={food.id} 
                  onClick={() => fetchPriceHistory(food)}
                  className="rounded-2xl p-5 glass-panel glass-panel-hover border border-white/5 space-y-4 cursor-pointer text-left relative"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full border border-violet-500/20">
                        {food.category}
                      </span>
                      <h3 className="text-lg font-bold text-white mt-1.5">{food.name}</h3>
                      <p className="text-xs text-slate-400 mt-1 line-clamp-1">{food.description || `Fresh tracked items per ${food.unit}`}</p>
                    </div>
                  </div>

                  {/* Prices comparison widget */}
                  <div className="space-y-2 border-t border-white/5 pt-3">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider block font-semibold">Current price readings</span>
                    
                    <div className="space-y-1.5">
                      {food.latest_prices && food.latest_prices.length > 0 ? (
                        food.latest_prices.map((p, idx) => (
                          <div key={idx} className="flex justify-between items-center text-xs">
                            <span className="text-slate-400 truncate max-w-[120px]">{p.store_name}</span>
                            <div className="flex items-center space-x-1.5">
                              {p.is_sale && (
                                <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-400 font-bold border border-amber-500/20 font-mono">
                                  SALE
                                </span>
                              )}
                              <span className="font-bold text-white font-mono">${parseFloat(p.price as any).toFixed(2)}</span>
                              <span className="text-[10px] text-slate-500">/{food.unit}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-[11px] text-slate-600">No prices logged. Dispatch a crawler to log prices.</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>

      </div>

      {/* Modal / Dialog showing full price history and beautiful interactive SVG graph.
          Clicking the backdrop (outside the panel) closes it. */}
      {selectedFoodDetails && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedFoodDetails(null)}
        >
          <div
            className="w-full max-w-2xl bg-[#090d1a] border border-white/10 rounded-3xl p-6 lg:p-8 space-y-6 relative overflow-hidden animate-slide-up"
            onClick={e => e.stopPropagation()}
          >
            <button 
              onClick={() => setSelectedFoodDetails(null)}
              className="absolute top-4 right-4 text-slate-500 hover:text-white p-2 rounded-full hover:bg-white/5 transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div>
              <span className="text-[10px] uppercase font-bold text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full border border-violet-500/20">
                {selectedFoodDetails.category}
              </span>
              <h2 className="text-2xl font-extrabold text-white mt-1.5">{selectedFoodDetails.name}</h2>
              <p className="text-xs text-slate-400 mt-1">Barcode: {selectedFoodDetails.barcode || 'N/A'}</p>
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
                    className="bg-slate-900 border border-violet-500/50 text-white text-xs font-bold rounded-full px-3 py-1 focus:outline-none w-44"
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
                      className="bg-slate-900 border border-sky-500/50 text-white text-xs rounded-full px-3 py-1 focus:outline-none w-40"
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
                  className="flex-1 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500"
                />
                <button onClick={() => addAlias(selectedFoodDetails.id)} className="px-3 py-1.5 rounded-lg bg-sky-600/20 border border-sky-500/30 text-sky-300 text-xs font-semibold hover:bg-sky-600/30 transition">
                  Add Name
                </button>
              </div>
            </div>

            {/* Nutrition Facts — edited via the shared MacroEditor popup */}
            <div className="bg-slate-950/60 border border-white/5 rounded-2xl p-4 space-y-3">
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
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono font-bold">
                    {Math.round(Number(selectedFoodDetails.nutrition.calories))} kcal
                    <span className="font-normal text-emerald-400/60"> / {Number(selectedFoodDetails.nutrition.serving_size)} {selectedFoodDetails.nutrition.serving_unit}</span>
                  </span>
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

            {/* Price Trend Graphic: Custom SVG visualization */}
            <div className="bg-slate-950/60 border border-white/5 rounded-2xl p-4">
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
          </div>
        </div>
      )}

      {/* Shared price popup (add or edit) */}
      {pricePopup && selectedFoodDetails && (
        <PriceEditor
          foodId={selectedFoodDetails.id}
          foodName={selectedFoodDetails.name}
          log={pricePopup.log}
          stores={stores}
          onClose={() => setPricePopup(null)}
          onSaved={() => { setPricePopup(null); fetchPriceHistory(selectedFoodDetails); fetchData(); }}
          onDeleted={() => { setPricePopup(null); fetchPriceHistory(selectedFoodDetails); fetchData(); }}
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
          onSaved={() => { setShowMacro(false); refreshSelectedFood(selectedFoodDetails.id); fetchData(); }}
        />
      )}

    </div>
  );
}
