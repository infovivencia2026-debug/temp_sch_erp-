import type { Ctx } from '../../router'
import { HttpError, now } from '../../http'
import { js, marks } from './common'

/* ONE BY ONE: how a course is taken (migrations 0011, 0012).

   A course (one subject in one section) is a line of steps: each module in
   order, its own days first (Day 1, Day 2, ...; sources with no day come
   last, as one more step), then its sub-modules the same way. A step is done
   when every required source on it is done and every assessment on it is
   handed in, or passed when the teacher set a pass mark. In a "sequential"
   course (the default) a step opens when the one before it is done, or when a
   teacher has unlocked it for that child; in an "open" course every step is
   open. Publish time still applies on top: a source scheduled for later is
   on its day but cannot be opened, and so holds the day back until it can
   be done.

   The same structure serves the teacher's progress grid (every child on the
   roll) and the child's own course, and the child's writes are checked
   against it: a locked source, quiz or assignment is a 403. */

export type Section = 'prereq' | 'resources' | 'tools' | 'assessment'
export const SECTIONS: Section[] = ['prereq', 'resources', 'tools', 'assessment']
export const asSection = (v: unknown): Section | null => (SECTIONS.includes(v as Section) ? (v as Section) : null)

export interface PUnit { id: string; title: string; description: string | null; sequence: number; starts_on: string | null; ends_on: string | null; parent_unit_id: string | null }
export interface PItem {
  type: 'lesson' | 'assignment' | 'quiz'; id: string; unit_id: string; day: number | null; section: Section; seq: number
  /* Counts toward the day being done. */
  required: boolean
  /* A published lesson not yet out (publish_at in the future). */
  opens_at: string | null
  pass_percent: number | null; max_marks: number | null
}
export interface PStep { key: string; unit_id: string; day: number | null; label: string; items: PItem[] }
export interface PStructure { gating: 'sequential' | 'open'; units: PUnit[]; steps: PStep[]; labels: Map<string, string> }

export interface PProgress {
  lessons: Set<string>
  /* homework_id -> what was handed in and marked */
  work: Map<string, { status: string; submitted_at: string | null; marks: number | null }>
  /* test_id -> attempts and the best score */
  quizzes: Map<string, { attempts: number; best: number | null; max: number | null }>
  unlocks: Set<string>
}

export type StepState = 'done' | 'open' | 'locked'
export interface PStepState { key: string; state: StepState; done: number; total: number; reason: string | null; opens_at: string | null }

export const stepKey = (unit: string, day: number | null) => `${unit}:${day ?? 0}`
export function dayName(day: number | null, label?: string | null): string {
  const base = day === null ? 'More' : `Day ${day}`
  return label ? (day === null ? label : `${base}: ${label}`) : base
}

/** The course's modules, days and what is on them. `studentView` leaves drafts out. */
export async function loadStructure(c: Ctx, sectionId: string, csId: string, studentView: boolean): Promise<PStructure> {
  const [set, units, labels, lessons, hw, qz] = await c.db.batch([
    c.db.prepare(`SELECT gating FROM lms_course_settings WHERE section_id = ? AND class_subject_id = ?`).bind(sectionId, csId),
    c.db.prepare(`SELECT id, title, description, sequence, starts_on, ends_on, parent_unit_id FROM syllabus_units WHERE class_subject_id = ? AND is_active = 1 ORDER BY sequence, created_at`).bind(csId),
    c.db.prepare(`SELECT d.unit_id, d.day, d.label FROM lms_unit_days d JOIN syllabus_units su ON su.id = d.unit_id WHERE su.class_subject_id = ?`).bind(csId),
    c.db.prepare(`SELECT l.id, l.unit_id, l.day, l.section, l.sequence, l.is_optional, l.is_published, l.publish_at FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id
        WHERE su.class_subject_id = ? AND (l.section_id IS NULL OR l.section_id = ?) ${studentView ? 'AND l.is_published = 1' : ''}`).bind(csId, sectionId),
    c.db.prepare(`SELECT id, lms_unit_id AS unit_id, lms_day AS day, lms_sequence AS seq, lms_pass_percent AS pass, CAST(max_marks AS REAL) AS max_marks, allow_submission
        FROM homework WHERE section_id = ? AND class_subject_id = ? AND lms_unit_id IS NOT NULL AND is_published = 1`).bind(sectionId, csId),
    c.db.prepare(`SELECT id, lms_unit_id AS unit_id, lms_day AS day, lms_sequence AS seq, lms_pass_percent AS pass FROM online_tests
        WHERE section_id = ? AND class_subject_id = ? AND lms_unit_id IS NOT NULL AND status IN ('published','closed')`).bind(sectionId, csId),
  ])
  const gating = (set.results[0] as { gating?: string } | undefined)?.gating === 'open' ? 'open' : 'sequential'
  const all = units.results as PUnit[]
  /* Top-level modules in order, each followed by its sub-modules; a sub-module of an archived module is hidden with it. */
  const ordered: PUnit[] = []
  for (const u of all.filter((x) => !x.parent_unit_id)) ordered.push(u, ...all.filter((x) => x.parent_unit_id === u.id))
  const t = now()
  const items: PItem[] = []
  for (const l of lessons.results as { id: string; unit_id: string; day: number | null; section: string | null; sequence: number; is_optional: number; is_published: number; publish_at: string | null }[]) {
    items.push({ type: 'lesson', id: l.id, unit_id: l.unit_id, day: l.day ?? null, section: asSection(l.section) ?? 'resources', seq: l.sequence ?? 0,
      required: !!l.is_published && !l.is_optional, opens_at: l.publish_at && l.publish_at > t ? l.publish_at : null, pass_percent: null, max_marks: null })
  }
  for (const h of hw.results as { id: string; unit_id: string; day: number | null; seq: number | null; pass: number | null; max_marks: number | null; allow_submission: number }[]) {
    items.push({ type: 'assignment', id: h.id, unit_id: h.unit_id, day: h.day ?? null, section: 'assessment', seq: h.seq ?? 9999, required: !!h.allow_submission,
      opens_at: null, pass_percent: h.pass ?? null, max_marks: h.max_marks ?? null })
  }
  for (const q of qz.results as { id: string; unit_id: string; day: number | null; seq: number | null; pass: number | null }[]) {
    items.push({ type: 'quiz', id: q.id, unit_id: q.unit_id, day: q.day ?? null, section: 'assessment', seq: q.seq ?? 9999, required: true, opens_at: null, pass_percent: q.pass ?? null, max_marks: null })
  }
  const lab = new Map<string, string>()
  const declared = new Map<string, Set<number>>()
  for (const d of labels.results as { unit_id: string; day: number; label: string }[]) {
    lab.set(stepKey(d.unit_id, d.day), d.label)
    if (!declared.has(d.unit_id)) declared.set(d.unit_id, new Set())
    declared.get(d.unit_id)!.add(d.day)
  }
  const rank = { lesson: 0, assignment: 1, quiz: 2 }
  const steps: PStep[] = []
  for (const u of ordered) {
    const mine = items.filter((i) => i.unit_id === u.id)
    const days = new Set<number>(studentView ? [] : declared.get(u.id) ?? [])
    for (const i of mine) if (i.day !== null) days.add(i.day)
    const nums = [...days].sort((a, b) => a - b)
    const groups: (number | null)[] = [...nums, ...(mine.some((i) => i.day === null) ? [null] : [])]
    for (const d of groups) {
      const on = mine.filter((i) => i.day === d).sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.seq - b.seq || rank[a.type] - rank[b.type])
      if (studentView && !on.length) continue
      steps.push({ key: stepKey(u.id, d), unit_id: u.id, day: d, label: lab.get(stepKey(u.id, d)) ?? '', items: on })
    }
  }
  return { gating, units: ordered, steps, labels: lab }
}

/** What each child has done in this course. */
export async function loadProgress(c: Ctx, s: PStructure, studentIds: string[]): Promise<Map<string, PProgress>> {
  const out = new Map<string, PProgress>()
  for (const id of studentIds) out.set(id, { lessons: new Set(), work: new Map(), quizzes: new Map(), unlocks: new Set() })
  if (!studentIds.length) return out
  const all = s.steps.flatMap((st) => st.items)
  const lessonIds = all.filter((i) => i.type === 'lesson').map((i) => i.id)
  const hwIds = all.filter((i) => i.type === 'assignment').map((i) => i.id)
  const qIds = all.filter((i) => i.type === 'quiz').map((i) => i.id)
  const unitIds = s.units.map((u) => u.id)
  const kids = js(studentIds)
  const q: D1PreparedStatement[] = [
    c.db.prepare(`SELECT lesson_id, student_id FROM lms_lesson_progress WHERE student_id IN (${marks()}) AND lesson_id IN (${marks()})`).bind(kids, js(lessonIds)),
    c.db.prepare(`SELECT homework_id, student_id, status, submitted_at, CAST(marks AS REAL) AS marks FROM homework_submissions WHERE student_id IN (${marks()}) AND homework_id IN (${marks()})`).bind(kids, js(hwIds)),
    c.db.prepare(`SELECT test_id, student_id, count(*) AS n, max(CAST(score AS REAL)) AS best, max(CAST(max_score AS REAL)) AS max FROM online_test_attempts
        WHERE student_id IN (${marks()}) AND test_id IN (${marks()}) AND status <> 'in_progress' GROUP BY test_id, student_id`).bind(kids, js(qIds)),
    c.db.prepare(`SELECT student_id, unit_id, day FROM lms_unlocks WHERE student_id IN (${marks()}) AND unit_id IN (${marks()})`).bind(kids, js(unitIds)),
  ]
  const [lp, hs, qa, un] = await c.db.batch(q)
  for (const r of lp.results as { lesson_id: string; student_id: string }[]) out.get(r.student_id)?.lessons.add(r.lesson_id)
  for (const r of hs.results as { homework_id: string; student_id: string; status: string; submitted_at: string | null; marks: number | null }[]) {
    out.get(r.student_id)?.work.set(r.homework_id, { status: r.status, submitted_at: r.submitted_at, marks: r.marks })
  }
  for (const r of qa.results as { test_id: string; student_id: string; n: number; best: number | null; max: number | null }[]) {
    out.get(r.student_id)?.quizzes.set(r.test_id, { attempts: r.n, best: r.best, max: r.max })
  }
  for (const r of un.results as { student_id: string; unit_id: string; day: number }[]) out.get(r.student_id)?.unlocks.add(stepKey(r.unit_id, r.day || null))
  return out
}

/** Has the child done this item, for the day's sake? */
export function satisfied(i: PItem, p: PProgress): boolean {
  if (i.type === 'lesson') return p.lessons.has(i.id)
  if (i.type === 'assignment') {
    const w = p.work.get(i.id)
    if (!w) return false
    if (i.pass_percent !== null) return w.status === 'graded' && w.marks !== null && !!i.max_marks && (100 * w.marks) / i.max_marks >= i.pass_percent
    return w.status === 'graded' || (!!w.submitted_at && w.status !== 'resubmit')
  }
  const q = p.quizzes.get(i.id)
  if (!q || q.attempts < 1) return false
  if (i.pass_percent === null) return true
  return q.best !== null && !!q.max && (100 * q.best) / q.max >= i.pass_percent
}

/** Every step's state for one child. */
export function computeSteps(s: PStructure, p: PProgress): PStepState[] {
  const unit = new Map(s.units.map((u) => [u.id, u]))
  const name = (st: PStep, from: PStep) => {
    const d = dayName(st.day, st.label)
    return st.unit_id === from.unit_id ? d : `${d} (${unit.get(st.unit_id)?.title ?? 'the module before'})`
  }
  const out: PStepState[] = []
  let prevOpen = true, prevDone = true
  let blocker: PStep | null = null
  s.steps.forEach((st, k) => {
    const req = st.items.filter((i) => i.required)
    const done = req.filter((i) => satisfied(i, p)).length
    const complete = done === req.length
    const later = st.items.filter((i) => i.opens_at).map((i) => i.opens_at!).sort()[0] ?? null
    const open = s.gating === 'open' || k === 0 || p.unlocks.has(st.key) || (prevOpen && prevDone)
    if (!open && !blocker) blocker = s.steps[k - 1]
    out.push({ key: st.key, state: complete && open ? 'done' : open ? 'open' : 'locked', done, total: req.length,
      reason: open ? null : `Finish ${name(blocker ?? s.steps[k - 1], st)} to unlock`, opens_at: later })
    prevOpen = open; prevDone = complete
    if (open) blocker = null
  })
  return out
}

/** For the child's writes: the step an item is on must be open, or this is a 403 with the reason. */
export function assertOpen(s: PStructure, states: PStepState[], type: PItem['type'], id: string) {
  const k = s.steps.findIndex((st) => st.items.some((i) => i.type === type && i.id === id))
  if (k < 0) return
  const st = states[k]
  if (st.state === 'locked') throw new HttpError(403, `${st.reason ?? 'This is locked'}.`, { code: 'locked' })
}
