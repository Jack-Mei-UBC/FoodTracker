// Thin shim over the TEXT model pool (backend/src/modelPool.ts).
//
// Every backend LLM surface (meal drafting, /audit auto-tagger, duplicate
// finder) calls chatJson() here; the pool underneath does sequential failover
// across FREE_TEXT_MODELS (+ paid when opted in), so one stalled/flaky free
// model can't sink the request. Per-call timeout + JSON repair live in the pool.
//
// LlmError is re-exported from the pool ON PURPOSE: server.ts does
// `err instanceof LlmError` to pass the status through, and a second copy of the
// class here would make that check silently false (→ every LLM failure becoming
// a generic 500).

export { LlmError } from './modelPool';
import { chatJsonPool, ChatJsonOptions } from './modelPool';

// Sends system+user messages, expects a single JSON object back.
// `modelOverride` pins a single model (e.g. TAG_MODEL / MERGE_MODEL) and skips
// the pool; omit it to get failover across the configured text models.
// `onModelUsed` reports which model in the chain actually answered, so routes can
// surface the real model rather than whatever the env var happens to say.
export async function chatJson(
  system: string,
  user: string,
  modelOverride?: string,
  onModelUsed?: (model: string) => void,
): Promise<any> {
  const opts: ChatJsonOptions = modelOverride ? { modelOverride } : {};
  if (onModelUsed) opts.onModelUsed = onModelUsed;
  return chatJsonPool(system, user, opts);
}
