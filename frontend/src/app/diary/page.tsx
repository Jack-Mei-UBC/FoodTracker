"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { UNIT_OPTIONS, parseAmountInput } from '../../lib/units';
import { scaleNutrients, NutritionFacts, MICRO_META } from '../../lib/nutrition';
import FoodDetailModal from '../../components/FoodDetailModal';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface CatalogFood {
  id: number;
  name: string;
  category: string;
  aliases: { id: number; alias: string }[] | null;
  nutrition: (NutritionFacts & { food_id: number }) | null;
}

interface DiaryEntry {
  id: number;
  food_id: number | null;
  food_name: string;
  consumed_at: string;
  meal: string;
  amount: string;
  amount_unit: string;
  calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
  notes: string | null;
  category?: string | null;
}

interface DiaryTotals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  entry_count: number;
  // Micronutrient totals (keyed by MICRO_META fields) are summed server-side.
  [field: string]: number;
}

interface Goals {
  daily_calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
}

const MEALS = [
  { key: 'breakfast', label: 'Breakfast', accent: 'text-amber-400', chip: 'bg-amber-500/10 border-amber-500/20' },
  { key: 'lunch', label: 'Lunch', accent: 'text-sky-400', chip: 'bg-sky-500/10 border-sky-500/20' },
  { key: 'dinner', label: 'Dinner', accent: 'text-violet-400', chip: 'bg-violet-500/10 border-violet-500/20' },
  { key: 'snack', label: 'Snacks', accent: 'text-emerald-400', chip: 'bg-emerald-500/10 border-emerald-500/20' },
];

// Units offered when logging food: servings first, then the shared vocabulary.
const DIARY_UNITS = ['serving'].concat(UNIT_OPTIONS);

const pad = (n: number) => String(n).padStart(2, '0');

// Local date as YYYY-MM-DD (never toISOString — the containers run on UTC and
// the diary is keyed by the user's local day).
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr: string, delta: number): string {
  const parts = dateStr.split('-').map(Number);
  return localDateStr(new Date(parts[0], parts[1] - 1, parts[2] + delta));
}

// Naive local timestamp for consumed_at: the viewed date + the current wall time.
function timestampFor(dateStr: string): string {
  const now = new Date();
  return `${dateStr}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function defaultMeal(): string {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

const fmtKcal = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(Number(v))}`;

// consumed_at is a naive local timestamp (we send it; Postgres stores it
// verbatim; node-postgres serializes it as if UTC). Show the stored wall-clock
// digits as-is instead of letting Date shift them into the browser's zone.
const fmtTime = (ts: string) => ts.slice(11, 16);

export default function DiaryPage() {
  const [viewDate, setViewDate] = useState(() => localDateStr(new Date()));
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [totals, setTotals] = useState<DiaryTotals>({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, entry_count: 0 });
  const [goals, setGoals] = useState<Goals | null>(null);
  const [foods, setFoods] = useState<CatalogFood[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Add-entry form
  const [query, setQuery] = useState('');
  const [selectedFood, setSelectedFood] = useState<CatalogFood | null>(null);
  const [oneOffName, setOneOffName] = useState<string | null>(null);
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState('serving');
  const [meal, setMeal] = useState(defaultMeal());
  const [manualCalories, setManualCalories] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Inline entry editing
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({
    name: '', amount: '', unit: 'serving', meal: 'snack', calories: '', time: '12:00', notes: '',
  });

  // Goals editing
  const [editingGoals, setEditingGoals] = useState(false);
  const [goalsDraft, setGoalsDraft] = useState({ daily_calories: '', protein_g: '', carbs_g: '', fat_g: '' });

  // Food detail modal (edit prices / add names / view price photos)
  const [detailFoodId, setDetailFoodId] = useState<number | null>(null);

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const fetchDiary = async (date: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/diary?date=${date}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setEntries(data.entries);
      setTotals(data.totals);
      setGoals(data.goals);
    } catch {
      showToast('Failed to load diary.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    fetchDiary(viewDate);
  }, [viewDate]);

  const loadFoods = () => {
    fetch(`${API_BASE_URL}/api/foods`)
      .then(r => (r.ok ? r.json() : []))
      .then(setFoods)
      .catch(() => {});
  };

  useEffect(() => { loadFoods(); }, []);

  // Catalog suggestions: substring match on the primary name and aliases.
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return foods
      .filter(f =>
        f.name.toLowerCase().indexOf(q) !== -1 ||
        (f.aliases ?? []).some(a => a.alias.toLowerCase().indexOf(q) !== -1)
      )
      .slice(0, 6);
  }, [query, foods]);

  const facts = selectedFood?.nutrition ?? null;
  const needsManualCalories = (selectedFood !== null && !facts) || oneOffName !== null;

  // Live preview of what this entry will log.
  const preview = useMemo(() => {
    if (needsManualCalories) {
      const kcal = parseFloat(manualCalories);
      return isFinite(kcal) && kcal >= 0 ? { calories: kcal, protein_g: null, carbs_g: null, fat_g: null } : null;
    }
    if (!facts) return null;
    const amt = parseFloat(amount);
    if (!isFinite(amt) || amt <= 0) return null;
    return scaleNutrients(facts, amt, unit);
  }, [facts, amount, unit, manualCalories, needsManualCalories]);

  const resetForm = () => {
    setQuery('');
    setSelectedFood(null);
    setOneOffName(null);
    setAmount('1');
    setUnit('serving');
    setManualCalories('');
    setShowSuggestions(false);
  };

  const pickFood = (f: CatalogFood) => {
    setSelectedFood(f);
    setOneOffName(null);
    setQuery(f.name);
    setShowSuggestions(false);
    setAmount('1');
    setUnit(f.nutrition ? 'serving' : 'each');
  };

  const pickOneOff = () => {
    setOneOffName(query.trim());
    setSelectedFood(null);
    setShowSuggestions(false);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFood && !oneOffName) {
      showToast('Pick a food from the catalog or log a one-off entry.', 'error');
      return;
    }
    const body: any = { meal, consumed_at: timestampFor(viewDate) };
    if (selectedFood) {
      body.food_id = selectedFood.id;
      body.amount = parseFloat(amount);
      body.amount_unit = unit;
      if (needsManualCalories) body.calories = parseFloat(manualCalories);
    } else {
      body.food_name = oneOffName;
      body.calories = parseFloat(manualCalories);
    }
    if (needsManualCalories && !(parseFloat(manualCalories) >= 0)) {
      showToast('Enter the calories for this entry.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/consumption-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to log entry');
      showToast(`Logged ${data.food_name} — ${fmtKcal(data.calories)} kcal.`);
      resetForm();
      fetchDiary(viewDate);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const startEdit = (entry: DiaryEntry) => {
    setEditId(entry.id);
    setEditDraft({
      name: entry.food_name,
      amount: String(Number(entry.amount)),
      unit: entry.amount_unit,
      meal: entry.meal,
      calories: entry.calories === null ? '' : String(Math.round(Number(entry.calories))),
      time: fmtTime(entry.consumed_at),
      notes: entry.notes ?? '',
    });
  };

  const saveEdit = async (entry: DiaryEntry) => {
    const body: any = {
      amount: parseFloat(editDraft.amount),
      amount_unit: editDraft.unit,
      meal: editDraft.meal,
      // Keep the entry's stored date, swap in the edited wall-clock time.
      consumed_at: `${entry.consumed_at.slice(0, 10)}T${editDraft.time}:00`,
      notes: editDraft.notes.trim() || null,
    };
    if (editDraft.name.trim()) body.food_name = editDraft.name.trim();
    // Only send calories when the user actually changed them, so amount edits
    // on catalog foods recompute from the food's facts instead.
    const origKcal = entry.calories === null ? '' : String(Math.round(Number(entry.calories)));
    if (editDraft.calories !== origKcal) body.calories = parseFloat(editDraft.calories);
    try {
      const res = await fetch(`${API_BASE_URL}/api/consumption-logs/${entry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setEditId(null);
      fetchDiary(viewDate);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const deleteEntry = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/consumption-logs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      showToast('Entry removed.');
      fetchDiary(viewDate);
    } catch {
      showToast('Failed to delete entry.', 'error');
    }
  };

  const startGoalsEdit = () => {
    setGoalsDraft({
      daily_calories: goals?.daily_calories ? String(Math.round(Number(goals.daily_calories))) : '',
      protein_g: goals?.protein_g ? String(Math.round(Number(goals.protein_g))) : '',
      carbs_g: goals?.carbs_g ? String(Math.round(Number(goals.carbs_g))) : '',
      fat_g: goals?.fat_g ? String(Math.round(Number(goals.fat_g))) : '',
    });
    setEditingGoals(true);
  };

  const saveGoals = async () => {
    const body: any = {};
    if (goalsDraft.daily_calories) body.daily_calories = parseFloat(goalsDraft.daily_calories);
    if (goalsDraft.protein_g) body.protein_g = parseFloat(goalsDraft.protein_g);
    if (goalsDraft.carbs_g) body.carbs_g = parseFloat(goalsDraft.carbs_g);
    if (goalsDraft.fat_g) body.fat_g = parseFloat(goalsDraft.fat_g);
    try {
      const res = await fetch(`${API_BASE_URL}/api/goals`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      setEditingGoals(false);
      showToast('Targets updated.');
      fetchDiary(viewDate);
    } catch {
      showToast('Failed to save targets.', 'error');
    }
  };

  const goalCalories = goals?.daily_calories ? Number(goals.daily_calories) : 0;
  const eaten = totals.calories;
  const remaining = goalCalories - eaten;
  const ringPct = goalCalories > 0 ? Math.min(eaten / goalCalories, 1) : 0;
  const overGoal = goalCalories > 0 && eaten > goalCalories;
  const RADIUS = 62;
  const CIRC = 2 * Math.PI * RADIUS;

  const isToday = viewDate === localDateStr(new Date());
  const dateLabel = (() => {
    const parts = viewDate.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  })();

  const macroBars = [
    { label: 'Protein', eaten: totals.protein_g, goal: goals?.protein_g ? Number(goals.protein_g) : null, color: 'bg-sky-500' },
    { label: 'Carbs', eaten: totals.carbs_g, goal: goals?.carbs_g ? Number(goals.carbs_g) : null, color: 'bg-amber-500' },
    { label: 'Fat', eaten: totals.fat_g, goal: goals?.fat_g ? Number(goals.fat_g) : null, color: 'bg-rose-500' },
  ];

  return (
    <div data-loc="page.diary" className="space-y-8 animate-slide-up relative">
      {notification && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 ${
          notification.type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'
        }`}>
          <div className={`w-2 h-2 rounded-full ${notification.type === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          <span className="text-sm font-semibold">{notification.message}</span>
        </div>
      )}

      {/* ═══ Section: Header — title + date navigation ═══ */}
      <div data-loc="diary.header" className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-linear-to-r from-white via-slate-100 to-emerald-300 bg-clip-text text-transparent">
            Food Diary
          </h1>
          <p className="text-sm text-slate-400 mt-1">{dateLabel}{isToday && <span className="ml-2 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5 uppercase">Today</span>}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setViewDate(shiftDate(viewDate, -1))} className="p-2 rounded-xl bg-slate-900/60 border border-white/5 text-slate-300 hover:text-white hover:bg-white/5 transition" title="Previous day">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <input
            type="date"
            value={viewDate}
            onChange={e => e.target.value && setViewDate(e.target.value)}
            className="bg-slate-900/60 border border-white/5 rounded-xl px-3 py-2 text-sm text-white focus:outline-hidden focus:border-emerald-500 transition scheme-dark"
          />
          <button onClick={() => setViewDate(shiftDate(viewDate, 1))} className="p-2 rounded-xl bg-slate-900/60 border border-white/5 text-slate-300 hover:text-white hover:bg-white/5 transition" title="Next day">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
          </button>
          {!isToday && (
            <button onClick={() => setViewDate(localDateStr(new Date()))} className="px-3 py-2 rounded-xl bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold hover:bg-emerald-600/30 transition">
              Today
            </button>
          )}
        </div>
      </div>

      {/* ═══ Section: Summary — calorie ring + macros + goals ═══ */}
      <div data-loc="diary.summary" className="card rounded-3xl p-6 lg:p-8 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-emerald-600/10 rounded-full blur-3xl -z-10" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-center">

          {/* Calorie ring */}
          <div className="flex items-center justify-center">
            <div className="relative w-44 h-44">
              <svg viewBox="0 0 160 160" className="w-full h-full -rotate-90">
                <circle cx="80" cy="80" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                <circle
                  cx="80" cy="80" r={RADIUS} fill="none"
                  stroke={overGoal ? '#fb7185' : '#34d399'}
                  strokeWidth="12" strokeLinecap="round"
                  strokeDasharray={`${CIRC}`}
                  strokeDashoffset={`${CIRC * (1 - ringPct)}`}
                  style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1)' }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-3xl font-extrabold font-mono ${overGoal ? 'text-rose-400' : 'text-white'}`}>{Math.round(eaten)}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">kcal eaten</span>
                {goalCalories > 0 && (
                  <span className={`text-xs font-mono mt-1 ${overGoal ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {overGoal ? `${Math.round(-remaining)} over` : `${Math.round(remaining)} left`}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Macro bars */}
          <div className="space-y-4">
            {macroBars.map(m => {
              const pct = m.goal ? Math.min(m.eaten / m.goal, 1) * 100 : 0;
              return (
                <div key={m.label}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-300">{m.label}</span>
                    <span className="font-mono text-slate-400">
                      {Math.round(m.eaten)}g{m.goal ? ` / ${Math.round(m.goal)}g` : ''}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div className={`h-full rounded-full ${m.color} transition-all duration-500`} style={{ width: m.goal ? `${pct}%` : m.eaten > 0 ? '100%' : '0%', opacity: m.goal ? 1 : 0.35 }} />
                  </div>
                </div>
              );
            })}
            <p className="text-[10px] text-slate-500">{totals.entry_count} entr{totals.entry_count === 1 ? 'y' : 'ies'} logged this day.</p>
          </div>

          {/* Goals */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Daily Targets</span>
              {!editingGoals && (
                <button onClick={startGoalsEdit} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition">Edit</button>
              )}
            </div>
            {editingGoals ? (
              <div className="space-y-2">
                {([
                  ['daily_calories', 'Calories (kcal)'],
                  ['protein_g', 'Protein (g)'],
                  ['carbs_g', 'Carbs (g)'],
                  ['fat_g', 'Fat (g)'],
                ] as const).map(pair => (
                  <div key={pair[0]} className="flex items-center justify-between gap-2">
                    <label className="text-xs text-slate-400">{pair[1]}</label>
                    <input
                      type="number"
                      value={(goalsDraft as any)[pair[0]]}
                      onChange={e => setGoalsDraft({ ...goalsDraft, [pair[0]]: e.target.value })}
                      className="w-24 bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-xs text-white text-right font-mono focus:outline-hidden focus:border-emerald-500"
                    />
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button onClick={saveGoals} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg py-1.5 text-xs font-semibold transition">Save</button>
                  <button onClick={() => setEditingGoals(false)} className="btn btn-secondary flex-1 rounded-lg py-1.5 text-xs">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="panel p-3">
                  <span className="block text-slate-500 text-[10px] uppercase font-semibold">Calories</span>
                  <span className="font-mono font-bold text-white">{goals?.daily_calories ? `${Math.round(Number(goals.daily_calories))}` : '—'}</span>
                </div>
                <div className="panel p-3">
                  <span className="block text-slate-500 text-[10px] uppercase font-semibold">Protein</span>
                  <span className="font-mono font-bold text-white">{goals?.protein_g ? `${Math.round(Number(goals.protein_g))}g` : '—'}</span>
                </div>
                <div className="panel p-3">
                  <span className="block text-slate-500 text-[10px] uppercase font-semibold">Carbs</span>
                  <span className="font-mono font-bold text-white">{goals?.carbs_g ? `${Math.round(Number(goals.carbs_g))}g` : '—'}</span>
                </div>
                <div className="panel p-3">
                  <span className="block text-slate-500 text-[10px] uppercase font-semibold">Fat</span>
                  <span className="font-mono font-bold text-white">{goals?.fat_g ? `${Math.round(Number(goals.fat_g))}g` : '—'}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ Section: Daily micronutrient totals ═══ */}
      <div data-loc="diary.micronutrients" className="card p-5 space-y-3">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-sky-400" />
          Micronutrients Today
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {MICRO_META.map(m => {
            const v = totals[m.field] ?? 0;
            return (
              <div key={m.field} className={`panel p-2.5 ${v > 0 ? '' : 'opacity-50'}`}>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold truncate">{m.label}</span>
                <span className="font-mono font-bold text-slate-200 text-sm">
                  {Math.round(v * 10) / 10}<span className="text-slate-500 text-[10px] font-normal ml-0.5">{m.unit}</span>
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-slate-500">Summed from the nutrition facts of everything logged this day. Foods without recorded facts contribute 0.</p>
      </div>

      {/* ═══ Section: Add entry ═══ */}
      <form data-loc="diary.add-entry" onSubmit={handleAdd} className="card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <h2 className="text-sm font-bold text-white">Log Food</h2>
        </div>
        <div className="flex flex-col lg:flex-row gap-3">
          {/* Food search with suggestions */}
          <div className="relative flex-1">
            <input
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setSelectedFood(null); setOneOffName(null); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="Search the catalog (e.g. Greek Yogurt)…"
              className="field-input focus:border-emerald-500"
            />
            {showSuggestions && query.trim() && !selectedFood && oneOffName === null && (
              <div className="absolute z-20 mt-1 w-full bg-[#0b101f] border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                {suggestions.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => pickFood(f)}
                    className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-white/5 transition flex justify-between items-center"
                  >
                    <span>{f.name} <span className="text-slate-500">· {f.category}</span></span>
                    {f.nutrition ? (
                      <span className="font-mono text-emerald-400">{fmtKcal(f.nutrition.calories)} kcal/serv</span>
                    ) : (
                      <span className="text-[10px] text-slate-500">no facts</span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={pickOneOff}
                  className="w-full text-left px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-500/10 transition border-t border-white/5"
                >
                  + Log “{query.trim()}” as a one-off entry (calories only)
                </button>
              </div>
            )}
          </div>

          {/* Amount + unit (catalog foods) or calories (one-off / no facts) */}
          {oneOffName === null && (
            <div className="flex gap-2">
              <input
                type="text" inputMode="text" placeholder="e.g. 600g"
                value={amount}
                onChange={e => {
                  const { amount: a, unit: u } = parseAmountInput(e.target.value);
                  if (u) { setAmount(a != null ? String(a) : ''); setUnit(u); }
                  else { setAmount(e.target.value); }
                }}
                title="Type a number with a unit (e.g. 600g, 2lb) to auto-fill both fields"
                className="w-20 bg-slate-950 border border-white/10 rounded-xl px-3 py-2 text-sm text-white text-right font-mono focus:outline-hidden focus:border-emerald-500"
              />
              <select
                value={unit}
                onChange={e => setUnit(e.target.value)}
                className="bg-slate-950 border border-white/10 rounded-xl px-2 py-2 text-sm text-white focus:outline-hidden focus:border-emerald-500"
              >
                {DIARY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          )}
          {needsManualCalories && (
            <input
              type="number" step="any" min="0"
              value={manualCalories}
              onChange={e => setManualCalories(e.target.value)}
              placeholder="kcal"
              className="w-24 bg-slate-950 border border-amber-500/30 rounded-xl px-3 py-2 text-sm text-white text-right font-mono placeholder-slate-600 focus:outline-hidden focus:border-amber-500"
            />
          )}

          <select
            value={meal}
            onChange={e => setMeal(e.target.value)}
            className="bg-slate-950 border border-white/10 rounded-xl px-2 py-2 text-sm text-white focus:outline-hidden focus:border-emerald-500"
          >
            {MEALS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>

          <button
            type="submit"
            disabled={isSaving}
            className="bg-linear-to-r from-emerald-600 to-teal-600 text-white rounded-xl px-5 py-2 text-sm font-semibold hover:shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98] transition disabled:opacity-50"
          >
            {isSaving ? 'Logging…' : 'Add'}
          </button>
        </div>

        {/* Live preview / hints */}
        {selectedFood && facts && (
          <p className="text-xs text-slate-400">
            {preview ? (
              <>
                <span className="font-mono font-bold text-emerald-400">{fmtKcal(preview.calories)} kcal</span>
                {preview.protein_g !== null && <span className="font-mono text-slate-500"> · P {preview.protein_g}g · C {preview.carbs_g}g · F {preview.fat_g}g</span>}
                <span className="text-slate-600"> — serving is {Number(facts.serving_size)} {facts.serving_unit}</span>
              </>
            ) : (
              <span className="text-amber-400">Can’t convert {amount || '?'} {unit} — the serving is measured in {facts.serving_unit}. Use a matching unit or ‘serving’.</span>
            )}
          </p>
        )}
        {selectedFood && !facts && (
          <p className="text-xs text-amber-400">
            “{selectedFood.name}” has no nutrition facts yet — enter the calories for this entry, or add facts from its card on the Dashboard.
          </p>
        )}
        {oneOffName !== null && (
          <p className="text-xs text-slate-400">One-off entry “{oneOffName}” — not linked to the catalog.</p>
        )}
      </form>

      {/* ═══ Section: Meals grid ═══ */}
      {isLoading ? (
        <div className="text-center text-slate-500 py-12">Loading diary…</div>
      ) : (
        <div data-loc="diary.meals-grid" className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {MEALS.map(m => {
            const mealEntries = entries.filter(en => en.meal === m.key);
            const subtotal = mealEntries.reduce((acc, en) => acc + (en.calories ? Number(en.calories) : 0), 0);
            return (
              <div key={m.key} className="card p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className={`text-sm font-bold ${m.accent}`}>{m.label}</h3>
                  <span className={`badge normal-case text-xs font-mono ${m.chip} ${m.accent}`}>
                    {Math.round(subtotal)} kcal
                  </span>
                </div>
                {mealEntries.length === 0 ? (
                  <p className="text-xs text-slate-600">Nothing logged.</p>
                ) : (
                  <div className="space-y-2">
                    {mealEntries.map(en => (
                      <div key={en.id} className="panel p-2.5 text-xs">
                        {editId === en.id ? (
                          <div className="space-y-2">
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={editDraft.name}
                                onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                                className="flex-1 bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white font-semibold focus:outline-hidden focus:border-emerald-500"
                              />
                              <input
                                type="time"
                                value={editDraft.time}
                                onChange={e => e.target.value && setEditDraft({ ...editDraft, time: e.target.value })}
                                className="bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white font-mono focus:outline-hidden focus:border-emerald-500 scheme-dark"
                              />
                            </div>
                            <div className="flex flex-wrap gap-2 items-center">
                              <input
                                type="text" inputMode="text" placeholder="e.g. 600g"
                                value={editDraft.amount}
                                onChange={e => {
                                  const { amount: a, unit: u } = parseAmountInput(e.target.value);
                                  if (u) setEditDraft({ ...editDraft, amount: a != null ? String(a) : '', unit: u });
                                  else setEditDraft({ ...editDraft, amount: e.target.value });
                                }}
                                title="Type a number with a unit (e.g. 600g, 2lb) to auto-fill both fields"
                                className="w-16 bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white text-right font-mono focus:outline-hidden focus:border-emerald-500"
                              />
                              <select
                                value={editDraft.unit}
                                onChange={e => setEditDraft({ ...editDraft, unit: e.target.value })}
                                className="bg-slate-950 border border-white/10 rounded-lg px-1.5 py-1 text-white focus:outline-hidden"
                              >
                                {DIARY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                              </select>
                              <select
                                value={editDraft.meal}
                                onChange={e => setEditDraft({ ...editDraft, meal: e.target.value })}
                                className="bg-slate-950 border border-white/10 rounded-lg px-1.5 py-1 text-white focus:outline-hidden"
                              >
                                {MEALS.map(mm => <option key={mm.key} value={mm.key}>{mm.label}</option>)}
                              </select>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number" step="any" min="0"
                                  value={editDraft.calories}
                                  onChange={e => setEditDraft({ ...editDraft, calories: e.target.value })}
                                  className="w-16 bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white text-right font-mono focus:outline-hidden focus:border-emerald-500"
                                />
                                <span className="text-slate-500">kcal</span>
                              </div>
                            </div>
                            <input
                              type="text"
                              value={editDraft.notes}
                              onChange={e => setEditDraft({ ...editDraft, notes: e.target.value })}
                              placeholder="Notes (optional)"
                              className="w-full bg-slate-950 border border-white/10 rounded-lg px-2 py-1 text-white placeholder-slate-600 focus:outline-hidden focus:border-emerald-500"
                            />
                            <div className="flex gap-2">
                              <button type="button" onClick={() => saveEdit(en)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg py-1 font-semibold transition">Save</button>
                              <button type="button" onClick={() => setEditId(null)} className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 rounded-lg py-1 font-semibold transition">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              {en.food_id ? (
                                <button
                                  onClick={() => setDetailFoodId(en.food_id)}
                                  title="Prices, names & photos"
                                  className="font-semibold text-slate-200 truncate hover:text-emerald-300 transition text-left flex items-center gap-1"
                                >
                                  {en.food_name}
                                  <svg className="w-3 h-3 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </button>
                              ) : (
                                <div className="font-semibold text-slate-200 truncate">{en.food_name}</div>
                              )}
                              <div className="text-[10px] text-slate-500 font-mono">
                                {Number(en.amount)} {en.amount_unit}
                                {en.protein_g !== null && ` · P ${Math.round(Number(en.protein_g))} C ${Math.round(Number(en.carbs_g))} F ${Math.round(Number(en.fat_g))}`}
                                {' · '}{fmtTime(en.consumed_at)}
                              </div>
                              {en.notes && <div className="text-[10px] text-slate-400 italic truncate">{en.notes}</div>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono font-bold text-white">{fmtKcal(en.calories)}</span>
                              <button onClick={() => startEdit(en)} title="Edit" className="text-slate-500 hover:text-white transition">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                              </button>
                              <button onClick={() => deleteEntry(en.id)} title="Delete" className="text-slate-500 hover:text-rose-400 transition">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Food detail: edit prices, add names, view each price log's photo */}
      {detailFoodId !== null && (
        <FoodDetailModal
          foodId={detailFoodId}
          onClose={() => setDetailFoodId(null)}
          onChange={loadFoods}
        />
      )}
    </div>
  );
}
