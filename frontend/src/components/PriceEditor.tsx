"use client";

// THE single price interface. A popup for creating OR editing one price log for
// a food. Every surface that adds/edits a price (dashboard, diary/FoodDetailModal,
// history, inbox) opens this same component — do not build another price form.
//   * edit mode  (log provided): audited PUT /api/price-logs/:id  (+ optional DELETE)
//   * create mode (no log):      POST /api/foods/:foodId/prices

import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { UNIT_OPTIONS, parseAmountInput, formatCanonicalUnitPrice } from '../lib/units';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Store { id: number; name: string; }

export interface EditablePriceLog {
  id: number;
  price: string | number;
  amount: string | number | null;
  amount_unit: string | null;
  is_sale: boolean;
  sale_ends_at?: string | null;
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
    // Blank means "let the backend apply the configured default sale length".
    sale_ends_at: log?.sale_ends_at ? String(log.sale_ends_at).slice(0, 10) : '',
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
      // Only sent when set; omitting it lets the backend fill the default for a
      // sale, and it's ignored outright for a non-sale price.
      sale_ends_at: draft.is_sale ? (draft.sale_ends_at || null) : null,
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

  const field = 'w-full bg-slate-950 border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-hidden focus:border-violet-500';

  return (
    <Modal onClose={onClose} maxWidth="max-w-md" dataLoc="modal.price-editor">
        <div>
          <h3 className="text-sm font-bold text-white">
            {isEdit ? 'Edit Price' : 'Add Price'}{foodName ? <span className="text-slate-400 font-normal"> — {foodName}</span> : null}
          </h3>
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
          {/* A sale price is hidden from current-price views once this date passes. */}
          {draft.is_sale && (
            <div>
              <Label>Sale ends</Label>
              <input type="date" value={draft.sale_ends_at}
                onChange={e => setDraft({ ...draft, sale_ends_at: e.target.value })}
                className="field-input w-full" />
              <p className="text-[10px] text-slate-500 mt-1">
                {draft.sale_ends_at
                  ? 'After this date the price stops showing as current (history keeps it).'
                  : 'Leave blank to use the default sale length from Settings.'}
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={save} disabled={busy} className="flex-1">
            {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Price'}
          </Button>
          {isEdit && onDeleted && (
            <Button onClick={del} disabled={busy} variant="destructive">
              Delete
            </Button>
          )}
          <Button onClick={onClose} disabled={busy} variant="secondary">
            Cancel
          </Button>
        </div>
    </Modal>
  );
}
