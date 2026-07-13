import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the static Next.js export (`npm run build:mobile` → ./out) in
// a native iOS/Android shell. The app runs as a client-side SPA inside a
// WebView and talks to the PUBLIC backend over HTTPS — set NEXT_PUBLIC_API_URL
// at build time (see next.config.js). The backend already sends permissive CORS
// (app.use(cors())), which the Capacitor origin (capacitor://localhost /
// http://localhost) requires.
const config: CapacitorConfig = {
  appId: 'com.foodtracker.app',
  appName: 'FoodTracker',
  webDir: 'out',
  // Android's WebView blocks plaintext HTTP by default; keep the backend on
  // HTTPS in production. For local device testing against an http:// LAN
  // backend, temporarily add: server: { cleartext: true }.
};

export default config;
