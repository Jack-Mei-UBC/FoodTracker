"use client";

// Reusable crop surface: react-easy-crop + a zoom slider + Back / Use-original /
// primary actions. **Presentation-only** — it is NOT wrapped in Modal; callers
// embed it (FoodIconPicker inside its own Modal, the scanner inside a new one).
// It emits a cropped JPEG Blob via onCropped; the canvas work lives in lib/crop.
//
// react-easy-crop is a pan/zoom cropper with a *fixed-aspect* window (v6 has no
// free-form mode). When `aspect` is omitted we frame the whole image (crop window
// = the image's own shape via onMediaLoaded) so zoom=1 ≈ the full picture and the
// user zooms in to crop tighter; pass a fixed `aspect` (e.g. 1) to force a shape.
//
// data-loc="component.image-cropper" (inspect-element → source; see CLAUDE.md).

import React, { useEffect, useRef, useState } from 'react';
import Cropper, { Area } from 'react-easy-crop';
import { Button } from './ui/button';
import { cropImageToBlob } from '../lib/crop';

// How far the crop can zoom in (react-easy-crop defaults to 3× — too shallow for
// isolating a small region of a busy receipt photo).
const MAX_ZOOM = 8;

export default function ImageCropper({
  source,
  aspect,
  maxSize,
  quality,
  busy = false,
  error = null,
  primaryLabel = 'Save',
  busyLabel = 'Saving…',
  onCropped,
  onSkip,
  onBack,
}: {
  source: { url: string };
  /** Fixed crop-window ratio (e.g. 1 for a square icon). Omit to match the image. */
  aspect?: number;
  /** Cap the longer side of the output JPEG (px). */
  maxSize?: number;
  /** JPEG quality 0–1 (default 0.9). */
  quality?: number;
  /** Parent-owned in-flight flag (e.g. an upload after the crop). */
  busy?: boolean;
  /** Parent-owned error message to surface. */
  error?: string | null;
  primaryLabel?: string;
  busyLabel?: string;
  onCropped: (blob: Blob) => void | Promise<void>;
  /** When provided, renders a "Use original" button that skips cropping. */
  onSkip?: () => void;
  /** When provided, renders a "Back" button. */
  onBack?: () => void;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [derivedAspect, setDerivedAspect] = useState<number | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Reset interaction state whenever the image being cropped changes.
  useEffect(() => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
    setDerivedAspect(undefined);
    setLocalError(null);
  }, [source.url]);

  const effectiveAspect = aspect ?? derivedAspect ?? 1;
  const disabled = busy || working;

  const handlePrimary = async () => {
    if (!croppedArea) return;
    setLocalError(null);
    setWorking(true);
    try {
      const blob = await cropImageToBlob(source.url, croppedArea, { maxSize, quality });
      await onCropped(blob);
    } catch (e: any) {
      if (mounted.current) setLocalError(e?.message || 'Crop failed');
    } finally {
      if (mounted.current) setWorking(false);
    }
  };

  return (
    <div data-loc="component.image-cropper" className="space-y-4">
      {(error || localError) && (
        <div className="text-xs font-semibold text-rose-300 bg-rose-950/70 border border-rose-500/30 rounded-lg px-3 py-2">
          {error || localError}
        </div>
      )}

      <div className="relative w-full h-72 bg-slate-950 rounded-lg overflow-hidden">
        <Cropper
          image={source.url}
          crop={crop}
          zoom={zoom}
          maxZoom={MAX_ZOOM}
          aspect={effectiveAspect}
          objectFit="contain"
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_, areaPixels) => setCroppedArea(areaPixels)}
          onMediaLoaded={(m) => {
            if (aspect === undefined && m.naturalWidth > 0 && m.naturalHeight > 0) {
              setDerivedAspect(m.naturalWidth / m.naturalHeight);
            }
          }}
        />
      </div>

      <input
        type="range" min={1} max={MAX_ZOOM} step={0.1} value={zoom}
        onChange={e => setZoom(Number(e.target.value))}
        disabled={disabled}
        className="w-full accent-violet-500"
      />

      <div className="flex gap-2">
        {onBack && (
          <Button onClick={onBack} disabled={disabled} variant="secondary">
            Back
          </Button>
        )}
        {onSkip && (
          <Button onClick={onSkip} disabled={disabled} variant="secondary">
            Use original
          </Button>
        )}
        <Button
          onClick={handlePrimary}
          disabled={disabled || !croppedArea}
          className="flex-1"
        >
          {disabled ? busyLabel : primaryLabel}
        </Button>
      </div>
    </div>
  );
}
