"use client";

// THE single price interface. A popup for creating OR editing one price log for
// a food. Every surface that adds/edits a price (dashboard, diary/FoodDetailModal,
// history, inbox) opens this same component — do not build another price form.
//   * edit mode  (log provided): audited PUT /api/price-logs/:id  (+ optional DELETE)
//   * create mode (no log):      POST /api/foods/:foodId/prices

import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import { UNIT_OPTIONS, parseAmountInput, formatCanonicalUnitPrice } from '../lib/units';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Store { id: number; name: string; }

export interface EditablePriceLog {
  id: number;
  price: string | number;
  amount: string | number | null;
  amount_unit: string | null;
  is_sale: boolean;
  store_id: number | null;
}

export default function PriceEditor({
  foodId,
  foodName,
  log,
  stores: storesProp,
  usablePct,
  density,
  onClose,
  onSaved,
  onDeleted,
}: {
  foodId: number;
  foodName?: string;
  log?: EditablePriceLog | null;   // present => edit, absent => create
  stores?: Store[];
  usablePct?: number | string | null; // food's usable %; reserved for callers
  density?: number | string | null;   // food's density (kg/L); converts volume preview to per-kg
  onClose: () => void;
  onSaved?: () => void;
  onDeleted?: (id: number) => void; // when provided in edit mode, shows Delete
}) {
  const isEdit = !!(log && log.id);
  const [stores, setStores] = useState<Store[]>(storesProp ?? []);
  const [draft, setDraft] = useState({
    price: log && log.price != null ? String(log.price) : '',
    amount: log && log.amount != null ? String(log.amount) : '',
    amount_unit: log?.amount_unit ?? '',
    store_id: log?.store_id != null ? String(log.store_id) : '',
    is_sale: !!(log && log.is_sale),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (storesProp && storesProp.length) { setStores(storesProp); return; }
    fetch(`${API_BASE_URL}/api/stores`).then(r => (r.ok ? r.json() : [])).then(setStores).catch(() => {});
  }, [storesProp]);

  // Smart amount entry: typing "600g" fills amount 600 + unit g (like the scan
  // review). A plain number is kept as-is so decimals/partial input still work.
  const onAmount = (raw: string) => {
    const { amount, unit } = parseAmountInput(raw);
    if (unit) {
      setDraft(d => ({ ...d, amount: amount != null ? String(amount) : '', amount_unit: unit }));
    } else {
      setDraft(d => ({ ...d, amount: raw }));
    }
  };

  // Live preview in the dashboard's canonical terms (kg / kg-via-density / each),
  // so what you see while entering matches the food cards.
  const preview = formatCanonicalUnitPrice(
    Number(draft.price),
    draft.amount === '' ? null : Number(draft.amount),
    draft.amount_unit,
    density,
  );
  void usablePct; // accepted for API parity with callers; not shown in this preview

  const save = async () => {
    if (draft.price === '') { setError('Enter a price.'); return; }
    if (!draft.store_id) { setError('Pick a store.'); return; }
    setBusy(true); setError(null);
    const body: any = {
      price: Number(draft.price),
      amount: draft.amount === '' ? null : Number(draft.amount),
      amount_unit: draft.amount_unit || null,
      store_id: Number(draft.store_id),
      is_sale: draft.is_sale,
    };
    try {
      let res: Response;
      if (isEdit) {
        res = await fetch(`${API_BASE_URL}/api/price-logs/${log!.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        body.source = 'manual';
        res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/prices`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onSaved?.();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!isEdit) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/price-logs/${log!.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      onDeleted?.(log!.id);
      onClose();
    } catch {
      setError('Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full bg-slate-950 border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500';

  return (
    <Modal onClose={onClose} maxWidth="max-w-md" panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">
            {isEdit ? 'Edit Price' : 'Add Price'}{foodName ? <span className="text-slate-400 font-normal"> — {foodName}</span> : null}
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white p-1 rounded-full hover:bg-white/5 transition">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {error && <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>}

        <div className="space-y-2.5">
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1">Store</label>
            <select value={draft.store_id} onChange={e => setDraft({ ...draft, store_id: e.target.value })} className={field}>
              <option value="">Choose a store…</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Price ($)</label>
              <input type="number" step="0.01" min="0" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} className={`${field} font-mono`} />
            </div>
            <div className="w-24">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Amount</label>
              <input
                type="text" inputMode="text" placeholder="e.g. 600g"
                value={draft.amount}
                onChange={e => onAmount(e.target.value)}
                title="Type a number with a unit (e.g. 600g, 2lb) to auto-fill both fields"
                className={`${field} font-mono`}
              />
            </div>
            <div className="w-24">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Unit</label>
              <select value={draft.amount_unit} onChange={e => setDraft({ ...draft, amount_unit: e.target.value })} className={field}>
                <option value="">—</option>
                {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input type="checkbox" checked={draft.is_sale} onChange={e => setDraft({ ...draft, is_sale: e.target.checked })} className="accent-amber-500" />
              On sale
            </label>
            {preview && <span className="text-xs font-mono text-emerald-400">{preview}</span>}
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={busy} className="btn btn-primary flex-1 rounded-lg py-2">
            {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Price'}
          </button>
          {isEdit && onDeleted && (
            <button onClick={del} disabled={busy} className="bg-rose-600/20 border border-rose-500/30 text-rose-300 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-rose-600/30 transition disabled:opacity-50">
              Delete
            </button>
          )}
          <button onClick={onClose} disabled={busy} className="btn btn-secondary rounded-lg px-4 py-2">
            Cancel
          </button>
        </div>
    </Modal>
  );
}
