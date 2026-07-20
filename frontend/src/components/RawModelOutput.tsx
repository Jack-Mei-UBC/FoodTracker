"use client";

// Everything the OCR models actually returned for a scan, as a collapsible panel.
//
// The worker tries several vision models per scan but stores only the single best
// body on scan_jobs.result — so when a scan comes back useless, the text a DIFFERENT
// model managed to read is the most valuable thing on the page. scan_jobs.attempts
// keeps one record per model tried (see the worker's ScanAttempt); this renders the
// winning raw text plus every other attempt, so nothing has to be retyped from the
// photo and it's obvious whether the models disagreed or all failed the same way.
//
// Deliberately collapsed by default (it's long and mostly noise on a good scan) and
// auto-expanded when nothing parsed, which is exactly when it's the main event.

import React, { useState } from 'react';

// Mirrors the record the worker writes to scan_jobs.attempts (worker/src/worker.ts
// `ScanAttempt`). Not part of the OCR response contract in types/scan.ts — this is
// a scan_jobs column the worker builds, not something ocr-service returns.
export interface ScanAttempt {
  model: string;
  ok: boolean;
  type?: string | null;
  item_count?: number;
  confidence?: number | null;
  raw_text?: string | null;
  error?: string;
}

interface RawModelOutputProps {
  rawText?: string | null;          // the winning result's raw_text
  attempts?: ScanAttempt[] | null;  // every model tried, including failures
  defaultOpen?: boolean;
  notify?: (text: string, type?: 'success' | 'error') => void;
}

function CopyButton({ text, notify }: { text: string; notify?: RawModelOutputProps['notify'] }) {
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text)
          .then(() => notify?.('Copied raw text.'))
          .catch(() => notify?.('Copy failed — select the text manually.', 'error'));
      }}
      className="text-[11px] font-semibold text-violet-300 hover:text-violet-200"
    >
      Copy
    </button>
  );
}

function TextBlock({ text, className = 'h-48' }: { text: string; className?: string }) {
  return (
    <textarea readOnly value={text}
      className={`w-full ${className} bg-slate-950 border border-white/10 rounded-lg p-3 text-xs font-mono text-slate-300 resize-y focus:outline-none`} />
  );
}

// One row in the per-model list: outcome summary + that model's own text.
function AttemptRow({ attempt, notify }: { attempt: ScanAttempt; notify?: RawModelOutputProps['notify'] }) {
  const [open, setOpen] = useState(false);
  const text = attempt.raw_text?.trim() ?? '';
  const usable = attempt.ok && attempt.type && attempt.type !== 'unknown';

  return (
    <div className="panel p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`badge text-[9px] ${
            !attempt.ok ? 'text-rose-300 bg-rose-500/10 border-rose-500/20'
            : usable ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
            : 'text-amber-300 bg-amber-500/10 border-amber-500/20'}`}>
            {!attempt.ok ? 'error' : attempt.type ?? 'unknown'}
          </span>
          <span className="text-[11px] font-mono text-slate-300 truncate">{attempt.model}</span>
          {attempt.ok && (
            <span className="text-[10px] text-slate-500 shrink-0">
              {attempt.item_count ?? 0} item{(attempt.item_count ?? 0) !== 1 ? 's' : ''}
              {attempt.confidence != null && ` · ${Math.round(attempt.confidence * 100)}%`}
            </span>
          )}
        </div>
        {text
          ? <button onClick={() => setOpen(o => !o)} className="text-[11px] font-semibold text-slate-400 hover:text-white shrink-0">
              {open ? 'Hide text' : 'Show text'}
            </button>
          : <span className="text-[10px] text-slate-600 shrink-0">no text</span>}
      </div>
      {attempt.error && <p className="text-[10px] text-rose-400/80 font-mono break-all">{attempt.error}</p>}
      {open && text && (
        <div className="space-y-1">
          <div className="flex justify-end"><CopyButton text={text} notify={notify} /></div>
          <TextBlock text={text} className="h-40" />
        </div>
      )}
    </div>
  );
}

export default function RawModelOutput({ rawText, attempts, defaultOpen = false, notify }: RawModelOutputProps) {
  const [open, setOpen] = useState(defaultOpen);
  const winning = rawText?.trim() ?? '';
  const list = attempts ?? [];
  // Don't render an empty shell when the scan produced no text at all anywhere.
  if (!winning && list.length === 0) return null;

  const others = list.filter(a => (a.raw_text?.trim() ?? '') !== winning || !a.ok);

  return (
    <div data-loc="component.raw-model-output" className="space-y-2">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white transition">
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        Raw model output
        <span className="font-normal text-slate-500">
          ({list.length || 1} model{(list.length || 1) !== 1 ? 's' : ''} tried)
        </span>
      </button>

      {open && (
        <div className="space-y-3">
          {winning && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="field-label">Text the scan read</span>
                <CopyButton text={winning} notify={notify} />
              </div>
              <TextBlock text={winning} />
              <p className="text-[10px] text-slate-500">Copy anything useful from here into the items below instead of retyping it.</p>
            </div>
          )}

          {others.length > 0 && (
            <div className="space-y-1.5">
              <span className="field-label">Every model tried</span>
              <div className="space-y-1.5">
                {list.map((a, i) => <AttemptRow key={`${a.model}-${i}`} attempt={a} notify={notify} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
