"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Modal from '../../components/Modal';
import { Label } from '../../components/ui/label';
import StatusToast, { useToast } from '../../components/StatusToast';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Store { id: number; name: string; }

interface Receipt {
  id: number;
  store_id: number | null;
  store_name: string | null;
  total: string;
  purchased_on: string;
  item_count: number;
  source: string;
  notes: string | null;
  image_id: number | null;
  scan_job_id: number | null;
}

interface Summary {
  month: string;
  spent: number;
  receipt_count: number;
  monthly_budget: number | null;
  by_store: { store_id: number | null; store_name: string; spent: number; receipt_count: number }[];
  by_month: { month: string; spent: number; receipt_count: number }[];
}

const money = (n: number) => `$${n.toFixed(2)}`;
const nowMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

// Shift a YYYY-MM string by n months (client-side, no Date-parse ambiguity).
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
};

export default function Budget() {
  const [month, setMonth] = useState(nowMonth());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [budgetInput, setBudgetInput] = useState('');
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [adding, setAdding] = useState(false);
  const { statusMsg, notify } = useToast();

  const load = useCallback(async () => {
    try {
      const [sumRes, listRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/receipts/summary?month=${month}`),
        fetch(`${API_BASE_URL}/api/receipts?month=${month}`),
      ]);
      if (sumRes.ok) {
        const s: Summary = await sumRes.json();
        setSummary(s);
        setBudgetInput(s.monthly_budget != null ? String(s.monthly_budget) : '');
      }
      if (listRes.ok) setReceipts(await listRes.json());
    } catch { /* transient */ }
  }, [month]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`).then(r => r.ok ? r.json() : []).then(setStores).catch(() => {});
  }, []);

  const saveBudget = async () => {
    const val = budgetInput.trim() === '' ? null : Number(budgetInput);
    try {
      const res = await fetch(`${API_BASE_URL}/api/budget`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_budget: val }),
      });
      if (!res.ok) throw new Error();
      notify(val == null ? 'Budget cleared.' : `Monthly budget set to ${money(val)}.`);
      load();
    } catch { notify('Failed to save budget.', 'error'); }
  };

  const deleteReceipt = async (id: number) => {
    setReceipts(prev => prev.filter(r => r.id !== id));
    try {
      const res = await fetch(`${API_BASE_URL}/api/receipts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      notify('Receipt deleted.');
      load();
    } catch { notify('Delete failed — it may reappear on refresh.', 'error'); load(); }
  };

  const spent = summary?.spent ?? 0;
  const budget = summary?.monthly_budget ?? null;
  const remaining = budget != null ? budget - spent : null;
  const pct = budget != null && budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const over = budget != null && spent > budget;
  const barColor = over ? 'from-rose-500 to-red-500' : pct > 80 ? 'from-amber-500 to-orange-500' : 'from-emerald-500 to-teal-500';

  const maxStore = useMemo(() => Math.max(1, ...(summary?.by_store ?? []).map(s => s.spent)), [summary]);
  const maxMonth = useMemo(() => Math.max(1, ...(summary?.by_month ?? []).map(m => m.spent)), [summary]);

  return (
    <div data-loc="page.budget" className="space-y-8 max-w-5xl mx-auto">
      <StatusToast statusMsg={statusMsg} />

      {/* ═══ Section: Header + month nav ═══ */}
      <div data-loc="budget.header" className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Budget &amp; Spending</h1>
          <p className="text-sm text-slate-400 mt-1">Every committed receipt scan records its store and total here. Track spend against a monthly budget.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setMonth(m => shiftMonth(m, -1))} className="btn btn-secondary rounded-lg px-3 py-2 text-xs">←</button>
          <span className="text-sm font-semibold text-white w-36 text-center">{monthLabel(month)}</span>
          <button onClick={() => setMonth(m => shiftMonth(m, 1))} disabled={month >= nowMonth()}
            className="btn btn-secondary rounded-lg px-3 py-2 text-xs disabled:opacity-40">→</button>
        </div>
      </div>

      {/* ═══ Section: Spend vs. budget ═══ */}
      <div data-loc="budget.summary" className="card rounded-3xl p-6 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="field-label">Spent this month</div>
            <div className={`text-4xl font-bold font-mono ${over ? 'text-rose-400' : 'text-white'}`}>{money(spent)}</div>
            <div className="text-xs text-slate-500 mt-1">{summary?.receipt_count ?? 0} receipt{(summary?.receipt_count ?? 0) !== 1 ? 's' : ''}</div>
          </div>
          <div className="text-right">
            {budget != null ? (
              <>
                <div className="field-label">{over ? 'Over budget by' : 'Remaining'}</div>
                <div className={`text-2xl font-bold font-mono ${over ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {money(Math.abs(remaining ?? 0))}
                </div>
                <div className="text-xs text-slate-500 mt-1">of {money(budget)} budget</div>
              </>
            ) : (
              <div className="text-xs text-slate-500 max-w-48">No monthly budget set — set one to track remaining spend.</div>
            )}
          </div>
        </div>

        {budget != null && (
          <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
            <div className={`h-full bg-linear-to-r ${barColor} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-white/5 pt-4">
          <div>
            <Label>Monthly budget ($)</Label>
            <input type="number" step="0.01" min="0" value={budgetInput} onChange={e => setBudgetInput(e.target.value)}
              placeholder="none" className="field-input w-40" />
          </div>
          <button onClick={saveBudget} className="btn btn-primary rounded-lg px-4 py-2.5 text-xs">Save budget</button>
        </div>
      </div>

      {/* ═══ Section: Breakdowns ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* By store (this month) */}
        <div data-loc="budget.by-store" className="card rounded-3xl p-6 space-y-3">
          <h2 className="text-sm font-bold text-white">By store · {monthLabel(month)}</h2>
          {(summary?.by_store.length ?? 0) === 0 && <p className="text-xs text-slate-600 py-4 text-center">No spending recorded this month.</p>}
          {summary?.by_store.map(s => (
            <div key={`${s.store_id}-${s.store_name}`} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-slate-300 truncate">{s.store_name}</span>
                <span className="font-mono text-white">{money(s.spent)}</span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-linear-to-r from-violet-500 to-indigo-400 rounded-full" style={{ width: `${(s.spent / maxStore) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>

        {/* By month (last 12) */}
        <div data-loc="budget.by-month" className="card rounded-3xl p-6 space-y-3">
          <h2 className="text-sm font-bold text-white">Last 12 months</h2>
          {(summary?.by_month.length ?? 0) === 0 && <p className="text-xs text-slate-600 py-4 text-center">No spending recorded yet.</p>}
          <div className="flex items-end justify-between gap-1 h-32">
            {summary?.by_month.map(m => (
              <button key={m.month} onClick={() => setMonth(m.month)} title={`${m.month}: ${money(m.spent)}`}
                className="flex-1 flex flex-col items-center gap-1 group">
                <div className="w-full flex items-end justify-center" style={{ height: '100%' }}>
                  <div className={`w-full rounded-t transition ${m.month === month ? 'bg-violet-400' : 'bg-slate-700 group-hover:bg-slate-600'}`}
                    style={{ height: `${Math.max(3, (m.spent / maxMonth) * 100)}%` }} />
                </div>
                <span className="text-[8px] text-slate-500 rotate-0">{m.month.slice(5)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ Section: Receipts list ═══ */}
      <div data-loc="budget.receipts" className="card rounded-3xl p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Receipts · {monthLabel(month)}</h2>
          <button onClick={() => setAdding(true)} className="btn btn-primary rounded-xl px-4 py-2 text-xs">+ Add receipt</button>
        </div>
        {receipts.length === 0 && <p className="text-slate-600 text-sm py-6 text-center">No receipts this month. Scan one, or add it manually.</p>}
        <div className="space-y-2">
          {receipts.map(r => (
            <div key={r.id} className="panel p-3 flex items-center gap-3">
              {r.image_id != null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${API_BASE_URL}/api/images/${r.image_id}`} alt="receipt" onClick={() => setLightboxId(r.image_id)}
                  className="w-10 h-10 rounded-lg object-cover border border-white/10 cursor-pointer shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-lg bg-slate-800/60 border border-white/5 flex items-center justify-center text-slate-600 shrink-0 text-lg">🧾</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white truncate">{r.store_name || 'Unknown store'}</span>
                  <span className={`badge text-[9px] ${r.source === 'scan' ? 'text-sky-300 bg-sky-500/10 border-sky-500/20' : 'text-slate-400 bg-slate-500/10 border-slate-500/20'}`}>{r.source}</span>
                </div>
                <div className="text-xs text-slate-500">{r.purchased_on}{r.item_count ? ` · ${r.item_count} item${r.item_count !== 1 ? 's' : ''}` : ''}{r.notes ? ` · ${r.notes}` : ''}</div>
              </div>
              <span className="font-mono font-bold text-white shrink-0">{money(Number(r.total))}</span>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setEditing(r)} className="text-[11px] text-violet-300 hover:text-violet-200 px-2 py-1">Edit</button>
                <button onClick={() => deleteReceipt(r.id)} className="text-[11px] text-slate-500 hover:text-rose-400 px-2 py-1">Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Manual add / edit popup */}
      {(adding || editing) && (
        <ReceiptForm
          receipt={editing}
          stores={stores}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); load(); notify('Saved.'); }}
          notify={notify}
        />
      )}

      {/* Image lightbox */}
      {lightboxId != null && (
        <div className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setLightboxId(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${API_BASE_URL}/api/images/${lightboxId}`} alt="receipt" className="max-h-full max-w-full rounded-xl" />
        </div>
      )}
    </div>
  );
}

// Shared add/edit form for a receipt (uses the shared Modal, per the overlay rule).
function ReceiptForm({ receipt, stores, onClose, onSaved, notify }: {
  receipt: Receipt | null;
  stores: Store[];
  onClose: () => void;
  onSaved: () => void;
  notify: (t: string, type?: 'success' | 'error') => void;
}) {
  const [storeId, setStoreId] = useState(receipt?.store_id != null ? String(receipt.store_id) : (stores[0] ? String(stores[0].id) : ''));
  const [total, setTotal] = useState(receipt ? String(receipt.total) : '');
  const [date, setDate] = useState(receipt?.purchased_on ?? today());
  const [notes, setNotes] = useState(receipt?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum < 0) { notify('Enter a valid total.', 'error'); return; }
    setSaving(true);
    try {
      const body = { store_id: storeId || null, total: totalNum, purchased_on: date || null, notes: notes || null };
      const res = receipt
        ? await fetch(`${API_BASE_URL}/api/receipts/${receipt.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`${API_BASE_URL}/api/receipts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, source: 'manual' }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'save failed'); }
      onSaved();
    } catch (e: any) { notify(e?.message || 'Save failed.', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} dataLoc="modal.receipt-form" maxWidth="max-w-md">
      <h3 className="text-sm font-bold text-white">{receipt ? 'Edit receipt' : 'Add receipt'}</h3>
      <div className="space-y-3">
        <div>
          <Label>Store</Label>
          <select value={storeId} onChange={e => setStoreId(e.target.value)} className="field-input w-full">
            <option value="">— none —</option>
            {stores.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Total ($)</Label>
            <input type="number" step="0.01" min="0" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00" className="field-input w-full" />
          </div>
          <div>
            <Label>Purchased on</Label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="field-input w-full" />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional" className="field-input w-full" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="btn btn-secondary rounded-lg px-4 py-2 text-xs">Cancel</button>
        <button onClick={save} disabled={saving} className="btn btn-primary rounded-lg px-4 py-2 text-xs">{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
