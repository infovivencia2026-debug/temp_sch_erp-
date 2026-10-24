/* A DEMO SCHOOL'S RECORDS (seller/sales.ts POST /seller/demos).

   Enough for a sales demo to open real screens with something in them: the
   current year, three classes with one section each, three subjects taught in
   every class, and twelve children per class. Every name is plainly invented
   ("Demo Student 01", admission numbers DEMO-001) so nobody mistakes a demo
   for a real school or a real child. Runs inside provisioning's seeding stage
   (services/provision.ts), after the school's own rows; a retry finds the
   year already there and does nothing. */

const CLASSES = [{ name: 'Class 1', level: 1 }, { name: 'Class 2', level: 2 }, { name: 'Class 3', level: 3 }]
const SUBJECTS = [{ name: 'English', code: 'ENG' }, { name: 'Mathematics', code: 'MAT' }, { name: 'Environmental Studies', code: 'EVS' }]
export const DEMO_STUDENTS_PER_CLASS = 12

/** The Indian school year (June to the next April) a date falls in. */
function schoolYear(today: string): { name: string; starts: string; ends: string } {
  let y = Number(today.slice(0, 4))
  if (Number(today.slice(5, 7)) < 6) y--
  return { name: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, starts: `${y}-06-01`, ends: `${y + 1}-04-30` }
}

export async function seedDemoSchool(db: D1Database, inst: string, today = new Date().toISOString().slice(0, 10)): Promise<void> {
  if (await db.prepare(`SELECT 1 FROM academic_years WHERE institution_id = ?`).bind(inst).first()) return
  const campus = await db.prepare(`SELECT id FROM campuses WHERE institution_id = ? LIMIT 1`).bind(inst).first<{ id: string }>()
  if (!campus) throw new Error('demo seed: the school has no campus')
  const id = () => crypto.randomUUID()
  const yr = schoolYear(today)
  const year = id()
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind(year, inst, campus.id, yr.name, yr.starts, yr.ends),
  ]
  const subjects = SUBJECTS.map((s) => ({ ...s, id: id() }))
  for (const s of subjects) {
    stmts.push(db.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, ?, ?)`).bind(s.id, inst, campus.id, s.name, s.code))
  }
  let n = 0
  for (const k of CLASSES) {
    const klass = id(), section = id()
    stmts.push(
      db.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, ?, ?)`).bind(klass, inst, campus.id, k.name, k.level),
      db.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'A')`)
        .bind(section, inst, campus.id, klass, year),
      ...subjects.map((s) => db.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(id(), inst, klass, s.id)),
    )
    for (let i = 1; i <= DEMO_STUDENTS_PER_CLASS; i++) {
      n++
      const student = id(), no = String(n).padStart(3, '0')
      stmts.push(
        db.prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date) VALUES (?, ?, ?, ?, 'Demo', ?, ?)`)
          .bind(student, inst, campus.id, `DEMO-${no}`, `Student ${String(n).padStart(2, '0')}`, yr.starts),
        db.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id(), inst, student, year, klass, section, i, yr.starts),
      )
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
}
