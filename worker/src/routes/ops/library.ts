import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid, uuidParam, like } from '../../http'
import { instId } from './common'

/* Port of the physical library under /ops: the catalogue and circulation
   (mod_ops.go), the loan register (role_backoffice.go), holds, the stock
   audit and the textbook indent (library_desk.go), and fines
   (library_fines.go).

   Postgres enforced two partial unique indexes (migration 00020) that SQLite
   here does not carry: one live hold per reader per title, and one open
   audit per campus. Both are checked in the handler before the write. */

const today = () => now().slice(0, 10)
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
const conflict = (code: string, message: string) => new HttpError(409, message, { code })

type Row = Record<string, unknown>
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v))
const num = (v: unknown) => Number(v ?? 0)

// concat_ws(' ', a, b) with the NULLs dropped, or NULL when nothing is there.
const fullName = (...cols: string[]) =>
  `NULLIF(TRIM(${cols.map((c) => `COALESCE(${c},'')`).join(" || ' ' || ")}), '')`

/* promoteNextHold, as the statements the caller adds to its batch: the freed
   copy goes to whoever has waited longest for its title, and the copy is
   'reserved' if somebody was waiting, 'available' if not. */
function promoteNextHold(c: Ctx, copyId: string): D1PreparedStatement[] {
  const ts = now()
  return [
    c.db.prepare(`UPDATE library_reservations
        SET status = 'ready', ready_copy_id = ?, ready_at = ?, collect_by = ?
      WHERE id = (SELECT res.id FROM library_reservations res
                    JOIN library_copies cp ON cp.id = ?
                   WHERE res.title_id = cp.title_id AND res.status = 'waiting'
                   ORDER BY res.placed_at LIMIT 1)`).bind(copyId, ts, plusDays(3), copyId),
    c.db.prepare(`UPDATE library_copies
        SET status = CASE WHEN EXISTS (SELECT 1 FROM library_reservations r WHERE r.ready_copy_id = ? AND r.status = 'ready')
                          THEN 'reserved' ELSE 'available' END
      WHERE id = ? AND status <> 'issued'`).bind(copyId, copyId),
  ]
}

/* The working year: ?academic_year_id if given (and checked), else the
   caller's chosen year, else the school's current or latest year. */
async function workingYear(c: Ctx): Promise<string | null> {
  const explicit = (c.url.searchParams.get('academic_year_id') ?? '').trim()
  if (explicit) {
    if (!isUUID(explicit)) throw badRequest('academic_year_id names no academic year of this school')
    const y = await c.db.prepare('SELECT id FROM academic_years WHERE id = ?').bind(explicit).first<{ id: string }>()
    if (!y) throw badRequest('academic_year_id names no academic year of this school')
    return y.id
  }
  const mine = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (mine) return mine.id
  const latest = await c.db.prepare('SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1').first<{ id: string }>()
  return latest?.id ?? null
}

export function registerLibrary(r: Router): void {
  // --- catalogue ------------------------------------------------------------

  r.get('/ops/library/titles', 'operations.library.read', async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim()
    const args: unknown[] = []
    let cond = ''
    if (q) {
      cond = `WHERE (t.title LIKE ? ESCAPE '\\' OR COALESCE(t.author,'') LIKE ? ESCAPE '\\' OR COALESCE(t.isbn,'') LIKE ? ESCAPE '\\')`
      args.push(like(q), like(q), like(q))
    }
    const rows = await c.db.prepare(`
      SELECT t.id, t.title, t.author, t.isbn, t.category,
             COUNT(cp.id) AS copies,
             SUM(CASE WHEN cp.id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM library_loans l WHERE l.copy_id = cp.id AND l.returned_on IS NULL) THEN 1 ELSE 0 END) AS available
        FROM library_titles t
        LEFT JOIN library_copies cp ON cp.title_id = t.id
        ${cond}
       GROUP BY t.id, t.title, t.author, t.isbn, t.category
       ORDER BY t.title LIMIT 300`).bind(...args).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, title: v.title, author: str(v.author), isbn: str(v.isbn), category: str(v.category),
      copies: num(v.copies), available: num(v.available) })) })
  })

  r.get('/ops/library/titles/{id}/copies', 'operations.library.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid title id')
    const rows = await c.db.prepare(`
      SELECT cp.id, cp.accession_no, cp.barcode, cp.rack,
             COALESCE(${fullName('st.first_name', 'st.last_name')}, ${fullName('e.first_name', 'e.last_name')}) AS on_loan_to,
             substr(l.due_on, 1, 10) AS due_on, cp.status,
             ${fullName('hs.first_name', 'hs.last_name')} AS held_for
        FROM library_copies cp
        LEFT JOIN library_loans l ON l.copy_id = cp.id AND l.returned_on IS NULL
        LEFT JOIN students st ON st.id = l.student_id
        LEFT JOIN employees e ON e.id = l.employee_id
        LEFT JOIN library_reservations res ON res.ready_copy_id = cp.id AND res.status = 'ready'
        LEFT JOIN students hs ON hs.id = res.student_id
       WHERE cp.title_id = ?
       ORDER BY cp.accession_no`).bind(c.params.id).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, accession_no: v.accession_no, barcode: str(v.barcode), rack: str(v.rack),
      on_loan_to: str(v.on_loan_to), due_on: str(v.due_on), status: v.status, held_for: str(v.held_for) })) })
  })

  // --- circulation ----------------------------------------------------------

  r.post('/ops/library/issue', 'operations.library.write', async (c) => {
    const req = await readJSON<{ copy_id?: string; student_id?: string; due_in_days?: number }>(c.req)
    if (!isUUID(req.copy_id)) throw badRequest('copy_id must be a uuid')
    const copyId = req.copy_id
    const studentId = req.student_id ?? ''
    let dueInDays = Number(req.due_in_days ?? 0)
    if (!Number.isInteger(dueInDays) || dueInDays <= 0) dueInDays = 14

    const out = await c.db.prepare('SELECT 1 AS x FROM library_loans WHERE copy_id = ? AND returned_on IS NULL LIMIT 1').bind(copyId).first()
    if (out) throw conflict('already_issued', 'that copy is already on loan')
    // A copy held for somebody goes to that somebody.
    const held = await c.db.prepare(`SELECT student_id FROM library_reservations WHERE ready_copy_id = ? AND status = 'ready' LIMIT 1`)
      .bind(copyId).first<{ student_id: string | null }>()
    if (held && held.student_id !== null && held.student_id !== studentId) {
      throw conflict('held_for_another', 'that copy is behind the counter for a reader who reserved it. Issue a different copy')
    }
    const d = today()
    await c.db.batch([
      c.db.prepare(`INSERT INTO library_loans (id, institution_id, copy_id, student_id, issued_on, due_on, issued_by)
                    VALUES (?,?,?,?,?,?,?)`).bind(uuid(), instId(c), copyId, studentId || null, d, plusDays(dueInDays), c.id.userId),
      // Issuing closes the hold it satisfies, and the copy is on loan now.
      c.db.prepare(`UPDATE library_reservations SET status = 'collected' WHERE ready_copy_id = ? AND status = 'ready'`).bind(copyId),
      c.db.prepare(`UPDATE library_copies SET status = 'issued' WHERE id = ?`).bind(copyId),
    ])
    return created({ issued: true, due_in_days: dueInDays })
  })

  r.get('/ops/library/loans', 'operations.library.read', async (c) => {
    const openOnly = c.url.searchParams.get('open') === 'true'
    const rows = await c.db.prepare(`
      SELECT l.id, t.title,
             COALESCE(${fullName('st.first_name', 'st.last_name')}, ${fullName('e.first_name', 'e.last_name')}, '-') AS borrower,
             substr(l.issued_on, 1, 10) AS issued_on, substr(l.due_on, 1, 10) AS due_on,
             substr(l.returned_on, 1, 10) AS returned_on, l.fine_paise,
             (l.returned_on IS NULL AND l.due_on < ?) AS overdue
        FROM library_loans l
        JOIN library_copies cp ON cp.id = l.copy_id
        JOIN library_titles t ON t.id = cp.title_id
        LEFT JOIN students st ON st.id = l.student_id
        LEFT JOIN employees e ON e.id = l.employee_id
       ${openOnly ? 'WHERE l.returned_on IS NULL' : ''}
       ORDER BY l.issued_on DESC LIMIT 300`).bind(today()).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, title: v.title, borrower: v.borrower, issued_on: v.issued_on, due_on: v.due_on,
      returned_on: str(v.returned_on), fine_paise: num(v.fine_paise), overdue: bool(v.overdue) })) })
  })

  // --- fines (mountLibraryFines) -------------------------------------------

  const fineRowSelect = (paid: 0 | 1) => `SELECT l.id AS loan_id,
             COALESCE(${fullName('st.first_name', 'st.middle_name', 'st.last_name')}, ${fullName('e.first_name', 'e.last_name')}, 'Unknown') AS borrower,
             t.title, cp.accession_no,
             substr(l.due_on, 1, 10) AS due_on, substr(l.returned_on, 1, 10) AS returned_on, l.fine_paise
        FROM library_loans l
        JOIN library_copies cp ON cp.id = l.copy_id
        JOIN library_titles t ON t.id = cp.title_id
        LEFT JOIN students st ON st.id = l.student_id
        LEFT JOIN employees e ON e.id = l.employee_id
       WHERE l.fine_paise > 0 AND l.fine_paid = ${paid}
       ORDER BY l.returned_on, l.due_on LIMIT 500`
  const fineRow = (v: Row) => ({
    loan_id: v.loan_id, borrower: v.borrower, title: v.title, accession_no: v.accession_no,
    due_on: v.due_on, returned_on: str(v.returned_on), fine_paise: num(v.fine_paise) })

  r.get('/ops/library/fines/summary', 'operations.library.read', async (c) => {
    const [tot, outstanding, collected] = await c.db.batch([
      c.db.prepare(`SELECT COALESCE(SUM(CASE WHEN fine_paid = 1 THEN fine_paise ELSE 0 END), 0) AS collected_paise,
                           SUM(CASE WHEN fine_paid = 1 AND fine_paise > 0 THEN 1 ELSE 0 END) AS collected_count,
                           COALESCE(SUM(CASE WHEN fine_paid = 0 THEN fine_paise ELSE 0 END), 0) AS outstanding_paise,
                           SUM(CASE WHEN fine_paid = 0 AND fine_paise > 0 THEN 1 ELSE 0 END) AS outstanding_count,
                           SUM(CASE WHEN returned_on IS NULL AND due_on < ? THEN 1 ELSE 0 END) AS overdue_open
                      FROM library_loans`).bind(today()),
      c.db.prepare(fineRowSelect(0)),
      c.db.prepare(fineRowSelect(1)),
    ])
    const t = (tot.results as Row[])[0] ?? {}
    return ok({
      collected_paise: num(t.collected_paise), collected_count: num(t.collected_count),
      outstanding_paise: num(t.outstanding_paise), outstanding_count: num(t.outstanding_count),
      overdue_open_loans: num(t.overdue_open),
      outstanding: (outstanding.results as Row[]).map(fineRow),
      collected: (collected.results as Row[]).map(fineRow),
    })
  })

  r.post('/ops/library/loans/{id}/fine/collect', 'operations.library.write', async (c) => {
    const loanId = uuidParam(c.params.id)
    const loan = await c.db.prepare('SELECT fine_paise FROM library_loans WHERE id = ? AND fine_paise > 0 AND fine_paid = 0')
      .bind(loanId).first<{ fine_paise: number }>()
    if (!loan) throw conflict('nothing_to_collect', 'no unpaid fine on that loan')
    await c.db.prepare('UPDATE library_loans SET fine_paid = 1 WHERE id = ? AND fine_paise > 0 AND fine_paid = 0').bind(loanId).run()
    return ok({ collected_paise: num(loan.fine_paise) })
  })

  r.post('/ops/library/loans/{id}/return', 'operations.library.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid loan id')
    const loanId = c.params.id
    let finePerDay = 100 // Rs 1/day is the common default
    // Go read the body only when ContentLength > 0; an empty body keeps the default.
    const raw = (await c.req.text()).trim()
    if (raw) {
      let req: { fine_per_day_paise?: number }
      try { req = JSON.parse(raw) } catch { throw badRequest('malformed JSON body') }
      const v = Number(req?.fine_per_day_paise ?? 0)
      if (Number.isFinite(v) && v > 0) finePerDay = Math.trunc(v)
    }
    const loan = await c.db.prepare('SELECT copy_id, due_on FROM library_loans WHERE id = ? AND returned_on IS NULL')
      .bind(loanId).first<{ copy_id: string; due_on: string }>()
    if (!loan) throw new HttpError(404, 'no open loan with that id', { code: 'not_found' })
    const d = today()
    const lateDays = Math.max(0, Math.round((Date.parse(d) - Date.parse(loan.due_on.slice(0, 10))) / 86_400_000))
    const fine = lateDays * finePerDay
    const results = await c.db.batch([
      c.db.prepare('UPDATE library_loans SET returned_on = ?, fine_paise = ? WHERE id = ? AND returned_on IS NULL').bind(d, fine, loanId),
      c.db.prepare(`UPDATE library_copies SET status = 'available' WHERE id = ?`).bind(loan.copy_id),
      // The next reader is promoted inside the return, not in a nightly job.
      ...promoteNextHold(c, loan.copy_id),
      c.db.prepare(`SELECT EXISTS (SELECT 1 FROM library_reservations WHERE ready_copy_id = ? AND status = 'ready') AS promoted`).bind(loan.copy_id),
    ])
    const last = (results[results.length - 1].results as { promoted: number }[])[0]
    return ok({ returned: true, fine_paise: fine, held_for_next_reader: bool(last?.promoted) })
  })

  // --- holds ----------------------------------------------------------------

  r.get('/ops/library/reservations', 'operations.library.read', async (c) => {
    const status = c.url.searchParams.get('status') || null
    const rows = await c.db.prepare(`
      SELECT res.id, res.title_id, t.title, t.author,
             COALESCE(${fullName('st.first_name', 'st.last_name')}, ${fullName('e.first_name', 'e.last_name')}, 'Unknown reader') AS reader,
             CASE WHEN res.student_id IS NOT NULL THEN 'student' ELSE 'staff' END AS reader_kind,
             substr(res.placed_at, 1, 16) AS placed_at, res.status,
             CASE WHEN res.status = 'waiting' THEN (
                 SELECT COUNT(*) + 1 FROM library_reservations q
                  WHERE q.title_id = res.title_id AND q.status = 'waiting' AND q.placed_at < res.placed_at)
             ELSE 0 END AS position,
             cp.accession_no, substr(res.collect_by, 1, 10) AS collect_by,
             (res.status = 'ready' AND res.collect_by < ?) AS expired,
             (SELECT COUNT(*) FROM library_copies lc WHERE lc.title_id = res.title_id AND lc.status = 'available') AS on_shelf
        FROM library_reservations res
        JOIN library_titles t ON t.id = res.title_id
        LEFT JOIN students st ON st.id = res.student_id
        LEFT JOIN employees e ON e.id = res.employee_id
        LEFT JOIN library_copies cp ON cp.id = res.ready_copy_id
       WHERE (? IS NULL OR res.status = ?)
       ORDER BY (res.status = 'ready') DESC, res.placed_at LIMIT 300`).bind(today(), status, status).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, title_id: v.title_id, title: v.title, author: str(v.author), reader: v.reader, reader_kind: v.reader_kind,
      placed_at: v.placed_at, status: v.status, position: num(v.position), ready_accession_no: str(v.accession_no),
      collect_by: str(v.collect_by), past_collection_date: bool(v.expired), copies_on_shelf: num(v.on_shelf) })) })
  })

  r.post('/ops/library/reservations', 'operations.library.write', async (c) => {
    const req = await readJSON<{ title_id?: string; student_id?: string; employee_id?: string }>(c.req)
    if (!isUUID(req.title_id)) throw badRequest('title_id must be a uuid')
    // readerOf: exactly one of the two, and each must parse.
    const badReader = 'name exactly one reader: student_id or employee_id'
    const student = req.student_id ? (isUUID(req.student_id) ? req.student_id : (() => { throw badRequest(badReader) })()) : null
    const employee = req.employee_id ? (isUUID(req.employee_id) ? req.employee_id : (() => { throw badRequest(badReader) })()) : null
    if ((student === null) === (employee === null)) throw badRequest(badReader)

    // library_reservations_one_per_reader, checked here.
    const dup = await c.db.prepare(`SELECT 1 AS x FROM library_reservations
        WHERE title_id = ? AND COALESCE(student_id,'') = ? AND COALESCE(employee_id,'') = ? AND status IN ('waiting','ready') LIMIT 1`)
      .bind(req.title_id, student ?? '', employee ?? '').first()
    if (dup) throw conflict('already_queued', 'this reader is already in the queue for that title')

    const free = await c.db.prepare(`SELECT id FROM library_copies WHERE title_id = ? AND status = 'available' ORDER BY accession_no LIMIT 1`)
      .bind(req.title_id).first<{ id: string }>()
    const id = uuid()
    const ts = now()
    const status = free ? 'ready' : 'waiting'
    const stmts: D1PreparedStatement[] = []
    // The copy moves to 'reserved' so the next hold looks elsewhere and the counter cannot issue it to a walk-in.
    if (free) stmts.push(c.db.prepare(`UPDATE library_copies SET status = 'reserved' WHERE id = ?`).bind(free.id))
    stmts.push(c.db.prepare(`INSERT INTO library_reservations
        (id, institution_id, title_id, student_id, employee_id, created_by, placed_at, status, ready_copy_id, ready_at, collect_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), req.title_id, student, employee, c.id.userId, ts, status,
        free?.id ?? null, free ? ts : null, free ? plusDays(3) : null))
    await c.db.batch(stmts)
    return created({ id, status })
  })

  r.post('/ops/library/reservations/{id}/decide', 'operations.library.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid reservation id')
    const resId = c.params.id
    const req = await readJSON<{ action?: string; reason?: string }>(c.req)
    const action = req.action ?? ''
    const reason = (req.reason ?? '').trim()
    if (!['collect', 'cancel', 'expire'].includes(action)) throw badRequest('action must be collect, cancel or expire')

    const cur = await c.db.prepare('SELECT status, ready_copy_id FROM library_reservations WHERE id = ?')
      .bind(resId).first<{ status: string; ready_copy_id: string | null }>()
    const allowed = action === 'cancel' ? ['waiting', 'ready'] : ['ready']
    if (!cur || !allowed.includes(cur.status)) throw conflict('wrong_state', 'that hold is not in a state where this action makes sense')

    let upd: D1PreparedStatement
    if (action === 'collect') {
      // The counter issues the book separately; this closes the hold.
      upd = c.db.prepare(`UPDATE library_reservations SET status = 'collected' WHERE id = ? AND status = 'ready'`).bind(resId)
    } else if (action === 'cancel') {
      upd = c.db.prepare(`UPDATE library_reservations SET status = 'cancelled', cancelled_reason = ?, ready_copy_id = NULL
                          WHERE id = ? AND status IN ('waiting','ready')`).bind(reason || null, resId)
    } else {
      upd = c.db.prepare(`UPDATE library_reservations SET status = 'expired', cancelled_reason = ?, ready_copy_id = NULL
                          WHERE id = ? AND status = 'ready'`).bind(reason || 'Not collected in time', resId)
    }
    const stmts = [upd]
    // Cancelling or expiring a ready hold puts that copy back in play for whoever is next.
    if (action !== 'collect' && cur.ready_copy_id) {
      stmts.push(c.db.prepare(`UPDATE library_copies SET status = 'available' WHERE id = ? AND status = 'reserved'`).bind(cur.ready_copy_id))
      stmts.push(...promoteNextHold(c, cur.ready_copy_id))
    }
    await c.db.batch(stmts)
    return ok({ id: resId, action })
  })

  // --- stock audit ----------------------------------------------------------

  r.get('/ops/library/audits', 'operations.library.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT a.id, a.name, substr(a.opened_on, 1, 10) AS opened_on, substr(a.closed_on, 1, 10) AS closed_on, a.remarks,
             (SELECT COUNT(*) FROM library_copies c WHERE c.status <> 'issued') AS expected,
             (SELECT COUNT(*) FROM library_copies c WHERE c.status = 'issued') AS on_loan,
             (SELECT COUNT(*) FROM library_copies c WHERE EXISTS (SELECT 1 FROM library_audit_scans s2 WHERE s2.audit_id = a.id AND s2.copy_id = c.id)) AS scanned,
             (SELECT COUNT(*) FROM library_copies c WHERE c.status <> 'issued'
                 AND NOT EXISTS (SELECT 1 FROM library_audit_scans s2 WHERE s2.audit_id = a.id AND s2.copy_id = c.id)) AS missing,
             (SELECT COUNT(*) FROM library_copies c WHERE c.status = 'issued'
                 AND EXISTS (SELECT 1 FROM library_audit_scans s2 WHERE s2.audit_id = a.id AND s2.copy_id = c.id)) AS found_on_loan
        FROM library_stock_audits a
       ORDER BY a.opened_on DESC LIMIT 50`).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, name: v.name, opened_on: v.opened_on, closed_on: str(v.closed_on), remarks: str(v.remarks),
      copies_expected: num(v.expected), copies_scanned: num(v.scanned), copies_missing: num(v.missing),
      copies_on_loan: num(v.on_loan), copies_found_on_loan: num(v.found_on_loan) })) })
  })

  r.post('/ops/library/audits', 'operations.library.write', async (c) => {
    const req = await readJSON<{ name?: string; remarks?: string; close?: boolean; id?: string }>(c.req)
    if (req.close) {
      if (!(req.remarks ?? '').trim()) throw badRequest('say what the audit found. An audit that ends with missing books and no note is not an audit')
      if (!isUUID(req.id)) throw badRequest('id must be a uuid to close an audit')
      const res = await c.db.prepare('UPDATE library_stock_audits SET closed_on = ?, remarks = ? WHERE id = ? AND closed_on IS NULL')
        .bind(today(), req.remarks, req.id).run()
      if (!res.meta.changes) throw conflict('already_closed', 'that audit is already closed')
      return ok({ closed: true })
    }
    // library_stock_audits_one_open (campus_id is never set here, so the key is the institution).
    const open = await c.db.prepare('SELECT 1 AS x FROM library_stock_audits WHERE closed_on IS NULL AND campus_id IS NULL LIMIT 1').first()
    if (open) throw conflict('audit_open', 'an audit is already open; close it before starting another, or two people scanning will each conclude half the shelf is missing')
    const d = today()
    const dd = new Date(d)
    const pretty = `${d.slice(8, 10)} ${dd.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${d.slice(0, 4)}`
    const id = uuid()
    await c.db.prepare('INSERT INTO library_stock_audits (id, institution_id, name, opened_on, opened_by) VALUES (?,?,?,?,?)')
      .bind(id, instId(c), (req.name ?? '').trim() || `Stock audit ${pretty}`, d, c.id.userId).run()
    return created({ id })
  })

  r.post('/ops/library/audits/{id}/scan', 'operations.library.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid audit id')
    const auditId = c.params.id
    const req = await readJSON<{ code?: string; found_rack?: string }>(c.req)
    const code = (req.code ?? '').trim()
    if (!code) throw badRequest('scan or type an accession number')
    const foundRack = req.found_rack ?? ''
    const cp = await c.db.prepare(`SELECT c.id, t.title, c.accession_no, c.status, c.rack
        FROM library_copies c JOIN library_titles t ON t.id = c.title_id
       WHERE c.accession_no = ? OR c.barcode = ? LIMIT 1`).bind(code, code)
      .first<{ id: string; title: string; accession_no: string; status: string; rack: string | null }>()
    if (!cp) throw new HttpError(404, `no copy with accession number ${code}`, { code: 'unknown_copy' })
    const audit = await c.db.prepare('SELECT 1 AS x FROM library_stock_audits WHERE id = ?').bind(auditId).first()
    if (!audit) throw notFound('audit not found')
    // Scanning the same book twice is a person double-checking, not an error.
    await c.db.prepare(`INSERT INTO library_audit_scans (audit_id, copy_id, scanned_at, scanned_by, found_rack) VALUES (?,?,?,?,?)
        ON CONFLICT (audit_id, copy_id) DO UPDATE SET scanned_at = excluded.scanned_at, found_rack = excluded.found_rack`)
      .bind(auditId, cp.id, now(), c.id.userId, foundRack || null).run()
    return ok({
      title: cp.title, accession_no: cp.accession_no, status: cp.status, register_rack: cp.rack,
      misshelved: cp.rack !== null && foundRack !== '' && cp.rack !== foundRack,
    })
  })

  r.get('/ops/library/audits/{id}/missing', 'operations.library.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid audit id')
    const rows = await c.db.prepare(`
      SELECT c.id AS copy_id, c.accession_no, t.title, t.author, c.rack, c.status
        FROM library_copies c JOIN library_titles t ON t.id = c.title_id
       WHERE c.status <> 'issued'
         AND NOT EXISTS (SELECT 1 FROM library_audit_scans s2 WHERE s2.audit_id = ? AND s2.copy_id = c.id)
       ORDER BY c.accession_no LIMIT 500`).bind(c.params.id).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      copy_id: v.copy_id, accession_no: v.accession_no, title: v.title, author: str(v.author), rack: str(v.rack), status: v.status })) })
  })

  // --- textbook indent ------------------------------------------------------

  r.get('/ops/library/indents', 'operations.library.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT ti.id, ti.class_id, cl.name AS class_name, sub.name AS subject, ti.title, ti.publisher,
             ti.qty_requested, ti.qty_received, ti.qty_issued, ti.unit_price_paise, ti.indent_no,
             (SELECT COUNT(*) FROM enrollments en JOIN sections sec ON sec.id = en.section_id
               WHERE sec.class_id = ti.class_id AND en.status = 'active') AS roll
        FROM textbook_indents ti
        JOIN classes cl ON cl.id = ti.class_id
        LEFT JOIN subjects sub ON sub.id = ti.subject_id
       ORDER BY cl.name, ti.title LIMIT 400`).all<Row>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, class_id: v.class_id, class_name: v.class_name, subject: str(v.subject), title: v.title, publisher: v.publisher,
      qty_requested: num(v.qty_requested), qty_received: num(v.qty_received), qty_issued: num(v.qty_issued),
      unit_price_paise: v.unit_price_paise === null ? undefined : num(v.unit_price_paise), indent_no: str(v.indent_no),
      class_roll: num(v.roll), shortfall: Math.max(0, num(v.roll) - num(v.qty_received)) })) })
  })

  r.post('/ops/library/indents', 'operations.library.write', async (c) => {
    const req = await readJSON<{ id?: string; class_id?: string; subject_id?: string; title?: string; publisher?: string
      qty_requested?: number; qty_received?: number | null; qty_issued?: number | null; unit_price_paise?: number | null; indent_no?: string }>(c.req)
    const ts = now()
    const issuedWithinReceived = 'you cannot issue more books than you received'

    // The common case: touching the received or issued count on an existing line.
    if (req.id) {
      if (!isUUID(req.id)) throw badRequest('id must be a uuid')
      const cur = await c.db.prepare('SELECT qty_received, qty_issued FROM textbook_indents WHERE id = ?').bind(req.id)
        .first<{ qty_received: number; qty_issued: number }>()
      if (cur) {
        const received = req.qty_received ?? cur.qty_received
        const issued = req.qty_issued ?? cur.qty_issued
        if (received < 0 || issued < 0) throw badRequest('quantities must not be negative')
        if (issued > received) throw badRequest(issuedWithinReceived) // textbook_indents_issued_within_received
        await c.db.prepare(`UPDATE textbook_indents SET qty_received = ?, qty_issued = ?, indent_no = COALESCE(NULLIF(?,''), indent_no), updated_at = ?
                            WHERE id = ?`).bind(received, issued, req.indent_no ?? '', ts, req.id).run()
      }
      return ok({ id: req.id })
    }

    if (!isUUID(req.class_id)) throw badRequest('class_id must be a uuid')
    const requested = Number(req.qty_requested ?? 0)
    if (!(req.title ?? '').trim() || !(requested > 0)) throw badRequest('a line needs a book and a quantity')
    if (req.subject_id && !isUUID(req.subject_id)) throw badRequest('subject_id must be a uuid')
    const publisher = req.publisher || 'NCERT'
    // Raised in February for June: the year is the one the librarian is working in.
    const year = await workingYear(c)
    const id = uuid()
    await c.db.prepare(`INSERT INTO textbook_indents
        (id, institution_id, academic_year_id, class_id, subject_id, title, publisher, qty_requested, unit_price_paise, indent_no, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), year, req.class_id, req.subject_id || null, req.title, publisher, requested,
        req.unit_price_paise ?? null, req.indent_no || null, ts, ts).run()
    return created({ id })
  })
}
