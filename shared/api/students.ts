/* Students: the list, one child, the 360 view. internal/api/students.go,
   student_detail.go. */
import type { Page } from './contract'

export interface Student {
  id: string; admission_no: string; full_name: string
  first_name: string; middle_name?: string; last_name?: string
  gender?: string; date_of_birth?: string; status: string; admission_date: string
  class_name?: string; section_name?: string; roll_no?: number
  primary_phone?: string; person_code?: string
}

export interface StudentGuardianBrief {
  id: string; full_name: string; relation: string; is_primary: boolean; portal_blocked: boolean
  phone?: string; email?: string; access_until?: string; photo_file_id?: string
}

/** GET /students/{id}: the list row plus the editable names and address. */
export interface StudentRecord extends Student {
  blood_group?: string; religion?: string; nationality: string
  address_line1?: string; address_line2?: string
  city?: string; state?: string; pincode?: string
  category?: string; aadhaar_last4?: string
  custom_fields?: Record<string, string>
  guardians: StudentGuardianBrief[]
}

/** The 360 view (GET /students/{id}/profile). Optional fields are omitted when empty. */
export interface StudentProfile {
  id: string; admission_no: string; full_name: string; status: string
  class_name?: string; section_name?: string; roll_no?: number
  gender?: string; date_of_birth?: string; medium?: string; blood_group?: string
  mother_tongue?: string; apaar_id?: string; child_info_id?: string
  primary_phone?: string; city?: string; prior_school?: string
  is_rte: boolean; is_cwsn: boolean; admission_date: string
  photo_file_id?: string
  attendance: { present: number; total: number; percent: number; below_threshold: boolean }
  fees: { outstanding_paise: number; paid_paise: number }
  category?: string; nationality?: string; aadhaar_last4?: string
  address_line1?: string; address_line2?: string; state?: string; pincode?: string
  permanent_address?: string
  emergency_contact_name?: string; emergency_contact_phone?: string
  emergency_contact_relation?: string
  house_id?: string; house_name?: string; house_color?: string
  exit_date?: string; exit_reason?: string
  height_cm?: string; weight_kg?: string; bmi?: string; measured_on?: string
  allergies?: string
  custom_fields?: Record<string, string>
  guardians: {
    id: string; full_name: string; relation: string; phone: string
    email: string; is_primary: boolean; photo_file_id?: string
    portal_blocked?: boolean; access_until?: string
    occupation?: string
    annual_income?: number | null
    /** none | issued | active | invited | suspended … — the parent's own login. */
    login?: string
    last_login_at?: string | null
  }[]
  recent_attendance: { date: string; status: string }[]
  results: { exam: string; percentage: string; grade: string; rank: string }[]
  invoices: { date: string; invoice_no: string; net_paise: number; paid_paise: number; status: string }[]
  documents: { serial_no: string; type: string; issued_on: string }[]
  enrolments: {
    year: string; class: string; section: string
    roll_no: number | null; from: string; status: string
  }[]
  transport: {
    route: string; vehicle: string
    pickup_stop: string; pickup_time: string
    drop_stop: string; drop_time: string
    from: string; to: string
  }[]
}

/** Every tab of the student record in one round trip (GET /students/{id}/detail). */
export interface StudentFullDetail {
  subject_marks: { exam: string; subject: string; marks?: string; max?: string; grade?: string; absent: boolean; on?: string; approved?: boolean }[]
  fee_heads: { head: string; charged_paise?: string; paid_paise?: string }[]
  /* Charges this child carries that their class does not: the bus fare from
     the stop they board at. Per instalment, added to every demand raised
     while live. */
  fee_components?: { code: string; description: string; fee_head: string; amount_paise: string; valid_from: string; valid_to: string; live: boolean }[]
  payments: { receipt_no: string; paid_on: string; amount_paise: string; mode: string; reference: string; status: string }[]
  documents: { id: string; doc_type: string; file_id: string; uploaded_on: string; verified: boolean; verified_by: string; notes: string; filename: string; content_type: string }[]
  leave: { from: string; to: string; type: string; reason: string; status: string; applied_by: string; decision_note: string; days: string }[]
  enrolment_history: { year: string; class: string; section: string; roll_no?: string; status: string; from: string; to?: string; remarks: string; promoted: boolean }[]
  /* The years before this school used this system, imported from whatever it
     kept. Deliberately not folded into enrolment_history: those are live rows
     in the live tables, these are a summary of a closed year. */
  prior_years?: {
    year: string; class: string
    days_present?: number | null; days_total?: number | null
    fee_billed_paise?: number | null; fee_paid_paise?: number | null
    fee_waived_paise?: number | null; notes: string
  }[]
  transport_crew: { route: string; vehicle: string; driver: string; driver_phone: string; attendant: string; attendant_phone: string }[]
  activities: { id: string; name: string; category: string; schedule: string; fee_paise: string; status: string; enrolled_on: string; invoice_status: string; invoice_no: string; due_paise: string }[]
  class_id: string | null
  concessions: {
    id: string; kind: string; status: string; percent: string; amount_paise: string; reason: string
    decision_note: string; decided_by: string; asked_by: string; raised_on: string; decided_on: string; fee_head: string
  }[]
  invoices: { invoice_no: string; net_paise: string; paid_paise: string; status: string; issued_on: string }[]
  co_scholastic: { area_id: string; area: string; grade: string; remark: string; term: string; graded_by: string; graded_on: string }[]
}

export interface StudentCounts { active: number; left: number; suspended: number; new_this_year: number }

export interface StudentListQuery {
  q?: string
  /** '' means active; 'all' means every status. */
  status?: string
  section_id?: string
  class_id?: string
  academic_year_id?: string
  new_this_year?: '1'
  limit?: number
  offset?: number
  cursor?: string
  with_total?: '0' | '1'
}

export interface StudentsApi {
  'GET /students': { query: StudentListQuery; res: Page<Student> }
  'POST /students': { body: Record<string, unknown>; res: { id: string; admission_no: string } }
  'GET /students/counts': { res: StudentCounts }
  'GET /students/{id}': { res: StudentRecord }
  'GET /students/{id}/profile': { res: StudentProfile }
  'GET /students/{id}/detail': { res: StudentFullDetail }
}
