import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * What the two connector screens share.
 *
 * Both are platform scope, both sit behind platform.tenants.write, and both
 * describe an integration whose far end this deployment holds no credential
 * for. The types and query keys live here rather than being restated in each
 * screen, for the reason tally-lib.ts gives: two copies of a shape drift, and
 * the drift shows up as one screen believing a connector is ready while the
 * other disagrees.
 *
 * Every "is this live" flag below comes off the server. No screen decides
 * whether a sync or a meeting creation is possible — that is a fact about the
 * deployment, and a UI that hardcoded it would go on promising after somebody
 * changed the backend.
 */

export const crmBase = '/api/v1/admin/connectors/crm'
export const meetingsBase = '/api/v1/admin/connectors/meetings'

export const connectorQk = {
  all: ['connectors'] as const,
  crm: ['connectors', 'crm'] as const,
  crmQueue: ['connectors', 'crm', 'queue'] as const,
  crmRuns: ['connectors', 'crm', 'runs'] as const,
  crmConflicts: ['connectors', 'crm', 'conflicts'] as const,
  crmCredentials: ['connectors', 'crm', 'credentials'] as const,
  meetings: ['connectors', 'meetings'] as const,
  meetingRequests: ['connectors', 'meetings', 'requests'] as const,
}

export interface CrmSettings {
  provider: string
  direction: string
  conflict_policy: string
  transport: string
  is_enabled: boolean
  last_synced_at?: string
  updated_at?: string
}

export interface CrmField {
  local_field: string
  label: string
  crm_field: string
  direction: string
  is_required: boolean
  mapped: boolean
}

export interface CrmTransport {
  key: string
  label: string
  live_sync: boolean
}

export interface CrmConnector {
  settings: CrmSettings
  fields: CrmField[]
  systems: { key: string; name: string }[]
  transports: CrmTransport[]
  mapped_fields: number
  total_fields: number
  linked_leads: number
  conflicts: number
  enquiries: number
  live_sync_available: boolean
  live_sync_note: string
}

export interface CrmQueueRow {
  enquiry_id: string
  external_id?: string
  student_name: string
  phone: string
  status: string
  action: string
  why?: string
}

export interface CrmRun {
  id: string
  provider: string
  direction: string
  transport: string
  status: string
  considered: number
  created_count: number
  updated_count: number
  skipped_count: number
  conflict_count: number
  failed_count: number
  detail?: string
  started_at: string
}

export interface CrmConflict {
  id: string
  enquiry_id: string
  external_id: string
  student_name: string
  phone: string
  our_status: string
  their_status?: string
  conflict_at: string
  conflict_note?: string
  remote_updated_at?: string
  local_updated_at?: string
}

export interface CrmCredential {
  provider: string
  base_url: string
  notes: string
  has_credentials: boolean
  is_installation_default: boolean
  updated_at: string
}

export interface CrmCredentials {
  items: CrmCredential[]
  live_sync_available: boolean
  note: string
}

export interface CrmSyncResult {
  run_id: string
  considered: number
  counts: Record<string, number>
  download_url?: string
  note?: string
}

export interface MeetingAccount {
  id: string
  provider: string
  display_name: string
  account_ref?: string
  auth_style: string
  base_url?: string
  has_credentials: boolean
  is_enabled: boolean
  is_installation_default: boolean
  notes?: string
  updated_at: string
}

export interface MeetingRoute {
  key: string
  label: string
  live_create: boolean
}

export interface MeetingConnector {
  accounts: MeetingAccount[]
  routes: MeetingRoute[]
  systems: { key: string; name: string }[]
  auth_styles: { key: string; name: string }[]
  sessions_awaiting_url: number
  sessions_joinable: number
  schools_using: number
  live_create_available: boolean
  live_create_note: string
}

export interface MeetingRequestRow {
  id: string
  session_id: string
  topic: string
  scheduled_at: string
  provider: string
  status: string
  detail?: string
  join_url?: string
  requested_at: string
}

/**
 * Every connector mutation invalidates the whole domain.
 *
 * A saved mapping changes what an export may do, an import changes the queue
 * and the conflict list, and all of them are read on the same screen. Narrower
 * invalidation leaves one card claiming a lead is unlinked seconds after the
 * card beside it linked it.
 */
export function useConnectorMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  onDone?: (result: TResult, args: TArgs) => void,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, args) => {
      qc.invalidateQueries({ queryKey: connectorQk.all })
      onDone?.(result, args)
    },
  })
}

export const useCrmConnector = () =>
  useQuery({ queryKey: connectorQk.crm, queryFn: () => api.get<CrmConnector>(crmBase) })

export const useCrmQueue = () =>
  useQuery({
    queryKey: connectorQk.crmQueue,
    queryFn: () =>
      api.get<{ items: CrmQueueRow[]; counts: Record<string, number> }>(`${crmBase}/queue`),
  })

export const useCrmRuns = () =>
  useQuery({
    queryKey: connectorQk.crmRuns,
    queryFn: () => api.get<{ items: CrmRun[] }>(`${crmBase}/runs`),
  })

export const useCrmConflicts = () =>
  useQuery({
    queryKey: connectorQk.crmConflicts,
    queryFn: () => api.get<{ items: CrmConflict[] }>(`${crmBase}/conflicts`),
  })

export const useCrmCredentials = () =>
  useQuery({
    queryKey: connectorQk.crmCredentials,
    queryFn: () => api.get<CrmCredentials>(`${crmBase}/credentials`),
  })

export const useMeetingConnector = () =>
  useQuery({
    queryKey: connectorQk.meetings,
    queryFn: () => api.get<MeetingConnector>(meetingsBase),
  })

export const useMeetingRequests = () =>
  useQuery({
    queryKey: connectorQk.meetingRequests,
    queryFn: () => api.get<{ items: MeetingRequestRow[] }>(`${meetingsBase}/requests`),
  })

/** What each sync outcome means, in the words the run record uses. */
export const ACTION_LABELS: Record<string, string> = {
  created: 'New',
  updated: 'Changed',
  skipped: 'Already synced',
  conflict: 'Both sides changed',
  failed: 'Could not be matched',
}

export const actionLabel = (k: string) => ACTION_LABELS[k] ?? k

export function actionTone(k: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (k === 'created' || k === 'updated') return 'success'
  if (k === 'conflict') return 'warning'
  if (k === 'failed') return 'danger'
  return 'neutral'
}

/** A timestamp as a person reads it, or an em dash. */
export function whenRead(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
