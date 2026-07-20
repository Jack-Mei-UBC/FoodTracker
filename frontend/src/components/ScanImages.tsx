"use client";

// The source photo(s) for a scan, shown wherever a scan result is reviewed (the
// inbox review panel and the unrecognized-scan card).
//
// When the job's image is a CROP (staging's crop-before-OCR step stores the crop
// linked to its original via images.original_image_id), both are rendered side by
// side and labelled: the crop is what the model actually read, the original is
// the full context. That pairing is the point — if the crop cut off the product
// name, the only way to tell is to see what it was cut from. A job that was never
// cropped renders the single image on its own.

import React from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface ScanImagesProps {
  imageId: number | null;
  originalImageId?: number | null; // set only when imageId is a crop of it
  className?: string;
}

function Shot({ id, caption, hint }: { id: number; caption: string; hint: string }) {
  const src = `${API_BASE_URL}/api/images/${id}`;
  return (
    <figure className="flex flex-col items-center gap-1.5 min-w-0">
      <a href={src} target="_blank" rel="noreferrer" title="Open full size" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={caption} loading="lazy"
          className="max-h-64 w-auto rounded-xl border border-white/10 hover:border-violet-500/50 transition" />
      </a>
      <figcaption className="text-center">
        <div className="text-[11px] font-semibold text-slate-300">{caption}</div>
        <div className="text-[10px] text-slate-500">{hint}</div>
      </figcaption>
    </figure>
  );
}

export default function ScanImages({ imageId, originalImageId = null, className = '' }: ScanImagesProps) {
  if (imageId == null) return null;
  const isCropped = originalImageId != null && originalImageId !== imageId;

  if (!isCropped) {
    return (
      <div data-loc="component.scan-images" className={`flex justify-center ${className}`}>
        <Shot id={imageId} caption="Scanned image" hint="not cropped" />
      </div>
    );
  }

  return (
    <div data-loc="component.scan-images" className={`flex flex-wrap items-start justify-center gap-4 ${className}`}>
      <Shot id={imageId} caption="Cropped (scanned)" hint="what the model read" />
      <Shot id={originalImageId} caption="Original" hint="full uncropped photo" />
    </div>
  );
}
