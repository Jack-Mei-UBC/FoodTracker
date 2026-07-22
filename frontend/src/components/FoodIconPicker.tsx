"use client";

// Popup for setting a food's dashboard-card icon. Two steps:
//   pick: choose one of the food's saved scan/scrape images, or upload a new one
//   crop: crop the chosen image to a square via the shared <ImageCropper>, then save
// Saving = POST the cropped blob to /api/images, then PUT { image_id } on the food.
// {image_id: null} (the "Reset to default" button) reverts to the food's
// display_image_id fallback (earliest linked price-log image) — see CLAUDE.md.

import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import ImageCropper from './ImageCropper';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function FoodIconPicker({
  foodId,
  foodName,
  ownImageId,
  onClose,
  onSaved,
}: {
  foodId: number;
  foodName?: string;
  ownImageId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<'pick' | 'crop'>('pick');
  const [candidateIds, setCandidateIds] = useState<number[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [source, setSource] = useState<{ url: string; isObjectUrl: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}/prices`);
        if (!res.ok) throw new Error();
        const logs: Array<{ image_id: number | null }> = await res.json();
        // Dedupe while keeping newest-first order (a Set works fine here — the
        // pre-ES2015 tsconfig target only blocks *spreading* a Set, not using one).
        const seen = new Set<number>();
        const ids: number[] = [];
        for (const log of logs) {
          if (log.image_id != null && !seen.has(log.image_id)) {
            seen.add(log.image_id);
            ids.push(log.image_id);
          }
        }
        if (!cancelled) setCandidateIds(ids.slice(0, 24));
      } catch {
        if (!cancelled) setError('Failed to load saved images.');
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    })();
    return () => { cancelled = true; };
  }, [foodId]);

  // Revoke any object URL we created when it's replaced or the popup closes.
  useEffect(() => {
    return () => {
      if (source?.isObjectUrl) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  const pickSaved = async (imageId: number) => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/images/${imageId}`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      setSource({ url: URL.createObjectURL(blob), isObjectUrl: true });
      setStep('crop');
    } catch {
      setError('Failed to load that image.');
    }
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSource({ url: URL.createObjectURL(file), isObjectUrl: true });
    setStep('crop');
  };

  const resetToDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_id: null }),
      });
      if (!res.ok) throw new Error();
      onSaved();
    } catch {
      setError('Failed to reset icon.');
    } finally {
      setBusy(false);
    }
  };

  // The crop → JPEG blob now comes from the shared <ImageCropper>; this just
  // persists it (POST /api/images) and points the food's icon at the new image.
  const handleCropped = async (blob: Blob) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('image', blob, `food-${foodId}-icon.jpg`);
      const uploadRes = await fetch(`${API_BASE_URL}/api/images`, { method: 'POST', body: form });
      if (!uploadRes.ok) throw new Error();
      const { id } = await uploadRes.json();
      const putRes = await fetch(`${API_BASE_URL}/api/foods/${foodId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_id: id }),
      });
      if (!putRes.ok) throw new Error();
      onSaved();
    } catch {
      setError('Failed to save icon.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} zClass="z-60" maxWidth="max-w-lg" panelClassName="bg-[#0b0f1e] border border-white/10 rounded-2xl p-5 space-y-4" dataLoc="modal.food-icon-picker">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">
          {step === 'pick' ? 'Choose Icon' : 'Crop Icon'}
          {foodName ? <span className="text-slate-400 font-normal"> — {foodName}</span> : null}
        </h3>
        <button onClick={onClose} className="text-slate-500 hover:text-white p-1 rounded-full hover:bg-white/5 transition">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {error && <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>}

      {step === 'pick' ? (
        <div className="space-y-3">
          {loadingCandidates ? (
            <div className="text-xs text-slate-500 py-6 text-center">Loading saved images…</div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {candidateIds.map(id => (
                <button
                  key={id}
                  onClick={() => pickSaved(id)}
                  className={`aspect-square rounded-lg overflow-hidden border ${ownImageId === id ? 'border-violet-500' : 'border-white/10'} hover:border-violet-500/60 transition`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${API_BASE_URL}/api/images/${id}`} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-lg border border-dashed border-white/20 hover:border-violet-500/60 flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-white transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                <span className="text-[10px] font-semibold">Upload</span>
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={onUpload} className="hidden" />
            </div>
          )}
          {!loadingCandidates && candidateIds.length === 0 && (
            <p className="text-xs text-slate-500">No saved images for this food yet — upload one instead.</p>
          )}
          {ownImageId != null && (
            <button
              onClick={resetToDefault}
              disabled={busy}
              className="btn btn-secondary w-full rounded-lg py-2 text-xs"
            >
              Reset to default
            </button>
          )}
        </div>
      ) : source ? (
        <ImageCropper
          source={source}
          aspect={1}
          maxSize={512}
          busy={busy}
          primaryLabel="Save Icon"
          busyLabel="Saving…"
          onBack={() => { setStep('pick'); setSource(null); }}
          onCropped={handleCropped}
        />
      ) : null}
    </Modal>
  );
}
