import { useNavigate, useLocation } from 'react-router-dom'
import { useCallback } from 'react'
import type { MessageKey } from '@/lib/i18n'

/* Shared by the Help Centre, the Helpdesk and the entry points. */

/** The address of the Help Centre, remembering the screen it was opened from. */
export function helpHref(from?: string, extra = ''): string {
  const f = from && !from.startsWith('/help') ? `from=${encodeURIComponent(from)}` : ''
  const q = [f, extra].filter(Boolean).join('&')
  return '/help' + (q ? `?${q}` : '')
}

/** Opens Help from wherever the person is, so a report knows the screen. */
export function useOpenHelp(): (extra?: string) => void {
  const navigate = useNavigate()
  const loc = useLocation()
  return useCallback((extra?: string) => navigate(helpHref(loc.pathname + loc.search, extra)), [navigate, loc.pathname, loc.search])
}

export const STAGE_KEY: Record<string, MessageKey> = {
  new: 'help.stage.new', acknowledged: 'help.stage.acknowledged', in_progress: 'help.stage.in_progress',
  waiting: 'help.stage.waiting', resolved: 'help.stage.resolved', closed: 'help.stage.closed',
}

/** The stage a person reads: "waiting" is its own word, though the stored stage folds it into in progress. */
export const shownStage = (t: { stage: string; status: string }) => (t.status === 'waiting' ? 'waiting' : t.stage)

export const STAGE_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'primary'> = {
  new: 'info', acknowledged: 'info', in_progress: 'primary', waiting: 'warning', resolved: 'success', closed: 'neutral',
}

/* Articles: a line that starts "1." is a step, every other line a paragraph. */
export function articleBlocks(body: string): { kind: 'p' | 'step'; text: string }[] {
  return body.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^\d+\.\s+(.*)$/.exec(l)
    return m ? { kind: 'step' as const, text: m[1] } : { kind: 'p' as const, text: l }
  })
}
