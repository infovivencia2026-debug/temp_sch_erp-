import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, bool, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { institutionId } from './common'
import { school } from '../school'

/* Port of mountPeriodClose (internal/api/period_close.go), mounted inside
   r.Route("/admin") in api.go, so the paths are /admin/period-closes*.
   No trigger touches period_closes or academic_years in migrations/, so there
   is nothing to re-implement. The requireOpenPeriod / requireOpenYear guards
   are helpers other handlers call; they are exported here for those ports. */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthLabel = (y: number, m0: number) => `${MONTHS[m0]} ${y}`
const monthKey = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}`

/** Go's httpx.Error(w, r, status, code, msg): the code rides as an extra field. */
const coded = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })

/** The months (YYYY-MM) from the month of `starts` to `ends`, inclusive. */
function monthsBetween(starts: string, ends: string): { y: number; m0: number }[] {
  let y = Number(starts.slice(0, 4)), m0 = Number(starts.slice(5, 7)) - 1
  const out: { y: number; m0: number }[] = []
  for (;;) {
    const first = `${monthKey(y, m0)}-01`
    if (first > ends.slice(0, 10)) break
    out.push({ y, m0 })
    if (++m0 === 12) { m0 = 0; y++ }
  }
  return out
}

/** requireOpenPeriod: a 409 period_closed when `on` (YYYY-MM-DD) falls inside a closed month or year. */
export async function requireOpenPeriod(c: Ctx, kind: 'month' | 'year', on: string): Promise<void> {
  const inst = school(c).id
  const key = on.slice(0, 7)
  const row = await c.db.prepare(`
    SELECT (? = 'month' AND EXISTS (SELECT 1 FROM period_closes WHERE institution_id = ? AND kind = 'month'
              AND period_key = ? AND reopened_at IS NULL)) AS month_closed,
           (SELECT name FROM academic_years WHERE institution_id = ? AND closed_at IS NOT NULL
              AND ? BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1) AS year_name`)
    .bind(kind, inst, key, inst, on.slice(0, 10)).first<{ month_closed: number; year_name: string | null }>()
  if (bool(row?.month_closed)) {
    throw coded(409, 'period_closed', `${monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1)} is closed; ask the principal to reopen it`)
  }
  if (row?.year_name) throw coded(409, 'period_closed', `The year ${row.year_name} is closed; ask the principal to reopen it`)
}

/** requireOpenYear: the same refusal for a write that knows its academic year by id. */
export async function requireOpenYear(c: Ctx, yearId: string): Promise<void> {
  const row = await c.db.prepare(`SELECT name, closed_at IS NOT NULL AS closed FROM academic_years WHERE id = ?`).bind(yearId)
    .first<{ name: string; closed: number }>()
  if (row && bool(row.closed)) throw coded(409, 'period_closed', `The year ${row.name} is closed; ask the principal to reopen it`)
}

interface PeriodYear {
  id: string; name: string; starts_on: string; ends_on: string
  is_current: boolean; closed: boolean; closed_at?: string; closed_by?: string
}
interface PeriodMonth {
  key: string; label: string; closed: boolean; via_year: boolean
  closed_at?: string; closed_by?: string; future: boolean
}

async function readPeriodRequest(c: Ctx): Promise<{ kind: string; period_key: string }> {
  const req = await readJSON<{ kind?: unknown; period_key?: unknown }>(c.req)
  const kind = typeof req.kind === 'string' ? req.kind.trim() : ''
  const key = typeof req.period_key === 'string' ? req.period_key.trim() : ''
  if (kind === 'month') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw badRequest('period_key must be YYYY-MM for a month')
  } else if (kind === 'year') {
    if (!isUUID(key)) throw badRequest("period_key must be the academic year's id for a year")
  } else {
    throw badRequest('kind must be month or year')
  }
  return { kind, period_key: kind === 'year' ? key.toLowerCase() : key }
}

const actor = (c: Ctx) => (c.id.platformAdmin ? null : c.id.userId)

export function registerPeriodCloses(r: Router): void {
  r.get('/admin/period-closes', 'institution.read', async (c) => {
    const inst = institutionId(c)
    const raw = (c.url.searchParams.get('academic_year_id') ?? '').trim()
    let yearId: string | null = null
    if (raw !== '') {
      if (!isUUID(raw)) throw badRequest('academic_year_id must be a uuid')
      yearId = raw.toLowerCase()
    }
    const [ys, cs] = await c.db.batch<Record<string, unknown>>([
      c.db.prepare(`SELECT ay.id, ay.name, substr(ay.starts_on, 1, 10) AS starts_on, substr(ay.ends_on, 1, 10) AS ends_on,
             ay.is_current, ay.closed_at IS NOT NULL AS closed, substr(ay.closed_at, 1, 10) AS closed_at,
             (SELECT u.full_name FROM users u WHERE u.id = ay.closed_by) AS closed_by
        FROM academic_years ay WHERE ay.institution_id = ? ORDER BY ay.starts_on DESC`).bind(inst),
      c.db.prepare(`SELECT pc.period_key, pc.via_year IS NOT NULL AS via_year, substr(pc.closed_at, 1, 10) AS closed_at,
             (SELECT u.full_name FROM users u WHERE u.id = pc.closed_by) AS closed_by
        FROM period_closes pc WHERE pc.institution_id = ? AND pc.kind = 'month' AND pc.reopened_at IS NULL`).bind(inst),
    ])
    const years: PeriodYear[] = ys.results.map((v) => {
      const y: PeriodYear = {
        id: String(v.id), name: String(v.name), starts_on: String(v.starts_on), ends_on: String(v.ends_on),
        is_current: bool(v.is_current), closed: bool(v.closed),
      }
      if (v.closed_at != null) y.closed_at = String(v.closed_at)
      if (v.closed_by != null) y.closed_by = String(v.closed_by)
      return y
    })
    let year: PeriodYear | undefined
    for (const y of years) if ((yearId !== null && y.id === yearId) || (yearId === null && y.is_current)) year = y
    if (!year && years.length > 0) year = years[0]

    const months: PeriodMonth[] = []
    if (year) {
      const live = new Map<string, PeriodMonth>()
      for (const v of cs.results) {
        const m: PeriodMonth = { key: String(v.period_key), label: '', closed: true, via_year: bool(v.via_year), future: false }
        if (v.closed_at != null) m.closed_at = String(v.closed_at)
        if (v.closed_by != null) m.closed_by = String(v.closed_by)
        live.set(m.key, m)
      }
      const nowMs = Date.now()
      for (const { y, m0 } of monthsBetween(year.starts_on, year.ends_on)) {
        const key = monthKey(y, m0)
        const m = live.get(key) ?? { key, label: '', closed: false, via_year: false, future: false }
        m.label = monthLabel(y, m0)
        m.future = Date.UTC(y, m0, 1) > nowMs
        months.push(m)
      }
    }
    // Go marshals a zero periodYear when the school has no years at all.
    const outYear = year ?? { id: '', name: '', starts_on: '', ends_on: '', is_current: false, closed: false }
    return ok({ year: outYear, years, months })
  })

  r.post('/admin/period-closes/close', 'institution.settings.write', async (c) => {
    const inst = institutionId(c)
    const req = await readPeriodRequest(c)
    const t = now()
    const by = actor(c)
    let closedMonths = 0
    if (req.kind === 'month') {
      const res = await c.db.prepare(`INSERT INTO period_closes (id, institution_id, kind, period_key, closed_by, closed_at)
        SELECT ?, ?, 'month', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM period_closes WHERE institution_id = ? AND kind = 'month'
                            AND period_key = ? AND reopened_at IS NULL)`)
        .bind(uuid(), inst, req.period_key, by, t, inst, req.period_key).run()
      if ((res.meta.changes ?? 0) === 0) throw coded(409, 'already_closed', 'That period is already closed.')
      closedMonths = 1
    } else {
      const yearId = req.period_key
      const y = await c.db.prepare(`SELECT institution_id, starts_on, ends_on, closed_at FROM academic_years WHERE id = ?`).bind(yearId)
        .first<{ institution_id: string; starts_on: string; ends_on: string; closed_at: string | null }>()
      if (!y) throw notFound()
      if (y.institution_id !== inst || y.closed_at !== null) throw coded(409, 'already_closed', 'That period is already closed.')
      /* One batch: the year update is guarded on closed_at IS NULL, and every
         insert after it is guarded on the year carrying this request's stamp,
         so a racing close makes the whole batch a no-op after the first line. */
      const guard = `EXISTS (SELECT 1 FROM academic_years WHERE id = ? AND closed_at = ? AND closed_by IS ?)`
      const stmts: D1PreparedStatement[] = [
        c.db.prepare(`UPDATE academic_years SET closed_at = ?, closed_by = ? WHERE id = ? AND institution_id = ? AND closed_at IS NULL`)
          .bind(t, by, yearId, inst),
        c.db.prepare(`INSERT INTO period_closes (id, institution_id, kind, period_key, closed_by, closed_at)
          SELECT ?, ?, 'year', ?, ?, ? WHERE ${guard}`).bind(uuid(), inst, yearId, by, t, yearId, t, by),
      ]
      for (const { y: yy, m0 } of monthsBetween(y.starts_on, y.ends_on)) {
        const key = monthKey(yy, m0)
        stmts.push(c.db.prepare(`INSERT INTO period_closes (id, institution_id, kind, period_key, via_year, closed_by, closed_at)
          SELECT ?, ?, 'month', ?, ?, ?, ?
           WHERE ${guard}
             AND NOT EXISTS (SELECT 1 FROM period_closes pc WHERE pc.institution_id = ? AND pc.kind = 'month'
                              AND pc.period_key = ? AND pc.reopened_at IS NULL)`)
          .bind(uuid(), inst, key, yearId, by, t, yearId, t, by, inst, key))
      }
      const res = await c.db.batch(stmts)
      if ((res[0].meta.changes ?? 0) === 0) throw coded(409, 'already_closed', 'That period is already closed.')
      closedMonths = res.slice(2).reduce((n, x) => n + (x.meta.changes ?? 0), 0)
    }
    return ok({ kind: req.kind, period_key: req.period_key, closed: true, months_closed: closedMonths })
  })

  r.post('/admin/period-closes/reopen', 'institution.settings.write', async (c) => {
    const inst = institutionId(c)
    const req = await readPeriodRequest(c)
    const t = now()
    const by = actor(c)
    let reopened = 0
    if (req.kind === 'month') {
      const row = await c.db.prepare(`SELECT via_year IS NOT NULL AS via FROM period_closes
         WHERE institution_id = ? AND kind = 'month' AND period_key = ? AND reopened_at IS NULL`)
        .bind(inst, req.period_key).first<{ via: number }>()
      if (!row) throw coded(409, 'not_closed', 'That period is not closed.')
      if (bool(row.via)) throw coded(409, 'year_closed', 'That month was closed with its year. Reopen the year instead.')
      const res = await c.db.prepare(`UPDATE period_closes SET reopened_at = ?, reopened_by = ?
         WHERE institution_id = ? AND kind = 'month' AND period_key = ? AND reopened_at IS NULL AND via_year IS NULL`)
        .bind(t, by, inst, req.period_key).run()
      reopened = res.meta.changes ?? 0
    } else {
      const yearId = req.period_key
      const y = await c.db.prepare(`SELECT closed_at FROM academic_years WHERE id = ? AND institution_id = ?`).bind(yearId, inst)
        .first<{ closed_at: string | null }>()
      if (!y || y.closed_at === null) throw coded(409, 'not_closed', 'That period is not closed.')
      // Guarded on the closed_at just read, so a concurrent reopen leaves the later statements with nothing to match.
      const guard = `EXISTS (SELECT 1 FROM academic_years WHERE id = ? AND closed_at IS NULL)`
      const res = await c.db.batch([
        c.db.prepare(`UPDATE academic_years SET closed_at = NULL, closed_by = NULL
           WHERE id = ? AND institution_id = ? AND closed_at = ?`).bind(yearId, inst, y.closed_at),
        c.db.prepare(`UPDATE period_closes SET reopened_at = ?, reopened_by = ?
           WHERE institution_id = ? AND kind = 'year' AND period_key = ? AND reopened_at IS NULL AND ${guard}`)
          .bind(t, by, inst, yearId, yearId),
        c.db.prepare(`UPDATE period_closes SET reopened_at = ?, reopened_by = ?
           WHERE institution_id = ? AND kind = 'month' AND via_year = ? AND reopened_at IS NULL AND ${guard}`)
          .bind(t, by, inst, yearId, yearId),
      ])
      if ((res[0].meta.changes ?? 0) === 0) throw coded(409, 'not_closed', 'That period is not closed.')
      reopened = res[2].meta.changes ?? 0
    }
    return ok({ kind: req.kind, period_key: req.period_key, closed: false, months_reopened: reopened })
  })
}
