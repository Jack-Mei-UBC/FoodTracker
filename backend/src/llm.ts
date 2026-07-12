// Minimal OpenRouter chat-completions client (native fetch, JSON responses).
// Used by POST /api/meals/generate to draft a meal from selected foods. The
// same OPENROUTER_API_KEY as ocr-service; the model is MEAL_MODEL (root .env).

const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// Sends system+user messages, expects a single JSON object back. Free models
// are flaky (empty content / malformed JSON), so one retry is built in — the
// same degrade-gracefully posture as ocr-service's reprompt-retry. Throws
// LlmError with an HTTP-ish status the route can pass through.
export async function chatJson(system: string, user: string): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new LlmError('OPENROUTER_API_KEY is not configured', 503);
  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.MEAL_MODEL || DEFAULT_MODEL;

  let lastErr: LlmError = new LlmError('OpenRouter returned no content');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await chatJsonOnce(baseUrl, apiKey, model, system, user);
    } catch (err: any) {
      // API-level failures (bad key, no credits) won't improve on retry.
      if (err instanceof LlmError && err.status !== 502) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

async function chatJsonOnce(baseUrl: string, apiKey: string, model: string, system: string, user: string): Promise<any> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
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
  });
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
