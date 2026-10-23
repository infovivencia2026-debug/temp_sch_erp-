import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSessionIfAny } from '@/lib/session'
import { aiApi, type AiState } from './aiApi'

/* Whether the AI features can answer right now (GET /api/v1/ai/status,
   worker/src/services/ai/key.ts). Read once and shared by every AI entry
   point; while AI is off it is read again every minute, so buttons come back
   on their own when the key is fixed. A screen that gets a refusal from a
   generation call calls markAiOff() so the others switch off at once. */

export const AI_STATUS_KEY = ['ai-status'] as const
/** Where an operator replaces the key: Controls, AI tab. */
export const AI_KEY_HREF = '/go/entitlements/module_entitlement_matrix?tab=ai'

export interface AiStatusView {
  /** Still loading: treat as on, so nothing flickers off and on. */
  loading: boolean
  ok: boolean
  state: AiState | null
  /** One line on why AI buttons are off, for the person reading it. */
  reason: string | null
  /** A platform (seller) account: they can fix it under Controls > AI. */
  operator: boolean
}

export function offReason(state: AiState | null, operator: boolean): string | null {
  if (state === null || state === 'ok') return null
  if (operator) {
    if (state === 'refused') return 'The AI key was refused by Google. Replace it under Controls, AI.'
    if (state === 'missing') return 'No AI key is set. Add one under Controls, AI.'
    if (state === 'quota') return 'The AI key has used its Google quota. Wait, or replace it under Controls, AI.'
    return 'Google could not be reached at the last check. Test the key under Controls, AI.'
  }
  if (state === 'quota') return 'AI is busy right now. Try again in a few minutes.'
  return 'AI is unavailable right now. You can still write it yourself.'
}

export function useAiStatus(): AiStatusView {
  const session = useSessionIfAny()
  const operator = session?.user?.platform_admin === true
  const q = useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: aiApi.status,
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (query) => (query.state.data && query.state.data.state !== 'ok' ? 60_000 : false),
  })
  const state: AiState | null = q.data ? (q.data.state ?? (q.data.configured ? 'ok' : 'missing')) : null
  // A failed status read is not a verdict: leave the buttons on and let the call say why.
  const ok = state === null || state === 'ok'
  return { loading: q.isPending, ok, state, reason: ok ? null : offReason(state, operator), operator }
}

/** After a generation call is refused (code assistant_not_configured or ai_not_configured). */
export function useMarkAiOff() {
  const qc = useQueryClient()
  return () => { void qc.invalidateQueries({ queryKey: AI_STATUS_KEY }) }
}

/** True for an error a refused or missing key causes. */
export function isAiKeyError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'assistant_not_configured' || code === 'ai_not_configured'
}

/** The one-line reason under a disabled AI button; give the button aria-describedby={id}. */
export function AiOffNote({ id, reason }: { id: string; reason: string | null }) {
  if (!reason) return null
  return <p id={id} className="text-[12px] text-muted-foreground">{reason}</p>
}
