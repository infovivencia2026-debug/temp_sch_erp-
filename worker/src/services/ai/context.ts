import { fullNameSQL } from '../../routes/students/common'

/* The facts an AI draft or brief is written from, read straight from the
   school database. Every reader is defensive: a query that fails (an older
   school, a module never used) leaves its part empty rather than failing the
   whole draft. Callers decide who may see what before calling these. */

export async function safe<T>(label: string, f: () => Promise<T>, fallback: T): Promise<T> {
  try { return await f() } catch (e) { console.error('ai context', label, e); return fallback }
}
const rows = async <T>(db: D1Database, sql: string, ...args: unknown[]) =>
  ((await db.prepare(sql).bind(...args).all<T>()).results ?? []) as T[]

export interface StudentSnapshot {
  id: string
  name: string
  first_name: string
  gender: string | null
  class_name: string | null
  section_name: string | null
  section_id: string | null
  attendance: { days: number; present: number; absent: number; late: number; percent: number | null; since: string }
  marks: { exam: string; subject: string; obtained: number | null; max: number; absent: boolean }[]
  remarks: { on: string; kind: string; body: string }[]
  report_remarks: { term: string | null; class_teacher: string | null }[]
  homework: { assigned: number; submitted: number; pending_titles: string[] }
  conduct: { on: string; category: string; positive: boolean; description: string }[]
  achievements: string[]
  fees_due_paise: number
}

export async function studentSnapshot(db: D1Database, sid: string, since: string, opts: { family?: boolean } = {}): Promise<StudentSnapshot | null> {
  const st = await db.prepare(`SELECT st.id, ${fullNameSQL('st')} AS name, st.first_name, st.gender,
        c.name AS class_name, sec.name AS section_name, en.section_id
      FROM students st
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id LEFT JOIN sections sec ON sec.id = en.section_id
     WHERE st.id = ?`).bind(sid).first<{ id: string; name: string; first_name: string; gender: string | null; class_name: string | null; section_name: string | null; section_id: string | null }>()
  if (!st) return null
  const famOnly = opts.family ? 'AND visible_to_family = 1' : ''
  const [att, marks, remarks, rc, hw, conduct, ach, fees] = await Promise.all([
    safe('attendance', () => db.prepare(`SELECT COUNT(DISTINCT on_date) AS days,
          COUNT(DISTINCT CASE WHEN status IN ('present','late','half_day') THEN on_date END) AS present,
          COUNT(DISTINCT CASE WHEN status = 'absent' THEN on_date END) AS absent,
          COUNT(DISTINCT CASE WHEN status = 'late' THEN on_date END) AS late
        FROM student_attendance WHERE student_id = ? AND on_date >= ?`).bind(sid, since)
      .first<{ days: number; present: number; absent: number; late: number }>(), null),
    safe('marks', () => rows<{ exam: string; subject: string; obtained: string | null; max: string; absent: number }>(db,
      `SELECT ex.name AS exam, sub.name AS subject, m.marks_obtained AS obtained, es.max_marks AS max, m.is_absent AS absent
         FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams ex ON ex.id = es.exam_id
         JOIN class_subjects cs ON cs.id = es.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
        WHERE m.student_id = ? ${opts.family ? 'AND ex.is_published = 1' : ''}
        ORDER BY COALESCE(ex.starts_on, ex.created_at) DESC, sub.name LIMIT 40`, sid), []),
    safe('remarks', () => rows<{ on: string; kind: string; body: string }>(db,
      `SELECT observed_on AS "on", kind, body FROM student_remarks WHERE student_id = ? ${famOnly} ORDER BY observed_on DESC LIMIT 8`, sid), []),
    safe('report remarks', () => rows<{ term: string | null; class_teacher: string | null }>(db,
      `SELECT t.name AS term, rc.class_teacher_remarks AS class_teacher FROM report_cards rc LEFT JOIN terms t ON t.id = rc.term_id
        WHERE rc.student_id = ? AND rc.class_teacher_remarks IS NOT NULL AND rc.class_teacher_remarks <> ''
          ${opts.family ? 'AND rc.is_published = 1' : ''}
        ORDER BY rc.created_at DESC LIMIT 4`, sid), []),
    safe('homework', async () => {
      if (!st.section_id) return { assigned: 0, submitted: 0, pending_titles: [] as string[] }
      const hs = await rows<{ title: string; status: string | null }>(db,
        `SELECT h.title, hs.status FROM homework h
           LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
          WHERE h.section_id = ? AND h.is_published = 1 AND h.assigned_on >= ? ORDER BY h.assigned_on DESC LIMIT 40`, sid, st.section_id, since)
      const done = (s: string | null) => s !== null && s !== 'pending'
      return { assigned: hs.length, submitted: hs.filter((h) => done(h.status)).length,
        pending_titles: hs.filter((h) => !done(h.status)).slice(0, 5).map((h) => h.title) }
    }, { assigned: 0, submitted: 0, pending_titles: [] }),
    safe('conduct', () => rows<{ on: string; category: string; positive: number; description: string }>(db,
      `SELECT occurred_on AS "on", category, is_positive AS positive, description FROM discipline_records
        WHERE student_id = ? ${opts.family ? 'AND visible_to_student = 1' : ''} ORDER BY occurred_on DESC LIMIT 5`, sid), []),
    safe('achievements', async () => (await rows<{ title: string }>(db,
      `SELECT title FROM student_achievements WHERE student_id = ? ORDER BY created_at DESC LIMIT 5`, sid)).map((r) => r.title), [] as string[]),
    safe('fees', async () => Number((await db.prepare(`SELECT COALESCE(SUM(COALESCE(net_paise, gross_paise - discount_paise + fine_paise) - paid_paise), 0) AS due
        FROM invoices WHERE student_id = ? AND status NOT IN ('paid','cancelled')`).bind(sid).first<{ due: number }>())?.due ?? 0), 0),
  ])
  const a = att ?? { days: 0, present: 0, absent: 0, late: 0 }
  return {
    ...st,
    attendance: { days: Number(a.days), present: Number(a.present), absent: Number(a.absent), late: Number(a.late),
      percent: Number(a.days) > 0 ? Math.round((Number(a.present) / Number(a.days)) * 1000) / 10 : null, since },
    marks: marks.map((m) => ({ exam: m.exam, subject: m.subject, obtained: m.obtained === null ? null : Number(m.obtained), max: Number(m.max), absent: Number(m.absent) === 1 })),
    remarks, report_remarks: rc, homework: hw,
    conduct: conduct.map((x) => ({ on: x.on, category: x.category, positive: Number(x.positive) === 1, description: x.description })),
    achievements: ach, fees_due_paise: fees,
  }
}

/** The teacher's own recent report-card remarks, so a draft can follow their voice. */
export async function teacherStyle(db: D1Database, userId: string): Promise<string[]> {
  return safe('style', async () => (await rows<{ r: string }>(db,
    `SELECT class_teacher_remarks AS r FROM report_cards WHERE class_teacher_remarks_by = ? AND class_teacher_remarks <> ''
      ORDER BY class_teacher_remarks_at DESC LIMIT 5`, userId)).map((x) => x.r), [])
}

/** A snapshot as compact text for a prompt. */
export function snapshotText(s: StudentSnapshot, o: { fees?: boolean } = {}): string {
  const L: string[] = [`Student: ${s.name} (first name ${s.first_name}${s.gender ? ', ' + s.gender : ''}), ${[s.class_name, s.section_name].filter(Boolean).join(' ') || 'class not recorded'}.`]
  const a = s.attendance
  L.push(a.days > 0 ? `Attendance since ${a.since}: present ${a.present} of ${a.days} days (${a.percent}%), absent ${a.absent}, late ${a.late}.` : `Attendance since ${a.since}: not recorded.`)
  if (s.marks.length) {
    L.push('Marks (latest first):')
    for (const m of s.marks.slice(0, 24)) L.push(`- ${m.exam}, ${m.subject}: ${m.absent ? 'absent' : m.obtained === null ? 'not entered' : `${m.obtained}/${m.max}`}`)
  } else L.push('Marks: none recorded yet.')
  if (s.homework.assigned) L.push(`Homework since ${a.since}: ${s.homework.submitted} of ${s.homework.assigned} submitted${s.homework.pending_titles.length ? '; pending: ' + s.homework.pending_titles.join('; ') : ''}.`)
  for (const r of s.remarks) L.push(`Teacher note (${r.on}, ${r.kind}): ${r.body}`)
  for (const r of s.report_remarks) L.push(`Earlier report-card remark${r.term ? ' (' + r.term + ')' : ''}: ${r.class_teacher}`)
  for (const d of s.conduct) L.push(`${d.positive ? 'Positive' : 'Conduct'} record (${d.on}, ${d.category}): ${d.description}`)
  if (s.achievements.length) L.push('Achievements: ' + s.achievements.join('; '))
  if (o.fees && s.fees_due_paise > 0) L.push(`Fees outstanding: Rs ${(s.fees_due_paise / 100).toFixed(0)}.`)
  return L.join('\n')
}
