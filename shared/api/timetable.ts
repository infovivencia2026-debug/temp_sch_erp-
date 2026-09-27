/* The live timetable. internal/api/timetable.go. */
import type { List } from './contract'

export interface Period {
  id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean
  bell_schedule_id?: string | null
}

export interface TimetableEntry {
  id: string; section_id: string; section_name: string; class_name: string
  period_id: string; period_name: string; weekday: number
  subject_name: string; subject_code: string
  teacher_id?: string; teacher_name?: string; room?: string
}

export interface Teacher {
  /** Empty for an employee with no sign-in account. */
  user_id: string
  full_name: string
  employee_code: string
  employee_id: string
  /** Active, or the reason they are not (resigned, retired, on_leave). */
  status?: string
  /* Absent unless the caller plans the timetable. The whole staff's weekly
     load is a league table of colleagues; the server omits it rather than
     sending a zero that would say something false about everybody. */
  weekly_periods?: number
  /** What they type into the sign-in box, and whether that account has a password yet. */
  sign_in_as: string
  can_sign_in: boolean
  /** Comma-separated role keys and subject names. */
  roles: string
  subjects: string
  class_teacher_of?: string
}

export interface TimetableApi {
  'GET /timetable/entries': {
    query: { section_id?: string; academic_year_id?: string; teacher_id?: string }
    res: List<TimetableEntry>
  }
  'GET /timetable/periods': { query: { section_id?: string; class_id?: string }; res: List<Period> }
  'GET /timetable/teachers': {
    query: { subject_id?: string; free_class_teacher?: 'true'; except_section?: string; include_former?: 'true' }
    res: List<Teacher>
  }
}
