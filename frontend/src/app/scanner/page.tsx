"use client";

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import StatusToast, { useToast } from '../../components/StatusToast';

// Scanner is now a pure INTAKE surface: every capture is staged for the
// background queue (there is no synchronous "scan now" path anymore — see
// CLAUDE.md "OCR ingestion"). Uploads/drops/pastes go to /staging as `staged`
// scan_jobs; the user crops there and sends them for multi-model OCR, then
// reviews the results in /inbox.

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Store { id: number; name: string; }

export default function Scanner() {
  const [queuing, setQueuing] = useState(false);
  const [lastStaged, setLastStaged] = useState<number>(0);

  const [targetStoreId, setTargetStoreId] = useState<string>('1');
  const [stores, setStores] = useState<Store[]>([]);

  const { statusMsg, notify } = useToast();

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`).then(r => r.ok ? r.json() : []).then(setStores).catch(() => {});
  }, []);

  // Stage one or more images (the ONLY intake action now). They land on /staging
  // as `staged` jobs — nothing is OCR'd until the user sends them there.
  const stageImages = async (files: File[]): Promise<boolean> => {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) {
      notify('Please provide image files.', 'error');
      return false;
    }
    setQueuing(true);
    try {
      const form = new FormData();
      images.forEach(f => form.append('images', f));
      form.append('store_id', targetStoreId);
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs`, { method: 'POST', body: form });
      if (!res.ok) throw new Error();
      setLastStaged(images.length);
      notify(`${images.length} image${images.length > 1 ? 's' : ''} added to Staging — crop and send for processing there.`);
      return true;
    } catch {
      notify('Failed to add image(s) to Staging.', 'error');
      return false;
    } finally {
      setQueuing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) stageImages(files);
    e.target.value = ''; // allow re-selecting the same file(s)
  };

  const imagesFromClipboardItems = (items: DataTransferItemList | undefined): File[] => {
    if (!items) return [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    return files;
  };

  // Paste (Ctrl+V) anywhere on the page stages the image(s).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (queuing) return;
      const files = imagesFromClipboardItems(e.clipboardData?.items);
      if (files.length > 0) { e.preventDefault(); stageImages(files); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuing, targetStoreId]);

  const pasteFromClipboard = async () => {
    if (queuing) return;
    try {
      if (!navigator.clipboard?.read) {
        notify('Clipboard paste is not supported by this browser. Use Ctrl+V or upload.', 'error');
        return;
      }
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of clipboardItems) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          files.push(new File([blob], 'pasted-image', { type: imageType }));
        }
      }
      if (files.length > 0) stageImages(files);
      else notify('No image found on the clipboard. Copy a receipt image first.', 'error');
    } catch (err) {
      console.error('clipboard read failed:', err);
      notify('Could not read the clipboard. Grant permission, or use Ctrl+V / upload.', 'error');
    }
  };

  return (
    <div data-loc="page.scanner" className="space-y-8 max-w-4xl mx-auto relative">
      <StatusToast statusMsg={statusMsg} />

      {/* ═══ Section: Header ═══ */}
      <div data-loc="scanner.header" className="border-b border-white/5 pb-3">
        <h1 className="text-lg font-bold text-white">Receipt &amp; Price-Tag Capture</h1>
        <p className="text-xs text-slate-500 mt-0.5">Upload, drag &amp; drop, or paste (Ctrl+V) receipts or shelf price tags. Everything is queued for background OCR — crop and send from Staging, then review in the Inbox.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">

        {/* ═══ Section: Uploader ═══ */}
        <div data-loc="scanner.uploader" className="md:col-span-2 card rounded-3xl p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">Add captures to Staging</h2>

          <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" multiple className="hidden" />

          <div
            onClick={() => { if (!queuing) fileInputRef.current?.click(); }}
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-violet-500/80'); }}
            onDragLeave={e => { e.currentTarget.classList.remove('border-violet-500/80'); }}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-violet-500/80');
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.length > 0) stageImages(files);
            }}
            className={`w-full aspect-4/3 rounded-2xl border-2 border-dashed border-white/10 hover:border-violet-500/50 flex flex-col items-center justify-center p-4 cursor-pointer bg-slate-950 transition overflow-hidden ${queuing ? 'opacity-60 pointer-events-none' : ''}`}
          >
            <svg className="w-8 h-8 text-slate-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-[10px] text-slate-500 font-semibold uppercase text-center">{queuing ? 'Adding to Staging…' : 'Click, Drop, or Paste Images'}</span>
            <span className="text-[9px] text-slate-600 mt-1 block">JPG, PNG, WEBP · Ctrl+V · multiple images supported</span>
          </div>

          {/* Store selector (prefills the review; applies to all staged images) */}
          <div className="flex items-center justify-between bg-slate-950 border border-white/5 p-2 rounded-xl">
            <span className="text-[10px] text-slate-500 font-semibold uppercase pl-1">Store</span>
            <select value={targetStoreId} onChange={e => setTargetStoreId(e.target.value)}
              className="bg-transparent text-xs text-white focus:outline-hidden">
              {stores.length > 0
                ? stores.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)
                : <><option value="1">SuperMarket Central</option><option value="2">Organic Grocer</option><option value="3">Value Foods</option></>}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => { if (!queuing) fileInputRef.current?.click(); }} disabled={queuing}
              className="btn btn-primary rounded-xl py-3 text-sm font-semibold disabled:opacity-50">
              {queuing ? 'Adding…' : 'Choose images'}
            </button>
            <button onClick={pasteFromClipboard} disabled={queuing}
              className="btn btn-secondary rounded-xl py-3 text-sm font-semibold disabled:opacity-50">
              Paste from clipboard
            </button>
          </div>
        </div>

        {/* ═══ Section: Next steps ═══ */}
        <div data-loc="scanner.next-steps" className="md:col-span-1 card rounded-3xl p-6 space-y-4">
          <h2 className="text-sm font-bold text-white">What happens next</h2>
          <ol className="space-y-3 text-xs text-slate-400">
            <li className="flex gap-2"><span className="text-violet-400 font-bold">1.</span><span>Images land in <span className="text-white font-semibold">Staging</span>.</span></li>
            <li className="flex gap-2"><span className="text-violet-400 font-bold">2.</span><span>Crop each one, then <span className="text-white font-semibold">send for processing</span> (choose free or paid models).</span></li>
            <li className="flex gap-2"><span className="text-violet-400 font-bold">3.</span><span>Multiple free models read them in parallel; results appear in the <span className="text-white font-semibold">Inbox</span> to review &amp; commit.</span></li>
          </ol>
          {lastStaged > 0 && (
            <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              Added {lastStaged} image{lastStaged > 1 ? 's' : ''} to Staging.
            </div>
          )}
          <div className="flex flex-col gap-2 pt-1">
            <Link href="/staging" className="btn btn-primary rounded-xl py-2.5 text-xs font-semibold text-center">Go to Staging →</Link>
            <Link href="/inbox" className="btn btn-secondary rounded-xl py-2.5 text-xs font-semibold text-center">Open Inbox</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
