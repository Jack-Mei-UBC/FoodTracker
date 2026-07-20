"use client";

// Shared bottom-right status toast + its state hook. The scanner and inbox both
// previously hand-rolled an identical copy of this.
import { useState, useCallback } from 'react';

export type ToastMsg = { type: 'success' | 'error'; text: string } | null;

export function useToast() {
  const [statusMsg, setStatusMsg] = useState<ToastMsg>(null);
  const notify = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 5000);
  }, []);
  return { statusMsg, notify };
}

export default function StatusToast({ statusMsg }: { statusMsg: ToastMsg }) {
  if (!statusMsg) return null;
  return (
    <div className={`fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center gap-3 transition ${
      statusMsg.type === 'success'
        ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/30'
        : 'bg-rose-950/90 text-rose-300 border border-rose-500/30'}`}>
      <span className="text-sm font-semibold">{statusMsg.text}</span>
    </div>
  );
}
