// Canvas crop → JPEG blob, shared by the food-icon picker and the receipt
// scanner's crop-before-OCR step (both go through <ImageCropper>). Extracted
// from FoodIconPicker's former inline getCroppedBlob and generalized: the output
// preserves the crop's aspect ratio (receipts are tall, not square) and only the
// max output size / quality vary per caller.

import type { Area } from 'react-easy-crop';

/**
 * Crop `area` out of the image at `imageUrl` and encode it as a JPEG Blob.
 *
 * `area` must be in **source-image pixels** — i.e. the 2nd argument of
 * react-easy-crop's `onCropComplete` (`croppedAreaPixels`), NOT the percentage
 * area. The output keeps the crop's aspect ratio; when `maxSize` is given the
 * longer side is scaled down to it (crops smaller than `maxSize` are never
 * upscaled).
 *
 * Behavior-preserving for the icon use case: a square crop (`aspect={1}`) with
 * `maxSize: 512` still yields a square ≤512px JPEG, exactly as before.
 */
export async function cropImageToBlob(
  imageUrl: string,
  area: Area,
  opts: { maxSize?: number; quality?: number } = {}
): Promise<Blob> {
  const { maxSize, quality = 0.9 } = opts;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for cropping'));
    img.src = imageUrl;
  });

  // Scale the crop so its longer side fits `maxSize`; never upscale a small crop.
  const longer = Math.max(area.width, area.height);
  const scale = maxSize ? Math.min(1, maxSize / longer) : 1;
  const outW = Math.max(1, Math.round(area.width * scale));
  const outH = Math.max(1, Math.round(area.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, outW, outH);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Crop failed'))),
      'image/jpeg',
      quality
    );
  });
}
