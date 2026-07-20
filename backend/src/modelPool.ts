// Text model pool — the backend's multi-model manager for OpenRouter chat calls
// (meal drafting, auto-tagger, duplicate-finder).
//
// Unlike the worker's IMAGE pool (which runs many models in parallel across
// different scans for throughput — see worker/src/modelPool.ts), the text
// surfaces are single interactive requests, so this pool does sequential
// failover-with-retry: try each model in turn, and the first one that returns
// parseable JSON passing an optional validator wins. That gives the same "one
// flaky free model can't sink the request" resilience without racing.
//
// Config contract (root .env, comma-separated — the text half of the 4-list
// model-pool contract; the image half lives in worker/src/modelPool.ts):
//   FREE_TEXT_MODELS, PAID_TEXT_MODELS, USE_PAID_MODELS
// Back-compat: an empty FREE_TEXT_MODELS seeds from the old MEAL_MODEL env.

const DEFAULT_TEXT_MODEL = 'google/gemini-2.5-flash';

// Hard cap on a single OpenRouter call. Free models occasionally stall with no
// bytes ever returned; without this the fetch hangs forever. Overridable.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function parseList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function freeTextModels(): string[] {
  const list = parseList(process.env.FREE_TEXT_MODELS);
  if (list.length > 0) return list;
  return [process.env.MEAL_MODEL || DEFAULT_TEXT_MODEL];
}

export function paidTextModels(): string[] {
  return parseList(process.env.PAID_TEXT_MODELS);
}

export function usePaidDefault(): boolean {
  return /^(1|true|yes)$/i.test(process.env.USE_PAID_MODELS || '');
}

// The ordered model list a request may try: free first, then paid when opted in.
export function textModelsFor(usePaid: boolean): string[] {
  const models = usePaid ? [...freeTextModels(), ...paidTextModels()] : freeTextModels();
  return Array.from(new Set(models));
}

export interface ChatJsonOptions {
  // Force a single model (e.g. TAG_MODEL / MERGE_MODEL), bypassing the pool.
  modelOverride?: string;
  // Include paid models in the failover chain (defaults to USE_PAID_MODELS).
  usePaid?: boolean;
  // Optional shape check; a parsed-but-wrong response is treated as a failure so
  // the pool falls through to the next model.
  validate?: (parsed: any) => boolean;
  // Called with the model that actually produced the winning response. Routes
  // report this instead of the env var, which says nothing about which model in
  // the failover chain really answered.
  onModelUsed?: (model: string) => void;
}

// One OpenRouter chat call, expecting a single JSON object back.
async function chatJsonOnce(baseUrl: string, apiKey: string, model: string, system: string, user: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new LlmError(`OpenRouter timed out after ${LLM_TIMEOUT_MS}ms`);
    throw new LlmError(`OpenRouter request failed: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data: any = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError('OpenRouter returned no content');

  // Some models wrap JSON in code fences despite response_format.
  const cleaned = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new LlmError('Model response was not valid JSON');
  }
}

// Sequential failover across the text model pool. Tries each model once; the
// first that returns parseable JSON passing `validate` (if given) wins. Every
// model failing throws the last LlmError so the route can pass the status
// through. A `modelOverride` collapses the pool to that single model.
export async function chatJsonPool(system: string, user: string, opts: ChatJsonOptions = {}): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new LlmError('OPENROUTER_API_KEY is not configured', 503);
  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

  const models = opts.modelOverride
    ? [opts.modelOverride]
    : textModelsFor(opts.usePaid ?? usePaidDefault());

  let lastErr: LlmError = new LlmError('No text models configured');
  for (const model of models) {
    try {
      const parsed = await chatJsonOnce(baseUrl, apiKey, model, system, user);
      if (opts.validate && !opts.validate(parsed)) {
        lastErr = new LlmError(`Model "${model}" returned JSON failing validation`);
        continue;
      }
      opts.onModelUsed?.(model);
      return parsed;
    } catch (err: any) {
      // A bad key / no-credits (non-502) won't improve on another model — bail.
      if (err instanceof LlmError && err.status !== 502) throw err;
      lastErr = err instanceof LlmError ? err : new LlmError(String(err?.message ?? err));
    }
  }
  throw lastErr;
}
