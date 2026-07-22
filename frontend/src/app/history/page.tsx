"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { formatUnitPrice } from '../../lib/units';
import PriceEditor from '../../components/PriceEditor';
import { Card } from '../../components/ui/card';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface PriceLog {
  id: number;
  food_id: number;
  food_name: string;
  store_id: number | null;
  store_name: string | null;
  price: string;
  amount: string | null;
  amount_unit: string | null;
  unit_price: string | null;
  is_sale: boolean;
  source: string;
  scraped_at: string;
  deleted_at: string | null;
  image_id: number | null;
}

interface AuditEntry {
  id: number;
  entity_id: number;
  action: string;
  before_data: any;
  after_data: any;
  note: string | null;
  reverted_at: string | null;
  created_at: string;
  food_name: string | null;
}

interface Store { id: number; name: string; }

const SOURCE_COLORS: Record<string, string> = {
  scan: 'text-violet-300 bg-violet-500/10 border-violet-500/20',
  queue: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
  manual: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  scraper: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
};

const ACTION_COLORS: Record<string, string> = {
  create: 'text-emerald-400',
  update: 'text-amber-400',
  delete: 'text-rose-400',
  restore: 'text-emerald-400',
  revert: 'text-sky-400',
};

export default function History() {
  const [logs, setLogs] = useState<PriceLog[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(true);
  const [editingLog, setEditingLog] = useState<PriceLog | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const notify = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      const [logsRes, auditRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/price-logs?include_deleted=${includeDeleted}`),
        fetch(`${API_BASE_URL}/api/audit-log`),
      ]);
      if (logsRes.ok) setLogs(await logsRes.json());
      if (auditRes.ok) setAudit(await auditRes.json());
    } catch {
      notify('Failed to load history.', 'error');
    }
  }, [includeDeleted]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`).then(r => r.ok ? r.json() : []).then(setStores).catch(() => {});
  }, []);

  const remove = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/price-logs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      notify('Entry deleted (revertible below).');
      load();
    } catch {
      notify('Delete failed.', 'error');
    }
  };

  const revert = async (auditId: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/audit-log/${auditId}/revert`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Revert failed' }));
        throw new Error(err.error);
      }
      notify('Change reverted.');
      load();
    } catch (e: any) {
      notify(e.message || 'Revert failed.', 'error');
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div data-loc="page.history" className="space-y-8 max-w-6xl mx-auto">
      {statusMsg && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl ${
          statusMsg.type === 'success'
            ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30'
            : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'
        }`}>
          <span className="text-sm font-semibold">{statusMsg.text}</span>
        </div>
      )}

      {/* ═══ Section: Header ═══ */}
      <div data-loc="history.header" className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Price History</h1>
          <p className="text-sm text-slate-400 mt-1">Every logged price. Edit or delete entries — all changes are revertible below.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} className="accent-violet-500" />
          Show deleted
        </label>
      </div>

      {/* ═══ Section: Price log table ═══ */}
      <Card data-loc="history.price-table" className="rounded-3xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-white/5 text-slate-500">
              <th className="py-2">Food</th>
              <th className="py-2">Store</th>
              <th className="py-2 w-24">Price</th>
              <th className="py-2 w-40">Amount</th>
              <th className="py-2 w-24">$ / Unit</th>
              <th className="py-2 w-20">Source</th>
              <th className="py-2 w-14">Photo</th>
              <th className="py-2 w-32">Date</th>
              <th className="py-2 w-32 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr><td colSpan={9} className="py-8 text-center text-slate-600">No price logs yet.</td></tr>
            )}
            {logs.map(log => {
              const deleted = !!log.deleted_at;
              return (
                <tr key={log.id} className={`border-b border-white/5 hover:bg-white/5 ${deleted ? 'opacity-40' : ''}`}>
                  <td className="py-2.5 pr-4 font-semibold text-white">
                    {log.food_name}
                    {deleted && <span className="ml-2 text-[9px] text-rose-400 uppercase font-bold">deleted</span>}
                  </td>
                  <td className="py-2.5 pr-4"><span className="text-slate-300">{log.store_name ?? '—'}</span></td>
                  <td className="py-2.5 pr-4"><span className="font-mono text-white font-bold">${Number(log.price).toFixed(2)}</span></td>
                  <td className="py-2.5 pr-4">
                    <span className="text-slate-400 font-mono">{log.amount ? `${Number(log.amount)} ${log.amount_unit ?? ''}` : '—'}</span>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-emerald-400">
                    {formatUnitPrice(Number(log.price), log.amount ? Number(log.amount) : null, log.amount_unit) ?? '—'}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`badge text-[9px] ${SOURCE_COLORS[log.source] ?? SOURCE_COLORS.manual}`}>
                      {log.source}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    {log.image_id ? (
                      <a href={`${API_BASE_URL}/api/images/${log.image_id}`} target="_blank" rel="noreferrer" title="Open source photo">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`${API_BASE_URL}/api/images/${log.image_id}`}
                          alt="source"
                          className="h-8 w-8 object-cover rounded-lg border border-white/10 hover:border-violet-500/60 transition"
                        />
                      </a>
                    ) : (
                      <span className="text-slate-700">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-500">{fmtDate(log.scraped_at)}</td>
                  <td className="py-2.5 text-right whitespace-nowrap">
                    {deleted ? (
                      <span className="text-[10px] text-slate-600">use Revert below</span>
                    ) : (
                      <>
                        <button onClick={() => setEditingLog(log)} className="text-[11px] font-bold text-violet-400 hover:text-violet-300 px-2">Edit</button>
                        <button onClick={() => remove(log.id)} className="text-[11px] font-bold text-rose-400 hover:text-rose-300 px-2">Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* ═══ Section: Change history / revert feed ═══ */}
      <Card data-loc="history.audit-log" className="rounded-3xl p-6 space-y-4">
        <h2 className="text-lg font-bold text-white">Change History</h2>
        <p className="text-xs text-slate-400">Every edit, delete, and revert. Revert any change to undo it.</p>
        <div className="space-y-2 max-h-[420px] overflow-y-auto">
          {audit.length === 0 && <p className="text-slate-600 text-xs">No changes recorded yet.</p>}
          {audit.map(a => (
            <div key={a.id} className="flex items-center justify-between bg-slate-900/50 border border-white/5 rounded-xl px-4 py-2.5">
              <div className="flex items-center gap-3 text-xs">
                <span className={`font-bold uppercase w-16 ${ACTION_COLORS[a.action] ?? 'text-slate-400'}`}>{a.action}</span>
                <span className="text-slate-300">{a.food_name ?? `entry #${a.entity_id}`}</span>
                {a.action === 'update' && a.before_data && a.after_data && (
                  <span className="text-slate-500 font-mono">
                    ${Number(a.before_data.price).toFixed(2)} → ${Number(a.after_data.price).toFixed(2)}
                  </span>
                )}
                {a.note && <span className="text-slate-600 italic">{a.note}</span>}
                <span className="text-slate-600">{fmtDate(a.created_at)}</span>
              </div>
              {a.reverted_at ? (
                <span className="text-[10px] text-slate-600 uppercase font-bold">reverted</span>
              ) : a.action === 'revert' ? (
                <span className="text-[10px] text-slate-600">—</span>
              ) : (
                <button onClick={() => revert(a.id)}
                  className="text-[11px] font-bold text-sky-400 hover:text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-lg px-3 py-1 transition">
                  Revert
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Shared price editor popup */}
      {editingLog && (
        <PriceEditor
          foodId={editingLog.food_id}
          foodName={editingLog.food_name}
          log={editingLog}
          stores={stores}
          onClose={() => setEditingLog(null)}
          onSaved={() => { setEditingLog(null); notify('Price updated.'); load(); }}
          onDeleted={() => { setEditingLog(null); notify('Price deleted.'); load(); }}
        />
      )}
    </div>
  );
}
