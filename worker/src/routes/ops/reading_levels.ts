import type { Router } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { instId } from './common'

/* Reading levels: a title has one, a child has one measured on a date, and
   the librarian matches the two.

   The level is a short free label the school chooses: Lexile bands ("600L"),
   a colour band ("Orange"), a grade ("Class 3"). The product does not grade
   anybody; it keeps what the teacher measured and shows who has a level,
   who is overdue for one, and which titles sit at each level. */

const READ = 'operations.library.read', WRITE = 'operations.library.write'
type Row = Record<string, unknown>
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const cleanLevel = (v: unknown): string => {
  const l = s(v).trim()
  if (l === '' || l.length > 40) throw badRequest('level is a short label of up to 40 characters, such as 600L, Orange or Class 3')
  return l
}

export function registerReadingLevels(r: Router): void {
  /* Everything on one answer: each child's latest level, the titles by
     level, and the counts the librarian reads first. ?section_id narrows the
     children. */
  r.get('/ops/library/reading-levels', READ, async (c) => {
    const inst = instId(c)
    const section = (c.url.searchParams.get('section_id') ?? '').trim()
    if (section && !isUUID(section)) throw badRequest('section_id must be a uuid')
    const students = await c.db.prepare(`
      SELECT st.id AS student_id, TRIM(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')) AS student_name, st.admission_no,
             c.name AS class_name, sec.name AS section_name, sec.id AS section_id,
             rl.level, rl.measured_on, rl.note,
             (SELECT COUNT(*) FROM library_loans lo JOIN library_copies cp ON cp.id = lo.copy_id WHERE lo.student_id = st.id AND lo.returned_on IS NOT NULL) AS books_read
        FROM students st
        JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
        JOIN academic_years ay ON ay.id = en.academic_year_id AND ay.is_current = 1
        JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN student_reading_levels rl ON rl.id = (SELECT x.id FROM student_reading_levels x WHERE x.student_id = st.id ORDER BY x.measured_on DESC, x.created_at DESC LIMIT 1)
       WHERE st.status = 'active' AND (? = '' OR sec.id = ?)
       ORDER BY c.level, c.name, sec.name, st.admission_no`).bind(section, section).all<Row>()
    const titles = await c.db.prepare(`
      SELECT reading_level AS level, COUNT(*) AS titles FROM library_titles WHERE institution_id = ? AND reading_level IS NOT NULL AND reading_level <> ''
       GROUP BY reading_level ORDER BY reading_level`).bind(inst).all<Row>()
    const list = students.results.map((v) => ({
      student_id: s(v.student_id), student_name: s(v.student_name), admission_no: s(v.admission_no),
      class_name: s(v.class_name) + (v.section_name ? ' ' + s(v.section_name) : ''), section_id: s(v.section_id) || null,
      level: s(v.level) || null, measured_on: s(v.measured_on) || null, note: s(v.note) || null, books_read: Number(v.books_read ?? 0),
    }))
    const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)
    return ok({
      items: list,
      titles_by_level: titles.results.map((v) => ({ level: s(v.level), titles: Number(v.titles ?? 0) })),
      summary: {
        students: list.length,
        measured: list.filter((v) => v.level).length,
        never_measured: list.filter((v) => !v.level).length,
        stale: list.filter((v) => v.measured_on && v.measured_on < cutoff).length,
      },
    })
  })

  r.get('/ops/library/reading-levels/{student_id}', READ, async (c) => {
    const id = uuidParam(c.params.student_id, 'student_id')
    const rows = await c.db.prepare(`
      SELECT rl.id, rl.level, rl.measured_on, rl.note, u.full_name AS measured_by
        FROM student_reading_levels rl LEFT JOIN users u ON u.id = rl.measured_by
       WHERE rl.student_id = ? ORDER BY rl.measured_on DESC, rl.created_at DESC LIMIT 50`).bind(id).all<Row>()
    return ok({ items: rows.results })
  })

  /* Record a measurement. History is kept: a child's level in March and in
     September are both facts. */
  r.post('/ops/library/reading-levels/{student_id}', WRITE, async (c) => {
    const id = uuidParam(c.params.student_id, 'student_id')
    const req = await readJSON<{ level?: unknown; measured_on?: unknown; note?: unknown }>(c.req)
    const level = cleanLevel(req.level)
    const on = s(req.measured_on) || now().slice(0, 10)
    if (!isDate(on)) throw badRequest('measured_on must be YYYY-MM-DD')
    const st = await c.db.prepare(`SELECT 1 FROM students WHERE id = ?`).bind(id).first()
    if (!st) throw notFound('no student with that id')
    const rid = crypto.randomUUID()
    await c.db.prepare(`INSERT INTO student_reading_levels (id, institution_id, student_id, level, measured_on, note, measured_by, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(rid, instId(c), id, level, on, s(req.note).trim() || null, c.id.userId, now()).run()
    return ok({ id: rid, student_id: id, level, measured_on: on })
  })

  /* Tag a title. Empty clears it. */
  r.put('/ops/library/titles/{id}/reading-level', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ level?: unknown }>(c.req)
    const raw = s(req.level).trim()
    const level = raw === '' ? null : cleanLevel(raw)
    const t = await c.db.prepare(`SELECT 1 FROM library_titles WHERE id = ?`).bind(id).first()
    if (!t) throw notFound('no title with that id')
    await c.db.prepare(`UPDATE library_titles SET reading_level = ? WHERE id = ?`).bind(level, id).run()
    return ok({ id, reading_level: level })
  })
}
