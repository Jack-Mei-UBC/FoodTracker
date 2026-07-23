'use client';

// Shared overlay/panel wrapper for every popup modal in the app (PriceEditor,
// MacroEditor, FoodDetailModal, the dashboard price-history modal, the meals
// log popup, ...). Image lightboxes (click-anywhere-closes, self-constraining
// <img>) stay hand-rolled — everything else must use this instead of forking
// the markup.
//
// Internals are Base UI's Dialog (via shadcn's generated wrapper in
// src/components/ui/dialog.tsx) — NOT hand-rolled anymore. That gets us, for
// free, everything Modal.tsx used to hand-roll and one thing it never had:
//   - viewport-centered, portaled panel (`DialogPortal` -> document.body).
//     Still required, not cosmetic: any transform/filter/backdrop-filter on
//     an ancestor makes it a containing block for `position: fixed`, which is
//     what made an inline modal center inside the page's scroll box instead
//     of the viewport. `frontend/e2e/modal.spec.ts` asserts this.
//   - Escape / outside-press to close, scoped to the topmost dialog when
//     stacked (Base UI's Root tracks this per-instance; verified against
//     FoodDetailModal -> ShareNutritionModal in modal.spec.ts).
//   - focus trap + scroll lock (`modal` defaults to `true` on Dialog.Root) —
//     the hand-rolled version never had this.
// Deliberately dropped, not preserved: the `zClass`/`backdropClass`/
// `panelClassName` props and the module-level `modalStack` array. 13 of 16
// call sites passed the byte-identical panelClassName; the z-index props were
// hand-maintained numbers encoding stacking order that Base UI now manages by
// DOM order. Panel chrome (background, border, radius) is shadcn's
// `DialogContent` default (`bg-popover`, `ring-1 ring-foreground/10`,
// `rounded-xl`) for every modal, uniformly, plus a built-in close button —
// so callers no longer hand-roll their own "×" button.
import { ReactNode } from 'react';
import { Dialog, DialogContent } from './ui/dialog';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Full Tailwind literal (JIT), e.g. "max-w-md". Default (shadcn's) is max-w-sm. */
  maxWidth?: string;
  /** data-loc marker for inspect-element -> source mapping, e.g. "modal.price-editor". */
  dataLoc?: string;
}

export default function Modal({ onClose, children, maxWidth, dataLoc }: ModalProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        data-loc={dataLoc}
        className={`max-h-[90vh] overflow-y-auto ${maxWidth ?? ''}`}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
