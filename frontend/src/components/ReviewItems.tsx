"use client";

import React, { useState, useEffect } from 'react';
import { UNIT_OPTIONS, formatUnitPrice, parseAmountInput } from '../lib/units';
import { bestCatalogMatch } from '../lib/match';
import { nearestStore, GeoPoint } from '../lib/geo';
import FoodDetailModal from './FoodDetailModal';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Raw extracted item shape (from a scan result), before catalog enrichment.
export interface RawItem {
  name: string;
  price: number;
  category?: string;
  unit?: string;
  barcode?: string | null;
  isSale?: boolean;
  amount?: number | null;
  amountUnit?: string | null;
}

interface ScannedProduct {
  name: string;
  price: number;
  barcode?: string;
  category: string;
  unit: string;
  isSale?: boolean;
  amount?: number | null;
  amountUnit?: string | null;
  matchedName?: string;
  matchScore?: number;
  needsReview?: boolean;
  reviewReason?: 'new_product' | 'price_anomaly';
  existingPrice?: number;
  existingFoodId?: number | null;
  approved?: boolean;
}

interface Store { id: number; name: string; latitude?: string | number | null; longitude?: string | number | null; }

interface ReviewItemsProps {
  items: RawItem[];
  confidence?: number;
  defaultStoreId?: string;
  source?: string; // 'scan' | 'queue' | 'manual'
  imageId?: number | null; // stored source photo; attached to every committed log
  imageSrc?: string | null; // URL to preview the source photo alongside the scan
  gps?: GeoPoint | null; // EXIF GPS from the photo, for store auto-selection
  label?: string; // optional heading (e.g. the source filename in batch review)
  manualEntry?: boolean; // render the shell even with no items, so items can be added by hand
  onCommitted?: () => void;
  onDiscard?: () => void;
  notify?: (text: string, type?: 'success' | 'error') => void;
}

export default function ReviewItems({
  items, confidence = 1, defaultStoreId = '1', source = 'scan', imageId = null, imageSrc = null, gps = null,
  label, manualEntry = false, onCommitted, onDiscard, notify,
}: ReviewItemsProps) {
  const [parsedItems, setParsedItems] = useState<ScannedProduct[]>([]);
  const [targetStoreId, setTargetStoreId] = useState<string>(defaultStoreId);
  const [stores, setStores] = useState<Store[]>([]);
  const [committing, setCommitting] = useState(false);
  const [geoMatchedStore, setGeoMatchedStore] = useState<string | null>(null);
  // Existing catalog food whose prices are being edited (shared editor).
  const [detailFoodId, setDetailFoodId] = useState<number | null>(null);

  const toast = (text: string, type: 'success' | 'error' = 'success') => notify?.(text, type);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`)
      .then(r => r.ok ? r.json() : [])
      .then((list: Store[]) => {
        setStores(list);
        // Photo has GPS: auto-select the nearest known store within ~200m.
        if (gps) {
          const near = nearestStore(gps, list);
          if (near) {
            setTargetStoreId(String(near.store.id));
            setGeoMatchedStore(`${near.store.name} (~${Math.round(near.distance)}m away)`);
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gps]);

  // Enrich raw items against the catalog whenever the input changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const foodsRes = await fetch(`${API_BASE_URL}/api/foods`).catch(() => null);
      const existingFoods: any[] = foodsRes && foodsRes.ok ? await foodsRes.json() : [];
      const lowConfidence = confidence < 0.5;

      const enriched: ScannedProduct[] = items.map(item => {
        const match = bestCatalogMatch(item.name, existingFoods);
        const existing = match?.food as any;

        let needsReview = false;
        let reviewReason: ScannedProduct['reviewReason'];
        let existingPrice: number | undefined;
        let existingFoodId: number | null = null;

        if (!existing) {
          needsReview = true;
          reviewReason = 'new_product';
        } else {
          existingFoodId = existing.id;
          const latestPriceRaw = existing.latest_prices?.[0]?.price;
          if (latestPriceRaw != null) {
            existingPrice = parseFloat(latestPriceRaw);
            const diff = Math.abs(item.price - existingPrice) / existingPrice;
            if (diff > 0.3) { needsReview = true; reviewReason = 'price_anomaly'; }
          }
        }
        if (lowConfidence && !needsReview) { needsReview = true; reviewReason = 'new_product'; }

        return {
          name: item.name,
          price: Number(item.price),
          category: item.category || 'Grocery',
          unit: item.unit || 'each',
          barcode: item.barcode ?? undefined,
          isSale: item.isSale ?? false,
          amount: item.amount ?? null,
          // No unit extracted from the scan → default to count ('each'), matching
          // the manual-entry behavior below.
          amountUnit: item.amountUnit ?? 'each',
          matchedName: existing && existing.name.toLowerCase() !== item.name.toLowerCase() ? existing.name : undefined,
          matchScore: match?.score,
          needsReview,
          reviewReason,
          existingPrice,
          existingFoodId,
          approved: !needsReview,
        };
      });
      if (!cancelled) setParsedItems(enriched);
    })();
    return () => { cancelled = true; };
  }, [items, confidence]);

  const updateParsedItem = (index: number, field: keyof ScannedProduct, value: any) => {
    setParsedItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  // Smart amount entry: "600g" → amount 600 + unit g (suffix stripped from the
  // number). A bare number with no unit selected defaults to count ('each').
  const setAmountFromInput = (index: number, raw: string) => {
    const { amount, unit } = parseAmountInput(raw);
    setParsedItems(prev => prev.map((it, i) =>
      i !== index ? it : { ...it, amount, amountUnit: unit ?? it.amountUnit ?? 'each' }
    ));
  };

  const approveItem = (index: number) => updateParsedItem(index, 'approved', true);
  const removeItem = (index: number) => setParsedItems(prev => prev.filter((_, i) => i !== index));

  // Manually add a blank line (used for unrecognized scans, or to add a missed item).
  const addItem = () => setParsedItems(prev => [...prev, {
    name: '', price: 0, category: 'Grocery', unit: 'each',
    amount: null, amountUnit: 'each', needsReview: true, reviewReason: 'new_product',
    existingFoodId: null, approved: false,
  }]);

  const pendingReviewCount = parsedItems.filter(i => i.needsReview && !i.approved).length;

  const commit = async () => {
    const toSave = parsedItems.filter(item => item.approved !== false);
    if (toSave.length === 0) { toast('No approved items to save.', 'error'); return; }

    setCommitting(true);
    let successCount = 0;
    try {
      const foodsRes = await fetch(`${API_BASE_URL}/api/foods`);
      const existingFoods: any[] = foodsRes.ok ? await foodsRes.json() : [];

      for (const item of toSave) {
        try {
          let foodId: number | null = item.existingFoodId ?? null;
          if (!foodId) {
            const match = existingFoods.find((f: any) => f.name.toLowerCase() === item.name.toLowerCase());
            if (match) {
              foodId = match.id;
            } else {
              const foodRes = await fetch(`${API_BASE_URL}/api/foods`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: item.name, category: item.category, unit: item.unit, barcode: item.barcode }),
              });
              if (foodRes.ok) foodId = (await foodRes.json()).id;
            }
          } else if (item.matchedName && item.name.toLowerCase() !== item.matchedName.toLowerCase()) {
            // User verified this fuzzy match by committing it — remember the
            // scanned name as an alias so future scans match at 100%.
            fetch(`${API_BASE_URL}/api/foods/${foodId}/aliases`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ alias: item.name }),
            }).catch(() => {});
          }
          if (foodId) {
            const priceRes = await fetch(`${API_BASE_URL}/api/foods/${foodId}/prices`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                store_id: targetStoreId, price: item.price, is_sale: item.isSale ?? false,
                amount: item.amount ?? null, amount_unit: item.amountUnit ?? null, source,
                image_id: imageId ?? null,
              }),
            });
            if (priceRes.ok) successCount++;
          }
        } catch (err) { console.error('Error committing item:', err); }
      }

      // Teach the selected store its location from the photo's GPS (first time only).
      if (successCount > 0 && gps) {
        const chosen = stores.find(s => String(s.id) === String(targetStoreId));
        if (chosen && (chosen.latitude == null || chosen.longitude == null)) {
          fetch(`${API_BASE_URL}/api/stores/${chosen.id}/location`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: gps.lat, longitude: gps.lng }),
          }).catch(() => {});
        }
      }

      if (successCount > 0) {
        toast(`Saved ${successCount} item${successCount > 1 ? 's' : ''} to database!`);
        setParsedItems([]);
        onCommitted?.();
      } else {
        toast('Failed to save items to database.', 'error');
      }
    } catch (err) {
      console.error(err);
      toast('Failed to connect to database.', 'error');
    } finally {
      setCommitting(false);
    }
  };

  if (parsedItems.length === 0 && !manualEntry) return null;

  return (
    <div data-loc="component.review-items" className="card rounded-3xl p-6 space-y-6 animate-slide-up">
      {label && <div className="text-xs font-semibold text-slate-400 truncate">{label}</div>}

      {/* Source photo shown alongside the extracted items */}
      {imageSrc && (
        <div className="flex justify-center">
          <a href={imageSrc} target="_blank" rel="noreferrer" title="Open full image" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageSrc} alt="scanned source"
              className="max-h-64 w-auto rounded-xl border border-white/10 hover:border-violet-500/50 transition" />
          </a>
        </div>
      )}

      {parsedItems.length === 0 && (
        <p className="text-sm text-slate-400">
          No items detected. Add them manually below, or discard this scan.
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">Review Extracted Items</h2>
          <p className="text-xs text-slate-400">
            {parsedItems.length === 0
              ? 'Click "Add Item" to enter a product by hand.'
              : pendingReviewCount > 0
              ? `${pendingReviewCount} item${pendingReviewCount > 1 ? 's' : ''} require approval before saving.`
              : 'All items verified. Select store and save.'}
          </p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center space-x-3 bg-slate-950 border border-white/5 p-2 rounded-xl">
            <span className="text-xs text-slate-500 font-semibold uppercase pl-1">Store Bought:</span>
            <select value={targetStoreId} onChange={e => { setTargetStoreId(e.target.value); setGeoMatchedStore(null); }}
              className="bg-transparent text-xs text-white focus:outline-none">
              {stores.length > 0
                ? stores.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)
                : <><option value="1">SuperMarket Central</option><option value="2">Organic Grocer</option><option value="3">Value Foods</option></>}
            </select>
          </div>
          {geoMatchedStore && (
            <p className="text-[10px] text-emerald-400 text-right">📍 auto-selected by photo location: {geoMatchedStore}</p>
          )}
        </div>
      </div>

      {/* Flagged items */}
      {pendingReviewCount > 0 && (
        <div className="bg-amber-950/20 border border-amber-500/20 rounded-2xl p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.539-1.333-3.309 0L3.178 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm font-bold text-amber-300">
              {pendingReviewCount} Item{pendingReviewCount > 1 ? 's' : ''} Need Your Review
            </span>
          </div>
          <div className="space-y-2">
            {parsedItems.map((item, idx) => {
              if (!item.needsReview || item.approved) return null;
              const pctDiff = item.existingPrice != null
                ? ((Math.abs(item.price - item.existingPrice) / item.existingPrice) * 100).toFixed(0) : null;
              return (
                <div key={idx} className="bg-slate-900/70 border border-amber-500/15 rounded-xl p-3">
                  <div className="flex gap-3 items-start">
                    <div className="shrink-0 mt-0.5">
                      {item.reviewReason === 'new_product'
                        ? <span className="badge text-[9px] text-violet-300 bg-violet-500/15 border-violet-500/25">NEW</span>
                        : <span className="badge text-[9px] text-amber-300 bg-amber-500/15 border-amber-500/25">⚠ PRICE</span>}
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <input type="text" value={item.name} onChange={e => updateParsedItem(idx, 'name', e.target.value)}
                        className="bg-transparent text-white font-semibold text-sm focus:outline-none border-b border-transparent focus:border-violet-500 w-full" />
                      <div className="flex items-center gap-3 text-xs">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-500">$</span>
                          <input type="number" step="0.01" value={item.price}
                            onChange={e => updateParsedItem(idx, 'price', parseFloat(e.target.value) || 0)}
                            className="bg-transparent text-white font-mono focus:outline-none border-b border-transparent focus:border-violet-500 w-16" />
                        </div>
                        {item.reviewReason === 'price_anomaly' && item.existingPrice != null && (
                          <span className="text-slate-500">
                            DB price: <span className="font-mono text-slate-300">${item.existingPrice.toFixed(2)}</span>{' '}
                            <span className={Number(pctDiff) > 0 ? 'text-rose-400' : 'text-emerald-400'}>
                              ({Number(item.price) > item.existingPrice ? '+' : '-'}{pctDiff}%)
                            </span>
                          </span>
                        )}
                        {item.reviewReason === 'new_product' && <span className="text-slate-500">Not found in database</span>}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => approveItem(idx)}
                        className="text-[11px] bg-emerald-600/80 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg font-bold transition">Approve</button>
                      <button onClick={() => removeItem(idx)}
                        className="text-[11px] bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 px-3 py-1.5 rounded-lg font-bold transition">Remove</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Full grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-white/5 text-slate-500">
              <th className="py-2">Product Name</th>
              <th className="py-2 w-24">Price</th>
              <th className="py-2 w-28">Category</th>
              <th className="py-2 w-16">Unit</th>
              <th className="py-2 w-40">Amount</th>
              <th className="py-2 w-24">$ / Unit</th>
              <th className="py-2 w-24 text-center">Status</th>
              <th className="py-2 w-12 text-center"></th>
            </tr>
          </thead>
          <tbody>
            {parsedItems.map((item, idx) => (
              <tr key={idx} className={`border-b border-white/5 hover:bg-white/5 ${item.needsReview && !item.approved ? 'opacity-50' : ''}`}>
                <td className="py-2.5 pr-4">
                  <input type="text" value={item.name} onChange={e => updateParsedItem(idx, 'name', e.target.value)}
                    className="bg-transparent text-white font-semibold focus:outline-none border-b border-transparent focus:border-violet-500 w-full" />
                  {item.matchedName && (
                    <span className="text-[10px] text-sky-400 flex items-center gap-1 mt-0.5">
                      <span className="text-slate-500">matched:</span>{item.matchedName}
                      {item.matchScore != null && <span className="text-slate-500">({item.matchScore}%)</span>}
                    </span>
                  )}
                  {item.existingFoodId != null && (
                    <button
                      type="button"
                      onClick={() => setDetailFoodId(item.existingFoodId ?? null)}
                      title="Edit this food's existing prices & names"
                      className="text-[10px] text-violet-300 hover:text-violet-200 mt-0.5 flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      prices &amp; names
                    </button>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <div className="flex items-center space-x-1">
                    <span className="text-slate-500">$</span>
                    <input type="number" step="0.01" value={item.price}
                      onChange={e => updateParsedItem(idx, 'price', parseFloat(e.target.value) || 0)}
                      className="bg-transparent text-white font-bold font-mono focus:outline-none border-b border-transparent focus:border-violet-500 w-16" />
                  </div>
                </td>
                <td className="py-2.5 pr-4">
                  <select value={item.category} onChange={e => updateParsedItem(idx, 'category', e.target.value)}
                    className="bg-transparent text-violet-400 font-semibold focus:outline-none w-full">
                    {['Fruits','Vegetables','Dairy','Bakery','Meat','Beverages','Pantry','Grocery'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="py-2.5 pr-4">
                  <input type="text" value={item.unit} onChange={e => updateParsedItem(idx, 'unit', e.target.value)}
                    className="bg-transparent text-slate-400 focus:outline-none border-b border-transparent focus:border-violet-500 w-12" />
                </td>
                <td className="py-2.5 pr-4">
                  <div className="flex items-center space-x-1">
                    <input type="text" inputMode="text" placeholder="e.g. 600g" value={item.amount ?? ''}
                      onChange={e => setAmountFromInput(idx, e.target.value)}
                      title="Type a number with a unit (e.g. 600g, 2lb) to auto-fill both fields"
                      className="bg-transparent text-white font-mono focus:outline-none border-b border-transparent focus:border-violet-500 w-16" />
                    <select value={item.amountUnit ?? 'each'} onChange={e => updateParsedItem(idx, 'amountUnit', e.target.value)}
                      className="bg-transparent text-slate-400 focus:outline-none">
                      {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </td>
                <td className="py-2.5 pr-4">
                  {(() => {
                    const label = formatUnitPrice(item.price, item.amount, item.amountUnit);
                    return label ? <span className="font-mono text-emerald-400">{label}</span> : <span className="text-slate-600">—</span>;
                  })()}
                </td>
                <td className="py-2.5 text-center">
                  {!item.needsReview
                    ? <span className="badge text-[9px] text-emerald-400 bg-emerald-500/10 border-emerald-500/20">✓ OK</span>
                    : item.approved
                    ? <span className="badge text-[9px] text-emerald-400 bg-emerald-500/10 border-emerald-500/20">✓ Approved</span>
                    : <button onClick={() => approveItem(idx)} className="badge text-[9px] text-amber-400 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20 transition">Approve</button>}
                </td>
                <td className="py-2.5 text-center">
                  <button onClick={() => removeItem(idx)} title="Remove this item" aria-label="Remove item"
                    className="text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg p-1.5 transition">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center gap-3 border-t border-white/5 pt-4">
        <button onClick={addItem}
          className="flex items-center gap-1.5 text-xs font-semibold text-violet-300 hover:text-violet-200 bg-violet-500/10 border border-violet-500/20 rounded-xl px-4 py-2.5 transition">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Item
        </button>
        <div className="flex gap-3">
        <button onClick={() => { setParsedItems([]); onDiscard?.(); }}
          className="bg-white/5 border border-white/5 rounded-xl px-5 py-2.5 text-xs text-white font-semibold hover:bg-white/10 transition">
          Discard All
        </button>
        <button onClick={commit} disabled={pendingReviewCount > 0 || committing || parsedItems.length === 0}
          className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl px-6 py-2.5 text-xs font-semibold hover:shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          title={pendingReviewCount > 0 ? 'Approve all flagged items first' : ''}>
          {committing ? 'Saving...' : pendingReviewCount > 0
            ? `Approve ${pendingReviewCount} Item${pendingReviewCount > 1 ? 's' : ''} First`
            : 'Save & Log Prices'}
        </button>
        </div>
      </div>

      {/* Shared price/name editor for an already-cataloged item (inbox access) */}
      {detailFoodId !== null && (
        <FoodDetailModal foodId={detailFoodId} onClose={() => setDetailFoodId(null)} />
      )}
    </div>
  );
}
