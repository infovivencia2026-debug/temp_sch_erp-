/* Port of internal/timetable/solver.go: greedy round-robin placement with a
   bounded repair pass, and the written report of what could not be placed.

   Pure, as the Go package is: no database, no clock. The one difference is
   the random source. Go seeds math/rand's additive lagged Fibonacci
   generator; this seeds mulberry32. The same seed therefore gives the same
   draft on every Worker run, but not the grid the Go server would have
   produced for that seed. Only the per-slot tie-break jitter is random, so
   the constraints, the order and the report are unchanged. */

export interface Slot { weekday: number; periodId: string }
export interface Period { id: string; name: string; sequence: number }
export interface Grid { weekdays: number[]; periods: Period[] }
export interface Requirement {
  sectionId: string; sectionName: string; classSubjectId: string; subjectName: string
  teacherId: string; periodsPerWeek: number; maxPerDay: number; difficult: boolean
}
export interface Teacher { userId: string; name: string; maxPerDay: number; maxPerWeek: number; unavailable: Slot[]; committed: Slot[] }
export interface Input { grid: Grid; requirements: Requirement[]; teachers: Teacher[]; seed: number; retryBudget: number }
export interface Placement {
  sectionId: string; sectionName: string; classSubjectId: string; subjectName: string
  teacherId: string; weekday: number; periodId: string
}
export interface Issue {
  kind: string; severity: string
  sectionId: string; sectionName: string; classSubjectId: string; subjectName: string
  teacherId: string; teacherName: string
  required: number; placed: number; detail: string
}
export interface Result { placements: Placement[]; issues: Issue[]; required: number; placed: number; moves: number }

export const SEVERITY_BLOCKING = 'blocking'
export const SEVERITY_WARNING = 'warning'

const BLK_SECTION_BUSY = 0, BLK_TEACHER_BUSY = 1, BLK_UNAVAILABLE = 2, BLK_DAY_CAP = 3, BLK_WEEK_CAP = 4, BLK_STACKING = 5, BLK_REASONS = 6
const blockerNames = [
  'the section is already teaching something in every remaining slot',
  'the teacher is already taking another class in every remaining slot',
  'the teacher is marked unavailable in every remaining slot',
  'the teacher would exceed their daily period limit',
  'the teacher has no room left in their weekly period limit',
  'the subject would have to be stacked more than once a day',
]

function mulberry32(seed: number): () => number {
  let a = (Math.trunc(seed) ^ Math.trunc(seed / 4294967296)) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const slotKey = (s: Slot) => s.weekday + '|' + s.periodId
const skey = (section: string, s: Slot) => section + '|' + s.weekday + '|' + s.periodId
const tkey = (teacher: string, s: Slot) => teacher + '|' + s.weekday + '|' + s.periodId
const dkey = (id: string, weekday: number) => id + '|' + weekday
const rkey = (req: number, weekday: number) => req + '|' + weekday

function gridSlots(g: Grid, sortedPeriods: Period[]): Slot[] {
  const days = [...g.weekdays].sort((a, b) => a - b)
  const out: Slot[] = []
  for (const d of days) for (const p of sortedPeriods) out.push({ weekday: d, periodId: p.id })
  return out
}

const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by)
const get = (m: Map<string, number>, k: string) => m.get(k) ?? 0

class State {
  slots: Slot[]
  sortedPeriods: Period[]
  seq = new Map<string, number>()
  jitter = new Map<string, number>()
  teachers = new Map<string, Teacher & { unavailableSet: Set<string> }>()
  placements: Placement[] = []
  owner: number[] = []
  secAt = new Map<string, number>()
  teachAt = new Set<string>()
  teachDay = new Map<string, number>()
  teachWk = new Map<string, number>()
  subjDay = new Map<string, number>()
  secDay = new Map<string, number>()
  remaining: number[]
  placed: number[]
  blocked: number[][]
  stacked: boolean[]
  moves = 0
  budget: number

  constructor(public input: Input) {
    this.sortedPeriods = [...input.grid.periods].sort((a, b) => a.sequence - b.sequence)
    this.slots = gridSlots(input.grid, this.sortedPeriods)
    const rng = mulberry32(input.seed)
    this.budget = input.retryBudget
    if (this.budget === 0) {
      let total = 0
      for (const r of input.requirements) total += r.periodsPerWeek
      this.budget = 2 * total
    }
    if (this.budget < 0) this.budget = 0
    for (const p of input.grid.periods) this.seq.set(p.id, p.sequence)
    for (const s of this.slots) this.jitter.set(slotKey(s), Math.floor(rng() * 1024))
    for (const src of input.teachers) {
      const t = { ...src, unavailableSet: new Set(src.unavailable.map(slotKey)) }
      if (t.maxPerWeek <= 0) t.maxPerWeek = this.slots.length
      if (t.maxPerDay <= 0) t.maxPerDay = input.grid.periods.length
      this.teachers.set(t.userId, t)
      for (const s of t.committed) {
        this.teachAt.add(tkey(t.userId, s))
        inc(this.teachDay, dkey(t.userId, s.weekday))
        inc(this.teachWk, t.userId)
      }
    }
    const n = input.requirements.length
    this.remaining = input.requirements.map((r) => r.periodsPerWeek)
    this.placed = new Array(n).fill(0)
    this.blocked = Array.from({ length: n }, () => new Array(BLK_REASONS).fill(0))
    this.stacked = new Array(n).fill(false)
  }

  dayCap(ri: number): number {
    const r = this.input.requirements[ri]
    if (r.maxPerDay > 0) return r.maxPerDay
    const days = this.input.grid.weekdays.length
    if (days === 0) return 1
    return Math.max(1, Math.floor((r.periodsPerWeek + days - 1) / days))
  }

  requirementOrder(): number[] {
    const list = this.input.requirements.map((r, idx) => {
      let room = this.slots.length
      const t = this.teachers.get(r.teacherId)
      if (t) {
        room = 0
        for (const s of this.slots) if (!t.unavailableSet.has(slotKey(s)) && !this.teachAt.has(tkey(t.userId, s))) room++
        if (t.maxPerWeek < room) room = t.maxPerWeek
      }
      const tension = room > 0 ? r.periodsPerWeek / room : 1000
      return { idx, tension, req: r }
    })
    list.sort((a, b) => {
      if (a.tension !== b.tension) return b.tension - a.tension
      if (a.req.difficult !== b.req.difficult) return a.req.difficult ? -1 : 1
      if (a.req.sectionName !== b.req.sectionName) return cmp(a.req.sectionName, b.req.sectionName)
      if (a.req.subjectName !== b.req.subjectName) return cmp(a.req.subjectName, b.req.subjectName)
      return cmp(a.req.classSubjectId, b.req.classSubjectId)
    })
    return list.map((s) => s.idx)
  }

  blockers(ri: number, s: Slot, slack: number): number {
    const r = this.input.requirements[ri]
    if (this.secAt.has(skey(r.sectionId, s))) return BLK_SECTION_BUSY
    const t = this.teachers.get(r.teacherId)
    if (t) {
      if (this.teachAt.has(tkey(t.userId, s))) return BLK_TEACHER_BUSY
      if (t.unavailableSet.has(slotKey(s))) return BLK_UNAVAILABLE
      if (get(this.teachWk, t.userId) >= t.maxPerWeek) return BLK_WEEK_CAP
      if (get(this.teachDay, dkey(t.userId, s.weekday)) >= t.maxPerDay) return BLK_DAY_CAP
    }
    if (get(this.subjDay, rkey(ri, s.weekday)) >= this.dayCap(ri) + slack) return BLK_STACKING
    return -1
  }

  score(ri: number, s: Slot): number {
    const r = this.input.requirements[ri]
    let sc = 0
    sc += 1000 * get(this.subjDay, rkey(ri, s.weekday))
    sc += 40 * get(this.secDay, dkey(r.sectionId, s.weekday))
    const t = this.teachers.get(r.teacherId)
    if (t) {
      sc += 30 * get(this.teachDay, dkey(t.userId, s.weekday))
      sc += 60 * this.gapDelta(t.userId, s)
    }
    sc += (r.difficult ? 12 : 2) * (this.seq.get(s.periodId) ?? 0)
    return sc * 1024 + (this.jitter.get(slotKey(s)) ?? 0)
  }

  gapDelta(teacher: string, s: Slot): number {
    return this.gaps(teacher, s.weekday, s.periodId) - this.gaps(teacher, s.weekday, '')
  }

  gaps(teacher: string, weekday: number, extra: string): number {
    const ps = this.sortedPeriods
    let first = -1, last = -1
    const busy: boolean[] = new Array(ps.length).fill(false)
    for (let i = 0; i < ps.length; i++) {
      if (this.teachAt.has(teacher + '|' + weekday + '|' + ps[i].id) || ps[i].id === extra) {
        busy[i] = true
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0) return 0
    let n = 0
    for (let i = first + 1; i < last; i++) if (!busy[i]) n++
    return n
  }

  placeOne(ri: number): boolean {
    for (const slack of [0, 1, this.input.grid.periods.length]) {
      if (this.tryPlace(ri, slack)) {
        if (slack > 0) this.stacked[ri] = true
        return true
      }
    }
    return this.repair(ri)
  }

  tryPlace(ri: number, slack: number): boolean {
    let best = -1, bestScore = 0
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      const b = this.blockers(ri, s, slack)
      if (b >= 0) {
        if (slack === 0) this.blocked[ri][b]++
        continue
      }
      const sc = this.score(ri, s)
      if (best < 0 || sc < bestScore) { best = i; bestScore = sc }
    }
    if (best < 0) return false
    this.commit(ri, this.slots[best])
    return true
  }

  commit(ri: number, s: Slot): void {
    const r = this.input.requirements[ri]
    const idx = this.placements.length
    this.placements.push({ sectionId: r.sectionId, sectionName: r.sectionName, classSubjectId: r.classSubjectId,
      subjectName: r.subjectName, teacherId: r.teacherId, weekday: s.weekday, periodId: s.periodId })
    this.secAt.set(skey(r.sectionId, s), idx)
    inc(this.secDay, dkey(r.sectionId, s.weekday))
    inc(this.subjDay, rkey(ri, s.weekday))
    if (r.teacherId !== '') {
      this.teachAt.add(tkey(r.teacherId, s))
      inc(this.teachDay, dkey(r.teacherId, s.weekday))
      inc(this.teachWk, r.teacherId)
    }
    this.remaining[ri]--
    this.placed[ri]++
    this.owner.push(ri)
  }

  uncommit(idx: number): void {
    const p = this.placements[idx]
    const ri = this.owner[idx]
    const s: Slot = { weekday: p.weekday, periodId: p.periodId }
    this.secAt.delete(skey(p.sectionId, s))
    inc(this.secDay, dkey(p.sectionId, s.weekday), -1)
    inc(this.subjDay, rkey(ri, s.weekday), -1)
    if (p.teacherId !== '') {
      this.teachAt.delete(tkey(p.teacherId, s))
      inc(this.teachDay, dkey(p.teacherId, s.weekday), -1)
      inc(this.teachWk, p.teacherId, -1)
    }
    this.remaining[ri]++
    this.placed[ri]--
    this.placements[idx].sectionId = ''
  }

  repair(ri: number): boolean {
    if (this.moves >= this.budget) return false
    const r = this.input.requirements[ri]
    const slack = this.input.grid.periods.length
    for (const s of this.slots) {
      const holder = this.secAt.get(skey(r.sectionId, s))
      if (holder === undefined) continue
      let blockedBySomethingElse = false
      const t = this.teachers.get(r.teacherId)
      if (t) {
        if (this.teachAt.has(tkey(t.userId, s)) || get(this.teachDay, dkey(t.userId, s.weekday)) >= t.maxPerDay ||
          get(this.teachWk, t.userId) >= t.maxPerWeek) blockedBySomethingElse = true
        if (t.unavailableSet.has(slotKey(s))) blockedBySomethingElse = true
      }
      if (blockedBySomethingElse) continue

      const hri = this.owner[holder]
      this.moves++
      this.uncommit(holder)
      if (!this.tryPlace(ri, slack)) {
        this.commit(hri, s)
        if (this.moves >= this.budget) return false
        continue
      }
      if (this.tryPlace(hri, slack)) return true
      this.uncommit(this.placements.length - 1)
      this.commit(hri, s)
      if (this.moves >= this.budget) return false
    }
    return false
  }

  preflight(): Issue[] {
    const out: Issue[] = []
    const byTeacher = new Map<string, { periods: number; subjects: string[] }>()
    for (const r of this.input.requirements) {
      if (r.teacherId === '') continue
      const d = byTeacher.get(r.teacherId) ?? { periods: 0, subjects: [] }
      d.periods += r.periodsPerWeek
      d.subjects.push(r.sectionName + ' ' + r.subjectName)
      byTeacher.set(r.teacherId, d)
    }
    for (const id of [...byTeacher.keys()].sort(cmp)) {
      const t = this.teachers.get(id)
      if (!t) continue
      const d = byTeacher.get(id)!
      const committed = t.committed.length
      if (d.periods + committed <= t.maxPerWeek) continue
      d.subjects.sort(cmp)
      out.push(issue({
        kind: 'teacher_oversubscribed', severity: SEVERITY_BLOCKING, teacherId: id, teacherName: t.name,
        required: d.periods + committed, placed: t.maxPerWeek,
        detail: `${nameOr(t.name, 'This teacher')} is asked for ${d.periods + committed} periods a week (${d.periods} here, ${committed} already committed) against a cap of ${t.maxPerWeek}. ${joinShort(d.subjects, 3)} cannot all be staffed by them.`,
      }))
    }
    const bySection = new Map<string, { name: string; periods: number }>()
    for (const r of this.input.requirements) {
      const d = bySection.get(r.sectionId) ?? { name: r.sectionName, periods: 0 }
      d.periods += r.periodsPerWeek
      bySection.set(r.sectionId, d)
    }
    const cells = this.slots.length
    for (const id of [...bySection.keys()].sort(cmp)) {
      const d = bySection.get(id)!
      if (d.periods <= cells) continue
      out.push(issue({
        kind: 'section_oversubscribed', severity: SEVERITY_BLOCKING, sectionId: id, sectionName: d.name,
        required: d.periods, placed: cells,
        detail: `${nameOr(d.name, 'This section')} needs ${d.periods} periods a week and the timetable has ${cells} teaching slots. ${d.periods - cells} periods cannot be placed anywhere.`,
      }))
    }
    return out
  }

  report(): Issue[] {
    const out: Issue[] = []
    this.input.requirements.forEach((r, i) => {
      const base = { sectionId: r.sectionId, sectionName: r.sectionName, classSubjectId: r.classSubjectId, subjectName: r.subjectName, required: r.periodsPerWeek, placed: this.placed[i] }
      if (this.placed[i] > 0 && r.teacherId === '') {
        out.push(issue({ ...base, kind: 'no_teacher', severity: SEVERITY_WARNING,
          detail: `${r.sectionName} ${r.subjectName} has ${this.placed[i]} periods in the draft and no teacher assigned to any of them.` }))
      }
      if (this.stacked[i]) {
        out.push(issue({ ...base, kind: 'subject_stacked', severity: SEVERITY_WARNING,
          detail: `${r.sectionName} ${r.subjectName} had to be doubled up on a day to fit its ${r.periodsPerWeek} periods.` }))
      }
      if (this.remaining[i] <= 0) return
      out.push(issue({ ...base, kind: 'unmet_periods', severity: SEVERITY_BLOCKING, teacherId: r.teacherId,
        teacherName: this.teachers.get(r.teacherId)?.name ?? '', detail: this.explain(i) }))
    })
    return out
  }

  explain(ri: number): string {
    const r = this.input.requirements[ri]
    const short = r.periodsPerWeek - this.placed[ri]
    const head = `${nameOr(r.sectionName, 'This section')} needs ${r.periodsPerWeek} ${r.subjectName} ${r.periodsPerWeek === 1 ? 'period' : 'periods'}; ${this.placed[ri]} placed, ${short} short.`
    const t = this.teachers.get(r.teacherId)
    if (t) {
      const wk = get(this.teachWk, t.userId)
      if (wk >= t.maxPerWeek) {
        return `${head} ${nameOr(t.name, 'The assigned teacher')} is at ${wk} of ${t.maxPerWeek} periods for the week and cannot take more.`
      }
      let full = 0
      for (const d of this.input.grid.weekdays) if (get(this.teachDay, dkey(t.userId, d)) >= t.maxPerDay) full++
      if (full === this.input.grid.weekdays.length && full > 0) {
        return `${head} ${nameOr(t.name, 'The assigned teacher')} is at their daily limit of ${t.maxPerDay} periods on every day of the week.`
      }
    }
    let worst = -1, worstN = 0
    this.blocked[ri].forEach((n, k) => { if (n > worstN) { worst = k; worstN = n } })
    if (worst < 0) return head + ' No slot in the week could take it.'
    if (t && (worst === BLK_TEACHER_BUSY || worst === BLK_UNAVAILABLE)) {
      return `${head} ${nameOr(t.name, 'The assigned teacher')}: ${blockerNames[worst]}.`
    }
    return head + ' ' + upperFirst(blockerNames[worst]) + '.'
  }
}

function issue(p: Partial<Issue> & { kind: string; severity: string; detail: string }): Issue {
  return { sectionId: '', sectionName: '', classSubjectId: '', subjectName: '', teacherId: '', teacherName: '', required: 0, placed: 0, ...p }
}
const nameOr = (s: string, fallback: string) => (s.trim() === '' ? fallback : s)
const upperFirst = (s: string) => (s === '' ? s : s[0].toUpperCase() + s.slice(1))
function joinShort(items: string[], n: number): string {
  if (items.length === 0) return ''
  if (items.length <= n) return items.join(', ')
  return `${items.slice(0, n).join(', ')} and ${items.length - n} more`
}

/** Generate produces one candidate timetable and the report on what it could not do. */
export function generate(input: Input): Result {
  const st = new State(input)
  const res: Result = { placements: [], issues: [], required: 0, placed: 0, moves: 0 }
  res.issues.push(...st.preflight())
  const order = st.requirementOrder()
  let maxRounds = 0
  for (const r of input.requirements) {
    res.required += r.periodsPerWeek
    if (r.periodsPerWeek > maxRounds) maxRounds = r.periodsPerWeek
  }
  for (let round = 0; round < maxRounds; round++) {
    for (const ri of order) {
      if (st.remaining[ri] <= 0) continue
      st.placeOne(ri)
    }
  }
  res.placements = st.placements.filter((p) => p.sectionId !== '')
  res.moves = st.moves
  for (const p of st.placed) res.placed += p
  res.issues.push(...st.report())
  res.issues.sort((a, b) => {
    const ab = a.severity === SEVERITY_BLOCKING, bb = b.severity === SEVERITY_BLOCKING
    if (ab !== bb) return ab ? -1 : 1
    if (a.sectionName !== b.sectionName) return cmp(a.sectionName, b.sectionName)
    if (a.subjectName !== b.subjectName) return cmp(a.subjectName, b.subjectName)
    return cmp(a.kind, b.kind)
  })
  res.placements.sort((a, b) => {
    if (a.sectionName !== b.sectionName) return cmp(a.sectionName, b.sectionName)
    if (a.sectionId !== b.sectionId) return cmp(a.sectionId, b.sectionId)
    if (a.weekday !== b.weekday) return a.weekday - b.weekday
    return cmp(a.periodId, b.periodId)
  })
  return res
}
