/* Early warnings and smart import with fakes: a fake Gemini (a function
   that answers canned JSON and records what it was asked), and one school
   database in node:sqlite carrying the real db/tenant.sql.

   Run from worker/: scripts/test-ai.sh (esbuild bundle, node --test). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import {
  attendanceFlags, marksFlags, feeFlags, staffFlags, registerFlags, type StudentRef,
} from '../src/services/ai/warning_rules'
import { runWarnings, explainBatch, digestCounts } from '../src/services/ai/warnings'
import {
  proposeImport, heuristicProposal, normaliseRows, parseClassCell, toIsoDate, normalisePhone, toImporterCSV, gridToTable,
  extractTableFromImage, type ImportKind,
} from '../src/services/ai/smart_import'
import { readXLSX } from '../src/services/ai/xlsx_read'
import { buildXLSX } from '../src/services/xlsx'
import type { Llm } from '../src/services/ai/gemini_seam'

// ---- a D1 over node:sqlite (as test/billing.test.ts) ---------------------------------
type Row = Record<string, unknown>
const bindable = (vs: unknown[]) => vs.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as never[]
const returnsRows = (sql: string) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)
function exec1(db: DatabaseSync, sql: string, params: unknown[]) {
  if (returnsRows(sql)) return { results: (db.prepare(sql).all(...bindable(params)) as Row[]).map((r) => ({ ...r })), success: true, meta: { changes: 0 } }
  const r = db.prepare(sql).run(...bindable(params))
  return { results: [], success: true, meta: { changes: Number(r.changes) } }
}
function d1(db: DatabaseSync): D1Database {
  const mk = (sql: string, params: unknown[] = []): any => ({
    sql, params, bind: (...v: unknown[]) => mk(sql, v),
    first: async () => (exec1(db, sql, params).results[0] as Row | undefined) ?? null,
    all: async () => exec1(db, sql, params), run: async () => exec1(db, sql, params),
  })
  return { prepare: (sql: string) => mk(sql), batch: async (stmts: any[]) => stmts.map((s) => exec1(db, s.sql, s.params)) } as unknown as D1Database
}

/** A fake Gemini: answers with `reply(system, text)` and keeps every call. */
function fakeGemini(reply: (system: string, text: string) => string): Llm & { calls: { system: string; parts: unknown[] }[] } {
  const calls: { system: string; parts: unknown[] }[] = []
  const f = (async (system: string, parts: any[]) => {
    calls.push({ system, parts })
    return reply(system, parts.map((p) => p.text ?? '').join('\n'))
  }) as Llm & { calls: typeof calls }
  f.calls = calls
  return f
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const TODAY = '2026-09-25' // a Friday
const kid: StudentRef = { student_id: 's1', name: 'Meera Menon', section_id: 'sec1', class_teacher_id: 't1' }

// ---- rules -----------------------------------------------------------------------------

test('attendance: a drop over the last 3 weeks against the term average', () => {
  const marks = []
  for (let i = 80; i >= 1; i--) marks.push({ on_date: addDays(TODAY, -i), status: i <= 20 ? (i % 2 ? 'absent' : 'present') : 'present' })
  const f = attendanceFlags(kid, marks, TODAY)
  const drop = f.find((x) => x.rule === 'attendance_drop')!
  assert.ok(drop, 'raises attendance_drop')
  assert.equal(drop.owner_role, 'class_teacher')
  assert.equal(drop.evidence.recent_days, 20)
  assert.equal(drop.evidence.recent_present, 10)
  assert.equal(drop.evidence.recent_pct, 50)
  assert.equal(drop.severity, 'high')
  assert.match(drop.reason, /50%/)
})

test('attendance: consecutive absences, and a steady child raises nothing', () => {
  const marks = [...Array(30)].map((_, i) => ({ on_date: addDays(TODAY, -30 + i), status: i >= 26 ? 'absent' : 'present' }))
  const f = attendanceFlags(kid, marks, TODAY)
  const run = f.find((x) => x.rule === 'consecutive_absence')!
  assert.equal(run.evidence.consecutive_absent, 4)
  assert.equal(run.severity, 'medium')
  const steady = [...Array(40)].map((_, i) => ({ on_date: addDays(TODAY, -40 + i), status: i % 10 === 0 ? 'absent' : 'present' }))
  assert.deepEqual(attendanceFlags(kid, steady, TODAY), [])
  // holidays and leave do not count as absences
  const hol = [...Array(10)].map((_, i) => ({ on_date: addDays(TODAY, -10 + i), status: i >= 6 ? 'holiday' : 'present' }))
  assert.deepEqual(attendanceFlags(kid, hol, TODAY), [])
})

test('marks: latest exam against the previous one, per subject', () => {
  const rows = [
    { subject: 'Maths', exam: 'Unit 1', exam_date: '2026-07-01', obtained: 40, max: 50, pass: 17 },
    { subject: 'Maths', exam: 'Mid-term', exam_date: '2026-09-01', obtained: 45, max: 100, pass: 35 },
    { subject: 'English', exam: 'Unit 1', exam_date: '2026-07-01', obtained: 40, max: 50 },
    { subject: 'English', exam: 'Mid-term', exam_date: '2026-09-01', obtained: 75, max: 100 },
  ]
  const [f] = marksFlags(kid, rows)
  assert.equal(f.rule, 'marks_falling')
  assert.equal(f.evidence.worst_subject, 'Maths')
  assert.equal(f.evidence.worst_drop_points, 35)
  assert.deepEqual(f.evidence.subjects, ['Maths 80% → 45%'])
  assert.equal(f.severity, 'high')
  assert.deepEqual(marksFlags(kid, rows.filter((r) => r.subject === 'English')), [])
})

test('fees: overdue plus payment history sets the severity; owner is accounts', () => {
  const base = { overdue_paise: 1_250_000, oldest_due_on: addDays(TODAY, -45), overdue_invoices: 2, last_paid_on: addDays(TODAY, -50), payments_last_year: 4, late_payments_last_year: 3 }
  const [f] = feeFlags(kid, base, TODAY)
  assert.equal(f.owner_role, 'accounts')
  assert.equal(f.severity, 'medium')
  assert.equal(f.evidence.overdue_rupees, 12500)
  assert.equal(f.evidence.days_overdue, 45)
  assert.match(f.reason, /most payments this year came late/)
  assert.equal(feeFlags(kid, { ...base, last_paid_on: null }, TODAY)[0].severity, 'high')
  assert.deepEqual(feeFlags(kid, { ...base, oldest_due_on: addDays(TODAY, -10) }, TODAY), [])
})

test('staff: Monday/Friday pattern and count', () => {
  const fridays = [0, 7, 14].map((n) => ({ on_date: addDays(TODAY, -n), status: 'absent' }))
  const [f] = staffFlags({ user_id: 'u1', name: 'Ravi Kumar' }, fridays, TODAY)
  assert.equal(f.rule, 'staff_absence')
  assert.equal(f.evidence.monday_friday_absences, 3)
  assert.equal(f.owner_role, 'principal')
  assert.deepEqual(staffFlags({ user_id: 'u1', name: 'R' }, [{ on_date: addDays(TODAY, -2), status: 'absent' }], TODAY), [])
})

test('registers: sections with many unmarked school days', () => {
  const days = [...Array(10)].map((_, i) => addDays(TODAY, -i - 1))
  const [f] = registerFlags({ section_id: 'sec1', name: 'Grade 6 A', class_teacher_id: 't1', class_teacher_name: 'Anita' }, days, days.slice(0, 6))
  assert.equal(f.evidence.missing_days, 4)
  assert.match(f.next_step, /Anita/)
  assert.deepEqual(registerFlags({ section_id: 's', name: 'x', class_teacher_id: null }, days, days.slice(0, 9)), [])
})

// ---- the nightly run against a real schema ----------------------------------------------

function school() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('db/tenant.sql', 'utf8'))
  db.exec('PRAGMA foreign_keys = OFF')
  const I = 'inst'
  const q = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...bindable(a))
  q(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current) VALUES ('y', ?, 'cmp', '2026-27', '2026-06-01', '2027-03-31', 1)`, I)
  q(`INSERT INTO users (id, institution_id, email, full_name) VALUES ('t1', ?, 't@x', 'Anita Teacher'), ('t2', ?, 't2@x', 'Bala Teacher')`, I, I)
  q(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES ('c6', ?, 'cmp', 'Grade 6', 6)`, I)
  q(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, class_teacher_id) VALUES ('sA', ?, 'cmp', 'c6', 'y', 'A', 't1'), ('sB', ?, 'cmp', 'c6', 'y', 'B', 't2')`, I, I)
  for (const [id, fn, sec] of [['k1', 'Meera', 'sA'], ['k2', 'Arjun', 'sA'], ['k3', 'Zoya', 'sB']]) {
    q(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, status) VALUES (?, ?, 'cmp', ?, ?, 'S', 'active')`, id, I, id.toUpperCase(), fn)
    q(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, status) VALUES (?, ?, ?, 'y', 'c6', ?, 'active')`, 'e' + id, I, id, sec)
  }
  // Section A marks its register every weekday for 60 days; Meera is absent for the last 6 of them. Section B marked only long ago.
  let n = 0
  for (let i = 60; i >= 1; i--) {
    const d = addDays(TODAY, -i)
    const wd = new Date(d + 'T00:00:00Z').getUTCDay()
    if (wd === 0 || wd === 6) continue
    n++
    for (const k of ['k1', 'k2']) q(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, 'sA', ?, ?)`,
      `a${k}${i}`, I, k, d, k === 'k1' && i <= 8 ? 'absent' : 'present')
    if (i > 30) q(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, status) VALUES (?, ?, 'k3', 'sB', ?, 'present')`, `ak3${i}`, I, d)
  }
  assert.ok(n > 30)
  q(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, issued_on, due_on, gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status)
     VALUES ('inv1', ?, 'cmp', 'k2', 'y', 'INV1', '2026-06-01', ?, 500000, 0, 0, 500000, 100000, 'partial')`, I, addDays(TODAY, -100))
  return { db, D: d1(db), I }
}

test('runWarnings: raises, stores, keeps status, clears, explains with a fake Gemini', async () => {
  const { db, D, I } = school()
  const gem = fakeGemini((_s, text) => {
    const items = JSON.parse(text) as { key: string; who: string }[]
    return '```json\n' + JSON.stringify(Object.fromEntries(items.map((i) => [i.key, `AI: ${i.who} needs a look.`]))) + '\n```'
  })
  const r1 = await runWarnings(D, I, TODAY, gem)
  const rows = db.prepare(`SELECT rule, subject_id, severity, owner_role, status, explanation, explained_by, evidence FROM ai_warnings ORDER BY rule, subject_id`).all() as any[]
  const rules = rows.map((r) => `${r.rule}:${r.subject_id}`)
  assert.ok(rules.includes('consecutive_absence:k1'), rules.join(','))
  assert.ok(rules.includes('attendance_drop:k1'), rules.join(','))
  assert.ok(rules.includes('fee_risk:k2'), rules.join(','))
  assert.ok(rules.includes('unmarked_registers:sB'), rules.join(','))
  assert.ok(!rules.some((x) => x.endsWith(':k3')), 'Zoya is fine')
  assert.equal(r1.explained, rows.length)
  assert.ok(rows.every((r) => r.explained_by === 'ai' && r.explanation.startsWith('AI: ')))
  assert.equal(JSON.parse(rows.find((r) => r.rule === 'fee_risk').evidence).overdue_rupees, 4000)

  // Acknowledged stays acknowledged on the next run; the cache means no second model call.
  db.prepare(`UPDATE ai_warnings SET status = 'acknowledged' WHERE rule = 'fee_risk'`).run()
  const callsBefore = gem.calls.length
  await runWarnings(D, I, TODAY, gem)
  assert.equal(gem.calls.length, callsBefore)
  assert.equal((db.prepare(`SELECT status FROM ai_warnings WHERE rule = 'fee_risk'`).get() as any).status, 'acknowledged')

  // The fee gets paid: next run clears the flag.
  db.prepare(`UPDATE invoices SET status = 'paid', paid_paise = 500000`).run()
  const r3 = await runWarnings(D, I, TODAY, null)
  assert.ok(r3.cleared >= 1)
  assert.ok((db.prepare(`SELECT cleared_at FROM ai_warnings WHERE rule = 'fee_risk'`).get() as any).cleared_at)

  const d = await digestCounts(D)
  assert.ok(d.open >= 3)
  assert.equal(d.by_rule.fee_risk, undefined)
})

test('runWarnings without a key: template sentences, nothing explained', async () => {
  const { db, D, I } = school()
  const r = await runWarnings(D, I, TODAY, null)
  assert.equal(r.ai, false)
  assert.equal(r.explained, 0)
  const row = db.prepare(`SELECT reason, explanation FROM ai_warnings WHERE rule = 'consecutive_absence'`).get() as any
  assert.equal(row.explanation, null)
  assert.match(row.reason, /Meera S has been absent \d+ school days in a row/)
})

test('explainBatch ignores keys it did not ask for and a broken reply', async () => {
  const items = [{ key: 'k1', rule: 'fee_risk', name: 'A', evidence: {}, reason: 'r', next_step: 'n' }]
  const got = await explainBatch(fakeGemini(() => '{"k1":"Fine.","zz":"extra"}'), items)
  assert.deepEqual([...got], [['k1', 'Fine.']])
  assert.equal((await explainBatch(fakeGemini(() => 'sorry, no'), items)).size, 0)
})

// ---- smart import ---------------------------------------------------------------------

const KINDS: ImportKind[] = [
  { key: 'students', label: 'Students', columns: ['full_name', 'admission_no', 'date_of_birth', 'gender', 'class', 'section', 'father_name', 'father_phone'], required: ['full_name'] },
  { key: 'attendance', label: 'Student attendance', columns: ['admission_no', 'date', 'status', 'remarks'], required: ['admission_no', 'date', 'status'] },
  { key: 'marks', label: 'Marks', columns: ['admission_no', 'year', 'exam', 'class', 'subject', 'max_marks', 'marks_obtained', 'grade'], required: ['admission_no', 'year', 'exam', 'class', 'subject', 'max_marks'] },
]
const SHEET = {
  headers: ['S.No', 'Name of Student', 'Adm No', 'DOB', 'Class', 'Father Mobile', 'Sex'],
  rows: [
    ['1', 'Meera Menon', 'A-101', '14/06/2013', 'VI-A', '+91 98450-12345', 'F'],
    ['2', 'Arjun Rao', 'A-102', '41000', 'Std 6 B', '098450 67890', 'm'],
    ['', '', '', '', '', '', ''],
  ],
}

test('normalisers: class names, dates, phones', () => {
  assert.deepEqual(parseClassCell('VI-A'), { level: 6, section: 'A', raw: 'VI-A' })
  assert.deepEqual(parseClassCell('Std 10 B')?.level, 10)
  assert.equal(parseClassCell('6th')?.level, 6)
  assert.equal(parseClassCell('Class XII')?.level, 12)
  assert.equal(parseClassCell('UKG-B')?.section, 'B')
  assert.equal(parseClassCell('Science club'), null)
  assert.equal(toIsoDate('14/06/2013'), '2013-06-14')
  assert.equal(toIsoDate('41000'), '2012-04-01')
  assert.equal(toIsoDate('15-Aug-26'), '2026-08-15')
  assert.equal(toIsoDate('June 12, 2021'), '2021-06-12')
  assert.equal(toIsoDate('31/02/2020'), '')
  assert.equal(normalisePhone('+91 98450-12345'), '9845012345')
  assert.equal(normalisePhone('098450 67890'), '9845067890')
  assert.equal(normalisePhone('9845012345.0'), '9845012345')
})

test('heuristic proposal: picks students and maps the office headers', () => {
  const p = heuristicProposal(SHEET, KINDS)
  assert.equal(p.kind, 'students')
  const m = Object.fromEntries(p.mapping.map((x) => [x.header, x.field]))
  assert.deepEqual(m, { 'S.No': null, 'Name of Student': 'full_name', 'Adm No': 'admission_no', DOB: 'date_of_birth', Class: 'class', 'Father Mobile': 'father_phone', Sex: 'gender' })
})

test('AI proposal with a fake Gemini: validated against real fields, merged with the rules', async () => {
  const gem = fakeGemini(() => JSON.stringify({
    kind: 'students', confidence: 0.93, notes: ['S.No is a serial number and is skipped.'],
    mapping: [
      { header: 'Name of Student', field: 'full_name', confidence: 0.98 },
      { header: 'Adm No', field: 'admission_no', confidence: 0.95 },
      { header: 'DOB', field: 'date_of_birth', confidence: 0.9 },
      { header: 'Class', field: 'class', confidence: 0.9 },
      { header: 'Father Mobile', field: 'made_up_field', confidence: 0.9 }, // not a real field: dropped
      { header: 'S.No', field: 'full_name', confidence: 0.2 },             // duplicate field: dropped
    ],
  }))
  const p = await proposeImport(gem, SHEET, KINDS)
  assert.equal(p.by, 'ai')
  assert.equal(p.kind_confidence, 0.93)
  const m = Object.fromEntries(p.mapping.map((x) => [x.header, x.field]))
  assert.equal(m['Father Mobile'], 'father_phone', 'the rules fill in where the model was wrong')
  assert.equal(m['Sex'], 'gender')
  assert.equal(m['S.No'], null)
  assert.deepEqual(p.notes, ['S.No is a serial number and is skipped.'])
  const sent = JSON.parse((gem.calls[0].parts[0] as { text: string }).text)
  assert.deepEqual(sent.headers, SHEET.headers)
  assert.equal(sent.kinds.length, 3)

  // A model that answers nonsense falls back to the rules.
  const bad = await proposeImport(fakeGemini(() => 'I think it is students'), SHEET, KINDS)
  assert.equal(bad.by, 'rule')
  assert.equal(bad.kind, 'students')
  // A model that is down falls back too.
  const down = await proposeImport((async () => { throw new Error('503') }) as Llm, SHEET, KINDS)
  assert.equal(down.by, 'rule')
})

test('normaliseRows + CSV: VI-A becomes the school class and section; blank rows dropped', () => {
  const kind = KINDS[0]
  const p = heuristicProposal(SHEET, KINDS)
  const { rows, changes, sourceRows } = normaliseRows(kind, SHEET, p.mapping, [{ name: 'Class 6', level: 6 }])
  assert.equal(rows.length, 2)
  assert.deepEqual(sourceRows, [0, 1])
  assert.deepEqual(rows[0], { full_name: 'Meera Menon', admission_no: 'A-101', date_of_birth: '2013-06-14', class: 'Class 6', section: 'A', father_phone: '9845012345', gender: 'female' })
  assert.equal(rows[1].class, 'Class 6')
  assert.equal(rows[1].section, 'B')
  assert.equal(rows[1].date_of_birth, '2012-04-01')
  assert.ok(changes.some((c) => c.field === 'class' && c.from === 'VI-A' && c.to === 'Class 6'))
  const csv = toImporterCSV(kind, rows)
  assert.equal(csv.split('\n')[0], 'full_name,admission_no,date_of_birth,gender,class,section,father_phone')
  // Without a school class at that level, the importer's own naming is used.
  assert.equal(normaliseRows(kind, SHEET, p.mapping, []).rows[0].class, 'Grade 6')
})

test('attendance words normalise', () => {
  const t = { headers: ['Adm No', 'Date', 'Status'], rows: [['A1', '1.9.2026', 'P'], ['A2', '01-09-2026', 'A']] }
  const p = heuristicProposal(t, KINDS, 'attendance')
  const { rows } = normaliseRows(KINDS[1], t, p.mapping, [])
  assert.deepEqual(rows, [{ admission_no: 'A1', date: '2026-09-01', status: 'present' }, { admission_no: 'A2', date: '2026-09-01', status: 'absent' }])
})

test('photo: the fake Gemini gets the image inline; uncertain cells are kept for review', async () => {
  const gem = fakeGemini(() => JSON.stringify({ headers: ['Roll', 'Name', '1', '2'], rows: [['1', 'Meera', 'P', 'A'], ['2', 'Arjun', 'P', null]], uncertain: [[1, 3]], notes: 'September register' }))
  const t = await extractTableFromImage(gem, 'aGVsbG8=', 'image/jpeg')
  assert.deepEqual(t.rows[1], ['2', 'Arjun', 'P', ''])
  assert.deepEqual(t.uncertain, [[1, 3]])
  assert.deepEqual(gem.calls[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } })
  await assert.rejects(extractTableFromImage(fakeGemini(() => 'blurry'), 'x', 'image/png'))
})

// ---- xlsx --------------------------------------------------------------------------------

test('readXLSX: our own stored workbook round-trips', async () => {
  const bytes = buildXLSX([{ name: 'Students', rows: [['Name', 'Class'], ['Meera & co', 'VI-A'], ['Arjun', null]] }])
  const r = await readXLSX(bytes)
  assert.equal(r.sheet, 'Students')
  assert.deepEqual(r.rows, [['Name', 'Class'], ['Meera & co', 'VI-A'], ['Arjun', '']])
  assert.deepEqual(gridToTable(r.rows).headers, ['Name', 'Class'])
})

test('readXLSX: deflated entries with a shared-strings table (as Excel writes)', async () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const files: [string, string][] = [
    ['xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Marks" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>Adm No</t></si><si><r><t>Mar</t></r><r><t>ks</t></r></si><si><t>A-1</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>87.5</v></c></row></sheetData></worksheet>'],
  ]
  // A minimal ZIP with method 8 (deflate), local headers + central directory.
  const parts: Uint8Array[] = [], central: Uint8Array[] = []
  let off = 0
  const le = (n: number, w: number) => { const b = new Uint8Array(w); for (let i = 0; i < w; i++) b[i] = (n >>> (8 * i)) & 255; return b }
  const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length } return o }
  for (const [name, text] of files) {
    const raw = enc(text), comp = new Uint8Array(deflateRawSync(raw)), nm = enc(name)
    const local = cat(le(0x04034b50, 4), le(20, 2), le(0, 2), le(8, 2), le(0, 4), le(0, 4), le(comp.length, 4), le(raw.length, 4), le(nm.length, 2), le(0, 2), nm, comp)
    central.push(cat(le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(8, 2), le(0, 4), le(0, 4), le(comp.length, 4), le(raw.length, 4), le(nm.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), nm))
    parts.push(local); off += local.length
  }
  const cd = cat(...central)
  const zip = cat(...parts, cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cd.length, 4), le(off, 4), le(0, 2))
  const r = await readXLSX(zip)
  assert.equal(r.sheet, 'Marks')
  assert.deepEqual(r.rows, [['Adm No', '', 'Marks'], ['A-1', '', '87.5']])
})
