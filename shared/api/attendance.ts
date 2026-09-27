/* Daily attendance. internal/api/attendance.go. */
import type { List } from './contract'

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'half_day' | 'leave' | 'holiday'

export interface AttendanceRow {
  id: string; student_id: string; student_name: string; admission_no: string
  section_id: string; on_date: string; status: string; minutes_late?: number; remarks?: string
}

export interface MarkAttendanceRequest {
  section_id: string
  on_date?: string
  period_id?: string
  entries: { student_id: string; status: string; minutes_late?: number | null; remarks?: string | null }[]
  notify_channels?: string[]
  silent?: boolean
}

export interface MarkAttendanceResult {
  section_id: string
  on_date: string
  submitted: number
  written: number
  newly_absent: number
  parents_told: number
  messages_queued: number
  channels: string[]
}

export interface AttendanceApi {
  'GET /attendance': { query: { on_date?: string; section_id?: string; student_id?: string }; res: List<AttendanceRow> }
  'POST /attendance': { body: MarkAttendanceRequest; res: MarkAttendanceResult }
}
