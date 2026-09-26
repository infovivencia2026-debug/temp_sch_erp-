import type { Env } from './env'
import { can, type Identity } from './identity'
import { HttpError, forbidden } from './http'
import { entitlementFor } from './routes/misc/shell'
import type { Ctx } from './router'

/* The middleware api.go stacks in front of every /api/v1 handler that the
   per-route `perm` cannot express. Called from index.ts after the route's own
   permission check. */

/* Group permissions: r.Route(prefix, func(r) { r.Use(RequirePermission(p)) ... }).
   Every Go route under each prefix carries the key (checked against the route
   table), so a Worker route registered with only its inner key, e.g.
   finance.fees.write under /finance, still needs finance.invoices.read as Go did.
   Matched segment-wise: /timetable does not cover /timetable-admin. */
const GROUP_PERMS: [string, string][] = [
  ['/academics', 'academics.read'],
  ['/admissions', 'admissions.read'],
  ['/class', 'academics.class360.view'],
  ['/classroom', 'academics.timetable.read'],
  ['/compliance', 'admin.reports.read'],
  ['/department', 'hr.employees.read'],
  ['/department-timetable', 'academics.timetable.read'],
  ['/exams', 'academics.exams.read'],
  ['/finance', 'finance.invoices.read'],
  ['/hpc', 'self.profile.read'],
  ['/lifecycle', 'students.read'],
  ['/master-timetable', 'academics.timetable.read'],
  ['/mdm-register', 'admin.reports.read'],
  ['/office', 'office.front_desk.read'],
  ['/payroll', 'hr.payroll.read'],
  ['/portal', 'self.profile.read'],
  ['/principal', 'admin.reports.read'],
  ['/report-builder', 'admin.reports.read'],
  ['/seller', 'platform.tenants.write'],
  ['/students', 'students.read'],
  ['/teaching', 'academics.timetable.read'],
  ['/timetable', 'academics.timetable.read'],
  ['/timetable-admin', 'academics.timetable.write'],
  ['/timetable-cover', 'academics.timetable.read'],
  ['/timetable-optimizer', 'academics.timetable.read'],
]

const API = '/api/v1'

function hasPrefix(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && (path.length === prefix.length || path[prefix.length] === '/')
}

export function groupGate(id: Identity, pathname: string): void {
  const path = pathname.startsWith(API) ? pathname.slice(API.length) : pathname
  for (const [prefix, perm] of GROUP_PERMS) {
    if (hasPrefix(path, prefix) && !can(id, perm)) throw forbidden('missing permission: ' + perm)
  }
}

/* requirePasswordChanged (session.go): an account on its issued password
   reaches setting a password, skipping it, and the session. */
export function passwordGate(id: Identity, method: string, pathname: string): void {
  if (!id.mustChangePassword) return
  if (method === 'POST' && (pathname.endsWith('/profile/password') || pathname.endsWith('/profile/password/skip'))) return
  if (method === 'GET' && pathname.endsWith('/session')) return
  throw new HttpError(403, 'set your own password before using the app', { code: 'password_change_required' })
}

/* RequireSubscription (gate.go): a school that is not paying reaches only
   what explains why. Applies to a platform operator acting inside a school
   too, as in Go. */
const OPEN_WHILE_LOCKED = ['/session', '/catalog', '/me', '/profile', '/ref-data']

export async function subscriptionGate(env: Env, id: Identity, pathname: string): Promise<void> {
  if (!id.institution) return
  const path = pathname.startsWith(API) ? pathname.slice(API.length) : pathname
  if (OPEN_WHILE_LOCKED.some((p) => hasPrefix(path, p))) return
  const st = await entitlementFor({ env, id } as unknown as Ctx)
  if (!st.active) throw new HttpError(402, st.reason, { code: 'subscription_' + st.code })
}
