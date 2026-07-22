'use client';

// Shared overlay/panel wrapper for every popup modal in the app (PriceEditor,
// MacroEditor, FoodDetailModal, the dashboard price-history modal, the meals
// log popup, ...). Centers on the VIEWPORT and caps the panel at 90vh with
// internal scrolling so tall content never pushes the header off-screen.
// Image lightboxes (click-anywhere-closes, self-constraining <img>) stay
// hand-rolled — everything else must use this instead of forking the markup.
//
// Renders via a portal into document.body. This is required, not cosmetic:
// every page root div and <main> carries `.animate-slide-up`, a CSS animation
// that sets a `transform` and (per spec) that makes the ancestor a new
// containing block for `position: fixed` descendants. Without the portal, a
// modal centers within that ancestor's full scrollable content box instead of
// the viewport — i.e. "opens in the middle of the page" and is unreachable
// once the page is taller than the viewport. This was the actual root cause
// of the modal-positioning bug (max-h-[90vh] alone does not fix it).
import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Full Tailwind literal (JIT), e.g. "max-w-md". Default max-w-2xl. */
  maxWidth?: string;
  /** Full Tailwind literal (JIT), e.g. "z-50" / "z-60". Default z-[80]. */
  zClass?: string;
  backdropClass?: string;
  /** Panel cosmetics (bg, border, radius, padding, spacing). */
  panelClassName?: string;
  /** data-loc marker for inspect-element -> source mapping, e.g. "modal.price-editor". */
  dataLoc?: string;
}

// Modals can stack (e.g. FoodDetailModal z-60 under PriceEditor z-[80]);
// Escape must close only the topmost one, so each instance registers here.
const modalStack: Array<() => void> = [];

export default function Modal({
  onClose,
  children,
  maxWidth = 'max-w-2xl',
  zClass = 'z-80',
  backdropClass = 'bg-black/75 backdrop-blur-xs',
  panelClassName = 'bg-[#0b0f1e] border border-white/10 rounded-2xl p-5',
  dataLoc,
}: ModalProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Portals must not render on the server (no document.body during SSR).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const close = () => onCloseRef.current();
    modalStack.push(close);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      const i = modalStack.indexOf(close);
      if (i !== -1) modalStack.splice(i, 1);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 ${zClass} ${backdropClass} flex items-center justify-center p-4`}
      onClick={() => onCloseRef.current()}
    >
      <div
        className={`w-full ${maxWidth} max-h-[90vh] overflow-y-auto relative animate-slide-up ${panelClassName}`}
        onClick={e => e.stopPropagation()}
        data-loc={dataLoc}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
