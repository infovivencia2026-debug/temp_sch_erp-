import type { Env } from '../../env'
import type { Ctx } from '../../router'
import { HttpError } from '../../http'
import { ASSISTANT_MODEL, assistantFailure, callGeminiParts } from '../../routes/teaching/gemini'

/* The one door every "AI native" feature (drafting, translation, briefs) goes
   through to the model. It adds three things to routes/teaching/gemini.ts:

   - a clear refusal when the server has no Google key, so a screen can say
     "write it yourself" instead of a vague 502 (code ai_not_configured);
   - the school's daily cost cap: every call counts one row in ai_usage for
     the school's day, and the cap comes from module_settings (module 'ai',
     config.daily_cap, default DEFAULT_DAILY_CAP); code ai_cap_reached;
   - a transport seam, setAiTransport(), so tests run on a fake Gemini.

   Nothing here saves or sends what the model writes: callers return it as a
   labelled draft and the person edits and saves it as usual. */

export const AI_MODEL = ASSISTANT_MODEL
export const DEFAULT_DAILY_CAP = 300

export type AiTransport = (system: string, prompt: string, maxTokens: number) => Promise<string>
let transport: AiTransport | null = null
/** Tests only: route every model call to `t` (null restores Gemini). */
export function setAiTransport(t: AiTransport | null): void { transport = t }

export function aiConfigured(env: Env): boolean {
  if (transport) return true
  const e = env as unknown as Record<string, unknown>
  // Integration tests: gemini.ts answers from globalThis.__FAKE_GEMINI__ under APP_ENV=test.
  if (e.APP_ENV === 'test' && typeof (globalThis as { __FAKE_GEMINI__?: unknown }).__FAKE_GEMINI__ === 'function') return true
  const has = (k: string) => typeof e[k] === 'string' && (e[k] as string).trim() !== ''
  return has('GOOGLE_API_KEY') || has('GOOGLE_SERVICE_ACCOUNT_JSON')
}

export const NOT_CONFIGURED_MSG = 'AI writing is not switched on for this server yet (no Google key is set). You can still write it yourself.'
export const notConfigured = () => new HttpError(503, NOT_CONFIGURED_MSG, { code: 'ai_not_configured' })
export const capReached = (cap: number) => new HttpError(429,
  `This school has used today's AI allowance (${cap} requests). It resets tomorrow; a school admin can raise it under the AI settings.`,
  { code: 'ai_cap_reached' })

export interface AiSettings {
  /** Master switch for the school (default on). */
  enabled: boolean
  daily_cap: number
  /** Email the principal morning brief (queued through messaging, default off). */
  email_principal_brief: boolean
  /** Weekly parent note: also by SMS / email when the school enables it (in-app always). */
  parent_weekly_sms: boolean
  parent_weekly_email: boolean
}

export async function aiSettings(db: D1Database): Promise<AiSettings> {
  let enabled = true, cfg: Record<string, unknown> = {}
  try {
    const r = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = 'ai' LIMIT 1`).first<{ enabled: number; config: string }>()
    if (r) { enabled = Number(r.enabled) === 1; cfg = JSON.parse(r.config || '{}') as Record<string, unknown> }
  } catch (e) { console.error('ai settings', e) }
  const cap = Number(cfg.daily_cap)
  return {
    enabled,
    daily_cap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP,
    email_principal_brief: cfg.email_principal_brief === true,
    parent_weekly_sms: cfg.parent_weekly_sms === true,
    parent_weekly_email: cfg.parent_weekly_email === true,
  }
}

const IST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
export function schoolToday(tz = 'Asia/Kolkata', at: Date = new Date()): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at) } catch { return IST.format(at) }
}

/** Count one call against today's cap; throws ai_cap_reached when over. */
export async function spend(db: D1Database, today: string): Promise<void> {
  const s = await aiSettings(db)
  if (!s.enabled) throw new HttpError(403, 'AI features are switched off for this school.', { code: 'ai_disabled' })
  const row = await db.prepare(`INSERT INTO ai_usage (on_date, calls, updated_at) VALUES (?, 1, ?)
      ON CONFLICT (on_date) DO UPDATE SET calls = calls + 1, updated_at = excluded.updated_at RETURNING calls`)
    .bind(today, new Date().toISOString()).first<{ calls: number }>()
  if (row && Number(row.calls) > s.daily_cap) throw capReached(s.daily_cap)
}

export async function usageToday(db: D1Database, today: string): Promise<number> {
  const r = await db.prepare(`SELECT calls FROM ai_usage WHERE on_date = ?`).bind(today).first<{ calls: number }>()
  return Number(r?.calls ?? 0)
}

export interface GenOpts { maxTokens?: number; timeoutMs?: number; today?: string }

/** One model call under the cap. Errors are HttpErrors a route can throw as they are. */
export async function aiGenerate(env: Env, db: D1Database, system: string, prompt: string, o: GenOpts = {}): Promise<string> {
  if (!aiConfigured(env)) throw notConfigured()
  await spend(db, o.today ?? schoolToday())
  const max = o.maxTokens ?? 1024
  try {
    const out = transport
      ? await transport(system, prompt, max)
      : await callGeminiParts({ env } as unknown as Ctx, system, [{ text: prompt }], max, o.timeoutMs ?? 30_000)
    return out.trim()
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw assistantFailure(e)
  }
}

/** The first JSON object in a model answer (it sometimes wraps it in ```json fences). */
export function parseJsonObject<T = Record<string, unknown>>(raw: string): T | null {
  const s = raw.replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) as T } catch { return null }
}

/** Stable SHA-256 hex of any JSON-able value (object keys sorted). */
export async function inputsHash(v: unknown): Promise<string> {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(norm(v))))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
