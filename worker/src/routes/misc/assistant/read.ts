import type { Ctx, Router } from '../../../router'
import { can } from '../../../identity'
import { errorResponse, isUUID } from '../../../http'
import { buildRouter } from '../../index'

/* READING AS THE CALLER.

   Every tool the model can call reads through one of the Worker's own GET
   routes, dispatched here with the caller's identity (the same pattern as
   actions.ts `dispatch`). So "a teacher sees their sections, a parent only
   their children" is the route's own check, never something the assistant
   re-implements: a route that answers 403 or 404 for the person answers 403
   or 404 for the tool. The model never names a path; the tools do. */

let router: Router | null = null

export interface Got { status: number; data: Record<string, unknown> }

/** GET one of the Worker's own routes as the caller. Missing permission is a 403 answer, not a throw. */
export async function readAs(c: Ctx, path: string, query: Record<string, string | number | undefined | null> = {}): Promise<Got> {
  router = router ?? buildRouter()
  const url = new URL('/api/v1' + path, c.url)
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const hit = router.match('GET', url.pathname)
  if (!hit) throw new Error('assistant read: no route for GET ' + url.pathname)
  if (hit.route.perm !== 'auth' && !can(c.id, hit.route.perm)) return { status: 403, data: { error: 'missing permission: ' + hit.route.perm } }
  const headers = new Headers(c.req.headers)
  headers.delete('content-length'); headers.delete('content-type'); headers.delete('idempotency-key')
  const req = new Request(url.toString(), { method: 'GET', headers })
  const sub: Ctx = { req, env: c.env, url, params: hit.params, id: c.id, get db() { return c.db } }
  let res: Response
  try { res = await hit.route.handler(sub) } catch (e) { res = errorResponse(e) }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, data }
}

/** A route's refusal as a sentence the model can repeat. */
export function refusal(g: Got): string {
  if (g.status === 403) return 'not permitted: the person asking is not allowed to see this'
  if (g.status === 404) return 'not found, or not visible to the person asking'
  const e = g.data.error
  return typeof e === 'string' ? e : (e as { message?: string } | undefined)?.message ?? `the lookup failed (${g.status})`
}

// --- shaping answers -----------------------------------------------------------------------

export const MAX_ROWS = 25

/** The rows of a list answer: `items`, or the first array in the object. */
export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.items)) return o.items as Record<string, unknown>[]
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

export const rupees = (paise: unknown): string => {
  const n = Number(paise ?? 0) / 100
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

/** One row flattened for the model: scalars only, money as rupees, long text clipped. */
export function flat(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || typeof v === 'object') continue
    if (/photo|file_id|password|hash|token/i.test(k)) continue
    if (k.endsWith('_paise')) { out[k.slice(0, -6)] = rupees(v); continue }
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v
  }
  return out
}

// --- what a person may be linked to ----------------------------------------------------------

/** A family account reads through the portal routes, staff through the records ones. */
export const isFamily = (c: Ctx) => !can(c.id, 'students.read') && (can(c.id, 'self.children.read') || can(c.id, 'self.profile.read'))

export interface Link { label: string; to: string }

/** The screen a student opens on, for this reader. /go/ resolves the workspace when it is opened. */
export function studentLink(c: Ctx, id: string, label: string): Link {
  if (isFamily(c)) return { label, to: `/go/fees_payments?student_id=${id}` }
  if (can(c.id, 'students.read.all')) return { label, to: `/go/student_360?student=${id}` }
  return { label, to: `/go/student_details?student=${id}` }
}
export const screenLink = (slug: string, label: string, query = ''): Link => ({ label, to: `/go/${slug}${query ? '?' + query : ''}` })

// --- names to ids, through the caller's own view -------------------------------------------

export interface StudentRef { id: string; name: string; adm: string; class_name?: string; section_name?: string }

/** A student the caller can see, by id, admission number or name. Ambiguity is an answer, not a guess. */
export async function findStudent(c: Ctx, ref: string): Promise<{ one?: StudentRef; many?: StudentRef[]; error?: string }> {
  const q = ref.trim()
  if (q === '') return { error: 'name the student' }
  const pick = (r: Record<string, unknown>): StudentRef => ({
    id: String(r.id ?? r.student_id ?? ''), name: String(r.full_name ?? r.name ?? ''), adm: String(r.admission_no ?? ''),
    class_name: r.class_name ? String(r.class_name) : undefined, section_name: r.section_name ? String(r.section_name) : undefined,
  })
  let list: StudentRef[]
  if (isFamily(c)) {
    const g = await readAs(c, '/portal/students')
    if (g.status !== 200) return { error: refusal(g) }
    list = rowsOf(g.data).map(pick)
    const ql = q.toLowerCase()
    const toks = ql.split(/\s+/)
    const hit = list.filter((s) => s.id === q || s.adm.toLowerCase() === ql || toks.every((t) => s.name.toLowerCase().includes(t)))
    // A parent with one child means that child whatever name was used for them.
    list = hit
  } else {
    if (isUUID(q)) {
      const g = await readAs(c, `/students/${q}`)
      if (g.status !== 200) return { error: refusal(g) }
      return { one: pick(g.data) }
    }
    const g = await readAs(c, '/students', { q, limit: 6, with_total: 0 })
    if (g.status !== 200) return { error: refusal(g) }
    list = rowsOf(g.data).map(pick)
  }
  if (list.length === 0) return { error: `no student the person asking can see matches "${q}"` }
  const exact = list.filter((s) => s.adm.toLowerCase() === q.toLowerCase() || s.name.toLowerCase() === q.toLowerCase())
  if (list.length === 1) return { one: list[0] }
  if (exact.length === 1) return { one: exact[0] }
  return { many: list.slice(0, 6) }
}

export interface SectionRef { id: string; label: string; class_id: string }

/* Class and section names to ids. This reads only the school's own list of
   sections (names, not people), and every tool that then reads a section's
   data does it through a scoped route. */
export async function findSection(c: Ctx, cls: string, sec: string): Promise<{ one?: SectionRef; error?: string; classOnly?: { id: string; name: string } }> {
  const strip = (x: string) => x.trim().replace(/^(class|grade|std\.?|standard)\s*/i, '').trim()
  const cl = strip(cls), s = sec.trim().replace(/^section\s+/i, '')
  if (cl === '' && s === '') return { error: 'name the class and section' }
  // "6A", "6-A", "6 A", "3 BODHA" in one field.
  let c1 = cl, s1 = s
  if (s1 === '') { const m = /^(.*?\d.*?)[\s-]+([A-Za-z][A-Za-z ]*)$/.exec(cl) ?? /^(\d+)([A-Za-z])$/.exec(cl); if (m) { c1 = m[1].trim(); s1 = m[2].trim() } }
  /* Every section of the class, this year's first. Schools name classes
     "6", "Class 6" or "Grade 6", and sections "A" or a word ("BODHA"). */
  const rows = await c.db.prepare(`
    SELECT s.id, c.id AS class_id, c.name AS class_name, s.name AS section_name FROM sections s JOIN classes c ON c.id = s.class_id
     WHERE lower(c.name) IN (lower(?1), lower('class ' || ?1), lower('grade ' || ?1), lower('std ' || ?1), lower('standard ' || ?1))
     ORDER BY (s.academic_year_id = (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)) DESC, s.name LIMIT 60`)
    .bind(c1).all<{ id: string; class_id: string; class_name: string; section_name: string }>()
  const all: typeof rows.results = []
  for (const x of rows.results) if (!all.some((y) => y.section_name.toLowerCase() === x.section_name.toLowerCase())) all.push(x)
  if (all.length === 0) return { error: `no class "${cls}" in this school` }
  const cname = all[0].class_name
  const names = all.map((x) => x.section_name).join(', ')
  const pick = (x: (typeof all)[number]) => ({ one: { id: x.id, class_id: x.class_id, label: `${x.class_name} ${x.section_name}` } })
  if (s1 === '') {
    if (all.length === 1) return pick(all[0])
    return { classOnly: { id: all[0].class_id, name: cname }, error: `${cname} has ${all.length} sections: ${names}. Name one, or ask about each.` }
  }
  const want = s1.toLowerCase()
  const exact = all.filter((x) => x.section_name.toLowerCase() === want)
  if (exact.length === 1) return pick(exact[0])
  const loose = all.filter((x) => x.section_name.toLowerCase().startsWith(want) || (want.length >= 3 && x.section_name.toLowerCase().includes(want)))
  if (loose.length === 1) return pick(loose[0])
  return { error: `${cname} has no section "${s1}"; its sections are ${names}. Name one, or ask about each.` }
}

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
export const str = (a: Record<string, unknown>, k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : typeof a[k] === 'number' ? String(a[k]) : '')
export const num = (a: Record<string, unknown>, k: string): number | null => {
  const v = a[k]
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
export const strs = (a: Record<string, unknown>, k: string): string[] => {
  const v = a[k]
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,;]| and /).map((x) => x.trim()).filter(Boolean)
  return []
}
