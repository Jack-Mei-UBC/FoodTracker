/** @type {import('next').NextConfig} */

// Static export is OPT-IN via BUILD_TARGET=static so the two build targets stay
// separate:
//   - default `next build`  → normal Next.js server (Docker deploy: `npm start`)
//   - `BUILD_TARGET=static` → static ./out bundle for Capacitor (iOS/Android)
//
// A static export has no Node server, so:
//   - there can be no server-side API routes (the old /api/scan proxy now lives
//     in the Express backend), and
//   - next/image must run unoptimized (no image-optimization server).
//
// For the mobile build, point the client at your PUBLIC backend by setting
// NEXT_PUBLIC_API_URL at build time (it is baked into the bundle), e.g.
//   NEXT_PUBLIC_API_URL=https://api.example.com BUILD_TARGET=static npm run build
const isStatic = process.env.BUILD_TARGET === 'static';

const nextConfig = {
  ...(isStatic ? { output: 'export' } : {}),
  images: { unoptimized: true },
};

module.exports = nextConfig;
