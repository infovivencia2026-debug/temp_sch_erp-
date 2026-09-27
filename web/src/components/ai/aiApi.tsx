import { api } from '@/lib/api'

/* The AI endpoints (worker/src/routes/ai/*). Not on the shared contract yet,
   so the shapes live here. Every text they return is a draft or summary for a
   person to read and edit; nothing is saved or sent by these calls. */

export type DraftKind = 'report_remark' | 'teacher_remark' | 'parent_message' | 'circular' | 'admission_decision' | 'fee_reminder' | 'leave_reply' | 'enquiry_follow_up'
export type Lang = 'en' | 'te' | 'hi'
export const LANG_LABEL: Record<Lang, string> = { en: 'English', te: 'Telugu', hi: 'Hindi' }

export interface DraftContext {
  student_id?: string
  application_id?: string
  enquiry_id?: string
  leave_request_id?: string
  decision?: string
  topic?: string
  audience?: string
  reply_to?: string
}
export interface DraftResult { drafts: string[]; label: string; configured: boolean; message?: string }
export interface TranslateResult {
  configured: boolean; message?: string; label?: string; language?: Lang
  original: { title: string; text: string }
  translated?: { title: string; text: string }
}
export interface Bullet { text: string; link?: string; topic: string }
export interface Brief {
  id: string; kind: string; subject_id: string; period_key: string; body: string
  facts: { bullets?: Bullet[]; [k: string]: unknown }
  model: string; ai: boolean; label: string; created_at: string; updated_at: string
}

export const aiApi = {
  status: () => api.get<{ configured: boolean }>('/api/v1/ai/status'),
  draft: (body: DraftContext & { kind: DraftKind; tone: string; length: string; language: Lang; notes?: string; current?: string; variants?: number }) =>
    api.post<DraftResult>('/api/v1/ai/draft', body),
  translate: (body: { title?: string; text: string; language: Lang }) => api.post<TranslateResult>('/api/v1/ai/translate', body),
  principalBrief: () => api.get<{ brief: Brief; configured: boolean; message?: string }>('/api/v1/ai/briefs/principal'),
  refreshPrincipalBrief: () => api.post<{ brief: Brief; configured: boolean; message?: string }>('/api/v1/ai/briefs/principal'),
  student360: (id: string) => api.get<{ brief: Brief | null; fresh: boolean; configured: boolean }>(`/api/v1/ai/briefs/student/${id}`),
  makeStudent360: (id: string) => api.post<{ brief: Brief | null; fresh: boolean; configured: boolean; message?: string }>(`/api/v1/ai/briefs/student/${id}`),
  weekly: (studentId?: string) => api.get<{ student_id: string; brief: Brief | null }>(
    '/api/v1/portal/ai/weekly' + (studentId ? `?student_id=${encodeURIComponent(studentId)}` : '')),
}

/** The small label every AI output carries. */
export function AiLabel({ text = 'AI draft' }: { text?: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-dashed px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      title="Written by AI from the school's records. Check it and edit before you use it.">
      {text}
    </span>
  )
}
