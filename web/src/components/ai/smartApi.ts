import { api, actingInstitution, ApiError } from '@/lib/api'

/* Early warnings and "Import with AI" (worker/src/routes/ai/warnings.ts and
   ai/import.ts). Not on the shared contract yet, so the shapes live here. */

// ---- early warnings ------------------------------------------------------------

export type WarningStatus = 'open' | 'acknowledged' | 'resolved'
export interface Warning {
  id: string
  rule: string
  label: string
  subject_kind: 'student' | 'employee' | 'section'
  subject_id: string
  subject_name: string
  student_id: string | null
  section_id: string | null
  section_name: string | null
  severity: 'low' | 'medium' | 'high'
  owner_role: 'class_teacher' | 'accounts' | 'principal'
  evidence: Record<string, string | number | string[]>
  reason: string
  explanation: string | null
  explained_by: string | null
  summary: string
  next_step: string
  status: WarningStatus
  status_note: string | null
  status_at: string | null
  status_by_name: string | null
  first_seen_at: string
}
export interface WarningList { items: Warning[]; computed_at: string | null; ai: boolean }

export const warningsApi = {
  list: (q: { status?: string; section_id?: string; rule?: string } = {}) => {
    const sp = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])
    return api.get<WarningList>('/api/v1/ai/warnings' + (sp.toString() ? '?' + sp : ''))
  },
  student: (id: string) => api.get<{ items: Warning[] }>(`/api/v1/ai/warnings/student/${id}`),
  digest: () => api.get<{ open: number; high: number; new_this_week: number; resolved_this_week: number; text: string }>('/api/v1/ai/warnings/digest'),
  setStatus: (id: string, status: WarningStatus, note: string) => api.post<Warning>(`/api/v1/ai/warnings/${id}/status`, { status, note }),
  run: () => api.post<{ raised: number; cleared: number; explained: number; ai: boolean }>('/api/v1/ai/warnings/run'),
  dismiss: (id: string) => api.post<{ id: string }>(`/api/v1/ai/warnings/${id}/dismiss`),
  dismissAll: () => api.post<{ ids: string[]; count: number }>('/api/v1/ai/warnings/dismiss-all'),
  undismiss: (ids: string[]) => api.post<{ count: number }>('/api/v1/ai/warnings/undismiss', { ids }),
}

// ---- smart import --------------------------------------------------------------

export interface ImportKind { key: string; label: string; columns: string[]; required: string[] }
export interface Table { headers: string[]; rows: string[][] }
export interface ColumnMap { header: string; index: number; field: string | null; confidence: number; source: 'ai' | 'rule' | 'user' }
export interface Proposal { kind: string; kind_confidence: number; alternatives: { kind: string; score: number }[]; mapping: ColumnMap[]; notes: string[]; by: 'ai' | 'rule' }
export interface Analysis {
  source: 'sheet' | 'photo'
  filename: string
  table: Table
  proposal?: Proposal
  uncertain?: [number, number][]
  notes?: string
  needs_review?: boolean
  kinds: ImportKind[]
  ai: boolean
}
export interface RunResult {
  kind: string; label: string; dry_run: boolean
  total: number; valid: number; rejected: number; imported: number; run_id: string | null
  problems: { row: number; source_row: number | null; problem?: string }[]
  rows?: Record<string, string>[]
  /** The table row each preview row came from. */
  source_rows?: number[]
  fields: string[]
  changes?: { row: number; field: string; from: string; to: string }[]
}
export interface RunBody {
  kind: string; table: Table; mapping: { index: number; field: string | null }[]
  source: 'sheet' | 'photo'; reviewed: boolean; confirmed?: boolean; filename?: string
}

export const smartImportApi = {
  async analyze(file: File, kind?: string): Promise<Analysis> {
    const fd = new FormData()
    fd.set('file', file)
    if (kind) fd.set('kind', kind)
    const acting = actingInstitution()
    const res = await fetch('/api/v1/ai/import/analyze', {
      method: 'POST', body: fd, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const e = body?.error
      throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? (typeof e === 'string' ? e : 'That file could not be read.'))
    }
    return body as Analysis
  },
  propose: (table: Table, kind?: string) => api.post<{ proposal: Proposal; kinds: ImportKind[]; ai: boolean }>('/api/v1/ai/import/propose', { table, kind }),
  preview: (b: RunBody) => api.post<RunResult>('/api/v1/ai/import/preview', b),
  commit: (b: RunBody) => api.post<RunResult>('/api/v1/ai/import/commit', { ...b, confirmed: true }),
}
