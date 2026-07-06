import { useEffect, RefObject } from 'react';

// Calls `onOutside` when a mousedown lands outside the referenced element.
// Pass `enabled: false` to pause (e.g. while a save is in flight).
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onOutside, enabled]);
}
