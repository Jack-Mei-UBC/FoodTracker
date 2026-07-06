"use client";

import React, { useState, useEffect, useCallback } from 'react';
import type { ScanResponse } from '../../types/scan';
import ReviewItems, { RawItem } from '../../components/ReviewItems';
import type { GeoPoint } from '../../lib/geo';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface ScanJob {
  id: number;
  status: string;
  original_filename: string | null;
  store_id: number | null;
  store_name: string | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
  result_type: string | null;
  item_count: number;
}

// A finished job pulled up for review (several can be open at once).
interface OpenReview {
  jobId: number;
  filename: string;
  result: ScanResponse;
  rawItems: RawItem[]; // computed once — must stay referentially stable across
                        // re-renders, or ReviewItems' internal state (including
                        // manually-added items) gets reset on every poll tick.
  storeId: string;
  imageId: number | null;
  gps: GeoPoint | null;
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  processing: 'text-amber-300 bg-amber-500/10 border-amber-500/20 animate-pulse',
  done: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  failed: 'text-rose-300 bg-rose-500/10 border-rose-500/20',
  reviewed: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
};

function resultToRawItems(result: ScanResponse | null): RawItem[] {
  if (!result) return [];
  if (result.type === 'receipt') {
    return result.data.items.map(it => ({ ...it, amountUnit: it.amount_unit }));
  }
  if (result.type === 'price_tag') {
    const tag = result.data;
    return [{ name: tag.name, price: tag.price, category: tag.category, unit: tag.unit, barcode: tag.barcode, isSale: tag.is_sale, amount: tag.amount, amountUnit: tag.amount_unit }];
  }
  return [];
}

export default function Inbox() {
  const [jobs, setJobs] = useState<ScanJob[]>([]);
  const [openReviews, setOpenReviews] = useState<OpenReview[]>([]);
  // Jobs whose "unknown" scan the user chose to enter manually instead.
  const [manualOverrideIds, setManualOverrideIds] = useState<Set<number>>(new Set());
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const notify = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 5000);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs`);
      if (res.ok) setJobs(await res.json());
    } catch { /* ignore transient */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while any job is still in flight, so queued→processing→done updates live.
  useEffect(() => {
    const anyActive = jobs.some(j => j.status === 'queued' || j.status === 'processing');
    if (!anyActive) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const fetchReview = async (job: ScanJob): Promise<OpenReview | null> => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${job.id}`);
      if (!res.ok) return null;
      const d = await res.json();
      const result = d.result as ScanResponse;
      return {
        jobId: job.id,
        filename: job.original_filename ?? `job #${job.id}`,
        result,
        rawItems: resultToRawItems(result),
        storeId: job.store_id ? String(job.store_id) : '1',
        imageId: d.image_id ?? null,
        gps: d.latitude != null && d.longitude != null ? { lat: Number(d.latitude), lng: Number(d.longitude) } : null,
      };
    } catch { return null; }
  };

  const openJob = async (job: ScanJob) => {
    if (job.status !== 'done') return;
    if (openReviews.some(r => r.jobId === job.id)) return;
    const review = await fetchReview(job);
    if (review) setOpenReviews(prev => [...prev, review]);
    else notify('Failed to load job.', 'error');
  };

  const reviewAll = async () => {
    const doneJobs = jobs.filter(j => j.status === 'done' && !openReviews.some(r => r.jobId === j.id));
    if (doneJobs.length === 0) return;
    const reviews = (await Promise.all(doneJobs.map(fetchReview))).filter((r): r is OpenReview => r != null);
    setOpenReviews(prev => [...prev, ...reviews]);
  };

  const closeReview = (jobId: number) => setOpenReviews(prev => prev.filter(r => r.jobId !== jobId));

  const retry = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${id}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error();
      notify('Re-queued.');
      load();
    } catch { notify('Retry failed.', 'error'); }
  };

  const discard = async (id: number) => {
    // Close the panel and drop it from the list immediately — don't make the UI
    // wait on the network round-trip to feel responsive.
    closeReview(id);
    setJobs(prev => prev.filter(j => j.id !== id));
    setManualOverrideIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
    } catch {
      notify('Discard may not have saved on the server — it could reappear on refresh.', 'error');
    } finally {
      load();
    }
  };

  const markReviewed = async (id: number) => {
    // Items are already committed by the time this fires — close immediately
    // and mark the job reviewed in the background.
    closeReview(id);
    setManualOverrideIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    await fetch(`${API_BASE_URL}/api/scan-jobs/${id}/reviewed`, { method: 'POST' }).catch(() => {});
    load();
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const openableCount = jobs.filter(j => j.status === 'done' && !openReviews.some(r => r.jobId === j.id)).length;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {statusMsg && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl ${
          statusMsg.type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'}`}>
          <span className="text-sm font-semibold">{statusMsg.text}</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Scan Inbox</h1>
          <p className="text-sm text-slate-400 mt-1">Images processed in the background. Review finished scans — individually or all at once — with the source photo shown alongside.</p>
        </div>
        {openableCount > 0 && (
          <button onClick={reviewAll}
            className="shrink-0 text-xs font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-2 hover:bg-emerald-500/20 transition">
            Review all ({openableCount})
          </button>
        )}
      </div>

      <div className="rounded-3xl p-6 glass-panel border border-white/5 space-y-2">
        {jobs.length === 0 && <p className="text-slate-600 text-sm py-6 text-center">Inbox empty. Queue an image from the Scanner.</p>}
        {jobs.map(job => {
          const isOpen = openReviews.some(r => r.jobId === job.id);
          return (
            <div key={job.id} className="flex items-center justify-between bg-slate-900/50 border border-white/5 rounded-xl px-4 py-3">
              <div className="flex items-center gap-3 text-sm min-w-0">
                <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase ${STATUS_STYLES[job.status] ?? STATUS_STYLES.queued}`}>{job.status}</span>
                <span className="text-white font-medium truncate">{job.original_filename ?? `job #${job.id}`}</span>
                {job.status === 'done' && <span className="text-slate-500 text-xs">{job.result_type} · {job.item_count} item{job.item_count !== 1 ? 's' : ''}</span>}
                {job.status === 'failed' && <span className="text-rose-400 text-xs truncate max-w-[220px]">{job.error}</span>}
                <span className="text-slate-600 text-xs">{fmtDate(job.created_at)}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {job.status === 'done' && (
                  <button onClick={() => (isOpen ? closeReview(job.id) : openJob(job))}
                    className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1 transition">
                    {isOpen ? 'Close' : 'Review'}
                  </button>
                )}
                {job.status === 'failed' && (
                  <button onClick={() => retry(job.id)} className="text-[11px] font-bold text-amber-400 hover:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1 transition">Retry</button>
                )}
                <button onClick={() => discard(job.id)} className="text-[11px] text-slate-500 hover:text-rose-400 px-2 transition">Discard</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Stacked review panels — one per opened job, each with its source photo */}
      {openReviews.map(review => (
        <div key={review.jobId} className="relative">
          {review.result.type === 'unknown' && !manualOverrideIds.has(review.jobId) ? (
            <div className="rounded-3xl p-6 glass-panel border border-white/5 text-sm text-slate-400 space-y-3">
              <div className="text-xs font-semibold text-slate-400">{review.filename}</div>
              {review.imageId != null && (
                <a href={`${API_BASE_URL}/api/images/${review.imageId}`} target="_blank" rel="noreferrer" className="block w-fit">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${API_BASE_URL}/api/images/${review.imageId}`} alt="scan" className="max-h-48 rounded-xl border border-white/10" />
                </a>
              )}
              <p>Not recognized as a receipt or price tag: <span className="text-slate-300">{review.result.data.reason}</span></p>
              <div className="flex gap-2">
                <button onClick={() => setManualOverrideIds(prev => new Set(prev).add(review.jobId))}
                  className="text-[11px] font-bold text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1 hover:bg-violet-500/20 transition">
                  Enter Items Manually
                </button>
                <button onClick={() => discard(review.jobId)} className="text-[11px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-1">Discard</button>
                <button onClick={() => closeReview(review.jobId)} className="text-[11px] text-slate-400 hover:text-white px-3 py-1">Close</button>
              </div>
            </div>
          ) : (
            <ReviewItems
              items={review.rawItems}
              confidence={review.result.confidence}
              defaultStoreId={review.storeId}
              source="queue"
              imageId={review.imageId}
              imageSrc={review.imageId != null ? `${API_BASE_URL}/api/images/${review.imageId}` : null}
              gps={review.gps}
              label={review.filename}
              manualEntry={review.result.type === 'unknown'}
              notify={notify}
              onCommitted={() => markReviewed(review.jobId)}
              onDiscard={() => discard(review.jobId)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
