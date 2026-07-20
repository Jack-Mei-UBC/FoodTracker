# Capturing screenshots

The README gallery expects the seven PNGs below in this folder. Capturing them is
a two-minute job once the stack is up and seeded — do it from a real browser on
the host (the automated in-app browser can't rasterize this app's
glassmorphism reliably).

## Setup

```bash
docker compose up -d --wait
cd frontend && npm run seed        # deterministic fixture catalog
```

Open http://localhost:3000 in Chrome/Edge at a **1440×900** viewport, dark theme
(the app is dark-only). For crisp, flake-free frames, paste this into the
DevTools console once per page to freeze the entry animations and the glow
pulse:

```js
const s = document.createElement('style');
s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important} .animate-slide-up{transform:none!important;opacity:1!important}';
document.head.appendChild(s);
```

Capture with the browser's built-in full-page screenshot (DevTools → ⋮ → *Capture
node/full-size screenshot*, or Cmd/Ctrl-Shift-P → "screenshot"). Save each into
`docs/screenshots/` with the exact filename below — the README references them
directly, so no other wiring is needed.

## Shot list

| File | Page | What to frame — why it sells the project |
|---|---|---|
| `dashboard.png` | `/` | The three summary cards (foods / stores / **avg spread %**) above the sortable catalog table. The hero shot: real data, honest client-side sorting, canonical per-kg prices. |
| `price-history.png` | `/` → click any food row | The price-history modal: the trend sparkline **plus** the per-serving *and* per-100 nutrition chips and the canonical per-kg price. Shows the depth behind a single row. |
| `inbox-review.png` | `/inbox` → open a reviewed scan | The OCR review grid with the **cropped image beside its uncropped original** and the "Raw model output" panel expanded. This is the human-in-the-loop story in one frame. |
| `audit.png` | `/audit` | The bulk catalog audit — tag chips, category filters with counts, a few rows selected so the bulk bar (archive / merge / tag) shows. The "clean up 358 scraped rows" story. |
| `meals.png` | `/meals` → build a meal | The builder with its live per-serving macro **and cost** preview, and the Catalog / USDA tabs. Recipes costed against real price history. |
| `budget.png` | `/budget` | The spend-vs-budget progress bar with the by-store and by-month breakdowns. Receipts as a spending record, separate from prices. |
| `scrapes.png` | `/scrapes` → expand a run | A scrape run expanded to show logged prices with their saved flyer thumbnails and the "Flyer page ↗" links. The ingestion pipeline made visible. |

Keep them under ~500 KB each (PNG, the built-in capture is already compressed).
Once they're in, the gallery in the README renders automatically.
