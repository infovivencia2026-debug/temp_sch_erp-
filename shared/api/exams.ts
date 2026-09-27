/* Exams: the list, one paper's gradebook, entering marks, report cards and
   their approval. internal/api/mod_academics.go, report_card_approval.go. */
import type { List } from './contract'

export interface ExamSummary {
  id: string; name: string; kind: string; starts_on?: string
  is_published: boolean
  /** How many papers (exam_subjects) it has. */
  papers: number
}

/** One child's line in a paper's gradebook. */
export interface GradebookRow {
  student_id: string; admission_no: string; full_name: string
  marks_obtained?: number; max_marks: number; grade?: string; is_absent: boolean
  section: string
}

export interface MarksEntry { student_id: string; marks_obtained?: number | null; is_absent?: boolean; remarks?: string }

export interface ReportCardSubject {
  subject: string
  marks_obtained?: number
  grace_marks: number
  max_marks: number
  percent?: number
  grade?: string
  is_absent: boolean
}

export type ReportCardStatus = 'draft' | 'submitted' | 'returned' | 'published'

export interface ReportCard {
  id: string; student_id: string; admission_no: string; roll_no?: number; full_name: string
  photo_file_id?: string
  class_name?: string; section_name?: string
  total_marks?: number; max_marks?: number; percentage?: number
  grade?: string; rank_in_section?: number; attendance_percent?: number
  /** Whether a family can read it; `status` says whose desk it is on. */
  is_published: boolean
  status: ReportCardStatus
  return_note?: string
  subjects: ReportCardSubject[]
}

/** A section's cards waiting on the head, as one line. */
export interface PendingReportCards {
  status: 'submitted' | 'published'
  section_id: string; section_name: string; class_name: string
  cards: number; submitted_by?: string; submitted_at?: string
}

export interface ReportCardReadiness {
  subject: string
  teacher?: string
  marks_entered: number
  students: number
}

export interface ExamsApi {
  'GET /exams/list': { res: List<ExamSummary> }
  'GET /exams/gradebook': { query: { exam_subject_id: string; section_id?: string }; res: List<GradebookRow> }
  'POST /exams/marks': { body: { exam_subject_id: string; entries: MarksEntry[] }; res: { written: number } }
  'GET /exams/report-cards': { query: { section_id?: string; exam_id?: string }; res: List<ReportCard> }
  'GET /exams/report-cards/readiness': { query: { section_id?: string; exam_id?: string }; res: List<ReportCardReadiness> }
  'GET /exams/report-cards/pending': { res: List<PendingReportCards> }
}
