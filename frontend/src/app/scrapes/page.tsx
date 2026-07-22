"use client";

import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card } from '../../components/ui/card';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Compact list row (GET /api/scrape-jobs).
interface ScrapeJob {
  id: number;
  store_id: number | null;
  store_name: string | null;
  source: string | null; // flipp|cocowest
  source_url: string | null; // cocowest only
  postal_code: string | null;
  query: string | null;
  status: string;
  phase: string | null;
  total: number;
  processed: number;
  logged: number;
  error: string | null;
  created_at: string;
  updated_at: string | null;
  finished_at: string | null;
  item_count: number;
}

// Per-logged-price detail (GET /api/scrape-jobs/:id -> items[]).
interface ScrapeItem {
  food_id: number;
  food_name: string;
  is_new_food: boolean;
  flyer_name: string | null;
  price: number;
  amount: number | null;
  amount_unit: string | null;
  is_sale: boolean;
  image_id: number | null;
  flyer_url: string | null;
  valid_to: string | null;
  logged_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  processing: 'text-amber-300 bg-amber-500/10 border-amber-500/20 animate-pulse',
  done: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  failed: 'text-rose-300 bg-rose-500/10 border-rose-500/20',
};

const isActive = (s: string) => s === 'queued' || s === 'processing';

function ScrapesInner() {
  const searchParams = useSearchParams();
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [details, setDetails] = useState<Record<number, ScrapeItem[]>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [lightbox, setLightbox] = useState<number | null>(null); // image_id
  const autoExpanded = useRef(false);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scrape-jobs/${id}`);
      if (res.ok) {
        const d = await res.json();
        setDetails(prev => ({ ...prev, [id]: (d.items || []) as ScrapeItem[] }));
      }
    } catch { /* transient */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scrape-jobs`);
      if (!res.ok) return;
      const list: ScrapeJob[] = await res.json();
      setJobs(list);
      // Refresh detail for any expanded job (so items stream in live), and for
      // any still-active job (so its result is ready the moment you expand it).
      const toRefresh = new Set<number>(expanded);
      list.forEach(j => { if (isActive(j.status)) toRefresh.add(j.id); });
      toRefresh.forEach(id => loadDetail(id));
    } catch { /* transient */ }
  }, [expanded, loadDetail]);

  useEffect(() => { load(); }, [load]);

  // Auto-expand a job passed as ?job=<id> (dashboard redirect after dispatch).
  useEffect(() => {
    if (autoExpanded.current) return;
    const jobParam = searchParams.get('job');
    if (jobParam) {
      const id = parseInt(jobParam);
      if (!Number.isNaN(id)) {
        autoExpanded.current = true;
        setExpanded(prev => new Set(prev).add(id));
        loadDetail(id);
      }
    }
  }, [searchParams, loadDetail]);

  // Poll while any job is in flight.
  useEffect(() => {
    const anyActive = jobs.some(j => isActive(j.status));
    if (!anyActive) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else { next.add(id); loadDetail(id); }
      return next;
    });
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const modeLabel = (j: ScrapeJob) => (j.source === 'cocowest' ? 'Sale post' : (j.query ? `“${j.query}”` : 'Full catalog'));

  return (
    <div data-loc="page.scrapes" className="space-y-8 max-w-5xl mx-auto">
      {/* ═══ Section: Header ═══ */}
      <div data-loc="scrapes.header">
        <h1 className="text-2xl font-bold text-white">Scraper Activity</h1>
        <p className="text-sm text-slate-400 mt-1">
          Live progress of Flipp flyer scrapes and cocowest.ca Costco sale-post imports. Expand a run to see every logged price with its source image and a link to where it came from.
        </p>
      </div>

      {/* ═══ Section: Job list ═══ */}
      <div data-loc="scrapes.job-list" className="space-y-3">
        {jobs.length === 0 && (
          <Card className="rounded-3xl p-8 text-center text-slate-600 text-sm">
            No scrapes yet. Dispatch one from the <span className="text-violet-400 font-semibold">Dashboard</span>.
          </Card>
        )}

        {jobs.map(job => {
          const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : (job.status === 'done' ? 100 : 0);
          const items = details[job.id] || [];
          const open = expanded.has(job.id);
          return (
            <Card key={job.id} className="overflow-hidden">
              {/* Header row */}
              <button onClick={() => toggle(job.id)} className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-white/2 transition">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`badge text-[9px] shrink-0 ${STATUS_STYLES[job.status] ?? STATUS_STYLES.queued}`}>{job.status}</span>
                  <span className={`badge text-[9px] shrink-0 ${job.source === 'cocowest' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : 'text-violet-300 bg-violet-500/10 border-violet-500/20'}`}>
                    {job.source === 'cocowest' ? 'Costco' : 'Flipp'}
                  </span>
                  <span className="text-white font-semibold truncate">{job.store_name ?? `Store #${job.store_id}`}</span>
                  <span className="text-slate-500 text-xs shrink-0">{modeLabel(job)}</span>
                  {job.postal_code && <span className="text-slate-600 text-[11px] font-mono shrink-0 hidden sm:inline">{job.postal_code}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs font-mono text-emerald-400">{job.logged} logged</span>
                  <span className="text-slate-600 text-xs hidden sm:inline">{fmtDate(job.created_at)}</span>
                  <svg className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {/* Progress bar + phase */}
              <div className="px-5 pb-3 -mt-1">
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className={`truncate ${job.status === 'failed' ? 'text-rose-400' : 'text-slate-400'}`}>
                    {job.status === 'failed' ? (job.error || 'Failed') : (job.phase || '—')}
                  </span>
                  <span className="text-slate-500 font-mono shrink-0 ml-2">
                    {job.total > 0 ? `${job.processed}/${job.total}` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      job.status === 'failed' ? 'bg-rose-500' : job.status === 'done' ? 'bg-emerald-500' : 'bg-linear-to-r from-violet-500 to-indigo-500'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>

              {/* Expanded per-item detail */}
              {open && (
                <div className="border-t border-white/5 px-5 py-4 space-y-2 bg-slate-950/40">
                  {items.length === 0 ? (
                    <p className="text-xs text-slate-600 py-2">
                      {isActive(job.status) ? 'Waiting for the first logged price…' : 'No prices were logged in this run.'}
                    </p>
                  ) : (
                    items.map((it, idx) => (
                      <div key={idx} className="flex items-center gap-3 bg-slate-900/50 border border-white/5 rounded-xl p-2.5">
                        {/* Saved flyer image */}
                        {it.image_id != null ? (
                          <button onClick={() => setLightbox(it.image_id)} className="shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`${API_BASE_URL}/api/images/${it.image_id}`}
                              alt={it.flyer_name || it.food_name}
                              className="w-14 h-14 object-contain rounded-lg bg-white/5 border border-white/10 hover:border-violet-400/50 transition"
                            />
                          </button>
                        ) : (
                          <div className="w-14 h-14 shrink-0 rounded-lg bg-slate-800/50 border border-white/5 flex items-center justify-center text-[9px] text-slate-600 text-center">no image</div>
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white truncate">{it.food_name}</span>
                            {it.is_new_food && <span className="text-[8px] font-bold uppercase text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-sm px-1.5 py-0.5 shrink-0">new</span>}
                            {it.is_sale && <span className="text-[8px] font-bold uppercase text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-sm px-1.5 py-0.5 shrink-0">sale</span>}
                          </div>
                          {it.flyer_name && it.flyer_name !== it.food_name && (
                            <p className="text-[11px] text-slate-500 truncate">{it.flyer_name}</p>
                          )}
                          <div className="text-[11px] text-slate-400 font-mono">
                            ${Number(it.price).toFixed(2)}
                            {it.amount != null && <span className="text-slate-600"> · {Number(it.amount)} {it.amount_unit}</span>}
                          </div>
                        </div>

                        {it.flyer_url && (
                          <a
                            href={it.flyer_url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-[10px] font-bold text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded-lg px-2.5 py-1.5 hover:bg-violet-500/20 transition"
                          >
                            Flyer page ↗
                          </a>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* ═══ Section: Image lightbox (hand-rolled, not via Modal — see CLAUDE.md) ═══ */}
      {lightbox != null && (
        <div data-loc="scrapes.lightbox" className="fixed inset-0 z-80 bg-black/85 backdrop-blur-xs flex items-center justify-center p-6" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${API_BASE_URL}/api/images/${lightbox}`} alt="flyer" className="max-h-[85vh] max-w-[85vw] rounded-2xl border border-white/10 shadow-2xl" onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-5 right-5 text-slate-300 hover:text-white p-2 rounded-full bg-white/5 hover:bg-white/10 transition">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default function Scrapes() {
  return (
    <Suspense fallback={<div className="text-center text-slate-500 py-12">Loading scraper activity…</div>}>
      <ScrapesInner />
    </Suspense>
  );
}
