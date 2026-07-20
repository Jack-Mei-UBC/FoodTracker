// Image model pool — the worker's multi-model manager for OCR.
//
// Design (see CLAUDE.md "Model pool"): the free vision models are individually
// slow/flaky, so instead of picking one, we keep ALL of them busy at once —
// each processing a DIFFERENT scan (throughput parallelism, not redundancy on
// one image). The worker sizes its ocr-queue concurrency to the pool so up to
// `poolSize` scans run simultaneously, each round-robin-assigned a distinct
// model. Per scan, if the assigned model fails or returns garbage, the worker
// retries on the NEXT model in the list, so one bad model can't sink a scan.
//
// Config contract (root .env, comma-separated — the image half of the 4-list
// model-pool contract; the text half lives in backend/src/modelPool.ts):
//   FREE_IMAGE_MODELS, PAID_IMAGE_MODELS, USE_PAID_MODELS, OCR_MAX_ATTEMPTS
// Back-compat: an empty FREE_IMAGE_MODELS seeds from the old OCR_MODEL env.

const DEFAULT_OCR_MODEL = 'nvidia/nemotron-nano-12b-v2-vl:free';

// Hard ceiling on worker concurrency regardless of how many models are listed —
// each in-flight job holds an image file + an OpenRouter request in memory.
const MAX_POOL_SIZE = 8;

function parseList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Free image models, seeded from the legacy OCR_MODEL when the list is unset so
// existing single-model .env files keep working.
export function freeImageModels(): string[] {
  const list = parseList(process.env.FREE_IMAGE_MODELS);
  if (list.length > 0) return list;
  return [process.env.OCR_MODEL || DEFAULT_OCR_MODEL];
}

export function paidImageModels(): string[] {
  return parseList(process.env.PAID_IMAGE_MODELS);
}

export function usePaidDefault(): boolean {
  return /^(1|true|yes)$/i.test(process.env.USE_PAID_MODELS || '');
}

// The ordered model list a single scan may use: free first, then paid when this
// job (or the global default) opts into paid. De-duped, order preserved.
export function imageModelsFor(usePaid: boolean): string[] {
  const models = usePaid ? [...freeImageModels(), ...paidImageModels()] : freeImageModels();
  return Array.from(new Set(models));
}

// Worker ocr-queue concurrency: enough lanes to keep every model (free + paid,
// the superset, since paid is a per-job toggle) busy at once, capped so a long
// list can't exhaust memory. At least 1.
export function poolSize(): number {
  const total = new Set([...freeImageModels(), ...paidImageModels()]).size;
  return Math.max(1, Math.min(MAX_POOL_SIZE, total));
}

// Per-scan retry cap — how many models a single scan will cycle through before
// giving up. Defaults to 3, clamped to at least 1.
export function maxAttempts(): number {
  const n = Number(process.env.OCR_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

// Round-robin cursor so concurrent jobs start on DIFFERENT models. Module-level
// state is fine: the worker is a single process and BullMQ hands jobs to this
// one module. Each job takes the next start offset and then walks its own list.
let rrCursor = 0;
export function nextStartIndex(): number {
  const i = rrCursor;
  rrCursor = (rrCursor + 1) % Math.max(1, poolSize());
  return i;
}

// Order a job's model list starting at `startIndex` (round-robin), so two jobs
// picked up at the same time try different models first, then fall through the
// rest on retry.
export function orderedModels(models: string[], startIndex: number): string[] {
  if (models.length <= 1) return models;
  const offset = ((startIndex % models.length) + models.length) % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}
