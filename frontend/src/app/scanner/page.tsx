"use client";

import React, { useState, useRef, useEffect } from 'react';
import type { ScanResponse } from '../../types/scan';
import ReviewItems, { RawItem } from '../../components/ReviewItems';

// Staged status shown while the (possibly slow) vision call is in flight.
const stageForElapsed = (s: number): string => {
  if (s < 2) return 'Uploading image to vision AI...';
  if (s < 8) return 'Vision AI is reading the image...';
  if (s < 18) return 'Classifying receipt vs. price tag...';
  if (s < 35) return 'Extracting products, prices, and sizes...';
  return 'Still working — the free AI model can take up to ~90s...';
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Store { id: number; name: string; }

export default function Scanner() {
  const [isScanning, setIsScanning] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<string[]>([]);
  const [scanElapsed, setScanElapsed] = useState(0);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Selected-but-not-yet-processed image, and the extracted result for review.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [rawItems, setRawItems] = useState<RawItem[] | null>(null);
  const [scanConfidence, setScanConfidence] = useState(1);
  // Stored image id + EXIF GPS for the scan under review (attached to committed logs).
  const [scanImageId, setScanImageId] = useState<number | null>(null);
  const [scanGps, setScanGps] = useState<{ lat: number; lng: number } | null>(null);
  // True when the AI found nothing usable — review renders empty, ready for manual entry.
  const [manualEntryMode, setManualEntryMode] = useState(false);

  const [targetStoreId, setTargetStoreId] = useState<string>('1');
  const [stores, setStores] = useState<Store[]>([]);

  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const notify = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 5000);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const appendLog = (line: string) => setOcrProgress(prev => [...prev, line]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/stores`).then(r => r.ok ? r.json() : []).then(setStores).catch(() => {});
  }, []);

  const startScanTimer = () => {
    setScanElapsed(0);
    scanTimerRef.current = setInterval(() => setScanElapsed(s => s + 1), 1000);
  };
  const stopScanTimer = () => {
    if (scanTimerRef.current) { clearInterval(scanTimerRef.current); scanTimerRef.current = null; }
  };
  useEffect(() => stopScanTimer, []);

  // Send one or more images straight to the background queue (Inbox).
  const queueImages = async (files: File[]): Promise<boolean> => {
    try {
      const form = new FormData();
      files.forEach(f => form.append('images', f));
      form.append('store_id', targetStoreId);
      const res = await fetch(`${API_BASE_URL}/api/scan-jobs`, { method: 'POST', body: form });
      if (!res.ok) throw new Error();
      notify(`${files.length} image${files.length > 1 ? 's' : ''} queued — check the Inbox shortly.`);
      return true;
    } catch {
      notify('Failed to queue image(s).', 'error');
      return false;
    }
  };

  // Select an image for the live-scan slot. If an image is already waiting there,
  // it auto-queues to the background (starts processing) instead of being replaced.
  const selectImage = async (file: File) => {
    if (isScanning) {
      // A live scan is running — don't disturb it; process the new image in the background.
      queueImages([file]);
      return;
    }
    if (pendingFile) {
      const ok = await queueImages([pendingFile]);
      if (!ok) return; // keep both: old stays pending, user can retry
    }
    setPendingFile(file);
    setPendingPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setRawItems(null);
    setManualEntryMode(false);
    setScanImageId(null);
    setScanGps(null);
    setOcrProgress([]);
  };

  // Batch intake: one image goes to the live slot, several go to the background queue.
  const intakeFiles = (files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) {
      notify('Please provide image files.', 'error');
      return;
    }
    if (images.length === 1) selectImage(images[0]);
    else queueImages(images);
  };

  // Synchronous scan path (vision AI now → review below).
  const scanNow = async () => {
    if (!pendingFile) return;
    setIsScanning(true);
    setOcrProgress(['Uploading image to vision AI...']);
    setRawItems(null);
    setManualEntryMode(false);
    startScanTimer();
    try {
      // Store the image first (fast, local) so committed logs can link to it,
      // and pick up EXIF GPS for store auto-selection.
      try {
        const imgForm = new FormData();
        imgForm.append('image', pendingFile);
        const imgRes = await fetch(`${API_BASE_URL}/api/images`, { method: 'POST', body: imgForm });
        if (imgRes.ok) {
          const img = await imgRes.json();
          setScanImageId(img.id);
          if (img.latitude != null && img.longitude != null) {
            setScanGps({ lat: Number(img.latitude), lng: Number(img.longitude) });
            appendLog('Photo has GPS location — will try to auto-match the store.');
          }
        }
      } catch { /* attachment is best-effort; the scan itself continues */ }

      const formData = new FormData();
      formData.append('image', pendingFile);
      const scanRes = await fetch('/api/scan', { method: 'POST', body: formData });
      if (!scanRes.ok) {
        const err = await scanRes.json().catch(() => ({ error: scanRes.statusText }));
        appendLog(`Scan Error: ${err.error || err.detail || scanRes.statusText}`);
        notify('Image scan failed.', 'error');
        return;
      }
      const scan: ScanResponse = await scanRes.json();
      setScanConfidence(scan.confidence);

      let items: RawItem[];
      if (scan.type === 'receipt') {
        const { store_name, purchase_date, items: receiptItems } = scan.data;
        appendLog(`Detected a receipt${store_name ? ` from "${store_name}"` : ''}${purchase_date ? ` dated ${purchase_date}` : ''} — ${receiptItems.length} product lines.`);
        items = receiptItems.map(it => ({ ...it, amountUnit: it.amount_unit }));
      } else if (scan.type === 'price_tag') {
        const tag = scan.data;
        appendLog(`Detected a shelf price tag: ${tag.name} @ $${tag.price}${tag.is_sale ? ' (SALE)' : ''}.`);
        items = [{ name: tag.name, price: tag.price, category: tag.category, unit: tag.unit, barcode: tag.barcode, isSale: tag.is_sale, amount: tag.amount, amountUnit: tag.amount_unit }];
      } else {
        appendLog(`Image not recognized as a receipt or price tag: ${scan.data.reason}`);
        notify('Not recognized — you can still add items manually below.', 'error');
        setManualEntryMode(true);
        setRawItems([]);
        return;
      }
      if (items.length === 0) {
        appendLog('AI could not identify any product lines in this image. You can add them manually below.');
        notify('No products detected. Add items manually, or try a clearer image.', 'error');
        setManualEntryMode(true);
        setRawItems([]);
        return;
      }
      appendLog(`AI extracted ${items.length} product line${items.length > 1 ? 's' : ''}. Review below.`);
      setRawItems(items);
      notify('Scan complete — review items below and save.');
    } catch (err: any) {
      console.error(err);
      appendLog(`Fatal error: ${err.message || err}`);
      notify('Receipt processing failed.', 'error');
    } finally {
      stopScanTimer();
      setIsScanning(false);
    }
  };

  // Background queue path (upload → worker processes → Inbox).
  const queueForLater = async () => {
    if (!pendingFile) return;
    setQueuing(true);
    const ok = await queueImages([pendingFile]);
    if (ok) {
      setPendingFile(null);
      if (pendingPreview) { URL.revokeObjectURL(pendingPreview); setPendingPreview(null); }
      setOcrProgress([]);
    }
    setQueuing(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) intakeFiles(files);
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

  // Paste works even mid-scan: the new image routes to the background queue
  // instead of disturbing the in-flight scan.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (queuing) return;
      const files = imagesFromClipboardItems(e.clipboardData?.items);
      if (files.length > 0) { e.preventDefault(); intakeFiles(files); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuing, isScanning, pendingFile, targetStoreId]);

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
      if (files.length > 0) intakeFiles(files);
      else notify('No image found on the clipboard. Copy a receipt image first.', 'error');
    } catch (err) {
      console.error('clipboard read failed:', err);
      notify('Could not read the clipboard. Grant permission, or use Ctrl+V / upload.', 'error');
    }
  };

  const busy = isScanning || queuing;

  return (
    <div className="space-y-8 max-w-4xl mx-auto relative">
      {statusMsg && (
        <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 transition duration-300 ${
          statusMsg.type === 'success'
            ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30'
            : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'}`}>
          <span className="text-sm font-semibold">{statusMsg.text}</span>
        </div>
      )}

      <div className="border-b border-white/5 pb-3">
        <h1 className="text-lg font-bold text-white">Receipt OCR Scanner</h1>
        <p className="text-xs text-slate-500 mt-0.5">Upload, drag &amp; drop, or paste (Ctrl+V) a receipt or shelf price tag — scan now, or queue it to process in the background.</p>
      </div>

      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">

          {/* Uploader */}
          <div className="md:col-span-1 rounded-3xl p-6 glass-panel border border-white/5 space-y-4">
            <h2 className="text-lg font-bold text-white">Upload Receipt or Price Tag</h2>

            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" multiple className="hidden" />

            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-violet-500/80'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('border-violet-500/80'); }}
              onDrop={e => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-violet-500/80');
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length > 0) intakeFiles(files);
              }}
              className="w-full aspect-[4/3] rounded-2xl border-2 border-dashed border-white/10 hover:border-violet-500/50 flex flex-col items-center justify-center p-4 cursor-pointer bg-slate-950 transition overflow-hidden"
            >
              {pendingPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pendingPreview} alt="preview" className="max-h-full max-w-full object-contain rounded-lg" />
              ) : (
                <>
                  <svg className="w-8 h-8 text-slate-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-[10px] text-slate-500 font-semibold uppercase text-center">Click, Drop, or Paste Images</span>
                  <span className="text-[9px] text-slate-600 mt-1 block">JPG, PNG, WEBP · Ctrl+V · multiple images auto-queue to Inbox</span>
                </>
              )}
            </div>

            {/* Store selector (applies to background queue + prefills review) */}
            <div className="flex items-center justify-between bg-slate-950 border border-white/5 p-2 rounded-xl">
              <span className="text-[10px] text-slate-500 font-semibold uppercase pl-1">Store</span>
              <select value={targetStoreId} onChange={e => setTargetStoreId(e.target.value)}
                className="bg-transparent text-xs text-white focus:outline-none">
                {stores.length > 0
                  ? stores.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)
                  : <><option value="1">SuperMarket Central</option><option value="2">Organic Grocer</option><option value="3">Value Foods</option></>}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={scanNow} disabled={!pendingFile || busy}
                className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl py-3 text-sm font-semibold transition hover:shadow-lg disabled:opacity-50">
                {isScanning ? 'Scanning...' : 'Scan Now'}
              </button>
              <button onClick={queueForLater} disabled={!pendingFile || busy}
                title="Process in the background — results appear in the Inbox"
                className="flex items-center justify-center gap-1.5 bg-white/5 border border-white/10 text-white rounded-xl py-3 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-50">
                {queuing ? 'Queuing...' : 'Queue for Later'}
              </button>
            </div>
            <button onClick={pasteFromClipboard} disabled={busy}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-white py-1 transition disabled:opacity-50">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a1 1 0 001 1h4a1 1 0 001-1M9 5a1 1 0 011-1h4a1 1 0 011 1" />
              </svg>
              Paste from clipboard
            </button>
          </div>

          {/* Console Log */}
          <div className="md:col-span-2 rounded-3xl p-6 glass-panel border border-white/5 space-y-4 min-h-[300px]">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Processing Console</h2>
              <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                <span className={`w-1.5 h-1.5 rounded-full inline-block ${isScanning ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                Vision AI → DB
              </div>
            </div>

            {isScanning && (
              <div className="space-y-2 animate-slide-up">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-violet-300 font-semibold animate-pulse">{stageForElapsed(scanElapsed)}</span>
                  <span className="text-slate-500 font-mono tabular-nums">{scanElapsed}s</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-violet-500 to-indigo-400 rounded-full transition-all duration-1000 ease-out"
                    style={{ width: `${Math.min(95, Math.round((1 - Math.exp(-scanElapsed / 15)) * 100))}%` }} />
                </div>
              </div>
            )}

            <div className="bg-slate-950 rounded-2xl p-4 h-[220px] overflow-y-auto space-y-1.5 font-mono text-xs text-slate-300">
              {ocrProgress.length === 0 && !isScanning && (
                <span className="text-slate-600">Console idle. Select an image, then Scan Now or Queue for Later...</span>
              )}
              {ocrProgress.map((line, idx) => (
                <div key={idx} className="flex items-start space-x-2">
                  <span className="text-violet-500 shrink-0">&gt;&gt;</span>
                  <span className={idx === ocrProgress.length - 1 && isScanning ? 'text-violet-400 animate-pulse' : ''}>{line}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Review (shared component) */}
        {rawItems && (
          <ReviewItems
            items={rawItems}
            confidence={scanConfidence}
            defaultStoreId={targetStoreId}
            source="scan"
            imageId={scanImageId}
            imageSrc={pendingPreview}
            gps={scanGps}
            manualEntry={manualEntryMode}
            notify={notify}
            onCommitted={() => { setRawItems(null); setManualEntryMode(false); setPendingFile(null); setScanImageId(null); setScanGps(null); if (pendingPreview) { URL.revokeObjectURL(pendingPreview); setPendingPreview(null); } }}
            onDiscard={() => { setRawItems(null); setManualEntryMode(false); }}
          />
        )}
      </div>
    </div>
  );
}
