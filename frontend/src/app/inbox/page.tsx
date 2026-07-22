"use client";

import React, { useState, useEffect, useCallback } from 'react';
import type { ScanResponse } from '../../types/scan';
import ReviewItems, { RawItem } from '../../components/ReviewItems';
import RawModelOutput, { ScanAttempt } from '../../components/RawModelOutput';
import ScanImages from '../../components/ScanImages';
import StatusToast, { useToast } from '../../components/StatusToast';
import { scanResultToRawItems, receiptCaptureData } from '../../lib/scanResult';
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
  // The uncropped upload `imageId` was cropped from (null when never cropped),
  // so the review can show both and a bad crop is obvious.
  originalImageId: number | null;
  // Per-model OCR trace (scan_jobs.attempts) — every model tried and what it read,
  // not just the winning body kept on `result`.
  attempts: ScanAttempt[] | null;
  gps: GeoPoint | null;
  // Receipt spending context (budget tracking) — set only for receipt scans.
  receipt: { total: number | null; purchasedOn: string | null; scanJobId: number | null } | null;
}

// A failed job has no result to review, so its detail is fetched only when the
// row is expanded — what each model returned is the only diagnostic there is.
interface FailedDetail {
  imageId: number | null;
  originalImageId: number | null;
  attempts: ScanAttempt[] | null;
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'text-slate-300 bg-slate-500/10 border-slate-500/20',
  processing: 'text-amber-300 bg-amber-500/10 border-amber-500/20 animate-pulse',
  done: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  failed: 'text-rose-300 bg-rose-500/10 border-rose-500/20',
  reviewed: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
};

export default function Inbox() {
  const [jobs, setJobs] = useState<ScanJob[]>([]);
  const [openReviews, setOpenReviews] = useState<OpenReview[]>([]);
  // Jobs whose "unknown" scan the user chose to enter manually instead.
  const [manualOverrideIds, setManualOverrideIds] = useState<Set<number>>(new Set());
  // Expanded failed rows → their on-demand detail (images + per-model attempts).
  const [failedDetails, setFailedDetails] = useState<Map<number, FailedDetail>>(new Map());
  const { statusMsg, notify } = useToast();

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
        rawItems: scanResultToRawItems(result),
        storeId: job.store_id ? String(job.store_id) : '1',
        imageId: d.image_id ?? null,
        originalImageId: d.original_image_id ?? null,
        attempts: Array.isArray(d.attempts) ? d.attempts as ScanAttempt[] : null,
        gps: d.latitude != null && d.longitude != null ? { lat: Number(d.latitude), lng: Number(d.longitude) } : null,
        // Sourced from the receipt CAPTURE, not the top-level type — a mixed
        // scan (receipt + shelf tags in one photo) reports `type: 'mixed'` but
        // still has a receipt to record spending for.
        receipt: (() => {
          const rd = receiptCaptureData(result);
          return rd ? { total: rd.total ?? null, purchasedOn: rd.purchase_date ?? null, scanJobId: job.id } : null;
        })(),
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

  // A store change inside one review panel. With applyToAll, broadcast the new
  // store to every open panel (batch scanned at one store); otherwise just this
  // one. review.storeId is the controlled source ReviewItems syncs its selector to.
  const handleStoreChange = (jobId: number, storeId: string, applyToAll: boolean) => {
    setOpenReviews(prev => prev.map(r => (applyToAll || r.jobId === jobId) ? { ...r, storeId } : r));
  };

  const retry = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${id}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error();
      notify('Re-queued.');
      load();
    } catch { notify('Retry failed.', 'error'); }
  };

  // Send a job back to /staging to be re-cropped and re-run — the fix when OCR
  // read the wrong region. The backend reverts the job to the uncropped original,
  // so the re-crop starts from the full photo rather than tightening a bad crop.
  const restage = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${id}/restage`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || 'Restage failed.');
      // It leaves the inbox entirely (staged jobs live on /staging), so drop it here.
      closeReview(id);
      setJobs(prev => prev.filter(j => j.id !== id));
      setFailedDetails(prev => { const next = new Map(prev); next.delete(id); return next; });
      notify(body?.reverted_to_original
        ? 'Sent back to Staging with the original photo restored — re-crop it there.'
        : 'Sent back to Staging — crop it there and send it for processing.');
    } catch (err: any) {
      notify(err?.message || 'Failed to send back to staging.', 'error');
      load();
    }
  };

  // Failed jobs can't open a review panel (there's no result), but their attempts
  // trace is the whole point of debugging one — fetch it on demand when expanded.
  const toggleFailed = async (job: ScanJob) => {
    if (failedDetails.has(job.id)) {
      setFailedDetails(prev => { const next = new Map(prev); next.delete(job.id); return next; });
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${job.id}`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      setFailedDetails(prev => new Map(prev).set(job.id, {
        imageId: d.image_id ?? null,
        originalImageId: d.original_image_id ?? null,
        attempts: Array.isArray(d.attempts) ? d.attempts as ScanAttempt[] : null,
      }));
    } catch { notify('Failed to load job detail.', 'error'); }
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
    <div data-loc="page.inbox" className="space-y-8 max-w-5xl mx-auto">
      <StatusToast statusMsg={statusMsg} />

      {/* ═══ Section: Header ═══ */}
      <div data-loc="inbox.header" className="flex items-start justify-between gap-4">
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

      {/* ═══ Section: Job list ═══ */}
      <div data-loc="inbox.job-list" className="card rounded-3xl p-6 space-y-2">
        {jobs.length === 0 && <p className="text-slate-600 text-sm py-6 text-center">Inbox empty. Queue an image from the Scanner.</p>}
        {jobs.map(job => {
          const isOpen = openReviews.some(r => r.jobId === job.id);
          const failedDetail = failedDetails.get(job.id);
          // Anything already processed can go back for a re-crop; a job still in
          // flight can't (the worker is mid-read on its current image).
          const canRestage = job.status === 'done' || job.status === 'failed' || job.status === 'reviewed';
          return (
            <div key={job.id} className="bg-slate-900/50 border border-white/5 rounded-xl px-4 py-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-sm min-w-0">
                  <span className={`badge text-[9px] ${STATUS_STYLES[job.status] ?? STATUS_STYLES.queued}`}>{job.status}</span>
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
                    <>
                      <button onClick={() => toggleFailed(job)}
                        className="text-[11px] font-bold text-slate-400 hover:text-white bg-white/5 border border-white/10 rounded-lg px-3 py-1 transition">
                        {failedDetail ? 'Hide details' : 'Details'}
                      </button>
                      <button onClick={() => retry(job.id)} className="text-[11px] font-bold text-amber-400 hover:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1 transition">Retry</button>
                    </>
                  )}
                  {canRestage && (
                    <button onClick={() => restage(job.id)}
                      title="Send back to Staging to re-crop the original photo and run OCR again"
                      className="text-[11px] font-bold text-violet-300 hover:text-violet-200 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1 transition">
                      Re-crop
                    </button>
                  )}
                  <button onClick={() => discard(job.id)} className="text-[11px] text-slate-500 hover:text-rose-400 px-2 transition">Discard</button>
                </div>
              </div>

              {/* A failed job has no reviewable result — its images and the
                  per-model attempt trace are the only things to go on. */}
              {failedDetail && (
                <div className="border-t border-white/5 pt-3 space-y-3">
                  <ScanImages imageId={failedDetail.imageId} originalImageId={failedDetail.originalImageId} />
                  <RawModelOutput attempts={failedDetail.attempts} scanJobId={job.id} defaultOpen notify={notify} />
                  {!failedDetail.attempts?.length && (
                    <p className="text-xs text-slate-500">No per-model trace recorded for this job (it predates attempt logging).</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ═══ Section: Review panels — one per opened job, each with its source photo ═══ */}
      <div data-loc="inbox.review-panels" className="space-y-8">
      {openReviews.map(review => (
        <div key={review.jobId} className="relative">
          {review.result.type === 'unknown' && !manualOverrideIds.has(review.jobId) ? (
            <div className="card rounded-3xl p-6 text-sm text-slate-400 space-y-4">
              <div className="text-xs font-semibold text-slate-400">{review.filename}</div>
              <ScanImages imageId={review.imageId} originalImageId={review.originalImageId} />
              <p>Not recognized as a receipt or price tag: <span className="text-slate-300">{review.result.data.reason}</span></p>
              {/* The text is surfaced HERE, not hidden behind "enter manually" —
                  a failed scan is exactly when the models' output matters most. */}
              <RawModelOutput rawText={review.result.raw_text ?? null} attempts={review.attempts}
                scanJobId={review.jobId} defaultOpen notify={notify} />
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setManualOverrideIds(prev => new Set(prev).add(review.jobId))}
                  className="text-[11px] font-bold text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1 hover:bg-violet-500/20 transition">
                  Enter Items Manually
                </button>
                <button onClick={() => restage(review.jobId)}
                  title="Send back to Staging to re-crop the original photo and run OCR again"
                  className="text-[11px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1 hover:bg-amber-500/20 transition">
                  Re-crop in Staging
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
              storeId={review.storeId}
              onStoreChange={(sid, applyAll) => handleStoreChange(review.jobId, sid, applyAll)}
              openReviewCount={openReviews.length}
              source="queue"
              imageId={review.imageId}
              originalImageId={review.originalImageId}
              gps={review.gps}
              label={review.filename}
              manualEntry={review.result.type === 'unknown'}
              rawText={review.result.raw_text ?? null}
              attempts={review.attempts}
              scanJobId={review.jobId}
              onRestage={() => restage(review.jobId)}
              receipt={review.receipt}
              notify={notify}
              onCommitted={() => markReviewed(review.jobId)}
              onDiscard={() => discard(review.jobId)}
            />
          )}
        </div>
      ))}
      </div>
    </div>
  );
}
