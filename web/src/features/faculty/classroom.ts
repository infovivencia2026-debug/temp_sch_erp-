import { api, type List } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

/* Shapes and helpers shared by the five classroom screens.

   Everything here mirrors internal/api/classroom.go. Nothing computes an
   authorisation decision: the screens hide what the caller cannot use, and the
   server refuses it regardless, because a hidden button is not access control. */

export interface LanguageOption {
  id: string
  class_id: string
  class_name: string
  class_subject_id: string
  subject_name: string
  subject_code: string
  slot: string
  display_name?: string
  capacity?: number
  is_active: boolean
  elected_count: number
}

export interface LanguageElection {
  id: string
  student_id: string
  admission_no: string
  student_name: string
  section: string
  slot: string
  option_id: string
  subject_name: string
  status: string
  note?: string
  decided_on: string
}

export interface LanguageAllocation {
  class_id: string
  groups: {
    option_id: string
    slot: string
    subject_name: string
    capacity?: number
    elected: number
    proposed: number
    over_capacity_by: number
    sections: string[]
  }[]
  unchosen: {
    student_id: string
    admission_no: string
    student_name: string
    section: string
    missing_slots: string[]
  }[]
  clashes: {
    student_id: string
    student_name: string
    weekday: number
    period_name: string
    subject_a: string
    subject_b: string
  }[]
}

export interface PortfolioPiece {
  source: 'award' | 'claim'
  item_id: string
  title: string
  kind: string
  description?: string
  happened_on?: string
  evidence_url?: string
  shared_by_child: boolean
  curation_id?: string
  status: string
  comment?: string
  include_in_report: boolean
  is_featured: boolean
  curated_by?: string
  curated_at?: string
}

export interface MontessoriMaterial {
  id: string
  area: string
  name: string
  description?: string
  sequence: number
  min_age_months?: number
  max_age_months?: number
  is_active: boolean
}

export interface MontessoriPosition {
  material_id: string
  area: string
  name: string
  sequence: number
  current_stage: string
  last_seen_on?: string
  history: {
    id: string
    stage: string
    observed_on: string
    note?: string
    observed_by?: string
  }[]
}

export interface MontessoriChild {
  student_id: string
  admission_no: string
  student_name: string
  last_observed_on?: string
  areas: {
    area: string
    materials: number
    presented: number
    practising: number
    mastered: number
  }[]
}

export interface CaptureConflict {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  on_date: string
  offline_status: string
  server_status: string
  server_marked_by?: string
  server_marked_at?: string
  resolution: string
}

export interface CaptureBatch {
  id: string
  section_id: string
  section_name: string
  on_date: string
  captured_at: string
  synced_at: string
  device_note?: string
  rows_accepted: number
  rows_conflicted: number
}

export interface DiaryEntry {
  id: string
  section_id: string
  section_name: string
  subject_name?: string
  on_date: string
  kind: string
  body: string
  captured_offline: boolean
  is_visible_to_family: boolean
  written_by?: string
}

export interface GradableTest {
  id: string
  title: string
  section_id: string
  section_name: string
  subject_name: string
  status: string
  question_count: number
  max_score: number
  roll_strength: number
  graded_attempts: number
  allow_partial_credit: boolean
}

export interface GradingKey {
  test_id: string
  title: string
  max_score: number
  allow_partial_credit: boolean
  questions: {
    test_question_id: string
    sequence: number
    kind: string
    stem: string
    marks: number
    negative_marks: number
    multi_answer: boolean
    options: { id: string; sequence: number; body: string; is_correct: boolean }[]
  }[]
  roster: {
    student_id: string
    admission_no: string
    student_name: string
    attempt_id?: string
    attempt_status?: string
    score?: number
  }[]
}

export interface ItemAnalysisRow {
  test_question_id: string
  sequence: number
  stem: string
  marks: number
  sat: number
  attempted: number
  correct: number
  facility?: number
  discrimination?: number
  top_distractor?: string
  top_distractor_count: number
  flag: string
}

export const LANGUAGE_SLOTS = [
  { value: 'first', label: 'First language' },
  { value: 'second', label: 'Second language' },
  { value: 'third', label: 'Third language' },
] as const

export const MONTESSORI_AREAS = [
  { value: 'practical_life', label: 'Practical life' },
  { value: 'sensorial', label: 'Sensorial' },
  { value: 'language', label: 'Language' },
  { value: 'mathematics', label: 'Mathematics' },
  { value: 'culture', label: 'Culture' },
] as const

export const MONTESSORI_STAGES = [
  { value: 'presented', label: 'Presented' },
  { value: 'practising', label: 'Practising' },
  { value: 'mastered', label: 'Mastered' },
  { value: 'revisit', label: 'Revisited' },
] as const

export const ATTENDANCE_STATUSES = [
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
  { value: 'late', label: 'Late' },
  { value: 'half_day', label: 'Half day' },
  { value: 'leave', label: 'Leave' },
] as const

export const DIARY_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'classwork', label: 'Classwork' },
  { value: 'homework', label: 'Homework' },
  { value: 'reminder', label: 'Reminder' },
] as const

export function labelOf(
  list: readonly { value: string; label: string }[],
  v?: string,
): string {
  return list.find((o) => o.value === v)?.label ?? v ?? '—'
}

export function useClassroomSections() {
  return useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () =>
      api.get<List<{ section_id: string; section_name: string; class_name: string }>>(
        '/api/v1/teaching/classes',
      ),
  })
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
