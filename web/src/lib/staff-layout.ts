import type { SessionResponse } from './api'

/* The teaching workspaces. Class teachers and subject heads work inside the
   faculty workspace, so they are covered by it. */
const TEACHING = new Set(['faculty', 'hod'])

/** The school's staff layout switch: module_settings 'staff_layout' (settings
    registry key `app.staff_layout`), seller-set, off unless a row says on.
    Teaching staff only (Yajur, 2026-10-19: "this UI only for teaching staff");
    every other workspace keeps the standard shell. */
export function staffLayoutOn(session: Pick<SessionResponse, 'modules'>, roleKey: string | undefined): boolean {
  if (!roleKey || !TEACHING.has(roleKey)) return false
  return !!session.modules?.some((m) => m.module === 'staff_layout' && m.enabled)
}

/** The staff menu (sidebar only) for every role: module_settings
    'staff_layout_all_roles', per school (Yajur, 2026-10-24: "for all roles use the
    sidebar we designed for teaching staff ... only sidebar"). The top bar is
    still decided by staffLayoutOn. */
export function staffSidebarOn(session: Pick<SessionResponse, 'modules'>, roleKey: string | undefined): boolean {
  if (staffLayoutOn(session, roleKey)) return true
  return !!roleKey && !!session.modules?.some((m) => m.module === 'staff_layout_all_roles' && m.enabled)
}

export interface TodaySignIns {
  date: string
  /** The school's IANA timezone; the times are shown in it. */
  timezone: string
  first_sign_in_at: string | null
  last_activity_at: string
  employee_code: string | null
  campus: string | null
}

export const SIGN_INS_PATH = '/api/v1/me/sign-ins/today'
