"use client";

// Food detail modal: manage a food's known names, price logs, and nutrition
// facts without leaving the current page. Opened from the diary and the inbox.
// Price editing and macro editing are delegated to the two shared popups
// (PriceEditor / MacroEditor) — this modal only lists data and launches them.

import React, { useState, useEffect, useCallback } from 'react';
import { formatCanonicalUnitPrice, normalizeUnit } from '../lib/units';
import { NutritionFacts, nutrientsPer100 } from '../lib/nutrition';
import PriceEditor, { EditablePriceLog } from './PriceEditor';
import MacroEditor from './MacroEditor';
import Modal from './Modal';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Alias { id: number; alias: string; }
interface Food {
  id: number;
  name: string;
  category: string;
  barcode: string | null;
  usable_pct: number | string;
  density: number | string;
  unit: string;
  aliases: Alias[] | null;
  nutrition: (NutritionFacts & { source?: string; shared_food_count?: number }) | null;
}
interface Store { id: number; name: string; }

interface PriceLog {
  id: number;
  price: string;
  amount: string | null;
  amount_unit: string | null;
  is_sale: boolean;
  store_id: number | null;
  store_name: string | null;
  source: string;
  scraped_at: string;
  image_id: number | null;
}

export default function FoodDetailModal({
  foodId,
  onClose,
  onChange,
}: {
  foodId: number;
  onClose: () => void;
  onChange?: () => void;
}) {
  const [food, setFood] = useState<Food | null>(null);
  const [prices, setPrices] = useState<PriceLog[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState('');
  const [usableDraft, setUsableDraft] = useState('');   // editing foods.usable_pct
  const [densityDraft, setDensityDraft] = useState(''); // editing foods.density (kg/L)
  const [lightbox, setLightbox] = useState<number | null>(null); // image_id being viewed
  const [error, setError] = useState<string | null>(null);

  // The two shared popups. pricePopup: { log } for edit, { log: null } for add.
  const [pricePopup, setPricePopup] = useState<{ log: PriceLog | null } | null>(null);
  const [showMacro, setShowMacro] = useState(false);
  const [showShare, setShowShare] = useState(false); // "use another food's nutrition"

  const flashError = (msg: string) => { setError(msg); setTimeout(() => setError(null), 3500); };

  const load = useCallback(async () => {
    try {
      const [foodRes, pricesRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/foods/${foodId}`),
        fetch(`${API_BASE_URL}/api/foods/${foodId}/prices`),
      ]);
      if (foodRes.ok) setFood(await foodRes.json());
      if (pricesRes.ok) setPrices(await pricesRes.json());
    } catch {
      flashError('Failed to load food.');
    } finally {
      setLoading(false);
    }
  }, [foodId]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`).then(r => (r.ok ? r.json() : [])).then(setStores).catch(() => {});
  }, []);

  // Notify the parent (e.g. diary) so newly added aliases/facts show up there.
  const changed = () => { load(); onChange?.(); };

  const addName = async () => {
    const alias = newName.trim();
    if (!alias) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }),
      });
      if (!res.ok) throw new Error();
      setNewName('');
      changed();
    } catch { flashError('Failed to add name.'); }
  };

  const deleteName = async (aliasId: number) => {
    try {
      await fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases/${aliasId}`, { method: 'DELETE' });
      changed();
    } catch { flashError('Failed to remove name.'); }
  };

  // Keep the usable-% / density inputs in sync with the loaded food.
  useEffect(() => { if (food) setUsableDraft(String(Number(food.usable_pct ?? 100))); }, [food]);
  useEffect(() => { if (food) setDensityDraft(String(Number(food.density ?? 1))); }, [food]);

  const saveUsable = async () => {
    const pct = Number(usableDraft);
    if (!(pct > 0)) { flashError('Usable % must be greater than 0.'); return; }
    if (food && pct === Number(food.usable_pct)) return; // no-op
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usable_pct: pct }),
      });
      if (!res.ok) throw new Error();
      changed();
    } catch { flashError('Failed to save usable %.'); }
  };

  const saveDensity = async () => {
    const d = Number(densityDraft);
    if (!(d > 0)) { flashError('Density must be greater than 0.'); return; }
    if (food && d === Number(food.density)) return; // no-op
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ density: d }),
      });
      if (!res.ok) throw new Error();
      changed();
    } catch { flashError('Failed to save density.'); }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <Modal onClose={onClose} zClass="z-[60]" maxWidth="max-w-2xl" panelClassName="bg-[#090d1a] border border-white/10 rounded-3xl p-6 lg:p-7 space-y-5" dataLoc="modal.food-detail">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white p-2 rounded-full hover:bg-white/5 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>

        {error && (
          <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>
        )}

        {loading || !food ? (
          <div className="py-12 text-center text-slate-500">Loading…</div>
        ) : (
          <>
            <div>
              <span className="badge text-[10px] text-violet-400 bg-violet-500/10 border-violet-500/20">{food.category}</span>
              <h2 className="text-2xl font-extrabold text-white mt-1.5">{food.name}</h2>
              <p className="text-xs text-slate-400 mt-1">Barcode: {food.barcode || 'N/A'}</p>
            </div>

            {/* Known Names — add a new name (alias) for this food */}
            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Known Names</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-white bg-violet-600/40 border border-violet-500/50 rounded-full px-3 py-1">★ {food.name}</span>
                {(food.aliases ?? []).map(a => (
                  <span key={a.id} className="group flex items-center gap-1.5 text-xs text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-full px-3 py-1">
                    {a.alias}
                    <button onClick={() => deleteName(a.id)} title="Remove name" className="text-sky-500/50 hover:text-rose-400 transition">×</button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addName(); }}
                  placeholder="Add another name for this food…"
                  className="flex-1 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500"
                />
                <button onClick={addName} className="px-3 py-1.5 rounded-lg bg-sky-600/20 border border-sky-500/30 text-sky-300 text-xs font-semibold hover:bg-sky-600/30 transition">
                  Add Name
                </button>
              </div>
            </div>

            {/* Nutrition — opens the shared MacroEditor popup, or shares facts
                with another food (two products, one nutrition profile). */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Nutrition Facts</span>
                <div className="flex items-center gap-3">
                  <button onClick={() => setShowShare(true)} className="text-[10px] font-semibold text-sky-400 hover:text-sky-300 transition">
                    Use another food&rsquo;s facts
                  </button>
                  <button onClick={() => setShowMacro(true)} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition">
                    {food.nutrition ? 'Edit Facts' : '+ Add Facts'}
                  </button>
                </div>
              </div>
              {food.nutrition ? (
                <div className="text-xs space-y-1">
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono font-bold">
                    {Math.round(Number(food.nutrition.calories))} kcal
                    <span className="font-normal text-emerald-400/60"> / {Number(food.nutrition.serving_size)} {food.nutrition.serving_unit}</span>
                  </span>
                  {/* Comparable basis: per 100 g (solid) / 100 ml (liquid) */}
                  {(() => {
                    const per100 = nutrientsPer100(food.nutrition!, food.unit);
                    if (!per100) return null;
                    return (
                      <span className="ml-2 px-2.5 py-1 rounded-lg bg-slate-500/10 border border-white/10 text-slate-300 font-mono font-bold" title="Comparable basis across foods">
                        {Math.round(per100.calories)} kcal
                        <span className="font-normal text-slate-500"> / {per100.label}</span>
                      </span>
                    );
                  })()}
                  {Number(food.nutrition.shared_food_count) > 1 && (
                    <p className="text-[10px] text-sky-400/80">
                      Shared with {Number(food.nutrition.shared_food_count) - 1} other food{Number(food.nutrition.shared_food_count) - 1 !== 1 ? 's' : ''} — editing these facts updates all of them.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-slate-600">No nutrition facts yet — add them, or reuse another food&rsquo;s, so this food can be logged by amount in the diary.</p>
              )}
            </div>

            {/* Usable portion — scales prices into an effective cost per usable unit */}
            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Usable Portion <span className="normal-case font-normal text-slate-600">— % of what you buy that's actually usable</span>
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number" min="1" step="1"
                  value={usableDraft}
                  onChange={e => setUsableDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveUsable(); }}
                  onBlur={saveUsable}
                  className="w-24 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-violet-500"
                />
                <span className="text-xs text-slate-500">% usable</span>
                <span className="text-[10px] text-slate-600">e.g. 70 = 30% bone/waste · &gt;100 for dry goods that expand</span>
              </div>
            </div>

            {/* Density — only for foods sold by volume; converts per-volume prices to per-kg */}
            {normalizeUnit(food.unit)?.dimension === 'volume' && (
              <div className="space-y-2">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                  Density <span className="normal-case font-normal text-slate-600">— kg per litre, to show volume prices per kg</span>
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0.01" step="0.01"
                    value={densityDraft}
                    onChange={e => setDensityDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveDensity(); }}
                    onBlur={saveDensity}
                    className="w-24 bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-violet-500"
                  />
                  <span className="text-xs text-slate-500">kg/L</span>
                  <span className="text-[10px] text-slate-600">water ≈ 1 · oil ≈ 0.92 · honey ≈ 1.42</span>
                </div>
              </div>
            )}

            {/* Prices — list only; add/edit go through the shared PriceEditor popup */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Price Logs</span>
                <button onClick={() => setPricePopup({ log: null })} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 transition">
                  + Add Price
                </button>
              </div>

              {prices.length === 0 ? (
                <p className="text-xs text-slate-600">No prices logged for this food yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {prices.map(log => (
                    <div key={log.id} className="panel p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {/* Attached source photo — click to view full size */}
                          {log.image_id ? (
                            <button onClick={() => setLightbox(log.image_id)} title="View attached photo" className="shrink-0">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`${API_BASE_URL}/api/images/${log.image_id}`} alt="source" className="h-9 w-9 object-cover rounded-lg border border-white/10 hover:border-violet-500/60 transition" />
                            </button>
                          ) : (
                            <div className="h-9 w-9 shrink-0 rounded-lg border border-white/5 bg-slate-900/60 flex items-center justify-center text-slate-700" title="No photo attached">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-bold text-white">${Number(log.price).toFixed(2)}</span>
                              {log.is_sale && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-400 font-bold border border-amber-500/20">SALE</span>}
                              <span className="text-slate-400 truncate">{log.store_name ?? '—'}</span>
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono">
                              {log.amount ? `${Number(log.amount)} ${log.amount_unit ?? ''} · ` : ''}
                              {formatCanonicalUnitPrice(Number(log.price), log.amount ? Number(log.amount) : null, log.amount_unit, food.density) ?? ''}
                              {' · '}{fmtDate(log.scraped_at)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => setPricePopup({ log })} className="text-[11px] font-bold text-violet-400 hover:text-violet-300">Edit</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>

      {/* Shared price popup (add or edit) */}
      {pricePopup && food && (
        <PriceEditor
          foodId={food.id}
          foodName={food.name}
          log={pricePopup.log as EditablePriceLog | null}
          stores={stores}
          usablePct={food.usable_pct}
          density={food.density}
          onClose={() => setPricePopup(null)}
          onSaved={changed}
          onDeleted={changed}
        />
      )}

      {/* Shared macros popup */}
      {showMacro && food && (
        <MacroEditor
          foodId={food.id}
          foodName={food.name}
          barcode={food.barcode}
          nutrition={food.nutrition}
          onClose={() => setShowMacro(false)}
          onSaved={changed}
        />
      )}

      {/* Share-nutrition popup: point this food at another food's profile */}
      {showShare && food && (
        <ShareNutritionModal
          foodId={food.id}
          foodName={food.name}
          onClose={() => setShowShare(false)}
          onShared={() => { setShowShare(false); changed(); }}
          onError={flashError}
        />
      )}

      {/* Photo lightbox */}
      {lightbox !== null && (
        <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-6" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${API_BASE_URL}/api/images/${lightbox}`} alt="Attached source photo" className="max-h-full max-w-full rounded-2xl border border-white/10 shadow-2xl" onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-5 right-5 text-white/70 hover:text-white p-2 rounded-full bg-black/40 hover:bg-black/60 transition">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </>
  );
}

// Pick another food that already has nutrition facts and point THIS food at that
// same profile (POST /api/foods/:id/nutrition/copy-from/:sourceId). Used for the
// "two different products, one underlying nutrition" case. Searches the catalog
// server-side and only offers foods that carry facts.
function ShareNutritionModal({ foodId, foodName, onClose, onShared, onError }: {
  foodId: number;
  foodName: string;
  onClose: () => void;
  onShared: () => void;
  onError: (msg: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: number; name: string; nutrition: NutritionFacts | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);

  // Debounced catalog search; keep only other foods that have nutrition to share.
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE_URL}/api/foods?search=${encodeURIComponent(q)}`);
        const data = res.ok ? await res.json() : [];
        setResults((data as any[])
          .filter(f => f.id !== foodId && f.nutrition && f.nutrition.serving_size != null)
          .slice(0, 30));
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [query, foodId]);

  const share = async (sourceId: number) => {
    setSavingId(sourceId);
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/nutrition/copy-from/${sourceId}`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to share nutrition');
      onShared();
    } catch (e: any) {
      onError(e?.message || 'Failed to share nutrition');
      setSavingId(null);
    }
  };

  return (
    <Modal onClose={onClose} zClass="z-[70]" maxWidth="max-w-md" dataLoc="modal.share-nutrition"
      panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">Use another food&rsquo;s nutrition
          <span className="block text-[10px] text-slate-500 font-normal">“{foodName}” will share the picked food&rsquo;s facts — editing either updates both.</span>
        </h3>
        <button onClick={onClose} className="text-slate-500 hover:text-white p-1 rounded-full hover:bg-white/5 transition">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <input type="text" value={query} onChange={e => setQuery(e.target.value)} autoFocus
        placeholder="Search foods with nutrition…"
        className="field-input w-full text-xs rounded-lg" />
      <div className="panel rounded-lg max-h-64 overflow-y-auto divide-y divide-white/5">
        {loading ? (
          <p className="text-[11px] text-slate-500 px-3 py-2">Searching…</p>
        ) : results.length === 0 ? (
          <p className="text-[11px] text-slate-500 px-3 py-2">{query.trim() ? 'No foods with nutrition match.' : 'Type to search foods that have nutrition facts.'}</p>
        ) : results.map(f => (
          <div key={f.id} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1 text-xs">
              <span className="text-slate-200 truncate block">{f.name}</span>
              <span className="text-[10px] font-mono text-emerald-400">
                {Math.round(Number(f.nutrition!.calories))} kcal / {Number(f.nutrition!.serving_size)} {f.nutrition!.serving_unit}
              </span>
            </div>
            <button type="button" onClick={() => share(f.id)} disabled={savingId !== null}
              className="shrink-0 text-[11px] font-semibold rounded-lg px-2.5 py-1 border transition text-sky-300 bg-sky-500/10 border-sky-500/20 hover:bg-sky-500/20 disabled:opacity-50">
              {savingId === f.id ? 'Sharing…' : 'Use these'}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
