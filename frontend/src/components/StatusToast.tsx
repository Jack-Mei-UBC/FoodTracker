"use client";

// Thin wrapper over sonner so every call site keeps the same
// `const { notify } = useToast()` signature it had with the old hand-rolled
// bottom-right toast — only the rendering moved (to the single <Toaster />
// mounted once in layout.tsx). No local state, no per-page toast markup.
import { useCallback } from 'react';
import { toast } from 'sonner';

export function useToast() {
  const notify = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    (type === 'success' ? toast.success : toast.error)(text);
  }, []);
  return { notify };
}
