/* The staff list. internal/api/hr.go listEmployees. */
import type { Page } from './contract'

/** One employee. Optional fields are omitted when empty on file. */
export interface Employee {
  id: string
  full_name: string
  status: string
  user_id?: string
  employee_code?: string
  staff_number?: string
  device_user_id?: string
  department?: string
  designation?: string
  phone?: string
  email?: string
  photo_file_id?: string
  joined_on?: string
  periods_this_week: number
}

export interface StaffApi {
  'GET /hr/employees': {
    query: { status?: string; limit?: number; offset?: number; cursor?: string; with_total?: '0' | '1' }
    res: Page<Employee>
  }
}
