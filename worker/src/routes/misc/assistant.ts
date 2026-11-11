import type { Ctx, Router } from '../../router'
import { aiFetch } from '../../services/ai/fetch'
import { can } from '../../identity'
import { badRequest, HttpError, isUUID, ok, readJSON, unauthorized } from '../../http'
import { json } from '../../env'
import { CATALOG_ROLES } from '../admin/static_data'
import { importSpecs, SHEET_FACT_PARAMS } from '../setup/imports'
import { indiaToday, resolveScope, SECTION_SET_SQL } from '../students/common'
import { assistantFailure, assistantRateLimit, callGemini, type GeminiTurn } from '../teaching/gemini'
import { aiKey } from '../../services/ai/key'
import { HELP_ANSWERS } from './assistant/help_answers_data'
import { registerAgent } from './assistant/agent'
import { ASSISTANT_ACTIONS, ASSISTANT_ACTION_CATALOGUE, ActionRefusal, dispatch, parseProposedAction, refusalText, type ProposedAction } from './assistant/actions'

/* The in-app assistant, ported from internal/api/help_answers.go (the fast
   path), assistant_chat.go (the model, TTS), assistant_actions.go (proposed
   changes) and assistant_import.go (spreadsheets from the chat). Session-gated
   like Go: every route is 'auth', and the roles and permissions come from the
   session, never the request body. chat, tts, action and import carry Go's
   assistantRateLimit (30 a minute per user). */

// --- roles ---------------------------------------------------------------------------
/** assistantRoles: the asker's role keys from the school database. A failed lookup costs precision, not the answer. */
export async function assistantRoles(c: Ctx): Promise<string[]> {
  try {
    if (!c.id.institution) return []
    const rows = await c.db.prepare(`SELECT DISTINCT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key`)
      .bind(c.id.userId).all<{ key: string }>()
    return rows.results.map((r) => r.key).sort()
  } catch (e) {
    console.error('assistant roles', e)
    return []
  }
}

// --- the fast path (help_answers.go) -------------------------------------------------------
const STOP = new Set(['a', 'an', 'the', 'i', 'how', 'do', 'does', 'can', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'it', 'my', 'me',
  'we', 'you', 'where', 'what', 'and', 'with', 'from', 'at', 'by', 'or', 'be', 'as', 'this', 'that', 'if', 'when', 'there', 'here',
  'want', 'need', 'please', 'would', 'should', 'could'])
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const helpWords = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(stem)
const HELP_CONFIDENT = 2.0
/* Asked any way at all (owner, 2026-11-11: "how can I mark attendance" and
   "amrk attendace" got nothing, "take attendance" worked). Each word of the
   question also counts as its synonyms, and a misspelt word as the closest
   word the help knows (one or two letters off, swapped letters too). */
const SYNONYMS: string[][] = [
  ['take', 'mark', 'record', 'enter', 'entry', 'fill', 'put', 'submit', 'update'],
  ['attendance', 'attendence', 'present', 'absent', 'absentee', 'rollcall', 'roll'],
  ['fee', 'fees', 'payment', 'dues', 'collect', 'collection', 'receipt'],
  ['leave', 'holiday', 'off', 'absence'],
  ['mark', 'score', 'result', 'grade'],
  ['timetable', 'schedule', 'period', 'routine'],
  ['homework', 'assignment', 'task'],
  ['exam', 'test', 'examination', 'assessment'],
  ['student', 'pupil', 'child', 'kid', 'learner'],
  ['staff', 'teacher', 'employee', 'faculty'],
  ['salary', 'payroll', 'pay', 'payslip'],
  ['message', 'sms', 'whatsapp', 'notify', 'send', 'circular', 'notice'],
  ['report', 'card', 'marksheet', 'progress'],
  ['admission', 'enquiry', 'enroll', 'enrol', 'join', 'new'],
  ['transport', 'bus', 'van', 'route'],
  ['create', 'make', 'new', 'add', 'start'],
  ['see', 'view', 'check', 'find', 'open', 'show'],
  ['edit', 'change', 'modify', 'correct', 'fix'],
  ['delete', 'remove', 'cancel'],
  ['print', 'download', 'export', 'pdf'],
]
const SYN = new Map<string, Set<string>>()
for (const g of SYNONYMS) for (const w of g.map(stem)) {
  const set = SYN.get(w) ?? new Set([w])
  for (const x of g) set.add(stem(x))
  SYN.set(w, set)
}
let VOCAB: string[] | null = null
const vocab = () => (VOCAB ??= [...new Set(HELP_ANSWERS.flatMap((r) => [...r[4], ...r[5], ...r[6]]).concat(SYNONYMS.flat()))].filter((w) => w.length >= 3))
/** Edit distance with swapped neighbours counting as one. */
function typoDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[a.length][b.length]
}
/** The word as the help knows it: itself if known, else the closest spelling. */
function known(w: string): string {
  const v = vocab()
  if (w.length < 4 || v.includes(w) || SYN.has(w)) return w
  const max = w.length >= 7 ? 2 : 1
  let best = w, bestD = max + 1
  if (w.length < 4) return w
  for (const x of v) {
    const dd = typoDistance(w, x, max)
    // Fewest changes; on a tie, the same first letter and a word the synonyms know.
    const rank = (y: string, n: number) => n * 4 + (y[0] === w[0] ? 0 : 2) + (SYN.has(stem(y)) ? 0 : 1)
    if (dd <= max && rank(x, dd) < rank(best, bestD)) { best = x; bestD = dd }
  }
  return bestD <= max ? best : w
}
const alternatives = (w: string): string[] => { const k = known(w); return [...(SYN.get(k) ?? new Set([k]))] }

export function matchHelp(question: string, roles: string[]): { answer: string; name: string; where: string; score: number } | null {
  const fixed = question.replace(/\btime\s+table/gi, 'timetable').replace(/\bhome\s+work/gi, 'homework')
  // Spelling is checked on the word as typed ("fess" -> "fees"), then stemmed.
  const q = (fixed.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => stem(known(w)))
  if (q.length === 0) return null
  const alts = q.map(alternatives)
  const allowed = new Set(roles)
  let best: { answer: string; name: string; where: string; score: number } | null = null
  for (const [role, name, where, answer, nameW, whereW, terms] of HELP_ANSWERS) {
    if (allowed.size > 0 && !allowed.has(role)) continue
    const N = new Set(nameW), W = new Set(whereW), T = new Set(terms)
    let score = 0, hit = 0, named = 0
    // Words as typed first, then synonyms for the rest; a word counts once.
    const direct = q.map((w) => (N.has(w) ? 3 : W.has(w) ? 2 : T.has(w) ? 1 : 0))
    const used = new Set(q.filter((_, i) => direct[i] > 0))
    q.forEach((w, i) => {
      let s = direct[i], isName = N.has(w)
      if (!s) for (const a of alts[i]) {
        if (used.has(a)) continue
        const t = N.has(a) ? 2.5 : W.has(a) ? 1.5 : T.has(a) ? 0.75 : 0
        if (t > s) { s = t; isName = N.has(a); used.add(a) }
      }
      if (s) { score += s; hit++; if (isName) named++ }
    })
    if (hit === 0) continue
    const coverage = hit / q.length
    const nameMatch = nameW.length > 0 ? Math.min(1, named / nameW.length) : 0
    score = (score / q.length) * (1 + 0.5 * coverage) + 1.5 * nameMatch
    if (!best || score > best.score) best = { answer, name, where, score }
  }
  return best
}

/* A question that wants a figure, a name or a list out of the school's own
   records ("how many students", "total collections this month", "class
   teacher of grade 4") is for the agent, which can read them. The catalogue
   lookup used to answer these with a screen description because the screen's
   words matched (owner, 2026-11-05: "not answering properly"). "How do I" and
   "where is" questions stay on the fast path. */
export function asksForData(q: string): boolean {
  const t = q.toLowerCase()
  if (/\b(how\s+(do|can|to|should|would)\s+(i|we|you|a|the)|where\s+(do|can|is|are|to)|steps?\s+to|what\s+does)\b/.test(t)) return false
  return /\b(how\s+many|how\s+much|who|whom|whose|which|total|count|list|top\s+\d+|today|yesterday|tomorrow|this\s+(week|month|term|year)|last\s+(week|month)|pending|outstanding|due|absent|present|birthdays?|show\s+me|tell\s+me|give\s+me)\b/.test(t)
}

async function assistantAsk(c: Ctx): Promise<Response> {
  const req = await readJSON<{ message?: string }>(c.req)
  const roles = await assistantRoles(c)
  if (asksForData(req.message ?? '')) return ok({ answered: false })
  const m = matchHelp(req.message ?? '', roles)
  if (!m || m.score < HELP_CONFIDENT) return ok({ answered: false })
  return ok({ answered: true, answer: m.answer, screen: m.name, where: m.where })
}

// --- the slow path (assistant_chat.go) -------------------------------------------------------
const ASSISTANT_MAX_TOKENS = 1024

export const SYSTEM_PROMPT = `You are the help assistant inside a school ERP used by Indian schools.

The people asking are school staff and parents: a clerk at a fee counter, a
teacher marking a register, a principal, a parent on a phone. Answer in plain
English, in a few sentences. No preamble, no headings, no bullet lists unless
the answer really is a list of steps. Never use a dash as punctuation (no em
dash or en dash between words): write a comma, a full stop or a new sentence
instead.

Ground every answer in the screens listed below AND in the "Settings and
personalization" section that follows them. Name the screen or setting the way it
is written there, and say where it sits, so the person can find it.

If the answer is in neither, say you do not know and suggest who in the school
would. Never invent a screen, a button or a menu path that is not written here:
somebody sent to a menu item that does not exist loses more time than the refusal
would cost.

You have no access to school records. You cannot see a child, an invoice, an
attendance register or a salary, and you must not pretend to. If asked about a
specific person or figure, say that you can only explain how to find it, then
explain that.

Settings and personalization (available to everyone; open Settings from the gear
at the bottom of the screen, or in the top bar in the classic layout):
- Change the interface language, including Telugu (తెలుగు): Settings > Appearance
  > Language. It is remembered on that device and changes only that person's view.
- Switch which workspace/role you are working in: Settings > Role switch.
- Change the app colours: Settings > Colour.
- Change the layout (Sidebar or Focus), typeface, text size, density, corners and
  contrast: Settings > Appearance.
- Change the dock size and icon size: Settings > Dock.
- Arrange the home dashboard and its cards (add, resize, recolour, hide): Settings
  > Dashboard, or press and hold a card on the home board.
- Light or dark theme: the theme control in Settings > Appearance.
- Your profile and signing out: Settings > Account.
- Change your password or set up two-factor sign-in: Settings > Security.

Importing and exporting spreadsheets. Bulk import and export DO exist -- never say
they do not. A school can upload a spreadsheet to create records in bulk (class
lists, sections, subjects, periods, holidays, the timetable, class subjects,
teacher allocations, marks, student and staff attendance, students, student
history, fee heads, fee structures, fee payments, biometric punches, student
exits and payslips), and most lists in the app can be exported. The full importer lives at
Setup > Import, where each kind has a downloadable template, a dry-run that shows
which rows are wrong before anything is written, and an Import history that can
undo an upload.

You can also import a spreadsheet right here in the chat. When someone asks to
import or upload a spreadsheet, do NOT refuse: ask which kind of records it holds
(from the list above), tell them to use the matching template's columns, and tell
them to attach the CSV using the paper-clip on this panel -- once attached you
will show a preview of what will be imported before anything is saved. You do not
emit an action line for this; the attach-and-preview flow handles it.

What still cannot be imported or changed through the assistant, and what to say
so: staff salary structures, staff logins, passwords, roles and other security,
and bulk deletions. For those, tell the person they must be done by someone with
the right access on the proper setup screen.`

/** assistantGrounding: the screens this person can open, from the catalogue the navigation is built from. */
export function assistantGrounding(roles: string[]): string {
  let b = 'The screens this person can open, by workspace:\n'
  const seen = new Set<string>()
  for (const key of roles) {
    const role = CATALOG_ROLES.find((r) => r.key === key)
    if (!role) continue
    for (const sec of role.sections) for (const f of sec.features) {
      if (seen.has(f.key)) continue
      seen.add(f.key)
      b += `- ${sec.workspace} > ${sec.name} > ${f.name}${f.summary ? ': ' + f.summary : ''}\n`
    }
  }
  if (seen.size === 0) b += "- (none recorded for this person's roles)\n"
  return b
}

/* THE HISTORY, IN MEMORY AND DELIBERATELY FORGETFUL, as Go: the client sends a
   conversation id and one message, the server holds the last twelve turns for
   two hours. Per isolate here (Go: per process), so a follow-up that lands on
   another isolate starts afresh, which is the same failure Go accepted on a
   restart. */
const MAX_THREADS = 500, MAX_TURNS = 12, THREAD_TTL = 2 * 60 * 60 * 1000
const threads = new Map<string, { turns: GeminiTurn[]; seen: number }>()
function loadThread(id: string): GeminiTurn[] {
  const t = threads.get(id)
  if (!t || Date.now() - t.seen > THREAD_TTL) return []
  return [...t.turns]
}
function saveThread(id: string, turns: GeminiTurn[]): void {
  if (turns.length > MAX_TURNS) turns = turns.slice(turns.length - MAX_TURNS)
  threads.delete(id)
  threads.set(id, { turns, seen: Date.now() })
  if (threads.size <= MAX_THREADS) return
  for (const [k, v] of threads) if (Date.now() - v.seen > THREAD_TTL) threads.delete(k)
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value as string)
}

const rupees = (paise: number) => {
  const r = paise / 100
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
}
const NAME = (a: string) => `trim(replace(${a}.first_name || ' ' || COALESCE(${a}.middle_name,'') || ' ' || COALESCE(${a}.last_name,''), '  ', ' '))`

/* assistantData: a few role-scoped facts, fetched under the asker's own
   identity and each gated on the permission its own screen requires. The
   model never queries anything. Returns '' when there is nothing to add. */
async function assistantData(c: Ctx, q: string): Promise<string> {
  if (!c.id.institution) return ''
  const ql = q.toLowerCase()
  const has = (...subs: string[]) => subs.some((s) => ql.includes(s))
  const facts: string[] = []
  const today = indiaToday()
  const safe = async (f: () => Promise<void>) => { try { await f() } catch (e) { console.error('assistant data', e) } }

  if (has('on leave', 'who is away', "who's away", 'leave today') && can(c.id, 'hr.employees.read')) await safe(async () => {
    const rows = await c.db.prepare(`SELECT trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS n
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
       WHERE lr.subject_kind = 'staff' AND lr.status = 'approved' AND ? BETWEEN lr.from_date AND lr.to_date ORDER BY 1`).bind(today).all<{ n: string }>()
    const names = rows.results.map((r) => r.n)
    facts.push(names.length === 0 ? 'Staff on approved leave today: none.' : 'Staff on approved leave today: ' + names.join(', ') + '.')
  })
  if (has('absent', 'attendance today', 'present today') && can(c.id, 'academics.attendance.read.all')) await safe(async () => {
    const r = await c.db.prepare(`SELECT (SELECT count(*) FROM student_attendance WHERE on_date = ?1 AND status = 'absent') AS a,
        (SELECT count(*) FROM student_attendance WHERE on_date = ?1) AS m`).bind(today).first<{ a: number; m: number }>()
    if (r) facts.push(`Student attendance today: ${r.a} marked absent out of ${r.m} marked so far.`)
  })
  if (has('how many staff', 'staff count', 'number of staff', 'total staff') && can(c.id, 'hr.employees.read')) await safe(async () => {
    const r = await c.db.prepare(`SELECT count(*) AS n FROM employees WHERE status = 'active'`).first<{ n: number }>()
    if (r) facts.push(`Active staff on the roll: ${r.n}.`)
  })
  if (has('how many student', 'student count', 'strength', 'enrolment', 'enrollment') && can(c.id, 'students.read.all')) await safe(async () => {
    const r = await c.db.prepare(`SELECT count(*) AS n FROM students WHERE status = 'active'`).first<{ n: number }>()
    if (r) facts.push(`Active students on the roll: ${r.n}.`)
  })

  /* A named child: their class and, with the fees permission, what they owe.
     Matched by an admission number or a first name of four letters or more
     that appears in the question; at most five. */
  const wantsFee = has('fee', 'fees', 'balance', 'dues', 'owe', 'outstanding', 'pending')
  if ((has('class', 'section', 'which grade', 'roll', 'who is', 'details of', 'detail of', 'about') || wantsFee) && can(c.id, 'students.read.all')) await safe(async () => {
    const rows = await c.db.prepare(`
      SELECT st.id, ${NAME('st')} AS name, st.admission_no AS adm, cl.name AS class, sec.name AS sec,
             (SELECT e.roll_no FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS roll
        FROM students st
        LEFT JOIN classes cl ON cl.id = (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN sections sec ON sec.id = (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
       WHERE st.status = 'active'
         AND ( (?1 <> '' AND instr(?1, lower(st.admission_no)) > 0)
            OR (length(st.first_name) >= 4 AND instr(?1, lower(st.first_name)) > 0) )
       ORDER BY st.first_name LIMIT 5`).bind(ql).all<{ id: string; name: string; adm: string; class: string | null; sec: string | null; roll: number | null }>()
    for (const s of rows.results) {
      let where = 'not yet placed in a class'
      if (s.class) { where = s.class + (s.sec ? ' ' + s.sec : '') + (s.roll !== null && s.roll !== undefined ? `, roll no ${s.roll}` : '') }
      let line = `${s.name} (admission no ${s.adm}): ${where}.`
      if (wantsFee && can(c.id, 'finance.fees.read')) {
        try {
          const f = await c.db.prepare(`SELECT COALESCE((SELECT sum(net_paise) FROM invoices WHERE student_id = ?1 AND status <> 'cancelled'), 0) AS charged,
              COALESCE((SELECT sum(amount_paise) FROM payments WHERE student_id = ?1 AND status = 'success'), 0) AS paid`).bind(s.id).first<{ charged: number; paid: number }>()
          if (f) line += ` Fees: charged ${rupees(Number(f.charged))}, paid ${rupees(Number(f.paid))}, balance ${rupees(Number(f.charged) - Number(f.paid))}.`
        } catch (e) { console.error('assistant fees fact', e) }
      }
      facts.push(line)
    }
  })

  /* "List my students": the whole roll for school-wide access, the sections
     taught for a teacher, nothing for anyone else. */
  const wantsRoster = has('my student', 'my students', 'list student', 'list all student', 'class list', 'class roster', 'students in my class', 'my class list', 'list of student')
  if (wantsRoster) await safe(async () => {
    const res = await resolveScope(c)
    if (!(can(c.id, 'students.read') || res.allStudents)) return
    let where = '', args: unknown[] = []
    if (res.allStudents) where = '1'
    else if (res.sectionIds.length > 0) { where = `en_section IN (${SECTION_SET_SQL})`; const u = c.id.userId; args = [u, u, u, u] }
    if (where === '') return
    const base = `FROM (SELECT st.*, (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1) AS en_section,
                         (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1) AS en_class
                    FROM students st WHERE st.status = 'active') st
                  LEFT JOIN classes cl ON cl.id = st.en_class LEFT JOIN sections sec ON sec.id = st.en_section
                 WHERE st.en_section IS NOT NULL AND ${where}`
    const total = await c.db.prepare(`SELECT count(*) AS n ${base}`).bind(...args).first<{ n: number }>()
    const rows = await c.db.prepare(`SELECT ${NAME('st')} AS name, st.admission_no AS adm, cl.name AS class, sec.name AS sec ${base}
        ORDER BY cl.name, sec.name, st.first_name LIMIT 60`).bind(...args).all<{ name: string; adm: string; class: string | null; sec: string | null }>()
    const lines = rows.results.map((r) => {
      const place = r.class ? r.class + (r.sec ? ' ' + r.sec : '') : ''
      return place ? `${r.name} (${r.adm}), ${place}` : `${r.name} (${r.adm})`
    })
    if (lines.length === 0) { facts.push('You have no active students in your assigned classes.'); return }
    const n = Number(total?.n ?? lines.length)
    const hdr = n > lines.length ? `Students you may see (${n} total; first ${lines.length} listed, see My students for the rest)` : `Students you may see (${n})`
    facts.push(hdr + ': ' + lines.join('; ') + '.')
  })

  if (facts.length === 0) return ''
  return 'FACTS (already scoped to what you are allowed to see; use these to answer, and do not guess beyond them):\n- ' + facts.join('\n- ')
}

const canAct = (c: Ctx) => Object.values(ASSISTANT_ACTIONS).some((s) => can(c.id, s.perm))

async function assistantChat(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  const req = await readJSON<{ message?: string; conversation_id?: string; roles?: string[] }>(c.req)
  const message = req.message ?? ''
  if (message.trim() === '') throw badRequest('message is required')
  // The session's roles, not the body's.
  const roles = await assistantRoles(c)
  const conversationId = isUUID(req.conversation_id) ? req.conversation_id : crypto.randomUUID()
  const turns = loadThread(conversationId)
  turns.push({ role: 'user', text: message })

  let system = SYSTEM_PROMPT + '\n\n' + assistantGrounding(roles)
  const facts = await assistantData(c, message)
  if (facts) system += '\n\n' + facts
  if (canAct(c)) system += '\n\n' + ASSISTANT_ACTION_CATALOGUE

  let answerText: string
  try {
    answerText = await callGemini(c, system, turns, ASSISTANT_MAX_TOKENS, 60_000)
  } catch (e) {
    throw assistantFailure(e)
  }
  // A refusal is an answer, not an error.
  let answer = answerText.trim()
  if (answer === '') answer = 'I could not answer that one. Try asking it a different way, or ask the school office.'

  let proposed: ProposedAction | undefined
  const parsed = parseProposedAction(answer)
  if (parsed.kind) {
    answer = parsed.clean
    const spec = ASSISTANT_ACTIONS[parsed.kind]
    if (spec && can(c.id, spec.perm)) {
      try {
        proposed = await spec.preview(c, parsed.params ?? {})
        proposed.sensitive = spec.sensitive
      } catch (e) {
        if (!(e instanceof ActionRefusal) && !(e instanceof HttpError)) console.error('assistant preview', e)
        const msg = refusalText(e)
        answer = answer === '' ? msg : answer + '\n\n' + msg
      }
    }
  }
  if (answer === '') answer = 'Done.'
  turns.push({ role: 'model', text: answer })
  saveThread(conversationId, turns)
  return ok(proposed ? { answer, conversation_id: conversationId, action: proposed } : { answer, conversation_id: conversationId })
}

// --- the confirmed change (assistant_actions.go assistantActionExecute) ------------------------------
async function assistantAction(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  if (!c.id) throw unauthorized()
  const req = await readJSON<{ kind?: string; params?: Record<string, unknown> }>(c.req)
  const spec = ASSISTANT_ACTIONS[req.kind ?? '']
  if (!spec) throw badRequest('that action is not one the assistant can take')
  if (!can(c.id, spec.perm)) throw new HttpError(403, 'missing permission: ' + spec.perm, { code: 'forbidden' })
  let msg: string
  try {
    msg = await spec.execute(c, req.params && typeof req.params === 'object' ? req.params : {})
  } catch (e) {
    if (!(e instanceof ActionRefusal) && !(e instanceof HttpError)) { console.error('assistant action', e); throw e }
    throw new HttpError(422, e.message, { code: 'action_failed' })
  }
  return ok({ ok: true, message: msg })
}

// --- voice (assistant_chat.go assistantTTS) ---------------------------------------------------
/* Go used Google Cloud Text-to-Speech (en-IN-Neural2-A, MP3) with the Cloud
   Run service account. A Worker has no service account, so the same request
   goes to Cloud TTS with the API key; a key restricted to the Gemini API is
   refused there, and then Gemini's own speech model reads it instead (24 kHz
   PCM, wrapped as WAV, which the browser's decodeAudioData plays the same). */
function pcmToWav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i) }
  s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}
const b64bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))

async function assistantTTS(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  const req = await readJSON<{ text?: string }>(c.req)
  let text = (req.text ?? '').trim()
  if (text === '') throw badRequest('text is required')
  if (text.length > 2400) text = text.slice(0, 2400)
  const key = (await aiKey(c.env)).key
  if (!key) throw new HttpError(503, 'the voice service is only available on the cloud deployment', { code: 'tts_unavailable' })
  const signal = AbortSignal.timeout(20_000)
  const audio = (bytes: Uint8Array, type: string) =>
    new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'private, max-age=60' } })
  try {
    const r = await aiFetch(c.env, 'https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ input: { text }, voice: { languageCode: 'en-IN', name: 'en-IN-Neural2-A' }, audioConfig: { audioEncoding: 'MP3', speakingRate: 0.98 } }),
    })
    if (r.ok) {
      const out = await r.json() as { audioContent?: string }
      if (out.audioContent) return audio(b64bytes(out.audioContent), 'audio/mpeg')
    } else {
      console.error('tts', r.status, (await r.text()).slice(0, 300))
    }
    const g = await aiFetch(c.env, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Read this aloud in a warm Indian English voice: ' + text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
      }),
    })
    if (!g.ok) {
      console.error('tts gemini', g.status, (await g.text()).slice(0, 300))
      throw new HttpError(502, 'the voice service refused the request', { code: 'tts_failed' })
    }
    const out = await g.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] }
    const data = out.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data
    if (!data) throw new Error('tts: no audio in response')
    return audio(pcmToWav(b64bytes(data)), 'audio/wav')
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (signal.aborted) throw new HttpError(502, 'the voice service did not answer', { code: 'tts_unavailable' })
    throw e
  }
}

// --- import from the chat (assistant_import.go) ---------------------------------------------------
const IMPORTABLE: Record<string, string> = {
  classes: 'Classes and sections', sections: 'Sections', subjects: 'Subjects', periods: 'Periods', holidays: 'Holidays and calendar',
  timetable: 'Timetable', class_subjects: 'Class subjects', allocations: 'Teacher allocations', marks: 'Marks', marks_grid: 'Marks (grid)',
  attendance: 'Student attendance', staff_attendance: 'Staff attendance', students: 'Students', student_history: 'Student history',
  fee_heads: 'Fee heads', fee_structures: 'Fee structures', fee_payments: 'Fee payments', punches: 'Biometric punches',
  // Same gate as Setup > Import: the kind's own permission, and a dry run before any commit.
  student_exits: 'Student exits', payslips: 'Payslips',
}
const MAX_PROBLEMS = 20
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

interface ImportResult { total: number; valid: number; rejected: number; imported: number; dry_run: boolean; problems?: unknown[]; run_id?: string }

function importSummary(r: { total: number; ok: number; rejected: number; imported: number; label: string }, commit: boolean): string {
  if (commit) {
    let s = 'Imported ' + plural(r.imported, 'row', 'rows') + '.'
    if (r.rejected > 0) s += ' ' + plural(r.rejected, 'row', 'rows') + ' had problems and were skipped.'
    return s + ' You can undo this from Setup > Import history if it was not what you meant.'
  }
  if (r.total === 0) return 'That file has no rows to import. Check it was saved as CSV from the template.'
  if (r.rejected === 0) return `Ready to import ${plural(r.ok, 'row', 'rows')} as ${r.label}. Nothing has been changed yet.`
  return `${r.ok} of ${plural(r.total, 'row', 'rows')} are ready to import as ${r.label}; ${r.rejected} have problems (shown below). Nothing has been changed yet.`
}

async function assistantImport(c: Ctx, commit: boolean): Promise<Response> {
  await assistantRateLimit(c)
  if (!c.id.institution) throw new HttpError(400, 'this needs a school in scope', { code: 'no_institution' })
  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('send the spreadsheet as multipart form data, with the file in `file` and the kind in `entity`.')
  const entity = String(form.get('entity') ?? '').trim()
  const label = IMPORTABLE[entity]
  if (!label) {
    throw new HttpError(403, `the assistant cannot import ${entity === '' ? 'that' : '"' + entity + '"'}. It can import class lists, subjects, timetables, marks, attendance, students, fees and similar, but never salary structures or staff logins. Those must be done by someone with the right access on the setup screen.`, { code: 'forbidden' })
  }
  const perm = entity === 'students' ? 'students.write' : importSpecs[entity]?.perm ?? ''
  if (perm === '' || !can(c.id, perm)) throw new HttpError(403, 'missing permission: ' + perm, { code: 'forbidden' })
  const file = form.get('file')
  if (!file || typeof file === 'string') throw badRequest('attach the spreadsheet as a CSV in the `file` field.')
  const f = file as unknown as File
  const raw = new Uint8Array(await f.arrayBuffer()).slice(0, 8 << 20)
  if (raw.byteLength === 0) throw badRequest('that file was empty or could not be read. Save it as CSV and try again.')
  const qs = new URLSearchParams({ commit: String(commit), filename: f.name ?? '' })
  // Facts about the whole sheet and the column map travel as on Setup > Import (a grid mark sheet needs both).
  for (const k of SHEET_FACT_PARAMS) { const v = String(form.get(k) ?? '').trim(); if (v !== '') qs.set(k, v.slice(0, 200)) }
  const colMap = String(form.get('column_map') ?? '').trim()
  // The exact route the setup screen uses, as the caller: same dry run, same undoable import run.
  const path = entity === 'students' ? `/students/import?${qs}` : `/setup/import/${entity}?${qs}`
  const r = await dispatch(c, 'POST', path, raw, 'text/csv', colMap ? { 'x-column-map': colMap.slice(0, 20000) } : undefined)
  if (r.status === 400) {
    const msg = typeof r.data.error === 'string' ? r.data.error : ''
    throw badRequest(msg || (entity === 'students' ? 'that students file could not be read. Save it as CSV from the template and try again.' : 'that file could not be read.'))
  }
  if (r.status !== 200) throw new HttpError(r.status, typeof r.data.error === 'string' ? r.data.error : 'the import failed')
  const out = r.data as unknown as ImportResult
  const problems = Array.isArray(out.problems) ? out.problems.slice(0, MAX_PROBLEMS) : []
  const resp = {
    entity, label, total: Number(out.total ?? 0), ok: commit ? Number(out.imported ?? 0) : Number(out.valid ?? 0),
    rejected: Number(out.rejected ?? 0), imported: Number(out.imported ?? 0), dry_run: !!out.dry_run,
    summary: '', problems, ...(out.run_id ? { run_id: out.run_id } : {}),
  }
  resp.summary = importSummary(resp, commit)
  return json(resp)
}

export function registerAssistant(r: Router): void {
  r.post('/assistant/ask', 'auth', assistantAsk)
  r.post('/assistant/chat', 'auth', assistantChat)
  r.post('/assistant/tts', 'auth', assistantTTS)
  r.post('/assistant/action', 'auth', assistantAction)
  r.post('/assistant/import/preview', 'auth', (c) => assistantImport(c, false))
  r.post('/assistant/import/commit', 'auth', (c) => assistantImport(c, true))
  // Tool calling and the action registry: assistant/agent.ts.
  registerAgent(r)
}
