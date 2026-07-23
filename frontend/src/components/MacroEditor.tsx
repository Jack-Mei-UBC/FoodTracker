"use client";

// THE single macros interface. A popup for editing one food's per-serving
// nutrition facts (serving size/unit, calories, macros, micros) with USDA
// FoodData Central lookup. Every surface that edits a food's macros (dashboard,
// diary/FoodDetailModal, inbox) opens this same component — do not build another
// nutrition form. Persists via PUT /api/foods/:id/nutrition.

import React, { useState } from 'react';
import Modal from './Modal';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Command, CommandList, CommandItem } from './ui/command';
import { UNIT_OPTIONS, parseAmountInput } from '../lib/units';
import { NutritionFacts, MACRO_META, MICRO_META } from '../lib/nutrition';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Numeric nutrient fields (calories + macros + micros); mirrors backend NUTRIENT_FIELDS.
const NUM_NUTRIENT_FIELDS = ['calories'].concat(MACRO_META.map(m => m.field)).concat(MICRO_META.map(m => m.field));

function blankDraft(): Record<string, string> {
  const d: Record<string, string> = { serving_size: '', serving_unit: 'g' };
  for (const f of NUM_NUTRIENT_FIELDS) d[f] = '';
  return d;
}

export default function MacroEditor({
  foodId,
  foodName,
  barcode,
  nutrition,
  onClose,
  onSaved,
}: {
  foodId: number;
  foodName?: string;
  barcode?: string | null;
  nutrition?: (NutritionFacts & { source?: string }) | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d = blankDraft();
    if (nutrition) {
      d.serving_size = nutrition.serving_size != null ? String(Number(nutrition.serving_size)) : '';
      d.serving_unit = nutrition.serving_unit || 'g';
      for (const f of NUM_NUTRIENT_FIELDS) {
        const v = (nutrition as any)[f];
        if (v != null) d[f] = String(Number(v));
      }
    }
    return d;
  });
  const [source, setSource] = useState(nutrition?.source || 'manual');
  const [showMicros, setShowMicros] = useState(!!nutrition && MICRO_META.some(m => (nutrition as any)[m.field] != null));
  const [fdcQuery, setFdcQuery] = useState(barcode || foodName || '');
  const [fdcResults, setFdcResults] = useState<any[] | null>(null);
  const [fdcSearching, setFdcSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchUsda = async () => {
    const q = fdcQuery.trim();
    if (!q) return;
    setFdcSearching(true); setFdcResults(null); setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/nutrition-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lookup failed');
      setFdcResults(data);
    } catch (e: any) {
      setError(e.message); setFdcResults(null);
    } finally {
      setFdcSearching(false);
    }
  };

  const applyCandidate = (c: any) => {
    const d = blankDraft();
    d.serving_size = String(c.serving_size);
    d.serving_unit = c.serving_unit;
    for (const f of NUM_NUTRIENT_FIELDS) if (c[f] != null) d[f] = String(c[f]);
    setDraft(d);
    setShowMicros(MICRO_META.some(m => c[m.field] != null));
    setSource('usda');
    setFdcResults(null);
  };

  const save = async () => {
    if (!(parseFloat(draft.serving_size) > 0) || !(parseFloat(draft.calories) >= 0)) {
      setError('Serving size and calories are required.');
      return;
    }
    setBusy(true); setError(null);
    const body: any = { serving_size: parseFloat(draft.serving_size), serving_unit: draft.serving_unit, source };
    for (const f of NUM_NUTRIENT_FIELDS) body[f] = draft[f] ? parseFloat(draft[f]) : null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/nutrition`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Save failed');
      onSaved?.();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  // Smart serving entry: typing "170g" fills serving 170 + unit g.
  const onServing = (raw: string) => {
    const { amount, unit } = parseAmountInput(raw);
    if (unit) {
      setDraft(d => ({ ...d, serving_size: amount != null ? String(amount) : '', serving_unit: unit }));
    } else {
      setDraft(d => ({ ...d, serving_size: raw }));
    }
  };

  const num = 'text-right font-mono focus-visible:border-emerald-500';

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" dataLoc="modal.macro-editor">
        <div>
          <h3 className="text-sm font-bold text-white">
            Nutrition Facts{foodName ? <span className="text-slate-400 font-normal"> — {foodName}</span> : null}
            <span className="block text-[10px] text-slate-500 font-normal">per serving · feeds the Food Diary</span>
          </h3>
        </div>

        {error && <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>}

        {/* USDA lookup — prefills the form; nothing saves until Save. */}
        <div className="flex gap-2 items-center">
          <Input
            type="text" value={fdcQuery}
            onChange={e => setFdcQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); searchUsda(); } }}
            placeholder="Search USDA (name or barcode)…"
            className="flex-1 focus-visible:border-sky-500"
          />
          <Button type="button" onClick={searchUsda} disabled={fdcSearching} variant="outline" size="sm"
            className="text-sky-300 bg-sky-600/20 border-sky-500/30 hover:bg-sky-600/30 hover:text-sky-200">
            {fdcSearching ? 'Searching…' : 'Search USDA'}
          </Button>
        </div>
        {fdcResults !== null && (
          <Command shouldFilter={false} className="border rounded-lg max-h-40">
            <CommandList>
              {fdcResults.length === 0 ? (
                <p className="text-[11px] text-slate-500 px-2 py-1.5">No USDA matches with calorie data.</p>
              ) : fdcResults.map((c: any) => (
                <CommandItem key={c.fdc_id} value={String(c.fdc_id)} onSelect={() => applyCandidate(c)}>
                  <span className="text-slate-200">{c.description}</span>
                  {c.brand && <span className="text-slate-500"> · {c.brand}</span>}
                  <span className="block text-[10px] font-mono text-emerald-400">
                    {Math.round(c.calories)} kcal / {c.serving_size} {c.serving_unit}{c.serving_text ? ` (${c.serving_text})` : ''}
                    <span className="text-slate-600"> · {c.data_type}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}

        {/* Serving + calories */}
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <label className="text-slate-400">Serving</label>
          <Input type="text" inputMode="text" placeholder="e.g. 170g" value={draft.serving_size} onChange={e => onServing(e.target.value)} title="Type a number with a unit (e.g. 170g, 1cup) to auto-fill both fields" className={`${num} w-20`} />
          <Select value={draft.serving_unit} onValueChange={v => v && setDraft({ ...draft, serving_unit: v })}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {UNIT_OPTIONS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="text-slate-400 ml-2">Calories</label>
          <Input type="number" step="any" min="0" value={draft.calories} onChange={e => setDraft({ ...draft, calories: e.target.value })} className={`${num} w-20`} />
          <span className="text-slate-500">kcal</span>
        </div>

        {/* Macros */}
        <div className="flex flex-wrap gap-2 items-center text-xs">
          {MACRO_META.map(m => (
            <React.Fragment key={m.field}>
              <label className="text-slate-400">{m.label}</label>
              <Input type="number" step="any" min="0" value={draft[m.field]} onChange={e => setDraft({ ...draft, [m.field]: e.target.value })} placeholder={m.unit} className={`${num} w-16 placeholder-slate-700`} />
            </React.Fragment>
          ))}
        </div>

        {/* Micronutrients (collapsible) */}
        <button type="button" onClick={() => setShowMicros(!showMicros)} className="text-[11px] font-semibold text-slate-400 hover:text-white transition flex items-center gap-1">
          <svg className={`w-3 h-3 transition-transform ${showMicros ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
          Micronutrients (optional)
        </button>
        {showMicros && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-xs pl-1">
            {MICRO_META.map(m => (
              <div key={m.field} className="flex items-center justify-between gap-1.5">
                <label className="text-slate-400 truncate">{m.label}</label>
                <div className="flex items-center gap-1 shrink-0">
                  <Input type="number" step="any" min="0" value={draft[m.field]} onChange={e => setDraft({ ...draft, [m.field]: e.target.value })} className={`${num} w-14`} />
                  <span className="text-slate-600 w-6">{m.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={save} disabled={busy} className="flex-1">
            {busy ? 'Saving…' : 'Save Facts'}
          </Button>
          <Button onClick={onClose} disabled={busy} variant="secondary">Cancel</Button>
        </div>
    </Modal>
  );
}
