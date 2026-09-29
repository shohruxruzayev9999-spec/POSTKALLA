/**
 * Optional language model for summaries and the daily digest. Enabled when ANTHROPIC_API_KEY is
 * set; everything that uses it has a rule-based fallback, so the product works without it.
 * The model only recommends — it never writes to the database.
 */
export interface AiClient {
  complete(opts: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
}

export function anthropicClient(apiKey: string, model = 'claude-sonnet-5'): AiClient {
  return {
    async complete({ system, prompt, maxTokens = 900 }) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = (await r.json()) as { content: Array<{ type: string; text?: string }> };
      return j.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
        .trim();
    },
  };
}

/** Bullet lines out of a model answer ("- a\n• b\n1. c" → ["a", "b", "c"]). */
export function bullets(text: string, max = 8): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 3)
    .slice(0, max);
}

/** Small in-memory cache so a page refresh does not call the model again. */
export class TtlCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  constructor(private ttlMs: number) {}
  get(key: string, now = Date.now()): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T, now = Date.now()) {
    if (this.map.size > 500) this.map.clear();
    this.map.set(key, { at: now, value });
  }
}
