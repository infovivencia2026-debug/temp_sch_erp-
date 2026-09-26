import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, forbidden, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { has, instId } from './common'

/* Port of internal/api/digital_library.go and digital_library_usage.go: the
   digital holdings desk under /ops/digital-library. Lending stays with the
   physical desk (library_reservations / library_copies / library_loans); this
   file only decides who may see and open a holding, and queues a reader for a
   single-copy e-book.

   Postgres arrays became TEXT: subject_tags is a JSON array (the D1 default
   '{}' from the converter is read as empty). The three partial/expression
   UNIQUE indexes of the Postgres schema (one holding per title+campus+kind,
   one provider per kind+name, one live hold per reader) did not survive the
   conversion, so their conflicts are checked in the handler instead. */

const NIL = '00000000-0000-0000-0000-000000000000'
const ROW_LIMIT = 300

const coded = (status: number, code: string, message: string) => new HttpError(status, message, { code })

// --- scope -------------------------------------------------------------------

/** The two parts of internal/scope this desk needs: the campus boundary and the student records the caller is. */
interface DigitalScope { userId: string; studentIds: string[]; librarian: boolean; campuses: string[] | null }

async function digitalArgs(c: Ctx, librarian: boolean): Promise<DigitalScope> {
  const u = c.id.userId
  const s: DigitalScope = { userId: u, studentIds: [], librarian: librarian && has(c, 'operations.library.write'), campuses: null }
  if (c.id.platformAdmin) return s
  const [campuses, students] = await c.db.batch([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM students WHERE user_id = ?
                  UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                   WHERE g.user_id = ? AND sg.portal_blocked = 0
                     AND (sg.access_until IS NULL OR sg.access_until >= date('now'))`).bind(u, u),
  ])
  let all = false
  const ids: string[] = []
  for (const r of campuses.results as { campus_id: string | null }[]) {
    if (r.campus_id === null) all = true
    else ids.push(r.campus_id)
  }
  // An empty posting is an empty boundary, not a free one.
  s.campuses = all ? null : ids
  s.studentIds = (students.results as { id: string }[]).map((r) => r.id)
  return s
}

/** `col IN (?,?)` or a false predicate for an empty set. */
function inList(col: string, ids: string[]): { sql: string; args: string[] } {
  return ids.length ? { sql: `${col} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(ids)] } : { sql: '0', args: [] }
}

// --- projection --------------------------------------------------------------

interface HoldingRow {
  id: string; kind: string; title: string; author: string | null; publisher: string | null; identifier: string | null
  language: string | null; description: string | null; access_model: string; has_file: number; file_name: string | null
  subject_tags: string | null; provider_id: string | null; provider_name: string | null; provider_status: string | null
  campus_id: string | null; loan_days: number; is_active: number; library_title_id: string | null
  on_loan: number; due_on: string | null; readers_waiting: number; mine_now: number
  visible_to_classes: string | null; visible_to_roles: string | null; updated_at: string
}

interface DigitalHolding {
  id: string; kind: string; title: string; author?: string; publisher?: string; identifier?: string; language?: string
  description?: string; access_model: string; has_file: boolean; file_name?: string; subject_tags: string[]
  provider_id?: string; provider_name?: string; provider_status?: string; campus_id?: string; loan_days: number
  is_active: boolean; library_title_id?: string; on_loan: boolean; due_on?: string; readers_waiting: number
  available_to_me: boolean; visible_to_classes: string[]; visible_to_roles: string[]; updated_at: string
}

function parseTags(s: string | null | undefined): string[] {
  if (!s) return []
  const t = s.trim()
  if (t === '' || t === '{}' || t === '[]') return []
  if (t.startsWith('[')) { try { const v = JSON.parse(t); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  // A Postgres array literal that came through the converter unchanged.
  if (t.startsWith('{')) return t.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}
const parseList = (s: string | null): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? (v as string[]).filter((x) => x !== null).sort() : [] } catch { return [] } }
const opt = (v: string | null): string | undefined => (v === null ? undefined : v)

function shapeHolding(r: HoldingRow): DigitalHolding {
  return {
    id: r.id, kind: r.kind, title: r.title, author: opt(r.author), publisher: opt(r.publisher), identifier: opt(r.identifier),
    language: opt(r.language), description: opt(r.description), access_model: r.access_model, has_file: bool(r.has_file),
    file_name: opt(r.file_name), subject_tags: parseTags(r.subject_tags), provider_id: opt(r.provider_id),
    provider_name: opt(r.provider_name), provider_status: opt(r.provider_status), campus_id: opt(r.campus_id),
    loan_days: r.loan_days, is_active: bool(r.is_active), library_title_id: opt(r.library_title_id), on_loan: bool(r.on_loan),
    due_on: opt(r.due_on), readers_waiting: r.readers_waiting, available_to_me: bool(r.mine_now),
    visible_to_classes: parseList(r.visible_to_classes), visible_to_roles: parseList(r.visible_to_roles),
    updated_at: (r.updated_at ?? '').slice(0, 16),
  }
}

/** The one SELECT every holding read uses, with the scope bound in. Returns the SQL up to (not including) WHERE, and the args it consumed. */
function holdingSelect(s: DigitalScope): { sql: string; args: unknown[] } {
  const mine = inList('l.student_id', s.studentIds)
  const sql = `
    SELECT h.id, h.kind, h.title, h.author, h.publisher, h.identifier, h.language, h.description, h.access_model,
           (h.file_id IS NOT NULL) AS has_file, f.original_name AS file_name,
           h.subject_tags, h.provider_id, p.name AS provider_name, p.status AS provider_status,
           h.campus_id, h.loan_days, h.is_active, h.library_title_id,
           EXISTS (SELECT 1 FROM library_loans l JOIN library_copies c ON c.id = l.copy_id
                    WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL) AS on_loan,
           (SELECT substr(l.due_on, 1, 10) FROM library_loans l JOIN library_copies c ON c.id = l.copy_id
             WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL LIMIT 1) AS due_on,
           (SELECT COUNT(*) FROM library_reservations res
             WHERE res.title_id = h.library_title_id AND res.status = 'waiting') AS readers_waiting,
           (h.access_model <> 'single_copy_loan'
            OR EXISTS (SELECT 1 FROM library_loans l JOIN library_copies c ON c.id = l.copy_id
                        WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL
                          AND (${mine.sql}
                               OR l.employee_id = (SELECT e.id FROM employees e WHERE e.user_id = ? LIMIT 1)))) AS mine_now,
           (SELECT json_group_array(cl.name) FROM digital_holding_visibility v JOIN classes cl ON cl.id = v.class_id
             WHERE v.holding_id = h.id) AS visible_to_classes,
           (SELECT json_group_array(v.role_key) FROM digital_holding_visibility v
             WHERE v.holding_id = h.id AND v.role_key IS NOT NULL) AS visible_to_roles,
           h.updated_at
      FROM digital_holdings h
      LEFT JOIN digital_library_providers p ON p.id = h.provider_id
      LEFT JOIN files f ON f.id = h.file_id AND f.deleted_at IS NULL`
  return { sql, args: [...mine.args, s.userId] }
}

/** digitalVisibility AND digitalCampusScope, bound to the scope. */
function scopeWhere(s: DigitalScope): { sql: string; args: unknown[] } {
  const en = inList('en.student_id', s.studentIds)
  const vis = `(? OR NOT EXISTS (SELECT 1 FROM digital_holding_visibility v WHERE v.holding_id = h.id)
     OR EXISTS (SELECT 1 FROM digital_holding_visibility v WHERE v.holding_id = h.id
                 AND ((v.role_key IS NOT NULL AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                                                            WHERE ur.user_id = ? AND ro.key = v.role_key))
                   OR (v.class_id IS NOT NULL AND EXISTS (SELECT 1 FROM enrollments en
                                                            WHERE en.class_id = v.class_id AND en.status = 'active' AND ${en.sql})))))`
  const args: unknown[] = [s.librarian ? 1 : 0, s.userId, ...en.args]
  let campus = '1'
  if (s.campuses !== null) {
    const cs = inList('h.campus_id', s.campuses)
    campus = `(h.campus_id IS NULL OR ${cs.sql})`
    args.push(...cs.args)
  }
  return { sql: `${vis} AND ${campus}`, args }
}

/** One holding the caller may see, or null: the same predicates as the list, so an id cannot be guessed. */
async function loadHolding(c: Ctx, holdingId: string, librarian: boolean): Promise<DigitalHolding | null> {
  const s = await digitalArgs(c, librarian)
  const sel = holdingSelect(s)
  const w = scopeWhere(s)
  const row = await c.db.prepare(`${sel.sql} WHERE h.id = ? AND ${w.sql}`).bind(...sel.args, holdingId, ...w.args).first<HoldingRow>()
  return row ? shapeHolding(row) : null
}

const oneOf = (v: unknown, ...allowed: string[]) => typeof v === 'string' && allowed.includes(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const nullIfEmpty = (v: string) => (v === '' ? null : v)

/** optionalUUID: '' is null, anything else must parse. */
function optionalUUID(v: string, name: string): string | null {
  if (v === '') return null
  if (!isUUID(v)) throw badRequest(`${name} must be a uuid`)
  return v
}

/** readerOf: exactly one of student_id / employee_id. */
function readerOf(studentId: string, employeeId: string): { student: string | null; employee: string | null } {
  const bad = badRequest('name exactly one reader: student_id or employee_id')
  const student = studentId ? (isUUID(studentId) ? studentId : null) : null
  const employee = employeeId ? (isUUID(employeeId) ? employeeId : null) : null
  if ((studentId && !student) || (employeeId && !employee)) throw bad
  if ((student === null) === (employee === null)) throw bad
  return { student, employee }
}

// --- usage -------------------------------------------------------------------

const monthStart = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1)).toISOString()
function usageMonthKeys(d: Date, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1) + i, 1))
    out.push(x.toISOString().slice(0, 7))
  }
  return out
}
function usageMonthsParam(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 2) return 6
  return Math.min(n, 24)
}

// --- register ----------------------------------------------------------------

export function registerDigitalLibrary(r: Router): void {
  const READ = 'operations.library.read'
  const WRITE = 'operations.library.write'

  /* GET /catalogue: ?manage=1 is the librarian's view (inactive included, past
     the visibility rules); otherwise the reader's. ?kind, ?subject, ?q narrow. */
  r.get('/ops/digital-library/catalogue', READ, async (c) => {
    const q = c.url.searchParams
    const manage = q.get('manage') === '1'
    const s = await digitalArgs(c, manage)
    const sel = holdingSelect(s)
    const w = scopeWhere(s)
    let where = w.sql
    const args: unknown[] = [...sel.args, ...w.args]
    if (!manage) where += ' AND h.is_active = 1'
    const kind = (q.get('kind') ?? '').trim()
    if (kind !== '') {
      if (!oneOf(kind, 'ebook', 'journal', 'database')) throw badRequest('kind must be ebook, journal or database')
      where += ' AND h.kind = ?'; args.push(kind)
    }
    const tag = (q.get('subject') ?? '').trim()
    if (tag !== '') {
      where += ` AND EXISTS (SELECT 1 FROM json_each(CASE WHEN substr(h.subject_tags,1,1) = '[' THEN h.subject_tags ELSE '[]' END) t WHERE t.value = ?)`
      args.push(tag)
    }
    const search = (q.get('q') ?? '').trim()
    if (search !== '') {
      where += ` AND (h.title LIKE '%' || ? || '%' OR h.author LIKE '%' || ? || '%')`
      args.push(search, search)
    }
    const rows = await c.db.prepare(`${sel.sql} WHERE ${where} ORDER BY h.kind, h.title LIMIT ${ROW_LIMIT}`).bind(...args).all<HoldingRow>()
    return ok(rows.results.map(shapeHolding))
  })

  /* GET /usage: opens per month and per holding, from digital_holding_opens. */
  r.get('/ops/digital-library/usage', READ, async (c) => {
    const n = usageMonthsParam(c.url.searchParams.get('months'))
    const today = new Date()
    const keys = usageMonthKeys(today, n)
    const thisStart = monthStart(today.getUTCFullYear(), today.getUTCMonth())
    const lastStart = monthStart(today.getUTCFullYear(), today.getUTCMonth() - 1)
    const firstStart = monthStart(today.getUTCFullYear(), today.getUTCMonth() - (n - 1))

    const [byMonth, totals, holdings] = await c.db.batch([
      c.db.prepare(`SELECT substr(opened_at, 1, 7) AS month, COUNT(*) AS opens, COUNT(DISTINCT user_id) AS readers
                      FROM digital_holding_opens WHERE opened_at >= ? GROUP BY 1`).bind(firstStart),
      c.db.prepare(`SELECT COUNT(DISTINCT CASE WHEN opened_at >= ? THEN user_id END) AS readers,
                           SUM(CASE WHEN opened_at >= ? THEN 1 ELSE 0 END) AS this_month,
                           SUM(CASE WHEN opened_at < ? THEN 1 ELSE 0 END) AS last_month
                      FROM digital_holding_opens WHERE opened_at >= ?`).bind(thisStart, thisStart, thisStart, lastStart),
      c.db.prepare(`SELECT h.id, h.title, h.kind, h.access_model, h.is_active,
                           COALESCE(o.this_month, 0) AS this_month, COALESCE(o.last_month, 0) AS last_month,
                           COALESCE(o.readers, 0) AS readers, COALESCE(o.total, 0) AS total,
                           strftime('%Y-%m-%dT%H:%M:%SZ', o.last_at) AS last_at
                      FROM digital_holdings h
                      LEFT JOIN (SELECT x.holding_id,
                                        SUM(CASE WHEN x.opened_at >= ? THEN 1 ELSE 0 END) AS this_month,
                                        SUM(CASE WHEN x.opened_at >= ? AND x.opened_at < ? THEN 1 ELSE 0 END) AS last_month,
                                        COUNT(DISTINCT CASE WHEN x.opened_at >= ? THEN x.user_id END) AS readers,
                                        COUNT(*) AS total, MAX(x.opened_at) AS last_at
                                   FROM digital_holding_opens x GROUP BY x.holding_id) o ON o.holding_id = h.id
                     ORDER BY COALESCE(o.this_month, 0) DESC, COALESCE(o.total, 0) DESC, h.title`)
        .bind(thisStart, lastStart, thisStart, thisStart),
    ])
    const months = keys.map((month) => ({ month, opens: 0, readers: 0 }))
    for (const m of byMonth.results as { month: string; opens: number; readers: number }[]) {
      const slot = months.find((x) => x.month === m.month)
      if (slot) { slot.opens = m.opens; slot.readers = m.readers }
    }
    const t = totals.results[0] as { readers: number | null; this_month: number | null; last_month: number | null } | undefined
    return ok({
      months,
      holdings: (holdings.results as { id: string; title: string; kind: string; access_model: string; is_active: number; this_month: number; last_month: number; readers: number; total: number; last_at: string | null }[]).map((h) => ({
        id: h.id, title: h.title, kind: h.kind, access_model: h.access_model, is_active: bool(h.is_active),
        opens_this_month: h.this_month, opens_last_month: h.last_month, readers_this_month: h.readers, opens_total: h.total,
        ...(h.last_at ? { last_opened_at: h.last_at } : {}),
      })),
      active_readers: t?.readers ?? 0,
      opens_this_month: t?.this_month ?? 0,
      opens_last_month: t?.last_month ?? 0,
    })
  })

  /* GET /holdings/{id}/access: hands over the link once entitlement holds, and counts the open. */
  r.get('/ops/digital-library/holdings/{id}/access', READ, async (c) => {
    const holdingId = uuidParam(c.params.id)
    const h = await loadHolding(c, holdingId, false)
    if (!h) throw notFound('resource not found')
    // digitalEntitlement, in its order: withdrawn, not lent to me, provider seam.
    if (!h.is_active) throw notFound('resource not found')
    if (h.access_model === 'single_copy_loan' && !h.available_to_me) {
      throw coded(409, 'not_borrowed', 'this e-book is licensed one reader at a time and is not currently lent to you')
    }
    if (h.provider_id !== undefined) {
      if (h.provider_status !== 'live') {
        throw coded(503, 'provider_unavailable',
          'this title sits behind a subscription that is not connected on this deployment - ask the librarian for the institutional login')
      }
      // resolveDigitalProvider: Go builds no signed link for a 'live' provider
      // (none is ever live on that deployment); it returns nil and the holding
      // opens through its own external_url / file below, exactly as here.
    }

    const row = await c.db.prepare(`SELECT h.external_url, f.id AS file_id FROM digital_holdings h
        LEFT JOIN files f ON f.id = h.file_id AND f.deleted_at IS NULL WHERE h.id = ?`).bind(holdingId)
      .first<{ external_url: string | null; file_id: string | null }>()
    if (!row) throw notFound('resource not found')
    // logDigitalOpen: past the checks, so usage counts reads and not refusals.
    await c.db.prepare(`INSERT INTO digital_holding_opens (institution_id, holding_id, user_id, opened_at) VALUES (?, ?, ?, ?)`)
      .bind(instId(c), holdingId, c.id.userId, now()).run()
    if (row.external_url === null && row.file_id === null) {
      throw coded(409, 'no_copy', 'the uploaded copy of this title is no longer on file, tell the librarian')
    }
    const out: Record<string, unknown> = { holding_id: h.id, title: h.title }
    if (row.external_url !== null) out.url = row.external_url
    if (row.file_id !== null) out.file_id = row.file_id
    if (h.due_on !== undefined) out.due_on = h.due_on
    if (h.access_model === 'single_copy_loan') out.note = 'On loan to you until ' + (h.due_on ?? '-')
    return ok(out)
  })

  /* POST /holdings/{id}/borrow: an ordinary library_reservations hold on the shadow title. */
  r.post('/ops/digital-library/holdings/{id}/borrow', READ, async (c) => {
    const holdingId = uuidParam(c.params.id)
    const req = await readJSON<{ student_id?: string; employee_id?: string }>(c.req)
    const h = await loadHolding(c, holdingId, false)
    if (!h) throw notFound('resource not found')
    if (h.access_model !== 'single_copy_loan' || h.library_title_id === undefined) {
      throw badRequest('this title is not lent one reader at a time, open it directly')
    }
    const titleId = h.library_title_id

    let student: string | null = null
    let employee: string | null = null
    const sid = str(req.student_id), eid = str(req.employee_id)
    if (sid !== '' || eid !== '') {
      // Naming somebody else is the librarian's privilege.
      if (!has(c, WRITE)) throw forbidden('you can only borrow for yourself')
      ;({ student, employee } = readerOf(sid, eid))
    } else {
      const me = await c.db.prepare(`SELECT (SELECT s.id FROM students s WHERE s.user_id = ?) AS st,
                                            (SELECT e.id FROM employees e WHERE e.user_id = ?) AS emp`)
        .bind(c.id.userId, c.id.userId).first<{ st: string | null; emp: string | null }>()
      if (me?.st) student = me.st
      else if (me?.emp) employee = me.emp
      else throw badRequest("your account is not a reader on the library's register. Ask the librarian to borrow this for you")
    }

    /* One batch: the hold (ready if a copy is on the shelf, waiting otherwise),
       guarded by the one-live-hold-per-reader rule the Postgres partial index
       enforced; then the copy is marked reserved only if the hold came out
       ready; then the hold is read back. */
    const resId = uuid()
    const [, , back] = await c.db.batch([
      c.db.prepare(`INSERT INTO library_reservations
                      (id, institution_id, title_id, student_id, employee_id, placed_at, status, ready_copy_id, ready_at, collect_by, created_by)
                    SELECT ?, ?, ?, ?, ?, ?,
                           CASE WHEN c.id IS NULL THEN 'waiting' ELSE 'ready' END,
                           c.id,
                           CASE WHEN c.id IS NULL THEN NULL ELSE ? END,
                           CASE WHEN c.id IS NULL THEN NULL ELSE date('now', '+3 days') END,
                           ?
                      FROM (SELECT 1 AS one) o
                      LEFT JOIN (SELECT id FROM library_copies WHERE title_id = ? AND status = 'available'
                                  ORDER BY accession_no LIMIT 1) c ON 1
                     WHERE NOT EXISTS (SELECT 1 FROM library_reservations x
                                        WHERE x.title_id = ? AND x.status IN ('waiting', 'ready')
                                          AND COALESCE(x.student_id, ?) = ? AND COALESCE(x.employee_id, ?) = ?)`)
        .bind(resId, instId(c), titleId, student, employee, now(), now(), c.id.userId, titleId,
          titleId, NIL, student ?? NIL, NIL, employee ?? NIL),
      c.db.prepare(`UPDATE library_copies SET status = 'reserved' WHERE title_id = ? AND status = 'available'
                     AND EXISTS (SELECT 1 FROM library_reservations WHERE id = ? AND status = 'ready')`).bind(titleId, resId),
      c.db.prepare(`SELECT status FROM library_reservations WHERE id = ?`).bind(resId),
    ])
    const placed = back.results[0] as { status: string } | undefined
    if (!placed) throw coded(409, 'already_queued', 'you are already in the queue for this title')
    return ok({ status: placed.status })
  })

  /* GET /audiences: the class and role vocabulary for the visibility editor. */
  r.get('/ops/digital-library/audiences', WRITE, async (c) => {
    const [classes, roles] = await c.db.batch([
      c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`),
      c.db.prepare(`SELECT key AS id, name FROM roles WHERE institution_id = ? OR institution_id IS NULL ORDER BY name`).bind(instId(c)),
    ])
    return ok({ classes: classes.results, roles: roles.results })
  })

  /* POST /holdings: catalogue (insert when id is blank, update otherwise) and mint the shadow copy for a lendable e-book. */
  r.post('/ops/digital-library/holdings', WRITE, async (c) => {
    const inst = instId(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const title = str(req.title).trim()
    const externalUrl = str(req.external_url).trim()
    const fileId = str(req.file_id).trim()
    const kind = str(req.kind)
    const access = str(req.access_model)
    if (title === '') throw badRequest('give the title a name')
    if (!oneOf(kind, 'ebook', 'journal', 'database')) throw badRequest('kind must be ebook, journal or database')
    if (!oneOf(access, 'open', 'subscription', 'single_copy_loan')) throw badRequest('access must be open, subscription or single_copy_loan')
    if (kind === 'database' && access === 'single_copy_loan') throw badRequest('a database is a place you search, not a thing one reader can borrow')
    if ((externalUrl === '') === (fileId === '')) throw badRequest('give exactly one of external_url or file_id (upload the file first)')
    if (externalUrl !== '' && !externalUrl.startsWith('http://') && !externalUrl.startsWith('https://')) {
      throw badRequest('the link must start with http:// or https://')
    }
    const fileArg = optionalUUID(fileId, 'file_id')
    const providerArg = optionalUUID(str(req.provider_id), 'provider_id')
    const campusArg = optionalUUID(str(req.campus_id), 'campus_id')
    let loanDays = typeof req.loan_days === 'number' ? req.loan_days : 0
    if (loanDays === 0) loanDays = 14
    if (!Number.isInteger(loanDays) || loanDays < 1 || loanDays > 90) throw badRequest('a loan runs between 1 and 90 days')
    const tags: string[] = []
    for (const t of Array.isArray(req.subject_tags) ? req.subject_tags : []) {
      const v = str(t).trim()
      if (v !== '' && tags.length < 20) tags.push(v)
    }
    const active = typeof req.is_active === 'boolean' ? req.is_active : true
    const author = str(req.author), publisher = str(req.publisher), identifier = str(req.identifier)
    const language = str(req.language), description = str(req.description)
    const reqId = str(req.id).trim()

    let holdingId: string
    let existingTitleId: string | null = null
    if (reqId !== '') {
      if (!isUUID(reqId)) throw badRequest('id must be a uuid')
      const cur = await c.db.prepare(`SELECT library_title_id FROM digital_holdings WHERE id = ?`).bind(reqId)
        .first<{ library_title_id: string | null }>()
      if (!cur) throw notFound('resource not found')
      existingTitleId = cur.library_title_id
      holdingId = reqId
    } else {
      holdingId = uuid()
    }
    // digital_holdings_one_per_title, checked here because the expression index did not survive.
    const dup = await c.db.prepare(`SELECT 1 FROM digital_holdings WHERE COALESCE(campus_id, ?) = ? AND lower(trim(title)) = lower(?)
        AND kind = ? AND id <> ?`).bind(NIL, campusArg ?? NIL, title, kind, holdingId).first()
    if (dup) throw coded(409, 'duplicate_title', 'that title is already in the digital catalogue for this campus')

    const ts = now()
    const stmts: D1PreparedStatement[] = []
    if (reqId === '') {
      stmts.push(c.db.prepare(`INSERT INTO digital_holdings
          (id, institution_id, campus_id, kind, title, author, publisher, identifier, language, description, access_model,
           provider_id, external_url, file_id, subject_tags, loan_days, is_active, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(holdingId, inst, campusArg, kind, title, nullIfEmpty(author), nullIfEmpty(publisher), nullIfEmpty(identifier),
          nullIfEmpty(language), nullIfEmpty(description), access, providerArg, nullIfEmpty(externalUrl), fileArg,
          JSON.stringify(tags), loanDays, active ? 1 : 0, c.id.userId, ts, ts))
    } else {
      stmts.push(c.db.prepare(`UPDATE digital_holdings
           SET campus_id = ?, kind = ?, title = ?, author = ?, publisher = ?, identifier = ?, language = ?, description = ?,
               access_model = ?, provider_id = ?, external_url = ?, file_id = ?, subject_tags = ?, loan_days = ?, is_active = ?,
               updated_at = ?
         WHERE id = ?`)
        .bind(campusArg, kind, title, nullIfEmpty(author), nullIfEmpty(publisher), nullIfEmpty(identifier), nullIfEmpty(language),
          nullIfEmpty(description), access, providerArg, nullIfEmpty(externalUrl), fileArg, JSON.stringify(tags), loanDays,
          active ? 1 : 0, ts, holdingId))
    }
    if (access === 'single_copy_loan') {
      // ensureShadowCopy: idempotent; keeps the shadow's bibliography in step once it exists.
      if (existingTitleId !== null) {
        stmts.push(c.db.prepare(`UPDATE library_titles SET title = ?, author = ?, publisher = ? WHERE id = ?`)
          .bind(title, nullIfEmpty(author), nullIfEmpty(publisher), existingTitleId))
      } else {
        const titleId = uuid()
        const accession = 'DIG-' + titleId.replace(/-/g, '').slice(0, 10).toUpperCase()
        stmts.push(
          c.db.prepare(`INSERT INTO library_titles (id, institution_id, campus_id, title, author, publisher, category, language, created_at)
              SELECT ?, ?, COALESCE(?, (SELECT c.id FROM campuses c ORDER BY c.name LIMIT 1)), ?, ?, ?, 'digital', ?, ?`)
            .bind(titleId, inst, campusArg, title, nullIfEmpty(author), nullIfEmpty(publisher), nullIfEmpty(language), ts),
          c.db.prepare(`INSERT INTO library_copies (id, institution_id, title_id, accession_no, rack, status) VALUES (?, ?, ?, ?, 'digital', 'available')`)
            .bind(uuid(), inst, titleId, accession),
          c.db.prepare(`UPDATE digital_holdings SET library_title_id = ? WHERE id = ?`).bind(titleId, holdingId),
        )
      }
    }
    await c.db.batch(stmts)
    return ok({ id: holdingId })
  })

  /* DELETE /holdings/{id}: refused while the e-book is on loan; withdrawing is the alternative. */
  r.del('/ops/digital-library/holdings/{id}', WRITE, async (c) => {
    const holdingId = uuidParam(c.params.id)
    const lent = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM digital_holdings h
        JOIN library_copies c ON c.title_id = h.library_title_id
        JOIN library_loans l ON l.copy_id = c.id AND l.returned_on IS NULL WHERE h.id = ?) AS lent`).bind(holdingId).first<{ lent: number }>()
    if (lent?.lent) throw badRequest('that e-book is on loan. Take it back first, or withdraw it instead')
    // ON DELETE CASCADE on visibility and opens is declared in the D1 schema; the shadow title is left, as in Go.
    const res = await c.db.prepare(`DELETE FROM digital_holdings WHERE id = ?`).bind(holdingId).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ deleted: true })
  })

  /* PUT /holdings/{id}/visibility: replaces the rules; both lists empty means everyone. */
  r.put('/ops/digital-library/holdings/{id}/visibility', WRITE, async (c) => {
    const holdingId = uuidParam(c.params.id)
    const req = await readJSON<{ class_ids?: unknown; role_keys?: unknown }>(c.req)
    const classes: string[] = []
    for (const x of Array.isArray(req.class_ids) ? req.class_ids : []) {
      const v = str(x).trim()
      if (!isUUID(v)) throw badRequest('class_ids must be uuids')
      if (!classes.includes(v)) classes.push(v)
    }
    const roles: string[] = []
    for (const x of Array.isArray(req.role_keys) ? req.role_keys : []) {
      const v = str(x).trim()
      if (v !== '' && !roles.includes(v)) roles.push(v)
    }
    const exists = await c.db.prepare(`SELECT 1 FROM digital_holdings WHERE id = ?`).bind(holdingId).first()
    if (!exists) throw notFound('resource not found')
    const inst = instId(c)
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`DELETE FROM digital_holding_visibility WHERE holding_id = ?`).bind(holdingId),
      ...classes.map((id) => c.db.prepare(`INSERT INTO digital_holding_visibility (id, holding_id, class_id)
          SELECT ?, ?, c.id FROM classes c WHERE c.id = ?`).bind(uuid(), holdingId, id)),
      ...roles.map((key) => c.db.prepare(`INSERT INTO digital_holding_visibility (id, holding_id, role_key)
          SELECT ?, ?, ro.key FROM roles ro WHERE ro.key = ? AND (ro.institution_id = ? OR ro.institution_id IS NULL) LIMIT 1`)
        .bind(uuid(), holdingId, key, inst)),
    ]
    await c.db.batch(stmts)
    return ok({ saved: true })
  })

  /* GET /providers */
  r.get('/ops/digital-library/providers', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT p.id, p.kind, p.name, p.base_url, p.has_credentials, p.status, p.notes,
        (SELECT COUNT(*) FROM digital_holdings h WHERE h.provider_id = p.id) AS holdings
        FROM digital_library_providers p ORDER BY p.name`)
      .all<{ id: string; kind: string; name: string; base_url: string | null; has_credentials: number; status: string; notes: string | null; holdings: number }>()
    return ok(rows.results.map((p) => ({
      id: p.id, kind: p.kind, name: p.name, ...(p.base_url !== null ? { base_url: p.base_url } : {}),
      has_credentials: bool(p.has_credentials), status: p.status, ...(p.notes !== null ? { notes: p.notes } : {}), holdings: p.holdings,
    })))
  })

  /* POST /providers: records a subscription; never a password, never a status. */
  r.post('/ops/digital-library/providers', WRITE, async (c) => {
    const inst = instId(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name).trim()
    const baseUrl = str(req.base_url).trim()
    const kind = str(req.kind)
    const notes = str(req.notes)
    const hasCreds = req.has_credentials === true
    if (name === '') throw badRequest('give the provider a name')
    if (!oneOf(kind, 'ebsco', 'jstor', 'proquest', 'other')) throw badRequest('provider must be ebsco, jstor, proquest or other')
    if (baseUrl !== '' && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw badRequest('the base URL must start with http:// or https://')
    }
    const reqId = str(req.id).trim()
    let out: string
    if (reqId === '') out = uuid()
    else {
      if (!isUUID(reqId)) throw badRequest('id must be a uuid')
      const cur = await c.db.prepare(`SELECT 1 FROM digital_library_providers WHERE id = ?`).bind(reqId).first()
      if (!cur) throw notFound('resource not found')
      out = reqId
    }
    // digital_library_providers_one_per_kind (institution, kind, lower(btrim(name))).
    const dup = await c.db.prepare(`SELECT 1 FROM digital_library_providers WHERE kind = ? AND lower(trim(name)) = lower(?) AND id <> ?`)
      .bind(kind, name, out).first()
    if (dup) throw coded(409, 'duplicate_provider', 'that provider is already recorded')
    const ts = now()
    if (reqId === '') {
      await c.db.prepare(`INSERT INTO digital_library_providers (id, institution_id, kind, name, base_url, has_credentials, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).bind(out, inst, kind, name, nullIfEmpty(baseUrl), hasCreds ? 1 : 0, nullIfEmpty(notes), ts, ts).run()
    } else {
      await c.db.prepare(`UPDATE digital_library_providers SET kind = ?, name = ?, base_url = ?, has_credentials = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .bind(kind, name, nullIfEmpty(baseUrl), hasCreds ? 1 : 0, nullIfEmpty(notes), ts, out).run()
    }
    return ok({ id: out, status: 'unavailable' })
  })

  /* DELETE /providers/{id}: holdings survive with provider_id set NULL (FK ON DELETE SET NULL). */
  r.del('/ops/digital-library/providers/{id}', WRITE, async (c) => {
    const providerId = uuidParam(c.params.id)
    const res = await c.db.prepare(`DELETE FROM digital_library_providers WHERE id = ?`).bind(providerId).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ deleted: true })
  })
}
