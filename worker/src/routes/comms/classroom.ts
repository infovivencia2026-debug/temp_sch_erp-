import type { Router, Ctx } from '../../router'
import { badRequest, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, requireAny, requirePerm, resolveScope } from '../teaching/common'
import { bodyUUID, bodyUUIDPtr, firstLast, isDate, isoZ, omitNull, optBool, optInt, optStr, queryUUID, trim, ymdOf } from './common'
import { denied, inJSON, pathUUID, reachesClass, reachesSection, requireTaughtStudent } from './classroom_common'

/* Port of classroom.go parts 1-3: language subject allocation, the portfolio
   curation builder and Montessori tracking. Every route is on
   academics.timetable.read, and every handler narrows to the caller's own
   sections through resolveScope. */

const OPEN = 'academics.timetable.read'
const NIL = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------- languages

async function listLanguageOptions(c: Ctx): Promise<Response> {
  const classId = queryUUID(c, 'class_id')
  const s = await resolveScope(c)
  let where = '1'
  const args: unknown[] = []
  if (classId) {
    if (!(await reachesClass(c, s, classId))) throw denied()
    where = 'o.class_id = ?'; args.push(classId)
  } else if (!(s.allStudents || s.allAttendance)) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('sec.id', s.sectionIds)
    where = `o.class_id IN (SELECT sec.class_id FROM sections sec WHERE ${q.sql})`; args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT o.id, o.class_id, cl.name AS class_name, o.class_subject_id, sub.name AS subject_name,
        sub.code AS subject_code, o.slot, o.display_name, o.capacity, o.is_active,
        (SELECT count(*) FROM student_language_elections el WHERE el.option_id = o.id AND el.status <> 'withdrawn') AS elected_count
      FROM class_language_options o
      JOIN classes cl ON cl.id = o.class_id
      JOIN class_subjects cs ON cs.id = o.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      WHERE ${where}
      ORDER BY cl.level, cl.name, o.slot, sub.name`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ id: v.id, class_id: v.class_id, class_name: v.class_name,
    class_subject_id: v.class_subject_id, subject_name: v.subject_name, subject_code: v.subject_code, slot: v.slot,
    display_name: v.display_name, capacity: v.capacity, is_active: bool(v.is_active), elected_count: Number(v.elected_count ?? 0) })) })
}

async function saveLanguageOption(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const id = bodyUUIDPtr(req.id)
  const csId = bodyUUID(req.class_subject_id)
  const slot = req.slot
  if (slot !== 'first' && slot !== 'second' && slot !== 'third') throw badRequest('slot must be first, second or third')
  if (csId === '') throw badRequest('a language option needs a class subject')
  const cs = await c.db.prepare(`SELECT class_id FROM class_subjects WHERE id = ?`).bind(csId).first<{ class_id: string }>()
  if (!cs) throw badRequest('that subject is not on any class')
  const active = optBool(req.is_active) ?? true
  const display = optStr(req.display_name), capacity = optInt(req.capacity)
  const t = now()
  if (id) {
    const res = await c.db.prepare(`UPDATE class_language_options SET class_subject_id = ?, class_id = ?, slot = ?, display_name = ?,
        capacity = ?, is_active = ?, updated_at = ? WHERE id = ?`)
      .bind(csId, cs.class_id, slot, display, capacity, active ? 1 : 0, t, id).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id })
  }
  const existing = await c.db.prepare(`SELECT id FROM class_language_options WHERE class_subject_id = ? AND slot = ?`).bind(csId, slot).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE class_language_options SET display_name = ?, capacity = ?, is_active = ?, updated_at = ? WHERE id = ?`)
      .bind(display, capacity, active ? 1 : 0, t, existing.id).run()
    return ok({ id: existing.id })
  }
  const nid = uuid()
  await c.db.prepare(`INSERT INTO class_language_options (id, institution_id, class_id, class_subject_id, slot, display_name, capacity, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(nid, institutionId(c), cs.class_id, csId, slot, display, capacity, active ? 1 : 0, t, t).run()
  return ok({ id: nid })
}

async function retireLanguageOption(c: Ctx): Promise<Response> {
  const id = pathUUID(c, 'id')
  const res = await c.db.prepare(`UPDATE class_language_options SET is_active = 0, updated_at = ? WHERE id = ?`).bind(now(), id).run()
  if (!res.meta.changes) throw notFound()
  return ok({ ok: true })
}

async function listLanguageElections(c: Ctx): Promise<Response> {
  const sectionId = queryUUID(c, 'section_id')
  const s = await resolveScope(c)
  const where = [`el.status <> 'withdrawn'`]
  const args: unknown[] = []
  if (sectionId) {
    if (!reachesSection(s, sectionId)) throw denied()
    where.push('en.section_id = ?'); args.push(sectionId)
  } else if (!s.allStudents) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('en.section_id', s.sectionIds)
    where.push(q.sql); args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT el.id, st.id AS student_id, st.admission_no, ${firstLast('st')} AS student_name,
        COALESCE(sec.name, '-') AS section, el.slot, o.id AS option_id, sub.name AS subject_name, el.status, el.note,
        ${ymdOf('el.decided_on')} AS decided_on
      FROM student_language_elections el
      JOIN students st ON st.id = el.student_id
      JOIN class_language_options o ON o.id = el.option_id
      JOIN class_subjects cs ON cs.id = o.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id
      WHERE ${where.join(' AND ')}
      ORDER BY sec.name, el.slot, st.admission_no`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v })) })
}

async function recordLanguageElection(c: Ctx): Promise<Response> {
  requireAny(c, 'students.write', 'academics.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const studentId = bodyUUID(req.student_id), optionId = bodyUUID(req.option_id)
  const yearId = bodyUUIDPtr(req.academic_year_id)
  if (studentId === '' || optionId === '') throw badRequest('an election needs a student and an option')
  let status = typeof req.status === 'string' ? req.status : ''
  if (status === '') status = 'confirmed'
  if (!['proposed', 'confirmed', 'withdrawn'].includes(status)) throw badRequest('status must be proposed, confirmed or withdrawn')
  const s = await resolveScope(c)
  await requireTaughtStudent(c, s, studentId)
  const opt = await c.db.prepare(`SELECT slot, class_id, is_active FROM class_language_options WHERE id = ?`).bind(optionId)
    .first<{ slot: string; class_id: string; is_active: number }>()
  if (!opt) throw badRequest('no such language option')
  if (!bool(opt.is_active)) throw badRequest('that language option has been withdrawn')
  const same = await c.db.prepare(`SELECT 1 AS x FROM enrollments e JOIN sections sec ON sec.id = e.section_id
      WHERE e.student_id = ? AND e.status = 'active' AND sec.class_id = ? LIMIT 1`).bind(studentId, opt.class_id).first()
  if (!same) throw badRequest('that option belongs to a class this child is not in')
  const note = optStr(req.note)
  const t = now()
  const live = await c.db.prepare(`SELECT id FROM student_language_elections
      WHERE student_id = ? AND slot = ? AND status <> 'withdrawn' AND option_id = ?
        AND COALESCE(academic_year_id, '${NIL}') = COALESCE(?, '${NIL}')`).bind(studentId, opt.slot, optionId, yearId).first<{ id: string }>()
  const withdraw = c.db.prepare(`UPDATE student_language_elections SET status = 'withdrawn', updated_at = ?
      WHERE student_id = ? AND slot = ? AND status <> 'withdrawn'
        AND COALESCE(academic_year_id, '${NIL}') = COALESCE(?, '${NIL}') AND option_id <> ?`)
    .bind(t, studentId, opt.slot, yearId, optionId)
  const id = live?.id ?? uuid()
  const write = live
    ? c.db.prepare(`UPDATE student_language_elections SET option_id = ?, status = ?, note = ?, decided_by = ?, updated_at = ? WHERE id = ?`)
      .bind(optionId, status, note, c.id.userId, t, id)
    : c.db.prepare(`INSERT INTO student_language_elections (id, institution_id, student_id, option_id, slot, academic_year_id, status, note,
          decided_by, decided_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, institutionId(c), studentId, optionId, opt.slot, yearId, status, note, c.id.userId, t.slice(0, 10), t, t)
  await c.db.batch([withdraw, write])
  return ok({ id })
}

async function getLanguageAllocation(c: Ctx): Promise<Response> {
  const classId = queryUUID(c, 'class_id')
  if (!classId) throw badRequest('class_id is required')
  const s = await resolveScope(c)
  if (!(await reachesClass(c, s, classId))) throw denied()
  const [groups, unchosen, clashes] = await c.db.batch([
    c.db.prepare(`SELECT o.id AS option_id, o.slot, COALESCE(o.display_name, sub.name) AS subject_name, o.capacity,
          count(*) FILTER (WHERE el.status = 'confirmed') AS elected,
          count(*) FILTER (WHERE el.status = 'proposed') AS proposed,
          json_group_array(DISTINCT sec.name) FILTER (WHERE sec.name IS NOT NULL) AS sections
        FROM class_language_options o
        JOIN class_subjects cs ON cs.id = o.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN student_language_elections el ON el.option_id = o.id AND el.status <> 'withdrawn'
        LEFT JOIN enrollments en ON en.student_id = el.student_id AND en.status = 'active'
        LEFT JOIN sections sec ON sec.id = en.section_id
        WHERE o.class_id = ? AND o.is_active = 1
        GROUP BY o.id, o.slot, o.display_name, sub.name, o.capacity
        ORDER BY o.slot, sub.name`).bind(classId),
    c.db.prepare(`WITH slots AS (SELECT DISTINCT slot FROM class_language_options WHERE class_id = ? AND is_active = 1)
        SELECT st.id AS student_id, st.admission_no, ${firstLast('st')} AS student_name, COALESCE(sec.name, '-') AS section,
               sec.name AS sec_name, slots.slot
          FROM students st
          JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
          JOIN sections sec ON sec.id = en.section_id
         CROSS JOIN slots
         WHERE sec.class_id = ?
           AND NOT EXISTS (SELECT 1 FROM student_language_elections el
                            WHERE el.student_id = st.id AND el.slot = slots.slot AND el.status <> 'withdrawn')
         ORDER BY sec.name, st.admission_no, st.id, slots.slot`).bind(classId, classId),
    c.db.prepare(`SELECT st.id AS student_id, ${firstLast('st')} AS student_name, ta.weekday,
          COALESCE(p.name, 'Period ' || p.sequence) AS period_name, sa.name AS subject_a, sb.name AS subject_b
        FROM student_language_elections ea
        JOIN student_language_elections eb ON eb.student_id = ea.student_id AND eb.id <> ea.id AND eb.status <> 'withdrawn'
        JOIN class_language_options oa ON oa.id = ea.option_id
        JOIN class_language_options ob ON ob.id = eb.option_id
        JOIN students st ON st.id = ea.student_id
        JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
        JOIN timetable_entries ta ON ta.class_subject_id = oa.class_subject_id AND ta.section_id = en.section_id
        JOIN timetable_entries tb ON tb.class_subject_id = ob.class_subject_id AND tb.section_id = en.section_id
                                 AND tb.weekday = ta.weekday AND tb.period_id = ta.period_id
        JOIN periods p ON p.id = ta.period_id
        JOIN class_subjects csa ON csa.id = oa.class_subject_id
        JOIN class_subjects csb ON csb.id = ob.class_subject_id
        JOIN subjects sa ON sa.id = csa.subject_id
        JOIN subjects sb ON sb.id = csb.subject_id
        WHERE ea.status <> 'withdrawn' AND oa.class_id = ? AND oa.id < ob.id
        ORDER BY ta.weekday, p.sequence`).bind(classId),
  ])
  const out = {
    class_id: classId,
    groups: (groups.results as Record<string, unknown>[]).map((g) => {
      const elected = Number(g.elected ?? 0), proposed = Number(g.proposed ?? 0)
      const cap = g.capacity === null || g.capacity === undefined ? null : Number(g.capacity)
      let sections: string[] = []
      try { sections = (JSON.parse(String(g.sections ?? '[]')) as (string | null)[]).filter((x): x is string => x !== null).sort() } catch { sections = [] }
      return omitNull({ option_id: g.option_id, slot: g.slot, subject_name: g.subject_name, capacity: cap, elected, proposed,
        over_capacity_by: cap !== null && elected + proposed > cap ? elected + proposed - cap : 0, sections })
    }),
    unchosen: [] as Record<string, unknown>[],
    clashes: (clashes.results as Record<string, unknown>[]).map((v) => ({ student_id: v.student_id, student_name: v.student_name,
      weekday: Number(v.weekday), period_name: v.period_name, subject_a: v.subject_a, subject_b: v.subject_b })),
  }
  let last: Record<string, unknown> | null = null, lastKey = ''
  for (const v of unchosen.results as Record<string, unknown>[]) {
    const key = `${v.student_id}\u0000${v.sec_name}`
    if (!last || key !== lastKey) {
      last = { student_id: v.student_id, admission_no: v.admission_no, student_name: v.student_name, section: v.section, missing_slots: [] as string[] }
      out.unchosen.push(last); lastKey = key
    }
    (last.missing_slots as string[]).push(String(v.slot))
  }
  return ok(out)
}

// ---------------------------------------------------------------- portfolio

async function getPortfolioForCuration(c: Ctx): Promise<Response> {
  const studentId = pathUUID(c, 'studentID')
  const s = await resolveScope(c)
  await requireTaughtStudent(c, s, studentId)
  const rows = await c.db.prepare(`
      SELECT 'award' AS source, a.id AS item_id, a.title, a.kind, a.description, ${ymdOf('a.awarded_on')} AS happened_on,
             NULL AS evidence_url, 0 AS shared_by_child,
             cu.id AS curation_id, COALESCE(cu.status, 'uncurated') AS status, cu.comment,
             COALESCE(cu.include_in_report, 0) AS include_in_report, COALESCE(cu.is_featured, 0) AS is_featured,
             u.full_name AS curated_by, ${isoZ('cu.curated_at')} AS curated_at
        FROM student_achievements a
        LEFT JOIN student_portfolio_curations cu ON cu.achievement_id = a.id
        LEFT JOIN users u ON u.id = cu.curated_by
       WHERE a.student_id = ?
      UNION ALL
      SELECT 'claim', p.id, p.title, p.kind, p.description, ${ymdOf('p.happened_on')}, p.evidence_url, p.is_shared,
             cu.id, COALESCE(cu.status, 'uncurated'), cu.comment,
             COALESCE(cu.include_in_report, 0), COALESCE(cu.is_featured, 0),
             u.full_name, ${isoZ('cu.curated_at')}
        FROM student_portfolio_items p
        LEFT JOIN student_portfolio_curations cu ON cu.portfolio_item_id = p.id
        LEFT JOIN users u ON u.id = cu.curated_by
       WHERE p.student_id = ?
      ORDER BY 6 DESC NULLS LAST, 3`).bind(studentId, studentId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ source: v.source, item_id: v.item_id, title: v.title, kind: v.kind,
    description: v.description, happened_on: v.happened_on, evidence_url: v.evidence_url, shared_by_child: bool(v.shared_by_child),
    curation_id: v.curation_id, status: v.status, comment: v.comment, include_in_report: bool(v.include_in_report),
    is_featured: bool(v.is_featured), curated_by: v.curated_by, curated_at: v.curated_at })) })
}

async function curatePortfolioItem(c: Ctx): Promise<Response> {
  requirePerm(c, 'welfare.discipline.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const studentId = bodyUUID(req.student_id), itemId = bodyUUID(req.item_id)
  if (studentId === '' || itemId === '') throw badRequest('a curation needs a student and an item')
  let status = typeof req.status === 'string' ? req.status : ''
  if (status === '') status = 'noted'
  if (!['noted', 'endorsed', 'returned'].includes(status)) throw badRequest('status must be noted, endorsed or returned')
  let table: string, column: string, other: string
  if (req.source === 'award') { table = 'student_achievements'; column = 'achievement_id'; other = 'portfolio_item_id' }
  else if (req.source === 'claim') { table = 'student_portfolio_items'; column = 'portfolio_item_id'; other = 'achievement_id' }
  else throw badRequest('source must be award or claim')
  const s = await resolveScope(c)
  await requireTaughtStudent(c, s, studentId)
  const belongs = await c.db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ? AND student_id = ?`).bind(itemId, studentId).first()
  if (!belongs) throw badRequest('that item does not belong to this child')
  let report = optBool(req.include_in_report) === true
  let featured = optBool(req.is_featured) === true
  const order = optInt(req.display_order) ?? 0
  if (status === 'returned') { report = false; featured = false }
  const comment = optStr(req.comment)
  const t = now()
  const existing = await c.db.prepare(`SELECT id FROM student_portfolio_curations WHERE ${column} = ? AND ${other} IS NULL`).bind(itemId).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE student_portfolio_curations SET status = ?, comment = ?, include_in_report = ?, is_featured = ?,
        display_order = ?, curated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(status, comment, report ? 1 : 0, featured ? 1 : 0, order, c.id.userId, t, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO student_portfolio_curations (id, institution_id, student_id, ${column}, status, comment,
        include_in_report, is_featured, display_order, curated_by, curated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, institutionId(c), studentId, itemId, status, comment, report ? 1 : 0, featured ? 1 : 0, order, c.id.userId, t, t).run()
  return ok({ id })
}

// ---------------------------------------------------------------- montessori

const AREAS = new Set(['practical_life', 'sensorial', 'language', 'mathematics', 'culture'])

async function listMontessoriMaterials(c: Ctx): Promise<Response> {
  const area = (c.url.searchParams.get('area') ?? '').trim()
  const rows = await c.db.prepare(`SELECT id, area, name, description, sequence, min_age_months, max_age_months, is_active
      FROM montessori_materials WHERE is_active = 1 AND (? = '' OR area = ?)
      ORDER BY area, sequence, name`).bind(area, area).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, sequence: Number(v.sequence ?? 0), is_active: bool(v.is_active) })) })
}

async function saveMontessoriMaterial(c: Ctx): Promise<Response> {
  requirePerm(c, 'academics.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const id = bodyUUIDPtr(req.id)
  const area = typeof req.area === 'string' ? req.area : ''
  if (!AREAS.has(area)) throw badRequest('area must be one of the five Montessori areas')
  const name = trim(req.name)
  if (name === '') throw badRequest('a material needs a name')
  const active = optBool(req.is_active) ?? true
  const desc = optStr(req.description), seq = optInt(req.sequence) ?? 0, minA = optInt(req.min_age_months), maxA = optInt(req.max_age_months)
  if (id) {
    const res = await c.db.prepare(`UPDATE montessori_materials SET area = ?, name = ?, description = ?, sequence = ?,
        min_age_months = ?, max_age_months = ?, is_active = ? WHERE id = ?`)
      .bind(area, name, desc, seq, minA, maxA, active ? 1 : 0, id).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id })
  }
  const existing = await c.db.prepare(`SELECT id FROM montessori_materials WHERE area = ? AND lower(trim(name)) = lower(trim(?))`)
    .bind(area, name).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE montessori_materials SET description = ?, sequence = ?, min_age_months = ?, max_age_months = ?, is_active = ? WHERE id = ?`)
      .bind(desc, seq, minA, maxA, active ? 1 : 0, existing.id).run()
    return ok({ id: existing.id })
  }
  const nid = uuid()
  await c.db.prepare(`INSERT INTO montessori_materials (id, institution_id, area, name, description, sequence, min_age_months, max_age_months, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(nid, institutionId(c), area, name, desc, seq, minA, maxA, active ? 1 : 0, now()).run()
  return ok({ id: nid })
}

async function getMontessoriChild(c: Ctx): Promise<Response> {
  const studentId = pathUUID(c, 'studentID')
  const s = await resolveScope(c)
  await requireTaughtStudent(c, s, studentId)
  const latest = (col: string) => `(SELECT ${col} FROM montessori_progress p WHERE p.material_id = m.id AND p.student_id = ?
      ORDER BY p.observed_on DESC, p.created_at DESC LIMIT 1)`
  const [mats, hist] = await c.db.batch([
    c.db.prepare(`SELECT m.id AS material_id, m.area, m.name, m.sequence,
          COALESCE(${latest('p.stage')}, 'not_presented') AS current_stage, ${latest('substr(p.observed_on, 1, 10)')} AS last_seen_on
        FROM montessori_materials m WHERE m.is_active = 1 ORDER BY m.area, m.sequence, m.name`).bind(studentId, studentId),
    c.db.prepare(`SELECT p.id, p.material_id, p.stage, ${ymdOf('p.observed_on')} AS observed_on, p.note, u.full_name AS observed_by
        FROM montessori_progress p LEFT JOIN users u ON u.id = p.observed_by
        WHERE p.student_id = ? ORDER BY p.observed_on DESC, p.created_at DESC`).bind(studentId),
  ])
  const out = (mats.results as Record<string, unknown>[]).map((v) => ({ ...omitNull({ material_id: v.material_id, area: v.area, name: v.name,
    sequence: Number(v.sequence ?? 0), current_stage: v.current_stage, last_seen_on: v.last_seen_on }), history: [] as Record<string, unknown>[] }))
  const by = new Map(out.map((v) => [v.material_id as string, v]))
  for (const h of hist.results as Record<string, unknown>[]) {
    by.get(h.material_id as string)?.history.push(omitNull({ id: h.id, stage: h.stage, observed_on: h.observed_on, note: h.note, observed_by: h.observed_by }))
  }
  return ok({ items: out })
}

async function getMontessoriSection(c: Ctx): Promise<Response> {
  const sectionId = queryUUID(c, 'section_id')
  if (!sectionId) throw badRequest('section_id is required')
  const s = await resolveScope(c)
  if (!reachesSection(s, sectionId)) throw denied()
  const rows = await c.db.prepare(`
      WITH latest AS (
        SELECT student_id, material_id, stage, observed_on FROM (
          SELECT p.student_id, p.material_id, p.stage, p.observed_on,
                 ROW_NUMBER() OVER (PARTITION BY p.student_id, p.material_id ORDER BY p.observed_on DESC, p.created_at DESC) AS rn
            FROM montessori_progress p
            JOIN enrollments e ON e.student_id = p.student_id AND e.status = 'active' AND e.section_id = ?1
        ) WHERE rn = 1
      )
      SELECT st.id AS sid, st.admission_no, ${firstLast('st')} AS name, m.area,
             count(*) FILTER (WHERE l.stage = 'presented') AS pres,
             count(*) FILTER (WHERE l.stage = 'practising') AS prac,
             count(*) FILTER (WHERE l.stage = 'mastered') AS mast,
             substr(max(l.observed_on), 1, 10) AS last
        FROM students st
        JOIN enrollments en ON en.student_id = st.id AND en.status = 'active' AND en.section_id = ?1
       CROSS JOIN (SELECT DISTINCT area FROM montessori_materials WHERE is_active = 1) m
        LEFT JOIN latest l ON l.student_id = st.id
        LEFT JOIN montessori_materials mm ON mm.id = l.material_id AND mm.area = m.area
       WHERE l.material_id IS NULL OR mm.id IS NOT NULL
       GROUP BY st.id, st.admission_no, st.first_name, st.last_name, m.area
       ORDER BY st.admission_no, m.area`).bind(sectionId).all<Record<string, unknown>>()
  const out: Record<string, unknown>[] = []
  const by = new Map<string, Record<string, unknown>>()
  for (const v of rows.results) {
    let child = by.get(v.sid as string)
    if (!child) {
      child = { student_id: v.sid, admission_no: v.admission_no, student_name: v.name, areas: [] as Record<string, unknown>[] }
      by.set(v.sid as string, child); out.push(child)
    }
    const pres = Number(v.pres ?? 0), prac = Number(v.prac ?? 0), mast = Number(v.mast ?? 0)
    ;(child.areas as Record<string, unknown>[]).push({ area: v.area, materials: pres + prac + mast, presented: pres, practising: prac, mastered: mast })
    const last = v.last as string | null
    if (last && (child.last_observed_on === undefined || last > (child.last_observed_on as string))) child.last_observed_on = last
  }
  return ok({ items: out })
}

async function recordMontessoriProgress(c: Ctx): Promise<Response> {
  requirePerm(c, 'academics.marks.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const studentId = bodyUUID(req.student_id), materialId = bodyUUID(req.material_id)
  if (!['presented', 'practising', 'mastered', 'revisit'].includes(req.stage as string)) {
    throw badRequest('stage must be presented, practising, mastered or revisit')
  }
  if (studentId === '' || materialId === '') throw badRequest('an observation needs a child and a material')
  let on = now().slice(0, 10)
  const raw = optStr(req.observed_on)
  if (raw !== null && raw.trim() !== '') {
    if (!isDate(raw.trim())) throw badRequest('observed_on must be YYYY-MM-DD')
    on = raw.trim()
  }
  const s = await resolveScope(c)
  await requireTaughtStudent(c, s, studentId)
  const note = optStr(req.note)
  const existing = await c.db.prepare(`SELECT id FROM montessori_progress WHERE student_id = ? AND material_id = ? AND stage = ? AND observed_on = ?`)
    .bind(studentId, materialId, req.stage, on).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE montessori_progress SET note = ?, observed_by = ? WHERE id = ?`).bind(note, c.id.userId, existing.id).run()
    return ok({ id: existing.id })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO montessori_progress (id, institution_id, student_id, material_id, stage, observed_on, note, observed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, institutionId(c), studentId, materialId, req.stage, on, note, c.id.userId, now()).run()
  return ok({ id })
}

export function registerClassroomLearning(r: Router): void {
  const also = (perm: string, h: (c: Ctx) => Promise<Response>) => async (c: Ctx) => { requirePerm(c, perm); return h(c) }
  r.get('/classroom/languages/options', OPEN, listLanguageOptions)
  r.post('/classroom/languages/options', OPEN, also('academics.write', saveLanguageOption))
  r.del('/classroom/languages/options/{id}', OPEN, also('academics.write', retireLanguageOption))
  r.get('/classroom/languages/elections', OPEN, listLanguageElections)
  r.post('/classroom/languages/elections', OPEN, recordLanguageElection)
  r.get('/classroom/languages/allocation', OPEN, getLanguageAllocation)

  r.post('/classroom/portfolio/curations', OPEN, curatePortfolioItem)
  r.get('/classroom/portfolio/{studentID}', OPEN, getPortfolioForCuration)

  r.get('/classroom/montessori/materials', OPEN, listMontessoriMaterials)
  r.post('/classroom/montessori/materials', OPEN, saveMontessoriMaterial)
  r.get('/classroom/montessori/child/{studentID}', OPEN, getMontessoriChild)
  r.get('/classroom/montessori/section', OPEN, getMontessoriSection)
  r.post('/classroom/montessori/progress', OPEN, recordMontessoriProgress)
}
