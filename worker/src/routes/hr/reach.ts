import type { Identity } from '../../identity'
import { can } from '../../identity'
import { placeholders, js } from '../admissions/util'

/* Port of growthReach (hr_growth.go) and narrow (hr_lifecycle.go): who may
   see whom in the staff file. The back office (hr.employees.write or a
   platform admin) reads the institution, a head of department reads their
   department and their own row, anybody else reads their own row alone. */

export interface Reach { userId: string; all: boolean; deptIds: string[]; ownEmpId: string | null }

export async function growthReach(db: D1Database, id: Identity): Promise<Reach> {
  const all = id.platformAdmin || can(id, 'hr.employees.write')
  const [depts, own] = await Promise.all([
    db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(id.userId).all<{ id: string }>(),
    db.prepare(`SELECT id FROM employees WHERE user_id = ? LIMIT 1`).bind(id.userId).first<{ id: string }>(),
  ])
  return { userId: id.userId, all, deptIds: depts.results.map((d) => d.id), ownEmpId: own?.id ?? null }
}

/** The predicate restricting an employees alias to what the caller may read, plus its arguments. FALSE when they reach nobody. */
export function employeeFilter(re: Reach, alias: string): { sql: string; args: unknown[] } {
  if (re.all) return { sql: '1', args: [] }
  const parts: string[] = []
  const args: unknown[] = []
  if (re.deptIds.length > 0) { parts.push(`${alias}.department_id IN (${placeholders(re.deptIds.length)})`); args.push(js(re.deptIds)) }
  if (re.ownEmpId) { parts.push(`${alias}.id = ?`); args.push(re.ownEmpId) }
  if (parts.length === 0) return { sql: '0', args: [] }
  return { sql: '(' + parts.join(' OR ') + ')', args }
}

/** grievanceFilter: outside the back office only the grievances one raised or was assigned. */
export function grievanceFilter(re: Reach, alias: string): { sql: string; args: unknown[] } {
  if (re.all) return { sql: '1', args: [] }
  const parts = [`${alias}.assigned_to = ?`]
  const args: unknown[] = [re.userId]
  if (re.ownEmpId) { parts.push(`${alias}.employee_id = ?`); args.push(re.ownEmpId) }
  return { sql: '(' + parts.join(' OR ') + ')', args }
}
