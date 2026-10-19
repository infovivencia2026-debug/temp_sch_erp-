import type { SessionResponse } from './api'

/** The school's staff layout switch: module_settings 'staff_layout' (settings
    registry key `app.staff_layout`), seller-set, off unless a row says on.
    Applies to staff only; a parent's or a student's screens never change. */
export function staffLayoutOn(session: Pick<SessionResponse, 'modules'>, roleKey: string | undefined): boolean {
  if (!roleKey || roleKey === 'parent' || roleKey === 'student') return false
  return !!session.modules?.some((m) => m.module === 'staff_layout' && m.enabled)
}

export interface TodaySignIns {
  date: string
  first_sign_in_at: string | null
  last_activity_at: string
  employee_code: string | null
  campus: string | null
}

export const SIGN_INS_PATH = '/api/v1/me/sign-ins/today'
