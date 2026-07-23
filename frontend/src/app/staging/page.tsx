"use client";

// Staging: the first half of the two-stage background queue. Images queued from
// the Scanner land here as `staged` scan_jobs (not yet processed). The user crops
// the ones that need it (shared <ImageCropper> → PUT /api/scan-jobs/:id/image,
// which stores the crop linked to the original) and then sends jobs for background
// OCR (POST /api/scan-jobs/process → they move to the Inbox). Nothing is OCR'd
// until the user explicitly sends it.

import React, { useState, useEffect, useCallback } from 'react';
import Modal from '../../components/Modal';
import ImageCropper from '../../components/ImageCropper';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/StatusToast';
import { Card } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface StagedJob {
  id: number;
  status: string;
  original_filename: string | null;
  store_id: number | null;
  store_name: string | null;
  image_id: number | null;
  created_at: string;
}

export default function Staging() {
  const [jobs, setJobs] = useState<StagedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Crop modal state.
  const [cropJob, setCropJob] = useState<StagedJob | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  // Per-batch: allow the worker's model pool to use PAID vision models (higher
  // accuracy, token cost) for the jobs sent from this page.
  const [usePaid, setUsePaid] = useState(false);

  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs?status=staged`);
      if (res.ok) setJobs(await res.json());
    } catch { /* ignore transient */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Revoke the crop object URL when it's replaced or the page unmounts.
  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);

  const openCrop = async (job: StagedJob) => {
    if (job.image_id == null) { notify('This job has no image to crop.', 'error'); return; }
    setCropError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/images/${job.image_id}`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      setCropSrc(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      setCropJob(job);
    } catch {
      notify('Failed to load the image for cropping.', 'error');
    }
  };

  const closeCrop = () => {
    setCropJob(null);
    setCropError(null);
    setCropSrc(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
  };

  const saveCrop = async (blob: Blob) => {
    if (!cropJob) return;
    setCropBusy(true);
    setCropError(null);
    try {
      const form = new FormData();
      form.append('image', blob, 'crop.jpg');
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${cropJob.id}/image`, { method: 'PUT', body: form });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      // Repoint the card's thumbnail at the new crop image (the src changes with the id).
      setJobs(prev => prev.map(j => j.id === cropJob.id ? { ...j, image_id: updated.image_id } : j));
      notify('Cropped — the original is kept and linked.');
      closeCrop();
    } catch {
      setCropError('Failed to save the crop.');
    } finally {
      setCropBusy(false);
    }
  };

  // Send staged jobs for background OCR. `ids` omitted → send all staged.
  const sendForProcessing = async (ids?: number[]) => {
    const count = ids ? ids.length : jobs.length;
    if (count === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(ids ? { ids } : {}), use_paid: usePaid }),
      });
      if (!res.ok) throw new Error();
      const { processed } = await res.json() as { processed: number[] };
      const sent = new Set<number>(processed);
      setJobs(prev => prev.filter(j => !sent.has(j.id)));
      notify(`Sent ${processed.length} for processing — track ${processed.length === 1 ? 'it' : 'them'} in the Inbox.`);
    } catch {
      notify('Failed to send for processing.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const discard = async (id: number) => {
    setJobs(prev => prev.filter(j => j.id !== id));
    try {
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
    } catch {
      notify('Discard may not have saved — it could reappear on refresh.', 'error');
    } finally { load(); }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div data-loc="page.staging" className="space-y-8 max-w-5xl mx-auto">

      {/* ═══ Section: Header ═══ */}
      <div data-loc="staging.header" className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Staging</h1>
          <p className="text-sm text-slate-400 mt-1">Images queued from the Scanner wait here — crop the ones that need it, then send them for background OCR. Nothing is processed until you do.</p>
        </div>
        {jobs.length > 0 && (
          <div className="shrink-0 flex flex-col items-end gap-2">
            <Button onClick={() => sendForProcessing()} disabled={busy}
              variant="outline" size="sm" className="rounded-xl text-emerald-300 bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20 hover:text-emerald-200">
              Send all for processing ({jobs.length})
            </Button>
            <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer select-none" title="Let the model pool use paid vision models (higher accuracy, token cost) for jobs sent from this page">
              <Checkbox checked={usePaid} onCheckedChange={c => setUsePaid(c === true)} />
              Use paid models (higher accuracy)
            </label>
          </div>
        )}
      </div>

      {/* ═══ Section: Staged grid ═══ */}
      <Card data-loc="staging.grid" className="rounded-3xl p-6">
        {loading ? (
          <p className="text-slate-600 text-sm py-6 text-center">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-slate-600 text-sm py-6 text-center">Nothing staged. Queue images from the Scanner to crop and process them here.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {jobs.map(job => (
              <div key={job.id} className="bg-muted/50 border rounded-lg p-3 space-y-2 flex flex-col">
                <div className="aspect-square rounded-lg overflow-hidden bg-slate-950 border border-white/5 flex items-center justify-center">
                  {job.image_id != null ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${API_BASE_URL}/api/images/${job.image_id}`} alt="" className="w-full h-full object-cover" />
                  ) : <span className="text-slate-600 text-xs">no image</span>}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-white font-medium truncate">{job.original_filename ?? `job #${job.id}`}</div>
                  <div className="text-[10px] text-slate-500 truncate">{job.store_name ?? 'No store'} · {fmtDate(job.created_at)}</div>
                </div>
                <div className="flex items-center gap-1.5 mt-auto">
                  <Button onClick={() => openCrop(job)} disabled={busy}
                    variant="secondary" size="sm" className="flex-1">Crop</Button>
                  <Button onClick={() => sendForProcessing([job.id])} disabled={busy}
                    size="sm" className="flex-1">Process</Button>
                  <button onClick={() => discard(job.id)} disabled={busy}
                    className="text-[11px] text-slate-500 hover:text-rose-400 px-1.5 transition" title="Discard">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ═══ Section: Crop modal ═══ */}
      {cropJob && cropSrc && (
        <Modal onClose={closeCrop} dataLoc="modal.staging-crop" maxWidth="max-w-xl">
          <div>
            <h3 className="text-sm font-bold text-white">
              Crop image
              <span className="text-slate-400 font-normal"> — {cropJob.original_filename ?? `job #${cropJob.id}`}</span>
            </h3>
          </div>
          <p className="text-xs text-slate-500">Zoom and drag to isolate the receipt or price tag. The crop replaces what gets read; the full original is kept and linked.</p>
          <ImageCropper
            source={{ url: cropSrc }}
            maxSize={2048}
            busy={cropBusy}
            error={cropError}
            primaryLabel="Save crop"
            busyLabel="Saving…"
            onCropped={saveCrop}
          />
        </Modal>
      )}
    </div>
  );
}
