"use client";

import React, { useState, useEffect } from 'react';
import { UNIT_OPTIONS, formatUnitPrice, parseAmountInput, normalizeUnit } from '../lib/units';
import { bestCatalogMatch } from '../lib/match';
import { nearestStore, GeoPoint } from '../lib/geo';
import FoodDetailModal from './FoodDetailModal';
import Modal from './Modal';
import ScanImages from './ScanImages';
import RawModelOutput, { ScanAttempt } from './RawModelOutput';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Raw extracted item shape (from a scan result), before catalog enrichment.
export interface RawItem {
  name: string;
  price: number;
  category?: string;
  unit?: string;
  barcode?: string | null;
  isSale?: boolean;
  // Printed sale end date from the scan (ISO YYYY-MM-DD), null when the image
  // didn't show one — the review then falls back to the configured default.
  saleEndsAt?: string | null;
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
  // Effective sale end date for this row. Seeded from the scan, else from the
  // app default, and editable per item — committing sends it with the price.
  saleEndsAt?: string | null;
  amount?: number | null;
  amountUnit?: string | null;
  // Raw text of the amount box while it's being typed ("2l" on the way to "2lb").
  // The input can't be driven by `amount` alone: re-rendering the parsed number
  // erases the half-typed unit suffix, so "lb" could never be finished. Cleared
  // on blur so the field falls back to the canonical number. Never committed.
  amountText?: string;
  matchedName?: string;
  matchScore?: number;
  needsReview?: boolean;
  reviewReason?: 'new_product' | 'price_anomaly';
  existingPrice?: number;
  existingFoodId?: number | null;
  approved?: boolean;
  // The user picked this catalog food by hand (auto-match missed or was wrong),
  // so show the link without a fuzzy score.
  manualMatch?: boolean;
}

// `foods.unit` for a food this review has to create. It is the food's own
// measuring unit (what a "1" of it means — drives the density input, the per-100
// nutrition basis and the dashboard fallback), NOT the size of this purchase —
// that's the price log's amount/amount_unit. The grid no longer asks for it
// separately: it's derived from how the item was purchased, since a row entered
// as "600 g" is a mass food, not the stale 'each' the scan defaulted to. Count
// units collapse to 'each' ("12 ct" of eggs is still measured in eggs).
const catalogUnitFor = (item: ScannedProduct): string => {
  const def = normalizeUnit(item.amountUnit);
  if (!def) return item.unit || 'each';
  return def.dimension === 'count' ? 'each' : (item.amountUnit as string);
};

interface Store { id: number; name: string; latitude?: string | number | null; longitude?: string | number | null; }

interface ReviewItemsProps {
  items: RawItem[];
  confidence?: number;
  defaultStoreId?: string;
  // Controlled store value from the parent (the inbox), so a store change in one
  // review panel can be broadcast to all open panels. When it changes, this
  // panel's selected store syncs to it. Falls back to defaultStoreId when unset.
  storeId?: string;
  // Called when the user confirms a manual store change. `applyToAll` carries the
  // "apply to all open reviews" checkbox so the parent can broadcast or not.
  onStoreChange?: (storeId: string, applyToAll: boolean) => void;
  // How many review panels are open in the parent — drives the "apply to all (N)"
  // copy and whether that checkbox is worth showing.
  openReviewCount?: number;
  source?: string; // 'scan' | 'queue' | 'manual'
  imageId?: number | null; // stored source photo; attached to every committed log
  // The full-res upload `imageId` was cropped from (null when never cropped).
  // Both are shown side by side so a bad crop is visible against its context.
  originalImageId?: number | null;
  gps?: GeoPoint | null; // EXIF GPS from the photo, for store auto-selection
  label?: string; // optional heading (e.g. the source filename in batch review)
  manualEntry?: boolean; // render the shell even with no items, so items can be added by hand
  rawText?: string | null; // the winning model's raw text extract (see RawModelOutput)
  attempts?: ScanAttempt[] | null; // per-model OCR trace from scan_jobs.attempts
  // Send this job back to /staging to be re-cropped and re-run — the recovery
  // path when OCR read the wrong region. Omitted where there's no job to restage.
  onRestage?: () => void;
  // Receipt context — present only for receipt-type scans. When set, the review
  // shows an editable receipt total + date and, on commit, records ONE spending
  // row (budget tracking). Must be a referentially-stable object (store it in the
  // caller's state, like `items`) so its init effect doesn't refire every render.
  receipt?: { total: number | null; purchasedOn: string | null; scanJobId?: number | null } | null;
  onCommitted?: () => void;
  onDiscard?: () => void;
  notify?: (text: string, type?: 'success' | 'error') => void;
}

interface NameMatch {
  matchedName?: string;
  matchScore?: number;
  needsReview: boolean;
  reviewReason?: 'new_product' | 'price_anomaly';
  existingPrice?: number;
  existingFoodId: number | null;
}

// Build the review fields for a matched catalog food: link its id, remember the
// catalog name if it differs from what was typed, and flag a >30% price gap.
function reviewFor(existing: any, name: string, price: number, score?: number): NameMatch {
  let needsReview = false;
  let reviewReason: NameMatch['reviewReason'];
  let existingPrice: number | undefined;
  const latestPriceRaw = existing.latest_prices?.[0]?.price;
  if (latestPriceRaw != null) {
    existingPrice = parseFloat(latestPriceRaw);
    if (existingPrice > 0 && Math.abs(price - existingPrice) / existingPrice > 0.3) {
      needsReview = true;
      reviewReason = 'price_anomaly';
    }
  }
  return {
    matchedName: existing.name.toLowerCase() !== name.toLowerCase() ? existing.name : undefined,
    matchScore: score,
    needsReview,
    reviewReason,
    existingPrice,
    existingFoodId: existing.id,
  };
}

// Match a product (scanned OR hand-typed) against the catalog and derive the
// review fields, so it links to an existing food (no duplicate) and flags price
// gaps. An exact **barcode** match wins over the fuzzy name match — that's what
// links "SM SF STEEVE SYRUP" to "Steeves Maple Syrup" and avoids a duplicate-
// barcode insert on commit. Every return path sets all keys so spreading the
// result clears any stale match when the name changes.
function computeMatch(name: string, price: number, foods: any[], barcode?: string | null): NameMatch {
  const noMatch: NameMatch = {
    matchedName: undefined, matchScore: undefined, needsReview: true,
    reviewReason: 'new_product', existingPrice: undefined, existingFoodId: null,
  };
  if (barcode) {
    const byBarcode = foods.find(f => f.barcode && String(f.barcode) === String(barcode));
    if (byBarcode) return reviewFor(byBarcode, name, price, 100);
  }
  if (!name.trim()) return noMatch;
  const match = bestCatalogMatch(name, foods);
  const existing = match?.food as any;
  if (!existing) return noMatch;
  return reviewFor(existing, name, price, match?.score);
}

export default function ReviewItems({
  items, confidence = 1, defaultStoreId = '1', storeId, onStoreChange, openReviewCount = 1,
  source = 'scan', imageId = null, originalImageId = null, gps = null,
  label, manualEntry = false, rawText = null, attempts = null, onRestage,
  receipt = null, onCommitted, onDiscard, notify,
}: ReviewItemsProps) {
  const [parsedItems, setParsedItems] = useState<ScannedProduct[]>([]);
  const [targetStoreId, setTargetStoreId] = useState<string>(storeId ?? defaultStoreId);
  const [stores, setStores] = useState<Store[]>([]);
  const [committing, setCommitting] = useState(false);
  const [geoMatchedStore, setGeoMatchedStore] = useState<string | null>(null);
  // Inline "create a new store" during review (no need to leave for the dashboard).
  const [addingStore, setAddingStore] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [savingStore, setSavingStore] = useState(false);
  // Store-change confirm popup: the newly-picked store id awaiting confirmation,
  // plus the "apply to all open reviews" choice (default on).
  const [pendingStore, setPendingStore] = useState<string | null>(null);
  const [applyToAll, setApplyToAll] = useState(true);
  // Store-delete confirm popup: the store being removed, how many rows reference
  // it, and where those rows should go ('' = leave unassigned).
  const [deletingStore, setDeletingStore] = useState<Store | null>(null);
  const [removingStore, setRemovingStore] = useState(false);
  const [storeUsage, setStoreUsage] = useState<{ price_logs: number; receipts: number; scan_jobs: number; scrape_jobs: number } | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');
  // Existing catalog food whose prices are being edited (shared editor).
  const [detailFoodId, setDetailFoodId] = useState<number | null>(null);
  // Cached catalog, so hand-edited names can be re-matched without a refetch.
  const [existingFoods, setExistingFoods] = useState<any[]>([]);
  // "Search existing items to add" box.
  const [searchQuery, setSearchQuery] = useState('');
  // Manual match picker: the index of the item being matched by hand, plus its query.
  const [matchFor, setMatchFor] = useState<number | null>(null);
  const [matchQuery, setMatchQuery] = useState('');
  // Receipt spending record (budget tracking): the receipt's total + date, shown
  // and editable when a receipt context is passed. Recorded once on commit.
  const [receiptTotal, setReceiptTotal] = useState('');
  const [receiptDate, setReceiptDate] = useState('');
  const [receiptSaved, setReceiptSaved] = useState(false);
  // Fallback sale length from /api/settings (mirrors app_settings.default_sale_days).
  const [defaultSaleDays, setDefaultSaleDays] = useState(7);
  const [bulkSaleEnd, setBulkSaleEnd] = useState('');

  const toast = (text: string, type: 'success' | 'error' = 'success') => notify?.(text, type);

  // The configured fallback sale length, used to show what a sale row will get
  // when the scan found no printed end date. The backend applies the same default
  // on write (resolveSaleEndsAt) — this is so the user can SEE and override it
  // before committing, not a second source of truth.
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/settings`)
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s?.default_sale_days) setDefaultSaleDays(Number(s.default_sale_days)); })
      .catch(() => {});
  }, []);

  const defaultSaleEnd = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + defaultSaleDays);
    return d.toISOString().slice(0, 10);
  }, [defaultSaleDays]);

  // What this row's sale will actually expire on: its own date if the scan read
  // one (or the user set one), otherwise the configured default.
  const effectiveSaleEnd = (item: ScannedProduct) => item.saleEndsAt || defaultSaleEnd;

  // Toggling a row's sale flag on adopts the default end date so the date field
  // is never left blank while is_sale is true; toggling off clears it.
  const setItemSale = (index: number, isSale: boolean) => {
    setParsedItems(prev => prev.map((it, i) =>
      i !== index ? it : { ...it, isSale, saleEndsAt: isSale ? (it.saleEndsAt || defaultSaleEnd) : null }
    ));
  };

  // Push one end date onto every sale row — the batch case, since a whole receipt
  // or flyer scan usually shares one sale period.
  const applySaleEndToAll = (date: string) => {
    if (!date) return;
    setParsedItems(prev => prev.map(it => it.isSale ? { ...it, saleEndsAt: date } : it));
    setBulkSaleEnd(date);
  };

  // (Re)initialize the receipt fields when a new receipt context arrives. The
  // caller must keep the `receipt` object referentially stable (see prop doc),
  // else this would clobber the user's edits every render.
  useEffect(() => {
    if (!receipt) return;
    setReceiptTotal(receipt.total != null ? String(receipt.total) : '');
    setReceiptDate(receipt.purchasedOn ?? new Date().toISOString().slice(0, 10));
    setReceiptSaved(false);
  }, [receipt]);

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

  // Create a store inline and select it, so a scan from an untracked store can be
  // committed without leaving the review for the dashboard.
  const createStore = async () => {
    const name = newStoreName.trim();
    if (!name) return;
    setSavingStore(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/stores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error();
      const store: Store = await res.json();
      setStores(prev => [...prev, store].sort((a, b) => a.name.localeCompare(b.name)));
      setNewStoreName('');
      setAddingStore(false);
      toast(`Added store "${store.name}".`);
      // Selecting a just-created store is still a store change, so with several
      // reviews open route it through the same confirm (to offer "apply to all").
      // With only one open there's nothing to ask — just select it.
      if (openReviewCount > 1) {
        setApplyToAll(true);
        setPendingStore(String(store.id));
      } else {
        setTargetStoreId(String(store.id));
        setGeoMatchedStore(null);
        onStoreChange?.(String(store.id), false);
      }
    } catch {
      toast('Failed to add store.', 'error');
    } finally {
      setSavingStore(false);
    }
  };

  // Sync the selected store when the parent broadcasts a change (another panel
  // picked a store with "apply to all"). Direct set — not a user action, so it
  // never opens the confirm popup.
  useEffect(() => {
    if (storeId != null) setTargetStoreId(storeId);
  }, [storeId]);

  // The store <select> only stages the change; the confirm popup applies it, so
  // the user can opt to push it to every open review at once.
  const requestStoreChange = (newId: string) => {
    if (newId === targetStoreId) return;
    setApplyToAll(true);
    setPendingStore(newId);
  };

  const confirmStoreChange = () => {
    if (pendingStore == null) return;
    const broadcast = applyToAll && openReviewCount > 1;
    setTargetStoreId(pendingStore);
    setGeoMatchedStore(null);
    // Always tell the parent so it keeps this panel's store in sync (broadcast=false
    // updates just this review; true updates all open reviews).
    onStoreChange?.(pendingStore, broadcast);
    setPendingStore(null);
  };

  // Open the remove-store confirm, loading how many rows reference it so the user
  // can decide where to reallocate them.
  const openDeleteStore = (store: Store) => {
    setDeletingStore(store);
    setStoreUsage(null);
    setReassignTo('');
    fetch(`${API_BASE_URL}/api/stores/${store.id}/usage`)
      .then(r => r.ok ? r.json() : null)
      .then(setStoreUsage)
      .catch(() => {});
  };

  // Soft-remove a store and reallocate everything that referenced it: to the picked
  // store, or unassigned when `reassignTo` is ''. Past prices are never deleted.
  const deleteStore = async () => {
    if (!deletingStore) return;
    setRemovingStore(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/stores/${deletingStore.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reassign_to: reassignTo === '' ? null : Number(reassignTo) }),
      });
      if (!res.ok) throw new Error();
      const body = await res.json().catch(() => null);
      const remaining = stores.filter(s => s.id !== deletingStore.id);
      setStores(remaining);
      // If this panel had the removed store selected, follow the reallocation
      // target when there is one, else fall back to whatever store is left.
      if (String(deletingStore.id) === targetStoreId) {
        const next = reassignTo !== '' ? reassignTo : (remaining[0] ? String(remaining[0].id) : '');
        setTargetStoreId(next);
        setGeoMatchedStore(null);
        if (next) onStoreChange?.(next, false);
      }
      const moved = body?.moved ? Object.values(body.moved as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
      const where = reassignTo !== ''
        ? ` — moved ${moved} item${moved === 1 ? '' : 's'} to "${stores.find(s => String(s.id) === reassignTo)?.name ?? 'the chosen store'}"`
        : moved > 0 ? ` — left ${moved} item${moved === 1 ? '' : 's'} unassigned` : '';
      toast(`Removed store "${deletingStore.name}"${where}.`);
      setDeletingStore(null);
    } catch {
      toast('Failed to remove store.', 'error');
    } finally {
      setRemovingStore(false);
    }
  };

  // Enrich raw items against the catalog whenever the input changes. The catalog
  // is cached in state too, so hand-edited names can be re-matched on the fly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const foodsRes = await fetch(`${API_BASE_URL}/api/foods`).catch(() => null);
      const foods: any[] = foodsRes && foodsRes.ok ? await foodsRes.json() : [];
      if (!cancelled) setExistingFoods(foods);
      const lowConfidence = confidence < 0.5;

      const enriched: ScannedProduct[] = items.map(item => {
        const m = computeMatch(item.name, Number(item.price), foods, item.barcode);
        let { needsReview, reviewReason } = m;
        if (lowConfidence && !needsReview) { needsReview = true; reviewReason = 'new_product'; }
        return {
          name: item.name,
          price: Number(item.price),
          category: item.category || 'Grocery',
          unit: item.unit || 'each',
          barcode: item.barcode ?? undefined,
          isSale: item.isSale ?? false,
          // Only what the scan actually read — a blank here renders (and commits)
          // as the configured default via effectiveSaleEnd, so the default can
          // change without this enrichment pass needing to re-run.
          saleEndsAt: item.saleEndsAt ?? null,
          amount: item.amount ?? null,
          // No unit extracted from the scan → default to count ('each').
          amountUnit: item.amountUnit ?? 'each',
          matchedName: m.matchedName,
          matchScore: m.matchScore,
          needsReview,
          reviewReason,
          existingPrice: m.existingPrice,
          existingFoodId: m.existingFoodId,
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

  // Re-match a hand-edited product name against the catalog (on blur) so a typed
  // name links to an existing food and re-flags price anomalies — the same match
  // logic scanned items get, applied to manual entry.
  const matchNameForItem = (index: number) => {
    setParsedItems(prev => prev.map((it, i) => {
      // A hand-picked match wins — never let auto-match clobber the user's choice
      // when they subsequently tweak the name.
      if (i !== index || it.manualMatch) return it;
      const m = computeMatch(it.name, Number(it.price), existingFoods, it.barcode);
      return { ...it, ...m, approved: !m.needsReview };
    }));
  };

  // Smart amount entry: "600g" → amount 600 + unit g (suffix stripped from the
  // number). A bare number with no unit selected defaults to count ('each').
  // The typed text is kept verbatim in `amountText` so multi-letter units survive
  // the keystroke that lands mid-suffix ("2l" → "2lb"); parsing runs on every
  // keystroke but an unrecognized suffix leaves the current unit alone.
  const setAmountFromInput = (index: number, raw: string) => {
    const { amount, unit } = parseAmountInput(raw);
    setParsedItems(prev => prev.map((it, i) =>
      i !== index ? it : { ...it, amount, amountText: raw, amountUnit: unit ?? it.amountUnit ?? 'each' }
    ));
  };

  // Drop the in-progress text once the field loses focus, so the box re-renders
  // from the parsed number (the unit lives in the dropdown next to it).
  const commitAmountInput = (index: number) =>
    setParsedItems(prev => prev.map((it, i) => (i !== index ? it : { ...it, amountText: undefined })));

  const approveItem = (index: number) => updateParsedItem(index, 'approved', true);
  const removeItem = (index: number) => setParsedItems(prev => prev.filter((_, i) => i !== index));

  // Manually add a blank line (used for unrecognized scans, or to add a missed item).
  const addItem = () => setParsedItems(prev => [...prev, {
    name: '', price: 0, category: 'Grocery', unit: 'each',
    amount: null, amountUnit: 'each', needsReview: true, reviewReason: 'new_product',
    existingFoodId: null, approved: false,
  }]);

  // Add a row already linked to an existing catalog food (from the search box),
  // prefilled with its latest price so the user just confirms/edits the price.
  const addExistingFood = (food: any) => {
    const latest = food.latest_prices?.[0]?.price;
    setParsedItems(prev => [...prev, {
      name: food.name,
      price: latest != null ? parseFloat(latest) : 0,
      category: food.category || 'Grocery',
      unit: food.unit || 'each',
      barcode: food.barcode ?? undefined,
      amount: null,
      amountUnit: UNIT_OPTIONS.includes(food.unit) ? food.unit : 'each',
      existingFoodId: food.id,
      needsReview: false,
      approved: true,
    }]);
    setSearchQuery('');
  };

  // Link a scanned item to a catalog food the user picked by hand — the fallback
  // when the barcode/fuzzy auto-match found nothing (or found the wrong food).
  // Reuses reviewFor so the price-anomaly flag still applies; commit then logs the
  // price against this food (and teaches the scanned name as an alias) instead of
  // creating a duplicate.
  const matchItemTo = (index: number, food: any) => {
    setParsedItems(prev => prev.map((it, i) => {
      if (i !== index) return it;
      const m = reviewFor(food, it.name, Number(it.price));
      // Always show what it's linked to, even if the names happen to be identical.
      return { ...it, ...m, matchedName: food.name, matchScore: undefined, manualMatch: true, approved: !m.needsReview };
    }));
    closeMatch();
  };

  // Force "create a new food" for this item, overriding any auto-match.
  const unmatchItem = (index: number) => {
    setParsedItems(prev => prev.map((it, i) => (
      i !== index ? it : {
        ...it, matchedName: undefined, matchScore: undefined, manualMatch: false,
        existingPrice: undefined, existingFoodId: null,
        needsReview: true, reviewReason: 'new_product' as const, approved: false,
      }
    )));
    closeMatch();
  };

  const openMatch = (index: number) => { setMatchFor(index); setMatchQuery(parsedItems[index]?.name ?? ''); };
  const closeMatch = () => { setMatchFor(null); setMatchQuery(''); };

  const pendingReviewCount = parsedItems.filter(i => i.needsReview && !i.approved).length;

  // Filter the cached catalog by name or barcode — shared by the "search existing
  // items to add" box and the manual match picker.
  const searchCatalog = (q: string, limit: number) => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return existingFoods.filter(f =>
      f.name.toLowerCase().includes(s) || (f.barcode && String(f.barcode).includes(s))
    ).slice(0, limit);
  };
  const searchResults = searchCatalog(searchQuery, 8);
  const matchResults = searchCatalog(matchQuery, 10);

  const commit = async () => {
    const toSave = parsedItems.filter(item => item.approved !== false);
    if (toSave.length === 0) { toast('No approved items to save.', 'error'); return; }

    setCommitting(true);
    let successCount = 0;
    const errors: string[] = [];
    const saved: ScannedProduct[] = [];
    try {
      const foodsRes = await fetch(`${API_BASE_URL}/api/foods`);
      const catalog: any[] = foodsRes.ok ? await foodsRes.json() : [];

      for (const item of toSave) {
        const labelName = item.name || 'Unnamed item';
        try {
          let foodId: number | null = item.existingFoodId ?? null;
          if (!foodId) {
            // Link to an existing food by **barcode** first (authoritative — avoids
            // a duplicate-barcode insert), then exact name, before creating a new one.
            const byBarcode = item.barcode
              ? catalog.find((f: any) => f.barcode && String(f.barcode) === String(item.barcode))
              : null;
            const byName = catalog.find((f: any) => f.name.toLowerCase() === item.name.toLowerCase());
            const existing = byBarcode || byName;
            if (existing) {
              foodId = existing.id;
            } else {
              const foodRes = await fetch(`${API_BASE_URL}/api/foods`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: item.name, category: item.category, unit: catalogUnitFor(item), barcode: item.barcode }),
              });
              if (foodRes.ok) {
                foodId = (await foodRes.json()).id;
              } else {
                const e = await foodRes.json().catch(() => ({}));
                errors.push(`${labelName}: ${e.error || `couldn't create food (HTTP ${foodRes.status})`}`);
                continue;
              }
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
                // Send the date the user actually saw in the grid, so what was on
                // screen is what gets stored (the backend would otherwise re-derive
                // its own default and could disagree with the displayed value).
                sale_ends_at: item.isSale ? effectiveSaleEnd(item) : null,
                amount: item.amount ?? null, amount_unit: item.amountUnit ?? null, source,
                image_id: imageId ?? null,
              }),
            });
            if (priceRes.ok) {
              successCount++;
              saved.push(item);
            } else {
              const e = await priceRes.json().catch(() => ({}));
              errors.push(`${labelName}: ${e.error || `couldn't save price (HTTP ${priceRes.status})`}`);
            }
          }
        } catch (err: any) {
          console.error('Error committing item:', labelName, err);
          errors.push(`${labelName}: ${err?.message || 'network error'}`);
        }
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

      // Record the shopping trip as ONE spending row (budget tracking) — only for
      // receipt scans, once, after at least one item committed. The receipt's own
      // total wins; a blank total falls back to the sum of the saved item prices.
      if (receipt && !receiptSaved && successCount > 0) {
        const typed = parseFloat(receiptTotal);
        const fallback = saved.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
        const total = receiptTotal.trim() !== '' && Number.isFinite(typed) ? typed : fallback;
        try {
          const rres = await fetch(`${API_BASE_URL}/api/receipts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              store_id: targetStoreId, total, purchased_on: receiptDate || null,
              item_count: saved.length, source: 'scan',
              image_id: imageId ?? null, scan_job_id: receipt.scanJobId ?? null,
            }),
          });
          if (rres.ok) setReceiptSaved(true);
          else console.error('Failed to record receipt spending:', await rres.text().catch(() => ''));
        } catch (e) { console.error('Failed to record receipt spending:', e); }
      }

      // Drop the rows that saved; keep any that failed so the user can fix them.
      const remaining = parsedItems.filter(it => !saved.includes(it));
      setParsedItems(remaining);

      if (errors.length > 0) {
        // Surface the real server error(s) — the full list also goes to the console.
        console.error('Commit errors:', errors);
        const extra = errors.length > 1 ? ` (+${errors.length - 1} more — see console)` : '';
        toast(`Saved ${successCount}. Failed — ${errors[0]}${extra}`, 'error');
      } else if (successCount > 0) {
        toast(`Saved ${successCount} item${successCount > 1 ? 's' : ''} to database!`);
      }
      // Close the whole review only when everything saved and nothing is left.
      if (successCount > 0 && remaining.length === 0) {
        onCommitted?.();
      }
    } catch (err: any) {
      console.error(err);
      toast(`Failed to connect to database${err?.message ? `: ${err.message}` : ''}.`, 'error');
    } finally {
      setCommitting(false);
    }
  };

  const hasRawText = !!(rawText && rawText.trim());
  const hasAttempts = !!(attempts && attempts.length > 0);
  if (parsedItems.length === 0 && !manualEntry && !hasRawText && !hasAttempts) return null;

  return (
    <div data-loc="component.review-items" className="card rounded-3xl p-6 space-y-6 animate-slide-up">
      {label && <div className="text-xs font-semibold text-slate-400 truncate">{label}</div>}

      {/* Source photo(s) alongside the extracted items — the crop that was read
          plus the uncropped original, so a bad crop is visible in context. */}
      <ScanImages imageId={imageId} originalImageId={originalImageId} />

      {parsedItems.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            No items detected. Add them manually below, check the raw model output, or re-crop this scan.
          </p>
          {onRestage && (
            <button onClick={onRestage}
              className="shrink-0 text-[11px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1 hover:bg-amber-500/20 transition"
              title="Send back to Staging to re-crop the original photo and run OCR again">
              Re-crop in Staging
            </button>
          )}
        </div>
      )}

      {/* What every model actually returned. Collapsed on a good scan; opened
          automatically when nothing parsed, which is when it's the main event. */}
      <RawModelOutput rawText={rawText} attempts={attempts}
        defaultOpen={parsedItems.length === 0} notify={toast} />

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
            <select value={targetStoreId} onChange={e => requestStoreChange(e.target.value)}
              className="bg-transparent text-xs text-white focus:outline-none">
              {stores.length > 0
                ? stores.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)
                : <><option value="1">SuperMarket Central</option><option value="2">Organic Grocer</option><option value="3">Value Foods</option></>}
            </select>
            <button type="button" onClick={() => { setAddingStore(v => !v); setNewStoreName(''); }}
              title="Create a new store"
              className="text-xs font-bold text-violet-300 hover:text-violet-200 px-1.5">
              {addingStore ? '×' : '+ New'}
            </button>
            {(() => { const sel = stores.find(s => String(s.id) === targetStoreId); return sel ? (
              <button type="button" onClick={() => openDeleteStore(sel)}
                title={`Remove "${sel.name}"`}
                className="text-xs font-bold text-slate-500 hover:text-rose-400 px-1">
                Remove
              </button>
            ) : null; })()}
          </div>
          {addingStore && (
            <div className="flex items-center gap-2 bg-slate-950 border border-white/5 p-2 rounded-xl">
              <input autoFocus value={newStoreName} onChange={e => setNewStoreName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createStore(); } }}
                placeholder="New store name" disabled={savingStore}
                className="flex-1 bg-transparent text-xs text-white placeholder:text-slate-600 focus:outline-none" />
              <button type="button" onClick={createStore} disabled={savingStore || !newStoreName.trim()}
                className="btn btn-primary rounded-lg px-3 py-1 text-[11px] disabled:opacity-50">
                {savingStore ? 'Adding…' : 'Add'}
              </button>
            </div>
          )}
          {geoMatchedStore && (
            <p className="text-[10px] text-emerald-400 text-right">📍 auto-selected by photo location: {geoMatchedStore}</p>
          )}
        </div>
      </div>

      {/* Receipt total + date (budget tracking) — receipt scans only */}
      {receipt && (
        <div data-loc="review-items.receipt" className="panel p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="field-label">Receipt total ($)</label>
            <input type="number" step="0.01" min="0" value={receiptTotal}
              onChange={e => setReceiptTotal(e.target.value)} placeholder="0.00"
              className="field-input w-28" />
          </div>
          <div>
            <label className="field-label">Purchased on</label>
            <input type="date" value={receiptDate}
              onChange={e => setReceiptDate(e.target.value)} className="field-input w-40" />
          </div>
          <p className="text-[11px] text-slate-500 flex-1 min-w-[12rem]">
            Recorded as a spending row for <span className="text-slate-300">budget tracking</span> when you save. A blank total falls back to the sum of saved item prices.
          </p>
          {receiptSaved && <span className="badge text-[9px] text-emerald-400 bg-emerald-500/10 border-emerald-500/20">✓ recorded</span>}
        </div>
      )}

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
                        onBlur={() => matchNameForItem(idx)}
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
                        {item.reviewReason === 'new_product' && (
                          <span className="text-slate-500 flex items-center gap-2">
                            Not found in database
                            <button onClick={() => openMatch(idx)}
                              className="text-sky-300 hover:text-sky-200 font-semibold underline decoration-dotted">
                              match to existing…
                            </button>
                          </span>
                        )}
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

      {/* ═══ Section: Sale expiry batch control ═══ */}
      {/* A scan is usually one shop or one flyer, so its sale rows nearly always
          share an end date — set it once here instead of per row. */}
      {parsedItems.some(it => it.isSale) && (
        <div data-loc="review-items.sale-expiry" className="panel p-3 flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-400">
            <span className="text-rose-300 font-semibold">{parsedItems.filter(it => it.isSale).length}</span> sale price
            {parsedItems.filter(it => it.isSale).length !== 1 ? 's' : ''} — hidden from the dashboard once expired.
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <label className="field-label mb-0">Set all sale end dates</label>
            <input type="date" value={bulkSaleEnd || defaultSaleEnd}
              onChange={e => applySaleEndToAll(e.target.value)}
              className="field-input text-xs rounded-lg py-1 w-[9rem]" />
          </div>
          {parsedItems.some(it => it.isSale && !it.saleEndsAt) && (
            <span className="text-[10px] text-slate-500 w-full">
              Rows shown in italics had no printed end date and default to {defaultSaleDays} days
              (change the default in Settings).
            </span>
          )}
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
              <th className="py-2 w-40">Amount</th>
              <th className="py-2 w-24">$ / Unit</th>
              <th className="py-2 w-40">Sale ends</th>
              <th className="py-2 w-24 text-center">Status</th>
              <th className="py-2 w-12 text-center"></th>
            </tr>
          </thead>
          <tbody>
            {parsedItems.map((item, idx) => (
              <tr key={idx} className={`border-b border-white/5 hover:bg-white/5 ${item.needsReview && !item.approved ? 'opacity-50' : ''}`}>
                <td className="py-2.5 pr-4">
                  <input type="text" value={item.name} onChange={e => updateParsedItem(idx, 'name', e.target.value)}
                    onBlur={() => matchNameForItem(idx)}
                    className="bg-transparent text-white font-semibold focus:outline-none border-b border-transparent focus:border-violet-500 w-full" />
                  {item.matchedName && (
                    <span className="text-[10px] text-sky-400 flex items-center gap-1 mt-0.5">
                      <span className="text-slate-500">matched:</span>{item.matchedName}
                      {item.matchScore != null && <span className="text-slate-500">({item.matchScore}%)</span>}
                      {item.manualMatch && <span className="text-slate-500">(chosen)</span>}
                    </span>
                  )}
                  <div className="flex items-center gap-3 mt-0.5">
                    {/* Pick the catalog item by hand when the auto-match missed or
                        picked the wrong food — links instead of creating a duplicate. */}
                    <button
                      type="button"
                      onClick={() => openMatch(idx)}
                      title={item.existingFoodId != null ? 'Link this item to a different catalog item' : 'Auto-match found nothing — pick the catalog item to link to'}
                      className="text-[10px] text-sky-300 hover:text-sky-200 flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 10-5.656-5.656l-1.1 1.1" /></svg>
                      {item.existingFoodId != null ? 'change match' : 'match…'}
                    </button>
                    {item.existingFoodId != null && (
                      <button
                        type="button"
                        onClick={() => setDetailFoodId(item.existingFoodId ?? null)}
                        title="Edit this food's existing prices & names"
                        className="text-[10px] text-violet-300 hover:text-violet-200 flex items-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        prices &amp; names
                      </button>
                    )}
                  </div>
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
                  <div className="flex items-center space-x-1">
                    <input type="text" inputMode="text" placeholder="e.g. 600g"
                      value={item.amountText ?? (item.amount ?? '')}
                      onChange={e => setAmountFromInput(idx, e.target.value)}
                      onBlur={() => commitAmountInput(idx)}
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
                {/* Sale + expiry. A sale price stops being real when the sale
                    ends, so the date is captured here rather than inferred later. */}
                <td className="py-2.5 pr-4">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 cursor-pointer select-none shrink-0"
                      title="Mark this as a promotional price that expires">
                      <input type="checkbox" checked={item.isSale ?? false}
                        onChange={e => setItemSale(idx, e.target.checked)}
                        className="accent-rose-500" />
                      <span className={item.isSale ? 'text-rose-300 font-semibold' : 'text-slate-500'}>sale</span>
                    </label>
                    {item.isSale && (
                      <input type="date" value={effectiveSaleEnd(item)}
                        onChange={e => updateParsedItem(idx, 'saleEndsAt', e.target.value || null)}
                        title={item.saleEndsAt ? 'Sale end date read from the scan (editable)' : `Not printed on the scan — defaulting to ${defaultSaleDays} days`}
                        className={`bg-transparent font-mono focus:outline-none border-b border-transparent focus:border-violet-500 w-[7.5rem] ${
                          item.saleEndsAt ? 'text-white' : 'text-slate-400 italic'}`} />
                    )}
                  </div>
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
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {/* Search the catalog and add an existing food to log a price against. */}
          <div className="relative flex-1 max-w-xs">
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search existing items to add…"
              className="field-input w-full text-xs rounded-xl" />
            {searchQuery.trim() !== '' && (
              <div className="absolute bottom-full mb-1 w-full max-h-56 overflow-y-auto bg-slate-900 border border-white/10 rounded-lg shadow-xl z-20">
                {searchResults.length === 0
                  ? <div className="px-3 py-2 text-[11px] text-slate-500">No matches — use &ldquo;Add Item&rdquo; to create it.</div>
                  : searchResults.map(f => (
                    <button key={f.id} type="button" onClick={() => addExistingFood(f)}
                      className="w-full text-left px-3 py-2 text-xs text-white hover:bg-white/5 flex items-center justify-between gap-2 transition">
                      <span className="truncate">{f.name}</span>
                      <span className="text-[10px] text-slate-500 shrink-0">{f.category}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          <button onClick={addItem}
            className="flex items-center gap-1.5 text-xs font-semibold text-violet-300 hover:text-violet-200 bg-violet-500/10 border border-violet-500/20 rounded-xl px-4 py-2.5 transition shrink-0">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Item
          </button>
        </div>
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

      {/* Manual match picker — the fallback when auto-match (barcode, then fuzzy
          name) finds nothing or the wrong food. A Modal, not an inline dropdown:
          the grid sits in an `overflow-x-auto` wrapper, which makes overflow-y
          `auto` too and would clip an absolutely-positioned list. */}
      {matchFor !== null && parsedItems[matchFor] && (
        <Modal onClose={closeMatch} dataLoc="modal.match-item" maxWidth="max-w-lg"
          panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">
              Match to an existing item
              <span className="block text-[10px] text-slate-500 font-normal">
                Scanned as &ldquo;{parsedItems[matchFor].name || 'Unnamed item'}&rdquo; — link it to a catalog item instead of creating a duplicate.
              </span>
            </h3>
            <button onClick={closeMatch} className="text-slate-500 hover:text-white p-1 rounded-full hover:bg-white/5 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <input type="text" value={matchQuery} onChange={e => setMatchQuery(e.target.value)}
            placeholder="Search the catalog by name or barcode…" autoFocus
            className="field-input w-full text-xs rounded-lg" />

          <div className="panel rounded-lg max-h-64 overflow-y-auto divide-y divide-white/5">
            {matchQuery.trim() === '' ? (
              <p className="text-[11px] text-slate-500 px-3 py-2">Type to search your catalog.</p>
            ) : matchResults.length === 0 ? (
              <p className="text-[11px] text-slate-500 px-3 py-2">No catalog match — create it as a new item instead.</p>
            ) : matchResults.map(f => {
              const latest = f.latest_prices?.[0]?.price;
              return (
                <button key={f.id} type="button" onClick={() => matchItemTo(matchFor, f)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 transition flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-xs text-white truncate">{f.name}</span>
                    {f.barcode && <span className="block text-[10px] font-mono text-slate-600">{f.barcode}</span>}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[10px] text-slate-500">{f.category}</span>
                    {latest != null && <span className="block text-[10px] font-mono text-emerald-400">${Number(latest).toFixed(2)}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => unmatchItem(matchFor)} className="btn btn-secondary rounded-lg px-4 py-2 text-xs"
              title="Ignore any match and create this as a brand-new catalog item">
              Create as a new item
            </button>
            <button onClick={closeMatch} className="btn btn-secondary rounded-lg px-4 py-2 text-xs">Cancel</button>
          </div>
        </Modal>
      )}

      {/* Shared price/name editor for an already-cataloged item (inbox access) */}
      {detailFoodId !== null && (
        <FoodDetailModal foodId={detailFoodId} onClose={() => setDetailFoodId(null)} />
      )}

      {/* ═══ Section: Store-change confirm ═══ */}
      {pendingStore !== null && (
        <Modal onClose={() => setPendingStore(null)} dataLoc="modal.store-change" maxWidth="max-w-md"
          panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-white">Change store?</h3>
          <p className="text-xs text-slate-400">
            Set the store to <span className="text-white font-semibold">{stores.find(s => String(s.id) === pendingStore)?.name ?? 'this store'}</span> for this scan.
          </p>
          {openReviewCount > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input type="checkbox" checked={applyToAll} onChange={e => setApplyToAll(e.target.checked)}
                className="accent-violet-500" />
              Apply to all {openReviewCount} open reviews
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setPendingStore(null)} className="btn btn-secondary rounded-lg px-4 py-2 text-xs">Cancel</button>
            <button onClick={confirmStoreChange} className="btn btn-primary rounded-lg px-4 py-2 text-xs">
              {applyToAll && openReviewCount > 1 ? 'Change all' : 'Change'}
            </button>
          </div>
        </Modal>
      )}

      {/* ═══ Section: Store-remove confirm ═══ */}
      {deletingStore !== null && (
        <Modal onClose={() => !removingStore && setDeletingStore(null)} dataLoc="modal.store-remove" maxWidth="max-w-md"
          panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-white">Remove store?</h3>
          <p className="text-xs text-slate-400">
            Remove <span className="text-white font-semibold">{deletingStore.name}</span> from the store list. Nothing is deleted — its prices, receipts and scans are reallocated below.
          </p>

          {/* What references this store */}
          {(() => {
            if (!storeUsage) return <p className="text-[11px] text-slate-500">Checking what uses this store…</p>;
            const parts = [
              [storeUsage.price_logs, 'price log'], [storeUsage.receipts, 'receipt'],
              [storeUsage.scan_jobs, 'scan'], [storeUsage.scrape_jobs, 'scrape'],
            ].filter(([n]) => (n as number) > 0)
             .map(([n, label]) => `${n} ${label}${(n as number) === 1 ? '' : 's'}`);
            return (
              <p className="text-[11px] text-slate-400 panel p-2">
                {parts.length === 0 ? 'Nothing references this store.' : `References: ${parts.join(', ')}.`}
              </p>
            );
          })()}

          <div className="space-y-1">
            <label className="field-label">Move its items to</label>
            <select value={reassignTo} onChange={e => setReassignTo(e.target.value)} disabled={removingStore}
              className="field-input w-full">
              <option value="">Leave unassigned (no store)</option>
              {stores.filter(s => s.id !== deletingStore.id).map(s => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500">
              {reassignTo === ''
                ? 'Items keep their history but will have no store attached.'
                : 'Every price, receipt and scan from this store moves to the chosen store.'}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setDeletingStore(null)} disabled={removingStore} className="btn btn-secondary rounded-lg px-4 py-2 text-xs disabled:opacity-50">Cancel</button>
            <button onClick={deleteStore} disabled={removingStore}
              className="btn btn-primary rounded-lg px-4 py-2 text-xs bg-rose-600 hover:bg-rose-500 disabled:opacity-50">
              {removingStore ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
