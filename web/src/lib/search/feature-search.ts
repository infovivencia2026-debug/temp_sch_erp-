import { SEARCH_ALIASES } from '@/lib/search-aliases'

/* THE LAUNCHER'S RANKER.

   The "All features" sheet used to filter by substring and rank by where the
   substring sat. That answers "fee" and nothing else: "s360" found nothing,
   "fee def" found nothing, "attnd" found nothing, "bus" found nothing because
   the screen is called Transport. A launcher search is used by people who do
   not know what the screen is called -- that is why they are searching -- so
   it has to meet them at the words they have: a prefix, the initials, a
   half-remembered phrase, a synonym, a typo, a word from the description.

   Pure, synchronous and allocation-light: it runs on every keystroke across a
   few hundred features and must never be the reason the field lags. Nothing
   here touches the DOM; BentoLauncher draws what it returns. */

export interface SearchDoc {
  key: string
  name: string
  slug: string
  /** The section the feature is filed under, and the workspace that groups
      sections. Both are searched, both rank under the feature's own name. */
  section: string
  workspace: string
  /** The catalogue's one-paragraph description. */
  summary?: string
}

export interface SearchHit<D extends SearchDoc = SearchDoc> {
  doc: D
  score: number
  /** Which characters of the name were matched, as [start, end) runs, so
      the launcher can set them a shade bolder. Empty when the match landed
      elsewhere (an alias, the section, the summary). */
  runs: [number, number][]
}

/* WHAT PEOPLE CALL THINGS (owner, 2026-10-01). Keyed by slug like
   SEARCH_ALIASES, which is folded in too; this list is the launcher's own
   extras: product words against the school's words, plus a few Telugu words
   and their Latin spellings, which cost nothing and are what a Telugu-medium
   office types. A word earns its place by being what someone typed when they
   could not find the screen. */
export const LAUNCHER_ALIASES: Record<string, string[]> = {
  // marks -> gradebook, results
  marks_entry: ['marks', 'gradebook', 'grades', 'markulu', 'మార్కులు'],
  exams_grades: ['marks', 'gradebook', 'grades', 'markulu', 'మార్కులు'],
  mark_moderation: ['marks', 'gradebook'],
  marks_report_cards: ['marks', 'results', 'report card', 'markulu', 'మార్కులు'],
  results_report_cards: ['marks', 'results', 'result', 'report card', 'markulu', 'మార్కులు'],
  exams_results: ['marks', 'results', 'result', 'markulu', 'మార్కులు'],
  academic_performance: ['marks', 'results', 'performance'],
  // bus -> transport
  transport: ['bus', 'buses', 'vehicle', 'route', 'bussu', 'బస్సు'],
  transport_office: ['bus', 'buses', 'vehicle', 'bussu', 'బస్సు'],
  my_bus_route: ['bus', 'bussu', 'బస్సు'],
  my_childs_bus: ['bus', 'where is the bus', 'bussu', 'బస్సు'],
  live_bus_tracking: ['bus', 'bussu', 'బస్సు'],
  routes_stops: ['bus', 'transport'],
  // pay -> fees
  fees: ['pay', 'payment', 'fee', 'dues', 'feeju', 'ఫీజు'],
  fees_payments: ['pay', 'payment', 'fee', 'feeju', 'ఫీజు'],
  fee_collection: ['pay', 'fee', 'feeju', 'ఫీజు'],
  take_fee_payment: ['pay', 'fee', 'feeju', 'ఫీజు'],
  fee_dashboard: ['pay', 'fee', 'fees', 'feeju', 'ఫీజు'],
  fee_overview: ['pay', 'fee', 'fees', 'feeju', 'ఫీజు'],
  fee_default: ['fee defaulters', 'defaulter', 'bakayi', 'బకాయి'],
  online_fee_portal: ['pay', 'pay online', 'feeju', 'ఫీజు'],
  // LMS / courses
  lms: ['courses', 'course', 'learning', 'e-learning', 'elearning', 'online class', 'lessons'],
  courses: ['lms', 'learning', 'lessons', 'subjects'],
  courses_subjects: ['lms', 'learning'],
  lms_study_material_upload: ['courses', 'course', 'study material', 'notes'],
  // status -> Class Status
  class_status: ['status', 'class update', 'what happened in class', 'post'],
  // attendance
  attendance: ['present', 'absent', 'hajaru', 'హాజరు'],
  take_attendance: ['present', 'absent', 'hajaru', 'హాజరు'],
  attendance_overview: ['present', 'absent', 'hajaru', 'హాజరు'],
  staff_attendance_register: ['hajaru', 'హాజరు'],
  // timetable, leave, salary
  timetable: ['periods', 'schedule', 'time table', 'tt'],
  my_timetable: ['periods', 'schedule', 'time table', 'tt'],
  class_timetable: ['periods', 'schedule', 'time table', 'tt'],
  master_timetable: ['tt'],
  leave: ['selavu', 'సెలవు', 'time off', 'holiday'],
  apply_for_leave: ['selavu', 'సెలవు', 'time off', 'holiday'],
  leave_absence: ['selavu', 'సెలవు'],
  payroll: ['salary', 'jeetham', 'జీతం', 'payslip', 'wages'],
  monthly_payroll: ['jeetham', 'జీతం'],
  salary_setup: ['jeetham', 'జీతం', 'pay structure'],
  // library, homework, students
  library: ['books', 'book', 'pustakam', 'పుస్తకం'],
  homework: ['hw', 'home work', 'assignment'],
  homework_assignments: ['hw', 'home work'],
  homework_classwork: ['hw', 'home work'],
  student_360: ['student', 'profile', 'vidyarthi', 'విద్యార్థి'],
  enquiries: ['lead', 'leads', 'enquiry', 'inquiry'],
}

const SPLIT = /[\s&/(),.\-_·:]+/

/** Lowercased, accents folded, so "Résumé" and "resume" are the same word. */
export function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function words(s: string): string[] {
  return fold(s).split(SPLIT).filter(Boolean)
}

/** One edit apart: a letter swapped, dropped, added or two transposed. */
export function within1(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let diff = -1
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        if (diff !== -1) {
          return i === diff + 1 && a[i] === b[diff] && a[diff] === b[i] && a.slice(i + 1) === b.slice(i + 1)
        }
        diff = i
      }
    }
    return true
  }
  const [s, l] = la < lb ? [a, b] : [b, a]
  let i = 0
  while (i < s.length && s[i] === l[i]) i++
  return s.slice(i) === l.slice(i + 1)
}

/* A prepared document: everything lowercased once, at index time, so the
   per-keystroke work is comparisons and nothing else. */
interface Prepared<D extends SearchDoc> {
  doc: D
  name: string
  nameWords: string[]
  /** Where each word of the name starts in the original string. */
  wordAt: number[]
  initials: string
  compact: string
  aliases: string[]
  section: string
  workspace: string
  summaryWords: string[]
}

export interface FeatureIndex<D extends SearchDoc = SearchDoc> {
  docs: Prepared<D>[]
}

export function buildIndex<D extends SearchDoc>(docs: D[]): FeatureIndex<D> {
  return {
    docs: docs.map((doc) => {
      const name = fold(doc.name)
      const wordAt: number[] = []
      const nameWords: string[] = []
      const re = /[^\s&/(),.\-_·:]+/g
      let m: RegExpExecArray | null
      while ((m = re.exec(name))) { wordAt.push(m.index); nameWords.push(m[0]) }
      const aliases = [...(SEARCH_ALIASES[doc.slug] ?? []), ...(LAUNCHER_ALIASES[doc.slug] ?? [])].map(fold)
      return {
        doc,
        name,
        nameWords,
        wordAt,
        initials: nameWords.map((w) => w[0]).join(''),
        compact: nameWords.join(''),
        aliases,
        section: fold(doc.section),
        workspace: fold(doc.workspace),
        summaryWords: doc.summary ? words(doc.summary) : [],
      }
    }),
  }
}

/* SUBSEQUENCE, SCORED. Every character of the needle must appear in the
   haystack in order; the score rewards landing on a word start and staying
   contiguous, and punishes gaps, so "s360" against "student 360" (one word
   start, then three in a run) beats a scatter of the same letters across a
   long name. Returns null when the needle cannot be threaded through. Greedy
   with a word-start preference, which is right far more often than a full
   dynamic programme and runs in a single pass. */
function thread(needle: string, hay: string, starts: Set<number>): { q: number; idx: number[] } | null {
  const idx: number[] = []
  let from = 0
  let q = 0
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i]
    let at = -1
    // Prefer the next word start carrying this letter, if one is near.
    for (let j = from; j < hay.length; j++) {
      if (hay[j] === c && starts.has(j)) { at = j; break }
      if (hay[j] === c && at < 0) at = j
      if (at >= 0 && j - at > 2) break
    }
    if (at < 0) return null
    const prev = idx[idx.length - 1]
    if (prev !== undefined && at === prev + 1) q += 3
    else if (starts.has(at)) q += 2
    else q -= Math.min(3, at - (prev ?? -1) - 1) * 0.25
    idx.push(at)
    from = at + 1
  }
  return { q, idx }
}

function runsOf(idx: number[]): [number, number][] {
  const out: [number, number][] = []
  for (const i of idx) {
    const last = out[out.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else out.push([i, i + 1])
  }
  return out
}

/** Score one document against the folded needle, or null for no match. */
function scoreDoc<D extends SearchDoc>(p: Prepared<D>, needle: string, qWords: string[]): SearchHit<D> | null {
  const starts = new Set(p.wordAt)
  // 1. The whole name.
  if (p.name === needle) return { doc: p.doc, score: 100, runs: [[0, p.name.length]] }
  // 2. Its start.
  if (p.name.startsWith(needle)) return { doc: p.doc, score: 85, runs: [[0, needle.length]] }
  // 3. An alias, whole: what the school calls it. A deliberate statement
  //    ("bus" IS Transport) ties with a name that begins with the same
  //    letters (Bus breakdown...), and the shorter name wins the tie.
  for (const a of p.aliases) {
    if (a === needle) return { doc: p.doc, score: 85, runs: [] }
  }
  // 4. The start of a word in it.
  for (let w = 0; w < p.nameWords.length; w++) {
    if (p.nameWords[w].startsWith(needle)) {
      return { doc: p.doc, score: 72, runs: [[p.wordAt[w], p.wordAt[w] + needle.length]] }
    }
  }
  // 4. Every word of a phrase landing at a word start, in any order:
  //    "fee def" -> Fee defaulters; "card report" -> Report cards.
  if (qWords.length > 1) {
    const runs: [number, number][] = []
    const used = new Set<number>()
    let all = true
    for (const qw of qWords) {
      let hit = -1
      for (let w = 0; w < p.nameWords.length; w++) {
        if (!used.has(w) && p.nameWords[w].startsWith(qw)) { hit = w; break }
      }
      if (hit < 0) { all = false; break }
      used.add(hit)
      runs.push([p.wordAt[hit], p.wordAt[hit] + qw.length])
    }
    if (all) return { doc: p.doc, score: 68, runs: runs.sort((a, b) => a[0] - b[0]) }
  }
  // 5. The start of an alias, or of a word in one.
  for (const a of p.aliases) {
    if (a.startsWith(needle) || a.split(' ').some((w) => w.startsWith(needle))) {
      return { doc: p.doc, score: 58, runs: [] }
    }
  }
  // 6. Initials: "s360" is not initials but "tfp" is Take Fee Payment.
  if (needle.length >= 2 && p.initials.startsWith(needle)) {
    return { doc: p.doc, score: 56, runs: p.wordAt.slice(0, needle.length).map((i) => [i, i + 1]) }
  }
  // 7. Anywhere in the name.
  const at = p.name.indexOf(needle)
  if (at >= 0) return { doc: p.doc, score: 50, runs: [[at, at + needle.length]] }
  // 8. Section or workspace: gathers a family.
  if (p.section.startsWith(needle) || p.workspace.startsWith(needle)) return { doc: p.doc, score: 34, runs: [] }
  // 9. Threaded through the name: "s360", "attnd", "stu360".
  const compactNeedle = needle.replace(/\s+/g, '')
  if (compactNeedle.length >= 2) {
    const t = thread(compactNeedle, p.name, starts)
    if (t) {
      const quality = t.q / (compactNeedle.length * 3) // 1 = fully contiguous
      /* A thread must begin on a word -- "tmtbl" is Timetable, "mtbl" is
         nobody's abbreviation -- and a thread that is mostly gaps across a
         long name is noise. */
      if (starts.has(t.idx[0]) && quality >= 0.15) {
        return { doc: p.doc, score: 30 + Math.round(quality * 14), runs: runsOf(t.idx) }
      }
    }
  }
  // 10. A typo: each word of the query within one edit of a word of the
  //     name or an alias (four letters or more, so "fees" never reaches "fines").
  if (qWords.every((qw) => qw.length >= 4 && (
    p.nameWords.some((nw) => within1(qw, nw)) ||
    p.aliases.some((a) => a.split(' ').some((aw) => within1(qw, aw)))
  ))) {
    const runs: [number, number][] = []
    for (const qw of qWords) {
      const w = p.nameWords.findIndex((nw) => within1(qw, nw))
      if (w >= 0) runs.push([p.wordAt[w], p.wordAt[w] + p.nameWords[w].length])
    }
    return { doc: p.doc, score: 28, runs: runs.sort((a, b) => a[0] - b[0]) }
  }
  // 11. Section or workspace, anywhere.
  if (p.section.includes(needle) || p.workspace.includes(needle)) return { doc: p.doc, score: 22, runs: [] }
  // 12. The description: every real word of the query (three letters or
  //     more; "a" and "to" are not a search) at the start of a word in it.
  const real = qWords.filter((qw) => qw.length >= 3)
  if (real.length && real.every((qw) => p.summaryWords.some((sw) => sw.startsWith(qw)))) {
    return { doc: p.doc, score: 14, runs: [] }
  }
  return null
}

/** A best hit at or above this matched the name (or an alias) itself. */
const NAME_FLOOR = 50
/** Hits under this matched only the description. */
const SUMMARY_CEILING = 20

export interface RankOptions {
  /** Keys this person opened lately, most recent first. */
  recent?: string[]
  /** Keys this person pinned. */
  pinned?: string[]
  limit?: number
}

/** The hits for a query, best first; a tie breaks on the shorter name, then
    the alphabet. Empty query: no hits (the launcher shows its grid). */
export function rank<D extends SearchDoc>(index: FeatureIndex<D>, query: string, opts: RankOptions = {}): SearchHit<D>[] {
  const needle = fold(query).trim().replace(/\s+/g, ' ')
  if (!needle) return []
  const qWords = needle.split(' ').filter(Boolean)
  const recent = opts.recent ?? []
  const pinned = new Set(opts.pinned ?? [])
  const out: SearchHit<D>[] = []
  for (const p of index.docs) {
    const h = scoreDoc(p, needle, qWords)
    if (!h) continue
    /* Where you were and what you keep: a small lift, enough to settle a tie
       in favour of the screen this person actually uses, never enough to put
       a fuzzy hit over an exact one. */
    const r = recent.indexOf(p.doc.key)
    if (r >= 0) h.score += Math.max(1, 5 - r)
    if (pinned.has(p.doc.key)) h.score += 4
    out.push(h)
  }
  out.sort((a, b) =>
    b.score - a.score ||
    a.doc.name.length - b.doc.name.length ||
    a.doc.name.localeCompare(b.doc.name),
  )
  /* WHEN THE NAME ANSWERS, THE DESCRIPTION KEEPS QUIET. "fee" matches the
     fee screens by name and a dozen others whose paragraph merely mentions
     fees; listing those under a real answer is how a result list becomes a
     second catalogue. A description match is shown only when nothing better
     was found -- which is exactly when it is useful. */
  const kept = out.length && out[0].score >= NAME_FLOOR ? out.filter((h) => h.score >= SUMMARY_CEILING) : out
  return opts.limit ? kept.slice(0, opts.limit) : kept
}

/* ---- recent searches ---------------------------------------------------- */

export const RECENT_SEARCHES_KEY = 'erp.launcher.searches'
export const RECENT_SEARCHES_LIMIT = 5

export function readRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).slice(0, RECENT_SEARCHES_LIMIT) : []
  } catch {
    return []
  }
}

export function withRecentSearch(list: string[], q: string): string[] {
  const s = q.trim()
  if (!s) return list
  return [s, ...list.filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, RECENT_SEARCHES_LIMIT)
}

export function recordRecentSearch(q: string): string[] {
  const next = withRecentSearch(readRecentSearches(), q)
  try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  return next
}
