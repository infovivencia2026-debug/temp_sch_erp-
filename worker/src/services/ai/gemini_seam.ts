import type { Env } from '../../env'
import type { Ctx } from '../../router'
import { aiKeyPresent } from './key'
import { callGeminiParts, type GeminiPart } from '../../routes/teaching/gemini'

/* The Gemini seam for early warnings and smart import. Both take an `Llm`
   so tests pass a fake; production builds one from the Worker env with
   llmFromEnv(). No key configured -> null, and every caller has a non-AI
   fallback (template sentence, heuristic column mapping). Images go inline
   as GeminiPart inlineData, which ai/llm.ts (text prompts) does not carry. */

export type Llm = (system: string, parts: GeminiPart[], maxTokens: number) => Promise<string>

export function geminiKeySet(env: Env): Promise<boolean> {
  return aiKeyPresent(env)
}

/** A Gemini-backed Llm, or null when no key is set. */
export async function llmFromEnv(env: Env, timeoutMs = 15_000): Promise<Llm | null> {
  if (!(await geminiKeySet(env))) return null
  // callGeminiParts only reads c.env; a job has no request context.
  const c = { env } as unknown as Ctx
  return (system, parts, maxTokens) => callGeminiParts(c, system, parts, maxTokens, timeoutMs)
}

/** The first JSON value in a model reply (tolerates ```json fences and chatter). */
export function parseJsonReply<T>(text: string): T | null {
  const t = text.replace(/```(?:json)?/gi, '').trim()
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0)
  if (starts.length === 0) return null
  const s = Math.min(...starts)
  const close = t[s] === '{' ? '}' : ']'
  const e = t.lastIndexOf(close)
  if (e <= s) return null
  try { return JSON.parse(t.slice(s, e + 1)) as T } catch { return null }
}
