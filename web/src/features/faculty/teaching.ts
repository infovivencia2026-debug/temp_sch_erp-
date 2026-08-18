import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

/* Shapes and lookups shared by the eight teaching screens.

   The subject picker lives here rather than in each screen because every one
   of them needs it and every copy is a chance for one to call the setup
   endpoint instead, which lists the whole school rather than the classes the
   signed-in teacher actually takes. */

export interface TeachingSubject {
  class_subject_id: string
  class_id: string
  class_name: string
  subject: string
  subject_code: string
  is_scholastic: boolean
  max_marks: number
}

export interface Assignment {
  id: string
  section_id: string
  section: string
  class_name: string
  subject?: string
  kind: string
  title: string
  instructions?: string
  assigned_on: string
  due_on?: string
  max_marks?: number
  is_published: boolean
  allow_submission: boolean
  roll: number
  submitted: number
  graded: number
  awaiting_marking: number
  overdue: boolean
}

export interface Submission {
  student_id: string
  admission_no: string
  full_name: string
  roll_no?: number
  submission_id?: string
  status: string
  submitted_at?: string
  text_answer?: string
  file_id?: string
  marks?: number
  feedback?: string
  graded_by?: string
  graded_at?: string
  late: boolean
}

export interface Material {
  id: string
  class_subject_id?: string
  section_id?: string
  class_name?: string
  subject?: string
  section?: string
  title: string
  description?: string
  kind: string
  file_id?: string
  file_name?: string
  size_bytes?: number
  external_url?: string
  is_published: boolean
  uploaded_by?: string
  created_at: string
}

export interface VirtualClass {
  id: string
  section_id: string
  section: string
  class_name: string
  subject?: string
  provider?: string
  provider_name?: string
  topic: string
  agenda?: string
  scheduled_at: string
  duration_minutes: number
  join_url?: string
  status: string
  started_at?: string
  created_by?: string
  joinable: boolean
}

export interface MeetingProvider {
  id: string
  provider: string
  display_name: string
  account_ref?: string
  is_active: boolean
  integrated: boolean
}

export interface BankOption {
  sequence: number
  body: string
  is_correct: boolean
}

export interface BankQuestion {
  id: string
  class_subject_id: string
  class_name: string
  subject: string
  syllabus_unit_id?: string
  chapter?: string
  kind: string
  difficulty: string
  bloom_level: string
  stem: string
  default_marks: number
  explanation?: string
  is_active: boolean
  options: string[]
  objective: boolean
  used_on_tests: number
  created_by?: string
  answer_key?: BankOption[]
}

export interface BankSummary {
  class_subject_id: string
  class_name: string
  subject: string
  total: number
  objective: number
  easy: number
  medium: number
  hard: number
  higher_order: number
  chapters_covered: number
}

export interface OnlineTest {
  id: string
  section_id: string
  section: string
  class_name: string
  class_subject_id: string
  subject: string
  title: string
  instructions?: string
  opens_at?: string
  closes_at?: string
  duration_minutes?: number
  max_attempts: number
  shuffle_questions: boolean
  status: string
  questions: number
  total_marks?: number
  created_by?: string
}

export interface TestPaperQuestion {
  question_id: string
  sequence: number
  marks: number
  kind: string
  difficulty: string
  bloom_level: string
  stem: string
  chapter?: string
  answer_key: BankOption[]
}

export interface OnlineTestDetail extends OnlineTest {
  paper: TestPaperQuestion[]
}

export interface FormativeRow {
  student_id: string
  admission_no: string
  full_name: string
  roll_no?: number
  entry_id?: string
  written_work?: number
  project_work?: number
  slip_test?: number
  participation?: number
  component_max: number
  total?: number
  max_total: number
  observation?: string
  indicator?: string
  recorded_by?: string
  recorded_at?: string
}

export interface SummativePaper {
  exam_subject_id: string
  exam_id: string
  exam_name: string
  kind: string
  class_name: string
  subject: string
  exam_date?: string
  max_marks: number
  pass_marks: number
  entered: number
  roll: number
  is_published: boolean
  average?: number
}

/** The class-subjects this teacher takes — never the school's whole list. */
export function useTeachingSubjects() {
  return useQuery({
    queryKey: ['teaching-subjects'],
    queryFn: () => api.get<List<TeachingSubject>>('/api/v1/teaching/subjects'),
  })
}

export interface MyClassRow {
  section_id: string
  section_name: string
  class_name: string
  enrolled: number
}

export function useTeachingClasses() {
  return useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () => api.get<List<MyClassRow>>('/api/v1/teaching/classes'),
  })
}

export const MATERIAL_KINDS = [
  { value: 'note', label: 'Notes' },
  { value: 'worksheet', label: 'Worksheet' },
  { value: 'reference', label: 'Reference' },
  { value: 'video', label: 'Video' },
  { value: 'link', label: 'Link' },
  { value: 'syllabus', label: 'Syllabus' },
] as const

export const QUESTION_KINDS = [
  { value: 'mcq', label: 'Multiple choice' },
  { value: 'true_false', label: 'True / False' },
  { value: 'fill_blank', label: 'Fill in the blank' },
  { value: 'short', label: 'Short answer' },
  { value: 'long', label: 'Long answer' },
] as const

/** Only these can be auto-marked, so only these may go on an objective test. */
export const OBJECTIVE_KINDS = ['mcq', 'true_false', 'fill_blank']

export const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
] as const

export const BLOOM_LEVELS = [
  { value: 'remember', label: 'Remember' },
  { value: 'understand', label: 'Understand' },
  { value: 'apply', label: 'Apply' },
  { value: 'analyse', label: 'Analyse' },
  { value: 'evaluate', label: 'Evaluate' },
  { value: 'create', label: 'Create' },
] as const

export const FA_CYCLES = [
  { value: 'FA1', label: 'FA1' },
  { value: 'FA2', label: 'FA2' },
  { value: 'FA3', label: 'FA3' },
  { value: 'FA4', label: 'FA4' },
] as const

/* The descriptive band a teacher picks alongside the marks.

   Deliberately not derived from the total: a child scoring well who has
   stopped participating is exactly what continuous assessment is for, and a
   computed band would hide it. */
export const FA_INDICATORS = [
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'satisfactory', label: 'Satisfactory' },
  { value: 'needs_support', label: 'Needs support' },
] as const

export const MEETING_PROVIDERS = [
  { value: 'zoom', label: 'Zoom' },
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'ms_teams', label: 'Microsoft Teams' },
] as const

/** Today, in the format every date input and every API date column wants. */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/** A number typed into a grid cell: blank stays blank rather than becoming 0. */
export function numOrNull(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function label(list: readonly { value: string; label: string }[], v?: string) {
  return list.find((o) => o.value === v)?.label ?? v ?? '—'
}
