"use client";

// Search USDA FoodData Central (GET /api/nutrition-search) and turn results into
// catalog foods-with-nutrition (no price required) via POST /api/foods/from-nutrition.
//
// Two modes:
//  - **save-on-pick** (used by the meals builder): NOTHING is saved as results load.
//    Only when the user clicks the `onPick` action (e.g. "Add to meal") does THAT one
//    item get saved to the catalog (once, cached in `savedById`) and handed to onPick.
//    A recipe ingredient must reference a catalog food (FK), so the picked item does
//    become a real food — but a search no longer bulk-adds every result.
//  - **LEGACY `autoSave`** (no current caller): saved every result automatically as it
//    loaded. This piled up items the user didn't want, so it was removed from the
//    dashboard ("Add from USDA"). Kept only for reference — don't re-wire it.
// The other USDA path (not this component) is MacroEditor's in-form *prefill*, which
// edits an existing food's facts and never creates rows on its own.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MACRO_META, MICRO_META } from '../lib/nutrition';
import { Command, CommandList, CommandEmpty, CommandItem } from './ui/command';
import { Input } from './ui/input';
import { Button } from './ui/button';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// calories + macros + micros — mirrors backend NUTRIENT_FIELDS (same as MacroEditor).
const NUM_NUTRIENT_FIELDS = ['calories'].concat(MACRO_META.map(m => m.field)).concat(MICRO_META.map(m => m.field));

export interface SavedFood {
  id: number;
  name: string;
  category: string;
  unit: string;
  nutrition: any;
  latest_prices: any;
  aliases: any;
}

// Build the from-nutrition request body from a USDA candidate. serving_size /
// serving_unit are the weight USDA reports for a serving (e.g. 28 g).
function candidateToFood(c: any, category: string) {
  const body: any = {
    name: c.brand ? `${c.description} (${c.brand})` : c.description,
    barcode: c.barcode || null,
    category,
    unit: c.serving_unit,
    source: 'usda',
    serving_size: c.serving_size,
    serving_unit: c.serving_unit,
  };
  for (const f of NUM_NUTRIENT_FIELDS) body[f] = c[f] ?? null;
  return body;
}

export default function NutritionSearch({
  initialQuery = '',
  category = 'USDA',
  autoSave = false,
  saveLabel = 'Save to catalog',
  pickLabel,
  onSaved,
  onPick,
  notify,
}: {
  initialQuery?: string;
  category?: string;
  // Save each result to the catalog automatically as results load (no button press).
  autoSave?: boolean;
  // Manual-mode button label (when autoSave is off).
  saveLabel?: string;
  // When set, saved results show this action button; clicking calls onPick(food).
  pickLabel?: string;
  // Fired whenever a result is saved to the catalog (auto or manual).
  onSaved?: (food: SavedFood) => void;
  // Fired when the user clicks a saved result's action button (e.g. add to meal).
  onPick?: (food: SavedFood) => void;
  notify?: (msg: string, type?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [savedById, setSavedById] = useState<Record<number, SavedFood>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // fdc_ids we've already attempted to auto-save, so the effect never double-saves.
  const attempted = useRef<Set<number>>(new Set());

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true); setResults(null); setError(null);
    setSavedById({});
    attempted.current = new Set();
    try {
      const res = await fetch(`${API_BASE_URL}/api/nutrition-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lookup failed');
      setResults(data);
    } catch (e: any) {
      setError(e.message); setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const saveCandidate = useCallback(async (c: any): Promise<SavedFood | null> => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/from-nutrition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(candidateToFood(c, category)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSavedById(prev => ({ ...prev, [c.fdc_id]: data }));
      onSaved?.(data);
      return data;
    } catch (e: any) {
      setError(e.message); notify?.(e.message, 'error');
      return null;
    }
  }, [category, onSaved, notify]);

  // Auto-save: save every result to the catalog as soon as they load.
  useEffect(() => {
    if (!autoSave || !results || results.length === 0) return;
    let cancelled = false;
    (async () => {
      let n = 0;
      for (const c of results) {
        if (cancelled) break;
        if (attempted.current.has(c.fdc_id)) continue;
        attempted.current.add(c.fdc_id);
        if (await saveCandidate(c)) n++;
      }
      if (!cancelled && n > 0) notify?.(`Saved ${n} item${n > 1 ? 's' : ''} to catalog.`);
    })();
    return () => { cancelled = true; };
  }, [results, autoSave, saveCandidate, notify]);

  const saveOne = async (c: any) => {
    setSavingId(c.fdc_id); setError(null);
    const saved = await saveCandidate(c);
    if (saved) notify?.(`Saved “${c.description}” to catalog.`);
    setSavingId(null);
  };

  // Save-on-pick: only when the user chooses this specific result do we save it (once,
  // reusing the cache) and hand it to onPick. This is how the meals builder adds a USDA
  // item without a search dumping every result into the catalog.
  const pickCandidate = async (c: any) => {
    setSavingId(c.fdc_id); setError(null);
    const saved = savedById[c.fdc_id] ?? await saveCandidate(c);
    setSavingId(null);
    if (saved) onPick?.(saved);
  };

  return (
    <div data-loc="component.nutrition-search" className="space-y-2">
      <div className="flex gap-2 items-center">
        <Input
          type="text" value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
          placeholder="Search USDA (name or barcode)…"
          className="flex-1 focus-visible:border-sky-500"
        />
        <Button type="button" onClick={search} disabled={searching} variant="outline" size="sm"
          className="text-sky-300 bg-sky-600/20 border-sky-500/30 hover:bg-sky-600/30 hover:text-sky-200">
          {searching ? 'Searching…' : 'Search USDA'}
        </Button>
      </div>

      {autoSave ? (
        <p className="text-[10px] text-slate-500">Results are saved to your catalog automatically{pickLabel ? ` — use “${pickLabel}” to put one in the meal` : ''}.</p>
      ) : onPick && (
        <p className="text-[10px] text-slate-500">Nothing is added to your catalog until you press “{pickLabel || 'Add'}” on a result.</p>
      )}
      {error && <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>}

      {results !== null && (
        <Command shouldFilter={false} className="border rounded-lg">
          <CommandList>
            {results.length === 0 && (
              <CommandEmpty className="text-[11px] text-slate-500 px-2 py-1.5 text-left">
                No USDA matches with calorie data.
              </CommandEmpty>
            )}
            {results.map((c: any) => {
              const saved = savedById[c.fdc_id];
              // Only the save-on-pick mode (onPick set) is a genuine "pick one"
              // action cmdk's onSelect maps onto; the other states (already
              // saved, auto-saving, manual save) have nothing to select into,
              // so onSelect is a no-op there and stays mouse/click-driven.
              return (
                <CommandItem key={c.fdc_id} value={String(c.fdc_id)} disabled={savingId === c.fdc_id}
                  onSelect={() => { if (onPick) pickCandidate(c); }} className="justify-between">
                  <div className="min-w-0 flex-1 text-xs">
                    <span className="text-slate-200">{c.description}</span>
                    {c.brand && <span className="text-slate-500"> · {c.brand}</span>}
                    <span className="block text-[10px] font-mono text-emerald-400">
                      {Math.round(c.calories)} kcal / {c.serving_size} {c.serving_unit}{c.serving_text ? ` (${c.serving_text})` : ''}
                      <span className="text-slate-600"> · {c.data_type}</span>
                    </span>
                  </div>
                  {/* Right-hand action depends on mode:
                      - onPick set      → one-click "Add to meal": saves this result (once)
                        then hands it to onPick (save-on-pick — the meals builder path)
                      - saved, no pick  → a "✓ saved" indicator (legacy dashboard auto-save)
                      - not saved yet   → auto: "Saving…"; manual: the save button */}
                  {onPick ? (
                    <span className="shrink-0 text-[11px] font-semibold rounded-lg px-2.5 py-1 border text-violet-300 bg-violet-500/10 border-violet-500/20">
                      {savingId === c.fdc_id ? 'Adding…' : (pickLabel || 'Add')}
                    </span>
                  ) : saved ? (
                    <span className="shrink-0 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1">✓ saved</span>
                  ) : autoSave ? (
                    <span className="shrink-0 text-[11px] text-slate-500 px-2.5 py-1">Saving…</span>
                  ) : (
                    <button type="button" onClick={e => { e.stopPropagation(); saveOne(c); }} disabled={savingId === c.fdc_id}
                      className="shrink-0 text-[11px] font-semibold rounded-lg px-2.5 py-1 border transition text-violet-300 bg-violet-500/10 border-violet-500/20 hover:bg-violet-500/20 disabled:opacity-50">
                      {savingId === c.fdc_id ? 'Saving…' : saveLabel}
                    </button>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      )}
    </div>
  );
}
