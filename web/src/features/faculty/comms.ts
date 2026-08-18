import { useQuery } from '@tanstack/react-query'
import { api, type List, type Page, type Student } from '@/lib/api'

/* Shapes and lookups shared by the six faculty communication screens.

   Kept in one place because the five writing screens all need the same two
   pickers — a class the teacher teaches, and a child inside it — and five
   copies of that pair is five chances for one of them to forget the scope
   filter and offer the whole school. */

export interface Term {
  id: string
  name: string
  academic_year: string
  starts_on: string
  ends_on: string
  sequence: number
  is_current: boolean
}

export interface MyClass {
  section_id: string
  section_name: string
  class_name: string
  room?: string
  enrolled: number
  marked_today: boolean
}

export interface Remark {
  id: string
  student_id: string
  admission_no: string
  student_name: string
  class_name?: string
  section_name?: string
  subject?: string
  term?: string
  kind: string
  body: string
  private: boolean
  observed_on: string
  recorded_by?: string
  mine: boolean
}

export interface ReportRemark {
  student_id: string
  admission_no: string
  student_name: string
  roll_no?: number
  class_teacher_remark?: string
  class_teacher_remark_by?: string
  class_teacher_remark_at?: string
  principal_remark?: string
  principal_remark_by?: string
  principal_remark_at?: string
  card_exists: boolean
  is_published: boolean
  has_term_remarks: boolean
}

export interface PTMNote {
  id: string
  student_id: string
  admission_no: string
  student_name: string
  class_name?: string
  section_name?: string
  met_on: string
  attendance: string
  attended_by?: string
  mode: string
  concerns?: string
  agreed_actions?: string
  follow_up_on?: string
  follow_up_done: boolean
  overdue: boolean
  recorded_by?: string
  mine: boolean
}

export interface Broadcast {
  id: string
  title: string
  body: string
  kind: string
  requires_ack: boolean
  published_at: string
  sections: number
  students: number
  acknowledgements: number
  mine: boolean
}

export interface CommsSummary {
  sections: number
  students: number
  remarks: number
  anecdotal_records: number
  ptm_notes: number
  actions_overdue: number
  broadcasts: number
  awaiting_acknowledgement: number
  terms: number
}

/** The sections this teacher actually teaches — never the school's whole list. */
export function useMyClasses() {
  return useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () => api.get<List<MyClass>>('/api/v1/teaching/classes'),
  })
}

export function useTerms() {
  return useQuery({
    queryKey: ['teaching-terms'],
    queryFn: () => api.get<List<Term>>('/api/v1/teaching/terms'),
  })
}

/**
 * The children in one section.
 *
 * Left disabled until a section is chosen: an unfiltered roster is the whole
 * of the caller's scope, which for a head of department is several hundred
 * names in a dropdown nobody can use.
 */
export function useRoster(sectionID: string) {
  return useQuery({
    queryKey: ['roster', sectionID],
    enabled: !!sectionID,
    queryFn: () =>
      api.get<Page<Student>>(`/api/v1/students?section_id=${sectionID}&limit=200`),
  })
}

export const REMARK_KINDS = [
  { value: 'academic', label: 'Academic' },
  { value: 'behaviour', label: 'Behaviour' },
  { value: 'participation', label: 'Participation' },
  { value: 'achievement', label: 'Achievement' },
  { value: 'concern', label: 'Concern' },
] as const

export const ATTENDANCE_OPTIONS = [
  { value: 'both', label: 'Both parents' },
  { value: 'mother', label: 'Mother' },
  { value: 'father', label: 'Father' },
  { value: 'guardian', label: 'Guardian' },
  { value: 'none', label: 'Nobody came' },
] as const

export const MODE_OPTIONS = [
  { value: 'in_person', label: 'In person' },
  { value: 'phone', label: 'Telephone' },
  { value: 'video', label: 'Video call' },
] as const

/** Today, in the format every date input and every API date column wants. */
export function today() {
  return new Date().toISOString().slice(0, 10)
}
