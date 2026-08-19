import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * The integrations index: types and the one query behind the screen.
 *
 * Everything here is read-only and every judgement in it was made on the
 * server. There is no `deriveHealth` in this file and there must never be one:
 * `internal/api/integrations_index.go` asks each connector what it thinks of
 * itself, and a second opinion computed in the browser would drift from the
 * first the moment somebody changed a backend — which is exactly the failure
 * mode the connectors' own `live_*_available` flags were introduced to stop.
 *
 * The screen's job is to render what arrives, loudly.
 */

export const integrationsBase = '/api/v1/admin/integrations'

export const integrationsQk = {
  all: ['integrations-index'] as const,
  index: ['integrations-index', 'list'] as const,
}

/** The health vocabulary, mirroring the constants in integrations_index.go. */
export type IntegrationHealth =
  | 'ok'
  | 'failing'
  | 'stale'
  | 'idle'
  | 'not_configured'
  | 'unknown'

export interface IntegrationEntry {
  key: string
  label: string
  group: string
  /** 'institution' | 'platform'. A platform row only ever arrives for platform staff. */
  scope: string
  provider?: string

  enabled: boolean
  configured: boolean
  /** The connector's own sentence naming what is missing. Rendered verbatim. */
  reason?: string

  health: IntegrationHealth
  health_note?: string

  last_ok_at?: string
  /** What `last_ok_at` is the time OF. Never assume it means "delivered". */
  last_ok_label?: string
  last_error?: string
  last_error_at?: string

  silent_days?: number
  stale_after_days?: number
  failed_recently?: number

  live_available?: boolean
  live_note?: string

  /** Catalogue key of the screen that configures this connector. */
  fix_key: string
  fix_label: string
}

export interface IntegrationsIndex {
  items: IntegrationEntry[]
  institution_selected: boolean
  platform_view: boolean
  counts: { working: number; attention: number; not_configured: number; total: number }
  note: string
}

export function useIntegrationsIndex() {
  return useQuery({
    queryKey: integrationsQk.index,
    queryFn: () => api.get<IntegrationsIndex>(`${integrationsBase}/index`),
  })
}

/**
 * How each health value is drawn.
 *
 * `stale` and `failing` are both destructive on purpose. A school believing
 * Tally exports are going across when they stopped a fortnight ago is the
 * failure this screen exists to prevent, and a stale connector rendered as a
 * subtle grey dot is that failure with a screen in front of it.
 */
export const HEALTH_TONE: Record<IntegrationHealth, 'success' | 'danger' | 'warning' | 'neutral'> =
  {
    ok: 'success',
    failing: 'danger',
    stale: 'danger',
    idle: 'warning',
    not_configured: 'neutral',
    unknown: 'warning',
  }

export const HEALTH_LABEL: Record<IntegrationHealth, string> = {
  ok: 'Working',
  failing: 'Failing',
  stale: 'Silent — check it',
  idle: 'Never run',
  not_configured: 'Not set up',
  unknown: 'Cannot tell',
}

/** The two health values a person has to do something about today. */
export function needsAttention(e: IntegrationEntry) {
  return e.health === 'failing' || e.health === 'stale'
}

/**
 * A catalogue key is `role.section.feature`, and `featurePath` takes exactly
 * those three parts — so the link to the screen that fixes a connector is a
 * split, not a lookup table that would go stale beside the catalogue.
 */
export function fixPath(fixKey: string): string | undefined {
  const parts = fixKey.split('.')
  if (parts.length !== 3) return undefined
  return `/${parts[0]}/${parts[1]}/${parts[2]}`
}

/** Dates are shown in full. "2 days ago" hides the thing being looked for. */
export function whenLabel(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
