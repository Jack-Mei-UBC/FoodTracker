import { NextRequest, NextResponse } from 'next/server';

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';

export async function POST(req: NextRequest) {
  let image: File | null;
  try {
    const formData = await req.formData();
    image = formData.get('image') as File | null;
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data with an image field' }, { status: 400 });
  }

  if (!image) {
    return NextResponse.json({ error: 'No image file provided' }, { status: 400 });
  }

  try {
    const forward = new FormData();
    forward.append('image', image, image.name || 'capture.jpg');

    const res = await fetch(`${OCR_SERVICE_URL}/scan`, {
      method: 'POST',
      body: forward,
    });

    const body = await res.json().catch(() => ({ error: 'OCR service returned a non-JSON response' }));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error('scan route error:', err);
    return NextResponse.json({ error: 'OCR service unavailable' }, { status: 502 });
  }
}
