"use client";

// Catalog audit: bulk-review everything in `foods` and clean it up. The cocowest
// scraper logs every item in a Costco flyer post — including non-food (phones,
// luggage, detergent) — so this is where that noise gets archived, recategorized
// or tagged en masse. Archiving is a soft delete (foods.deleted_at): archived
// foods drop out of every catalog read but can be restored from the Archived tab.
//
// Selection supports the usual desktop idioms: click toggles, ctrl/cmd+click
// toggles, shift+click selects the range from the last clicked row.
//
// The AI auto-tagger (POST /api/foods/auto-tag) only ever PROPOSES tags — the
// draft is reviewed here and applied explicitly via POST /api/foods/apply-tags,
// the same human-in-the-loop rule as OCR and AI meal drafting.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import StatusToast, { useToast } from '../../components/StatusToast';
import FoodDetailModal from '../../components/FoodDetailModal';
import Modal from '../../components/Modal';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { NutritionFacts, formatCaloriesPer100 } from '../../lib/nutrition';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Tag { id: number; name: string; food_count?: number }

interface AuditFood {
  id: number;
  name: string;
  category: string;
  unit: string;
  barcode: string | null;
  display_image_id: number | null;
  nutrition: NutritionFacts | null;
  latest_prices: { price: string; store_name: string }[] | null;
  tags: Tag[] | null;
}

interface Suggestion { food_id: number; food_name: string; tag_ids: number[] }

export default function Audit() {
  const [foods, setFoods] = useState<AuditFood[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('All');
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null); // last clicked row index, for shift-range
  const [newCategory, setNewCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailFoodId, setDetailFoodId] = useState<number | null>(null);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);   // manual merge of selected foods
  const [dupOpen, setDupOpen] = useState(false);        // AI "find duplicates"
  const { statusMsg, notify } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${API_BASE_URL}/api/foods${tab === 'archived' ? '?deleted=1' : ''}`)
      .then(r => (r.ok ? r.json() : []))
      .then((d: AuditFood[]) => { setFoods(d); setSelected([]); setAnchor(null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tab]);

  const loadTags = useCallback(() => {
    fetch(`${API_BASE_URL}/api/tags`).then(r => (r.ok ? r.json() : [])).then(setTags).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTags(); }, [loadTags]);

  const categories = useMemo(() => {
    const out: string[] = [];
    for (const f of foods) if (f.category && out.indexOf(f.category) === -1) out.push(f.category);
    return out.sort();
  }, [foods]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return foods.filter(f =>
      (cat === 'All' || f.category === cat) &&
      (tagFilter === null || (f.tags ?? []).some(t => t.id === tagFilter)) &&
      (!q || f.name.toLowerCase().includes(q) || (f.barcode || '').includes(q))
    );
  }, [foods, search, cat, tagFilter]);

  // Any filter change invalidates the shift-range anchor (indices shift).
  useEffect(() => { setAnchor(null); }, [search, cat, tagFilter]);

  const allSelected = filtered.length > 0 && filtered.every(f => selected.includes(f.id));

  // Click semantics: shift = select the range from the anchor; ctrl/cmd or a
  // plain click = toggle one. The anchor is the last row clicked without shift.
  const onRowClick = (index: number, e: React.MouseEvent) => {
    const id = filtered[index].id;
    if (e.shiftKey && anchor !== null) {
      const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
      const rangeIds = filtered.slice(from, to + 1).map(f => f.id);
      // Shift-range adds to the selection (never clears what's already picked).
      setSelected(prev => prev.concat(rangeIds.filter(rid => !prev.includes(rid))));
      return; // keep the anchor so successive shift-clicks re-anchor from the same row
    }
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : prev.concat(id)));
    setAnchor(index);
  };

  const toggleAll = () => setSelected(allSelected ? [] : filtered.map(f => f.id));

  const runBulk = async (action: 'archive' | 'restore' | 'category' | 'tag' | 'untag', tagIds?: number[]) => {
    if (selected.length === 0) return;
    if (action === 'category' && !newCategory.trim()) { notify('Type a category first.', 'error'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selected, action, category: newCategory.trim() || undefined, tag_ids: tagIds }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Bulk action failed');
      const n = d.affected;
      notify(
        action === 'archive' ? `Archived ${n} item${n !== 1 ? 's' : ''} — restore them from the Archived tab.`
        : action === 'restore' ? `Restored ${n} item${n !== 1 ? 's' : ''}.`
        : action === 'tag' ? `Tagged ${n} item${n !== 1 ? 's' : ''}.`
        : action === 'untag' ? `Removed the tag from ${n} item${n !== 1 ? 's' : ''}.`
        : `Recategorized ${n} item${n !== 1 ? 's' : ''}.`
      );
      if (action === 'category') setNewCategory('');
      load(); loadTags();
    } catch (e: any) {
      notify(e?.message || 'Bulk action failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createTag = async (name: string): Promise<Tag | null> => {
    const n = name.trim();
    if (!n) return null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/tags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not create tag');
      notify(d.existed ? `Tag “${d.name}” already existed.` : `Created tag “${d.name}”.`);
      loadTags();
      return d;
    } catch (e: any) { notify(e?.message || 'Could not create tag.', 'error'); return null; }
  };

  const deleteTag = async (t: Tag) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/tags/${t.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      notify(`Deleted tag “${t.name}”.`);
      if (tagFilter === t.id) setTagFilter(null);
      loadTags(); load();
    } catch { notify('Could not delete tag.', 'error'); }
  };

  const priceOf = (f: AuditFood) => {
    const p = (f.latest_prices ?? [])[0];
    return p ? `$${Number(p.price).toFixed(2)}` : null;
  };

  return (
    <div data-loc="page.audit" className="space-y-6 max-w-6xl mx-auto">
      <StatusToast statusMsg={statusMsg} />

      {/* ═══ Section: Header ═══ */}
      <div data-loc="audit.header" className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Catalog Audit</h1>
          <p className="text-sm text-slate-400 mt-1">
            Review everything in your catalog and clean out what isn&rsquo;t food. Click to select,
            shift-click for a range, ctrl/⌘-click to toggle. Archiving hides an item from every list
            but keeps its data.
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Button onClick={() => setDupOpen(true)} disabled={tab === 'archived'}
            title="Let an LLM find likely-duplicate items across the catalog — you review before anything merges"
            variant="secondary" size="sm">✨ Find duplicates</Button>
          <Button onClick={() => setTagPanelOpen(true)}
            variant="secondary" size="sm">Manage tags</Button>
        </div>
      </div>

      {/* ═══ Section: Filters ═══ */}
      <Card data-loc="audit.filters" className="rounded-3xl p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 text-[11px] font-semibold">
            {(['active', 'archived'] as const).map(t => (
              <button key={t} onClick={() => { setTab(t); setCat('All'); setTagFilter(null); }}
                className={`px-3 py-1.5 rounded-lg border transition capitalize ${
                  tab === t ? 'text-violet-200 bg-violet-500/15 border-violet-500/30' : 'text-slate-400 border-white/10 hover:bg-white/5'}`}>
                {t}
              </button>
            ))}
          </div>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search name or barcode…" className="field-input flex-1 min-w-48 text-xs rounded-xl" />
          <span className="text-xs text-slate-500">{filtered.length} item{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {['All'].concat(categories).map(c => (
            <button key={c} onClick={() => setCat(c)}
              className={`badge text-[10px] transition ${
                cat === c ? 'text-violet-200 bg-violet-500/20 border-violet-500/40' : 'text-slate-400 bg-white/5 border-white/10 hover:bg-white/10'}`}>
              {c}{c !== 'All' && <span className="text-slate-500"> {foods.filter(f => f.category === c).length}</span>}
            </button>
          ))}
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center border-t border-white/5 pt-3">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Tags</span>
            {tags.map(t => (
              <button key={t.id} onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}
                className={`badge text-[10px] transition ${
                  tagFilter === t.id ? 'text-sky-200 bg-sky-500/20 border-sky-500/40' : 'text-sky-300/70 bg-sky-500/5 border-sky-500/20 hover:bg-sky-500/10'}`}>
                {t.name}<span className="text-slate-500"> {t.food_count ?? 0}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* ═══ Section: Bulk action bar ═══ */}
      {selected.length > 0 && (
        <Card data-loc="audit.bulk-bar" className="rounded-2xl p-4 space-y-3 sticky top-20 z-30 border-violet-500/30">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-bold text-white">{selected.length} selected</span>
            <button onClick={() => setSelected([])} className="text-[11px] text-slate-400 hover:text-white">Clear</button>
            <div className="flex-1" />
            <button onClick={() => setAiOpen(true)} disabled={busy || tab === 'archived'}
              title="Let an LLM propose tags for the selected items — you review before anything is applied"
              className="text-xs font-bold text-violet-200 bg-violet-500/15 border border-violet-500/30 rounded-lg px-4 py-2 hover:bg-violet-500/25 transition disabled:opacity-50">
              ✨ Auto-tag with AI
            </button>
            {tab === 'active' && (
              <button onClick={() => setMergeOpen(true)} disabled={busy || selected.length < 2}
                title="Merge the selected items into one — keeps all their prices, names, nutrition and tags"
                className="text-xs font-bold text-amber-200 bg-amber-500/15 border border-amber-500/30 rounded-lg px-4 py-2 hover:bg-amber-500/25 transition disabled:opacity-50">
                Merge {selected.length}
              </button>
            )}
            <input type="text" list="audit-categories" value={newCategory} onChange={e => setNewCategory(e.target.value)}
              placeholder="Set category (e.g. Non-food)" className="field-input w-44 text-xs rounded-lg" />
            <datalist id="audit-categories">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
            <Button onClick={() => runBulk('category')} disabled={busy}
              variant="secondary" size="sm">Apply category</Button>
            {tab === 'active' ? (
              <button onClick={() => runBulk('archive')} disabled={busy}
                className="text-xs font-bold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-2 hover:bg-rose-500/20 transition disabled:opacity-50">
                {busy ? 'Working…' : `Archive ${selected.length}`}
              </button>
            ) : (
              <button onClick={() => runBulk('restore')} disabled={busy}
                className="text-xs font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-2 hover:bg-emerald-500/20 transition disabled:opacity-50">
                {busy ? 'Working…' : `Restore ${selected.length}`}
              </button>
            )}
          </div>

          {/* Manual tagging: click a tag to add it to the selection, ✕ to remove it */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-3">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Tag selection</span>
            {tags.length === 0 && <span className="text-[11px] text-slate-600">No tags yet — create one under “Manage tags”.</span>}
            {tags.map(t => (
              <Badge key={t.id} variant="outline" className="text-[10px] text-sky-300 bg-sky-500/10 border-sky-500/25 flex items-center gap-1 normal-case">
                <button onClick={() => runBulk('tag', [t.id])} disabled={busy} title={`Add “${t.name}” to the ${selected.length} selected`}
                  className="hover:text-sky-100">{t.name}</button>
                <button onClick={() => runBulk('untag', [t.id])} disabled={busy} title={`Remove “${t.name}” from the ${selected.length} selected`}
                  className="text-slate-500 hover:text-rose-400">✕</button>
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {/* ═══ Section: Item table ═══ */}
      <Card data-loc="audit.table" className="rounded-3xl p-5">
        {loading ? (
          <p className="text-slate-500 text-sm py-10 text-center">Loading catalog…</p>
        ) : filtered.length === 0 ? (
          <p className="text-slate-600 text-sm py-10 text-center">
            {tab === 'archived' ? 'Nothing archived.' : 'No items match.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse select-none">
              <thead>
                <tr className="border-b border-white/5 text-slate-500">
                  <th className="py-2 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll}
                      title="Select all filtered" className="accent-violet-500 cursor-pointer" />
                  </th>
                  <th className="py-2 w-12"></th>
                  <th className="py-2">Name</th>
                  <th className="py-2 w-28">Category</th>
                  <th className="py-2 w-40">Tags</th>
                  <th className="py-2 w-20 text-right">Price</th>
                  <th className="py-2 w-32 text-right">Nutrition</th>
                  <th className="py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f, index) => {
                  const checked = selected.includes(f.id);
                  return (
                    <tr key={f.id}
                      onClick={e => onRowClick(index, e)}
                      className={`border-b border-white/5 cursor-pointer transition ${checked ? 'bg-violet-500/10' : 'hover:bg-white/5'}`}>
                      <td className="py-2">
                        <input type="checkbox" checked={checked} readOnly
                          onClick={e => e.stopPropagation()}
                          onChange={() => setSelected(prev => (prev.includes(f.id) ? prev.filter(x => x !== f.id) : prev.concat(f.id)))}
                          className="accent-violet-500 cursor-pointer" />
                      </td>
                      <td className="py-2">
                        {f.display_image_id != null ? (
                          // The flyer photo is the fastest way to tell food from a TV.
                          // Clicking it opens the food's detail/edit modal (same as the
                          // pencil) rather than a zoom — the modal shows the full photo
                          // alongside the names/prices/nutrition you'd want to fix.
                          // `loading=lazy` matters here: the audit list is the whole
                          // catalog (hundreds of rows) and GET /api/images/:id serves
                          // full-resolution originals — eager-loading them all locks
                          // up the renderer.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`${API_BASE_URL}/api/images/${f.display_image_id}`} alt=""
                            loading="lazy" decoding="async"
                            title="Open this item's details"
                            onClick={e => { e.stopPropagation(); setDetailFoodId(f.id); }}
                            className="w-9 h-9 rounded-lg object-cover border border-white/10 hover:border-violet-400 transition cursor-pointer" />
                        ) : (
                          <div className="w-9 h-9 rounded-lg bg-slate-800/60 border border-white/5" />
                        )}
                      </td>
                      <td className="py-2 pr-3 text-white font-medium">
                        {f.name}
                        {f.barcode && <span className="block text-[10px] text-slate-600 font-mono">{f.barcode}</span>}
                      </td>
                      <td className="py-2"><Badge variant="outline" className="text-[9px] text-slate-300 bg-white/5 border-white/10">{f.category}</Badge></td>
                      <td className="py-2">
                        <span className="flex flex-wrap gap-1">
                          {(f.tags ?? []).map(t => (
                            <Badge key={t.id} variant="outline" className="text-[9px] normal-case text-sky-300 bg-sky-500/10 border-sky-500/25">{t.name}</Badge>
                          ))}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono text-slate-300">{priceOf(f) ?? <span className="text-slate-600">—</span>}</td>
                      <td className="py-2 text-right font-mono text-[11px] text-slate-400 whitespace-nowrap">
                        {/* Per 100 g/ml so rows compare; falls back to the label serving. */}
                        {f.nutrition
                          ? (formatCaloriesPer100(f.nutrition, f.unit)
                              ?? `${Math.round(Number(f.nutrition.calories))} kcal / ${Number(f.nutrition.serving_size)} ${f.nutrition.serving_unit}`)
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="py-2 text-center">
                        <button onClick={e => { e.stopPropagation(); setDetailFoodId(f.id); }}
                          title="Open this food's prices, names & nutrition"
                          className="text-slate-500 hover:text-violet-300 transition">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ═══ Section: Manage-tags popup ═══ */}
      {tagPanelOpen && (
        <Modal onClose={() => setTagPanelOpen(false)} dataLoc="modal.manage-tags" maxWidth="max-w-md">
          <div>
            <h3 className="text-sm font-bold text-white">Tags
              <span className="block text-[10px] text-slate-500 font-normal">labels you can apply to many items</span>
            </h3>
          </div>
          <form onSubmit={async e => { e.preventDefault(); if (await createTag(newTagName)) setNewTagName(''); }}
            className="flex gap-2">
            <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)} maxLength={60}
              placeholder="New tag name…" className="field-input flex-1 text-xs rounded-lg" />
            <Button type="submit" size="sm">Create</Button>
          </form>
          <div className="panel rounded-lg max-h-64 overflow-y-auto divide-y divide-white/5">
            {tags.length === 0 ? (
              <p className="text-[11px] text-slate-500 px-3 py-2">No tags yet.</p>
            ) : tags.map(t => (
              <div key={t.id} className="flex items-center justify-between px-3 py-2">
                <span className="text-xs text-white">{t.name}<span className="text-slate-600"> · {t.food_count ?? 0} item{(t.food_count ?? 0) !== 1 ? 's' : ''}</span></span>
                <button onClick={() => deleteTag(t)} className="text-[11px] text-slate-500 hover:text-rose-400">Delete</button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* ═══ Section: AI auto-tag popup ═══ */}
      {aiOpen && (
        <AutoTagModal
          foodIds={selected}
          tags={tags}
          onClose={() => setAiOpen(false)}
          onCreateTag={createTag}
          onApplied={() => { setAiOpen(false); load(); loadTags(); }}
          notify={notify}
        />
      )}

      {/* ═══ Section: Merge popup (manual) ═══ */}
      {mergeOpen && (
        <MergeModal
          foods={foods.filter(f => selected.includes(f.id))}
          onClose={() => setMergeOpen(false)}
          onMerged={() => { setMergeOpen(false); load(); loadTags(); }}
          notify={notify}
        />
      )}

      {/* ═══ Section: Find-duplicates popup (AI) ═══ */}
      {dupOpen && (
        <FindDuplicatesModal
          foods={foods}
          onClose={() => setDupOpen(false)}
          onMerged={() => { load(); loadTags(); }}
          notify={notify}
        />
      )}

      {detailFoodId !== null && (
        <FoodDetailModal foodId={detailFoodId} onChange={() => { load(); loadTags(); }} onClose={() => setDetailFoodId(null)} />
      )}
    </div>
  );
}

// AI auto-tagger. Two steps: pick which tags the model may use, then review the
// draft it proposes and apply it. The model never writes — `Apply` is what calls
// POST /api/foods/apply-tags with whatever survived review.
function AutoTagModal({ foodIds, tags, onClose, onCreateTag, onApplied, notify }: {
  foodIds: number[];
  tags: Tag[];
  onClose: () => void;
  onCreateTag: (name: string) => Promise<Tag | null>;
  onApplied: () => void;
  notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [hint, setHint] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]); // food_ids excluded from Apply
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [model, setModel] = useState<string | null>(null);

  const tagById = useMemo(() => {
    const m = new Map<number, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const toggleTag = (id: number) =>
    setChosen(prev => (prev.includes(id) ? prev.filter(x => x !== id) : prev.concat(id)));

  // Auto-tagging is done in client-side batches: the endpoint caps a single LLM
  // call (free models have small contexts / get flaky on long lists), so a big
  // selection (e.g. 300 items) is split into chunks called sequentially, with
  // suggestions streamed into the review list and a live "batch N/M" bar. A
  // failed batch is skipped and reported, not fatal — the rest still complete.
  // Kept small (10): the free MEAL/TAG models get slow and stall on longer item
  // lists, so smaller prompts stay fast and give smoother progress.
  const BATCH_SIZE = 10;
  const generate = async () => {
    if (chosen.length === 0) { notify('Pick at least one tag for the AI to choose from.', 'error'); return; }
    const batches: number[][] = [];
    for (let i = 0; i < foodIds.length; i += BATCH_SIZE) batches.push(foodIds.slice(i, i + BATCH_SIZE));

    setRunning(true); setSkipped([]); setSuggestions([]); setProgress({ done: 0, total: batches.length });
    let acc: Suggestion[] = [];
    let mdl: string | null = null;
    let failed = 0;
    for (let b = 0; b < batches.length; b++) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/foods/auto-tag`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ food_ids: batches[b], tag_ids: chosen, hint: hint.trim() || undefined }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'batch failed');
        mdl = d.model ?? mdl;
        acc = acc.concat(d.suggestions ?? []);
        setSuggestions(acc.slice()); // stream results into the review list
      } catch {
        failed++;
      }
      setProgress({ done: b + 1, total: batches.length });
    }
    setModel(mdl);
    setProgress(null);
    setRunning(false);
    if (failed > 0) notify(`${failed} of ${batches.length} batch${batches.length !== 1 ? 'es' : ''} failed — Regenerate to retry the rest.`, 'error');
  };

  // Drop one proposed tag from one item, before applying.
  const dropTag = (foodId: number, tagId: number) =>
    setSuggestions(prev => (prev ?? []).map(s =>
      s.food_id === foodId ? { ...s, tag_ids: s.tag_ids.filter(t => t !== tagId) } : s));

  const apply = async () => {
    const assignments = (suggestions ?? [])
      .filter(s => !skipped.includes(s.food_id) && s.tag_ids.length > 0)
      .map(s => ({ food_id: s.food_id, tag_ids: s.tag_ids }));
    if (assignments.length === 0) { notify('Nothing to apply.', 'error'); return; }
    setApplying(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/apply-tags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Apply failed');
      notify(`Applied ${d.linked} tag${d.linked !== 1 ? 's' : ''} across ${assignments.length} item${assignments.length !== 1 ? 's' : ''}.`);
      onApplied();
    } catch (e: any) {
      notify(e?.message || 'Apply failed.', 'error');
    } finally {
      setApplying(false);
    }
  };

  const willApply = (suggestions ?? []).filter(s => !skipped.includes(s.food_id) && s.tag_ids.length > 0).length;

  return (
    <Modal onClose={onClose} dataLoc="modal.auto-tag" maxWidth="max-w-2xl">
      <div>
        <h3 className="text-sm font-bold text-white">Auto-tag {foodIds.length} item{foodIds.length !== 1 ? 's' : ''} with AI
          <span className="block text-[10px] text-slate-500 font-normal">
            The model only suggests — nothing is saved until you press Apply.
          </span>
        </h3>
      </div>

      {/* Step 1 — which tags may the model use */}
      <div className="space-y-2">
        <span className="field-label">Tags the AI may choose from</span>
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 && <span className="text-[11px] text-slate-600">No tags yet — create one below.</span>}
          {tags.map(t => (
            <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
              className={`badge text-[10px] normal-case transition ${
                chosen.includes(t.id) ? 'text-sky-200 bg-sky-500/25 border-sky-500/50' : 'text-slate-400 bg-white/5 border-white/10 hover:bg-white/10'}`}>
              {chosen.includes(t.id) ? '✓ ' : ''}{t.name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)} maxLength={60}
            placeholder="…or create a new tag" className="field-input flex-1 text-xs rounded-lg" />
          <Button type="button" disabled={!newTagName.trim()}
            onClick={async () => { const t = await onCreateTag(newTagName); if (t) { setChosen(prev => prev.concat(t.id)); setNewTagName(''); } }}
            variant="secondary" size="sm">Create &amp; use</Button>
        </div>
        <input type="text" value={hint} onChange={e => setHint(e.target.value)}
          placeholder="Optional hint (e.g. “anything you can't eat is Non-food”)"
          className="field-input w-full text-xs rounded-lg" />
      </div>

      {suggestions === null ? (
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} variant="secondary" size="sm">Cancel</Button>
          <Button onClick={generate} disabled={running || chosen.length === 0} size="sm">
            {running ? 'Asking the model…' : 'Generate suggestions'}
          </Button>
        </div>
      ) : (
        <>
          {/* Step 2 — review the draft (streams in as batches complete) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="field-label">Proposed tags — review before applying</span>
              {model && <span className="text-[10px] text-slate-600 font-mono">{model}</span>}
            </div>
            {running && progress && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-violet-300 font-semibold animate-pulse">
                    Tagging… batch {progress.done}/{progress.total} · {suggestions?.length ?? 0} of {foodIds.length} items
                  </span>
                  <span className="text-slate-500 font-mono tabular-nums">{Math.round((progress.done / progress.total) * 100)}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-linear-to-r from-violet-500 to-indigo-400 rounded-full transition-all duration-300"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              </div>
            )}
            <div className="panel rounded-lg max-h-72 overflow-y-auto divide-y divide-white/5">
              {suggestions.length === 0 && !running && <p className="text-[11px] text-slate-500 px-3 py-2">The model returned nothing usable.</p>}
              {suggestions.map(s => {
                const skip = skipped.includes(s.food_id);
                return (
                  <div key={s.food_id} className={`flex items-center gap-2 px-3 py-2 ${skip ? 'opacity-40' : ''}`}>
                    <input type="checkbox" checked={!skip}
                      onChange={() => setSkipped(prev => (skip ? prev.filter(x => x !== s.food_id) : prev.concat(s.food_id)))}
                      className="accent-violet-500 cursor-pointer shrink-0" />
                    <span className="text-xs text-slate-200 flex-1 min-w-0 truncate">{s.food_name}</span>
                    <span className="flex flex-wrap gap-1 justify-end shrink-0">
                      {s.tag_ids.length === 0 && <span className="text-[10px] text-slate-600">no tag</span>}
                      {s.tag_ids.map(tid => (
                        <Badge key={tid} variant="outline" className="text-[9px] normal-case text-sky-300 bg-sky-500/10 border-sky-500/25 flex items-center gap-1">
                          {tagById.get(tid)?.name ?? tid}
                          <button onClick={() => dropTag(s.food_id, tid)} title="Don't apply this tag"
                            className="text-slate-500 hover:text-rose-400">✕</button>
                        </Badge>
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex justify-between gap-2 pt-1">
            <Button onClick={generate} disabled={running} variant="secondary" size="sm">
              {running ? 'Tagging…' : 'Regenerate'}
            </Button>
            <div className="flex gap-2">
              <Button onClick={onClose} variant="secondary" size="sm">Cancel</Button>
              <Button onClick={apply} disabled={applying || running || willApply === 0} size="sm">
                {applying ? 'Applying…' : `Apply to ${willApply} item${willApply !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

// POST a single merge. Shared by the manual MergeModal and the AI FindDuplicatesModal.
async function mergeFoods(targetId: number, sourceIds: number[]): Promise<number> {
  const res = await fetch(`${API_BASE_URL}/api/foods/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_id: targetId, source_ids: sourceIds }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'Merge failed');
  return d.merged as number;
}

// Manual merge: collapse the selected foods into one survivor the user picks. The
// survivor keeps every source's prices, names, nutrition links and tags; the sources
// are archived.
function MergeModal({ foods, onClose, onMerged, notify }: {
  foods: AuditFood[];
  onClose: () => void;
  onMerged: () => void;
  notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const [targetId, setTargetId] = useState<number>(foods[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const target = foods.find(f => f.id === targetId);

  const run = async () => {
    const sources = foods.filter(f => f.id !== targetId).map(f => f.id);
    if (sources.length === 0) { notify('Pick a survivor different from the others.', 'error'); return; }
    setBusy(true);
    try {
      const merged = await mergeFoods(targetId, sources);
      notify(`Merged ${merged} item${merged !== 1 ? 's' : ''} into “${target?.name}”.`);
      onMerged();
    } catch (e: any) {
      notify(e?.message || 'Merge failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} dataLoc="modal.merge-foods" maxWidth="max-w-lg">
      <div>
        <h3 className="text-sm font-bold text-white">Merge {foods.length} items into one
          <span className="block text-[10px] text-slate-500 font-normal">Pick the survivor — the others are archived and all their data moves onto it.</span>
        </h3>
      </div>
      <div className="panel rounded-lg max-h-72 overflow-y-auto divide-y divide-white/5">
        {foods.map(f => (
          <label key={f.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/5">
            <input type="radio" name="merge-survivor" checked={targetId === f.id}
              onChange={() => setTargetId(f.id)} className="accent-amber-500 cursor-pointer shrink-0" />
            <span className="min-w-0 flex-1 text-xs">
              <span className="text-slate-200 truncate block">{f.name}</span>
              <span className="text-[10px] text-slate-500">
                {f.category}
                {(f.latest_prices ?? [])[0] ? ` · $${Number((f.latest_prices ?? [])[0].price).toFixed(2)}` : ''}
                {f.nutrition ? ` · ${formatCaloriesPer100(f.nutrition, f.unit) ?? `${Math.round(Number(f.nutrition.calories))} kcal`}` : ''}
              </span>
            </span>
            {targetId === f.id && <Badge variant="outline" className="text-[9px] text-amber-200 bg-amber-500/20 border-amber-500/40 shrink-0">survivor</Badge>}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} variant="secondary" size="sm">Cancel</Button>
        <Button onClick={run} disabled={busy} size="sm">
          {busy ? 'Merging…' : `Merge into “${target?.name ?? ''}”`}
        </Button>
      </div>
    </Modal>
  );
}

interface DupGroup { foods: { id: number; name: string }[]; reason: string | null; survivorId: number; }

// AI "Find duplicates": ask an LLM to cluster likely-duplicate foods across the
// active catalog, then review each proposed group (pick the survivor, drop foods or
// whole groups) and Apply to merge them. Mirrors AutoTagModal: propose→review→apply,
// batched with a progress bar; the model never merges on its own.
function FindDuplicatesModal({ foods, onClose, onMerged, notify }: {
  foods: AuditFood[];
  onClose: () => void;
  onMerged: () => void;
  notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [model, setModel] = useState<string | null>(null);

  // Batch the catalog: the endpoint caps a single call, and free models get flaky on
  // long lists (same reason AutoTagModal batches). 40 keeps each prompt fast.
  const BATCH_SIZE = 40;
  const generate = async () => {
    const ids = foods.map(f => f.id);
    const batches: number[][] = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

    setRunning(true); setGroups([]); setProgress({ done: 0, total: batches.length });
    let acc: DupGroup[] = [];
    let mdl: string | null = null;
    let failed = 0;
    for (let b = 0; b < batches.length; b++) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/foods/merge-suggestions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ food_ids: batches[b] }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'batch failed');
        mdl = d.model ?? mdl;
        for (const g of (d.groups ?? [])) {
          if ((g.foods ?? []).length >= 2) acc = acc.concat({ foods: g.foods, reason: g.reason, survivorId: g.foods[0].id });
        }
        setGroups(acc.slice());
      } catch { failed++; }
      setProgress({ done: b + 1, total: batches.length });
    }
    setModel(mdl);
    setProgress(null);
    setRunning(false);
    if (failed > 0) notify(`${failed} of ${batches.length} batch${batches.length !== 1 ? 'es' : ''} failed — Rescan to retry.`, 'error');
  };

  const dropGroup = (idx: number) => setGroups(prev => (prev ?? []).filter((_, i) => i !== idx));
  const dropFood = (idx: number, foodId: number) => setGroups(prev => (prev ?? []).map((g, i) => {
    if (i !== idx) return g;
    const remaining = g.foods.filter(f => f.id !== foodId);
    return { ...g, foods: remaining, survivorId: g.survivorId === foodId ? (remaining[0]?.id ?? 0) : g.survivorId };
  }).filter(g => g.foods.length >= 2));
  const setSurvivor = (idx: number, foodId: number) =>
    setGroups(prev => (prev ?? []).map((g, i) => (i === idx ? { ...g, survivorId: foodId } : g)));

  const apply = async () => {
    const valid = (groups ?? []).filter(g => g.foods.length >= 2);
    if (valid.length === 0) { notify('No groups to merge.', 'error'); return; }
    setApplying(true);
    let mergedTotal = 0;
    let failed = 0;
    for (const g of valid) {
      const sources = g.foods.filter(f => f.id !== g.survivorId).map(f => f.id);
      try { mergedTotal += await mergeFoods(g.survivorId, sources); }
      catch { failed++; }
    }
    setApplying(false);
    if (mergedTotal > 0) notify(`Merged ${mergedTotal} item${mergedTotal !== 1 ? 's' : ''} across ${valid.length} group${valid.length !== 1 ? 's' : ''}.`);
    if (failed > 0) notify(`${failed} group${failed !== 1 ? 's' : ''} failed to merge.`, 'error');
    onMerged();
    onClose();
  };

  const groupCount = (groups ?? []).filter(g => g.foods.length >= 2).length;

  return (
    <Modal onClose={onClose} dataLoc="modal.find-duplicates" maxWidth="max-w-2xl">
      <div>
        <h3 className="text-sm font-bold text-white">Find duplicate items with AI
          <span className="block text-[10px] text-slate-500 font-normal">
            The model only proposes groups — nothing merges until you press Apply.
          </span>
        </h3>
      </div>

      {groups === null ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">Scans {foods.length} active item{foods.length !== 1 ? 's' : ''} for likely duplicates.</p>
          <Button onClick={generate} disabled={running || foods.length < 2} size="sm">
            {running ? 'Scanning…' : 'Scan for duplicates'}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="field-label">Proposed duplicate groups — review before applying</span>
              {model && <span className="text-[10px] text-slate-600 font-mono">{model}</span>}
            </div>
            {running && progress && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-violet-300 font-semibold animate-pulse">
                    Scanning… batch {progress.done}/{progress.total} · {groupCount} group{groupCount !== 1 ? 's' : ''} so far
                  </span>
                  <span className="text-slate-500 font-mono tabular-nums">{Math.round((progress.done / progress.total) * 100)}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-linear-to-r from-violet-500 to-indigo-400 rounded-full transition-all duration-300"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              </div>
            )}
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {groupCount === 0 && !running && <p className="text-[11px] text-slate-500 px-1 py-2">No duplicates found.</p>}
              {(groups ?? []).map((g, idx) => g.foods.length < 2 ? null : (
                <div key={idx} className="panel rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[10px] text-slate-500 flex-1">{g.reason || 'Likely the same product'}</span>
                    <button onClick={() => dropGroup(idx)} className="text-[10px] text-slate-500 hover:text-rose-400 shrink-0">Dismiss group</button>
                  </div>
                  {g.foods.map(f => (
                    <label key={f.id} className="flex items-center gap-2.5 cursor-pointer">
                      <input type="radio" name={`survivor-${idx}`} checked={g.survivorId === f.id}
                        onChange={() => setSurvivor(idx, f.id)} className="accent-amber-500 cursor-pointer shrink-0" />
                      <span className="text-xs text-slate-200 flex-1 min-w-0 truncate">{f.name}</span>
                      {g.survivorId === f.id
                        ? <Badge variant="outline" className="text-[9px] text-amber-200 bg-amber-500/20 border-amber-500/40 shrink-0">survivor</Badge>
                        : <button onClick={(e) => { e.preventDefault(); dropFood(idx, f.id); }} title="Remove from this group"
                            className="text-slate-500 hover:text-rose-400 text-xs shrink-0">✕</button>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-between gap-2 pt-1">
            <Button onClick={generate} disabled={running} variant="secondary" size="sm">
              {running ? 'Scanning…' : 'Rescan'}
            </Button>
            <div className="flex gap-2">
              <Button onClick={onClose} variant="secondary" size="sm">Cancel</Button>
              <Button onClick={apply} disabled={applying || running || groupCount === 0} size="sm">
                {applying ? 'Merging…' : `Merge ${groupCount} group${groupCount !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
