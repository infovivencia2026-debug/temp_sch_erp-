/* The landing dashboards: principal, finance, HR. internal/api/principal.go,
   finance_backoffice.go, hr.go. Every one carries the date range it was cut
   for and names the figures that ignore that range (`as_of_now`). */

export interface DashboardRange { period: string; from: string; to: string; label: string }

export interface AppStatusCount { status: string; applications: number }
export interface PendingLeaveGroup {
  leave_type: string
  /** 'staff' or 'student'. */
  subject_kind: string
  /** Absent for student leave and for staff with no department on file. */
  department?: string
  requests: number
  /** Working days asked for; a float (half days). */
  days: number
}
export interface ClassRollGroup {
  /** Absent for the not-yet-enrolled bucket. Names are not unique; this is. */
  class_id?: string
  class_name: string
  students: number
}
export interface OutstandingAgeing {
  not_due_paise: number
  days_0_30_paise: number
  days_31_60_paise: number
  days_61_90_paise: number
  days_90_plus_paise: number
  /** Unpaid invoices with no due date. */
  undated_paise: number
}

/* Absent is not zero: the optional breakdowns are omitted when there is
   nothing to say, and a screen must draw the no-denominator form then. */
export interface PrincipalDashboard {
  students: number; staff: number; sections: number
  attendance_today_pct: number; attendance_marked_today: number
  attendance_range_pct?: number; attendance_range_marked?: number
  collected_paise: number; outstanding_paise: number; defaulters: number
  billed_paise: number; collected_year_paise: number; outstanding_year_paise: number
  /** How many invoices the year trio was summed over; always sent. */
  year_invoice_count: number
  pending_leave: number; open_applications: number; unassigned_subjects: number
  class_subjects_total?: number
  open_applications_by_status?: AppStatusCount[]
  pending_leave_by_type?: PendingLeaveGroup[]
  students_by_class?: ClassRollGroup[]
  /** Active staff whose designation is in the teaching category, and the rest. */
  staff_teaching?: number
  staff_non_teaching?: number
  /** Active students in each section, for the Students card's picker. */
  students_by_section?: { section_id: string; label: string; students: number }[]
  outstanding_ageing?: OutstandingAgeing
  range: DashboardRange
  as_of_now: string[]
}

export interface FinanceDashboard {
  today_paise: number; month_paise: number; outstanding_paise: number
  overdue_paise: number; defaulters: number; invoices: number
  unreconciled: number; refunds_pending: number
  range: DashboardRange
  as_of_now: string[]
}

export interface HRAway { name: string; employee_code: string; reason: string; until?: string }
export interface HRAlert { kind: 'danger' | 'warning' | 'neutral'; text: string; count: number; link: string }
export interface HRDashboard {
  headcount: number
  present_today: number
  absent_today: number
  leave_pending: number
  new_joiners_30d: number
  departments: number
  away_today: HRAway[]
  attention: HRAlert[]
}

/** The date-range picker's query (lib/date-range on the web). */
export interface RangeQuery { period?: string; from?: string; to?: string }

export interface DashboardsApi {
  'GET /principal/dashboard': { query: RangeQuery; res: PrincipalDashboard }
  'GET /finance/dashboard': { query: RangeQuery; res: FinanceDashboard }
  'GET /hr/dashboard': { res: HRDashboard }
}
