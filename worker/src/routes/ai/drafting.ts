import type { Ctx, Router } from '../../router'
import { badRequest, forbidden, isUUID, notFound, ok, readJSON } from '../../http'
import { can, resolveScope, studentPredicate, addDays, indiaToday } from '../students/common'
import { assistantRateLimit } from '../teaching/gemini'
import { AI_MODEL, aiConfigured, aiGenerate, NOT_CONFIGURED_MSG, parseJsonObject } from '../../services/ai/llm'
import { safe, snapshotText, studentSnapshot, teacherStyle } from '../../services/ai/context'

/* "Write with AI": POST /ai/draft returns drafts, POST /ai/translate returns a
   translation. Both only return text. Nothing is saved or sent here: the
   screen puts the draft in its own editor and the person saves or sends it
   the usual way, through the usual permission checks.

   The context is read server side from what the caller may see: a student
   only when the caller's scope reaches them (staff by section or
   students.read.all, family by their own child), an application only with
   admissions.read, a leave request only for HR (hr.leave.approve) or the
   class teacher of the student, fee figures only with a finance permission.
   GET /ai/status tells a screen whether to show the button at all. */

export const DRAFT_KINDS = ['report_remark', 'teacher_remark', 'parent_message', 'circular', 'admission_decision', 'fee_reminder', 'leave_reply', 'enquiry_follow_up'] as const
export type DraftKind = typeof DRAFT_KINDS[number]
export const LANGUAGES: Record<string, string> = { en: 'English', te: 'Telugu (in Telugu script)', hi: 'Hindi (in Devanagari script)' }
const TONES = ['warm', 'formal', 'neutral', 'encouraging', 'firm'] as const
const LENGTHS: Record<string, string> = {
  short: 'one or two sentences, at most 40 words',
  medium: 'a short paragraph of about 60-90 words',
  long: 'two short paragraphs, about 140-180 words',
}

export interface DraftRequest {
  kind?: string
  tone?: string
  length?: string
  language?: string
  variants?: number
  student_id?: string
  application_id?: string
  enquiry_id?: string
  leave_request_id?: string
  decision?: string
  /** The person's own notes or points to cover. */
  notes?: string
  /** The text already in the editor, to improve rather than replace blindly. */
  current?: string
  /** A message being replied to (the caller already sees it on screen). */
  reply_to?: string
  /** Circulars: the topic. */
  topic?: string
  /** Circulars: who it is for ("parents of class 5", "all staff"). */
  audience?: string
}

const clip = (s: unknown, n = 2000) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

async function studentVisible(c: Ctx, sid: string): Promise<{ staff: boolean; family: boolean }> {
  if (!isUUID(sid)) throw badRequest('student_id is required')
  const scope = await resolveScope(c)
  const family = scope.studentIds.includes(sid)
  const p = studentPredicate(scope, 'st')
  const hit = await c.db.prepare(`SELECT 1 AS x FROM students st WHERE st.id = ? AND ${p.sql}`).bind(sid, ...p.args).first()
  if (!hit) throw notFound('no such student in your scope')
  const staff = scope.allStudents || (scope.sectionIds.length > 0 && !family) || (can(c, 'students.read') && !family)
  return { staff, family }
}

const hasAnyPerm = (c: Ctx, prefix: string[]) => (c.id.platformAdmin && !c.id.restricted) || [...c.id.permissions].some((p) => prefix.some((x) => p.startsWith(x)))

/** What to tell the model for each kind, and the facts it may use. Throws when the caller may not. */
export async function draftContext(c: Ctx, k: DraftKind, b: DraftRequest): Promise<{ task: string; facts: string }> {
  const since = addDays(indiaToday(), -120)
  const decision = clip(b.decision, 40)
  switch (k) {
    case 'report_remark':
    case 'teacher_remark': {
      const v = await studentVisible(c, b.student_id ?? '')
      if (!v.staff) throw forbidden('only staff can draft remarks')
      const s = await studentSnapshot(c.db, b.student_id!, since)
      const style = await teacherStyle(c.db, c.id.userId)
      const facts = snapshotText(s!) + (style.length ? '\n\nThe teacher\'s own earlier remarks (match this voice, do not copy):\n' + style.map((x) => '- ' + x).join('\n') : '')
      return {
        task: k === 'report_remark'
          ? 'Write a class teacher\'s report-card remark for this student, addressed to the parents, grounded in the marks, attendance and notes. Name one strength and one specific next step. Do not quote every mark.'
          : 'Write a teacher\'s remark about this student (an observation for the record that the family may read), grounded in the facts. Specific, kind and constructive.',
        facts,
      }
    }
    case 'parent_message': {
      const v = await studentVisible(c, b.student_id ?? '')
      const s = await studentSnapshot(c.db, b.student_id!, since, { family: v.family && !v.staff })
      const who = v.staff ? 'a teacher writing to the parent of this student' : 'a parent writing to their child\'s teacher'
      const reply = clip(b.reply_to, 1500)
      return {
        task: `Write a message from ${who}.${reply ? ' It replies to the message below; answer what it asks.' : ''} Use only facts given; do not promise anything the school has not decided.`,
        facts: snapshotText(s!) + (reply ? `\n\nMessage being replied to:\n"""${reply}"""` : ''),
      }
    }
    case 'circular': {
      if (!hasAnyPerm(c, ['comms.', 'institution.settings.write', 'admin.'])) throw forbidden('drafting a circular needs a communications permission')
      const topic = clip(b.topic, 300) || clip(b.notes, 300)
      if (!topic) throw badRequest('say what the circular is about (topic)')
      const school = await safe('school', () => c.db.prepare(`SELECT name FROM institutions LIMIT 1`).first<{ name: string }>(), null)
      return {
        task: `Write a school circular / notice${b.audience ? ' for ' + clip(b.audience, 120) : ''}. Give it a one-line title on the first line, then the body. Include only dates, times and places given in the notes; where one is needed but missing write [date] or [time] as a placeholder.`,
        facts: `School: ${school?.name ?? ''}\nTopic: ${topic}`,
      }
    }
    case 'admission_decision': {
      if (!can(c, 'admissions.read')) throw forbidden('drafting an admission email needs admissions.read')
      if (!isUUID(b.application_id)) throw badRequest('application_id is required')
      const a = await c.db.prepare(`SELECT a.first_name, a.last_name, a.class_sought, a.parent_name, a.status, a.waitlist_rank, i.name AS school
          FROM applications a LEFT JOIN institutions i ON i.id = a.institution_id WHERE a.id = ?`).bind(b.application_id)
        .first<Record<string, string | number | null>>()
      if (!a) throw notFound('no such application')
      const d = decision || String(a.status)
      return {
        task: `Write an email to the parent about the admission decision "${d}" for this application. Courteous, clear about the decision and the next step; for a rejection be kind and brief, and do not give reasons that are not in the notes.`,
        facts: `School: ${a.school ?? ''}\nApplicant: ${a.first_name} ${a.last_name ?? ''}\nClass sought: ${a.class_sought}\nParent: ${a.parent_name}\nDecision: ${d}${a.waitlist_rank ? `\nWaitlist position: ${a.waitlist_rank}` : ''}`,
      }
    }
    case 'enquiry_follow_up': {
      // A WhatsApp or SMS to a family that enquired about admission, from the lead and its recent timeline.
      if (!can(c, 'admissions.read')) throw forbidden('drafting a message to an enquiry needs admissions.read')
      if (!isUUID(b.enquiry_id)) throw badRequest('enquiry_id is required')
      const e = await c.db.prepare(`SELECT e.student_name, e.parent_name, e.status, e.source, cl.name AS class_name, i.name AS school
          FROM enquiries e LEFT JOIN classes cl ON cl.id = e.class_sought LEFT JOIN institutions i ON i.id = e.institution_id WHERE e.id = ?`)
        .bind(b.enquiry_id).first<Record<string, string | null>>()
      if (!e) throw notFound('no such enquiry')
      const acts = await c.db.prepare(`SELECT kind, body, to_status, date(created_at) AS on_day FROM enquiry_activities WHERE enquiry_id = ? ORDER BY created_at DESC LIMIT 5`)
        .bind(b.enquiry_id).all<Record<string, string | null>>()
      const history = acts.results.map((a) => `- ${a.on_day} ${a.kind}${a.to_status ? ' -> ' + a.to_status : ''}${a.body ? ': ' + a.body : ''}`).join('\n')
      return {
        task: 'Write a short WhatsApp message from the school admissions office to a parent who enquired about admission. Friendly and plain, invite the next step (a campus visit, the application form, or a call back), and do not quote fees, seats or dates that are not in the facts or notes. No placeholders; sign off as the admissions office.',
        facts: `School: ${e.school ?? ''}\nChild: ${e.student_name}\nParent: ${e.parent_name ?? 'not given'}\nClass sought: ${e.class_name ?? 'not given'}\nStage: ${e.status}\nCame through: ${e.source}${history ? '\nRecent contact (newest first):\n' + history : ''}`,
      }
    }
    case 'fee_reminder': {
      if (!hasAnyPerm(c, ['finance.fees.', 'finance.invoices.', 'finance.payments.'])) throw forbidden('drafting a fee reminder needs a finance permission')
      let facts = 'A general reminder to all parents with fees outstanding. Use {{student_name}} and {{amount}} as placeholders where the name and amount go.'
      if (b.student_id) {
        await studentVisible(c, b.student_id)
        const s = await studentSnapshot(c.db, b.student_id, since)
        const inv = await safe('invoices', async () => (await c.db.prepare(`SELECT invoice_no, due_on, COALESCE(net_paise, gross_paise - discount_paise + fine_paise) - paid_paise AS due
            FROM invoices WHERE student_id = ? AND status NOT IN ('paid','cancelled') ORDER BY due_on LIMIT 6`).bind(b.student_id).all<{ invoice_no: string; due_on: string | null; due: number }>()).results, [])
        facts = `Student: ${s!.name}, ${s!.class_name ?? ''} ${s!.section_name ?? ''}\nOutstanding invoices:\n` +
          (inv.length ? inv.map((i) => `- ${i.invoice_no}: Rs ${(Number(i.due) / 100).toFixed(0)}${i.due_on ? ', due ' + i.due_on : ''}`).join('\n') : '- none')
      }
      return { task: 'Write a fee reminder to the parent. Polite and plain, with the amount and due date where given, and how to pay (at the fee counter or online through the parent app). No threats. ' +
        'If the current text has {{placeholders}} in double braces, keep every one of them exactly as written.', facts }
    }
    case 'leave_reply': {
      if (!isUUID(b.leave_request_id)) throw badRequest('leave_request_id is required')
      const row = await c.db.prepare(`SELECT lr.from_date, lr.to_date, lr.days, lr.reason, lr.status, lr.subject_kind,
            COALESCE((SELECT trim(e.first_name || ' ' || COALESCE(e.last_name,'')) FROM employees e WHERE e.id = lr.employee_id),
                     (SELECT trim(s.first_name || ' ' || COALESCE(s.last_name,'')) FROM students s WHERE s.id = lr.student_id)) AS who,
            lt.name AS leave_type
          FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.id = ? AND (? OR EXISTS (SELECT 1 FROM students st
              JOIN sections sec ON sec.id = (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
             WHERE st.id = lr.student_id AND sec.class_teacher_id = ?))`)
        .bind(b.leave_request_id, can(c, 'hr.leave.approve') ? 1 : 0, c.id.userId).first<Record<string, string | null>>()
      if (!row) throw notFound('no such leave request you can answer')
      const d = decision || 'approved'
      return {
        task: `Write the note that goes with the decision "${d}" on this leave request, to the person who asked. Short and respectful${d === 'rejected' ? '; if no reason is in the notes, say the school will discuss it rather than inventing one' : ''}.`,
        facts: `Leave for: ${row.who ?? ''} (${row.subject_kind})\nType: ${row.leave_type ?? 'leave'}\nFrom ${row.from_date} to ${row.to_date} (${row.days} day(s))\nReason given: ${row.reason ?? ''}`,
      }
    }
  }
}

export function draftSystem(language: string, tone: string, length: string, n: number): string {
  return [
    'You draft text for staff and parents of a school in India, inside the school\'s ERP. A person will read, edit and then send or save your draft themselves.',
    'Use only the facts provided. Never invent marks, dates, amounts, events or reasons; if something needed is missing, use a [placeholder] in square brackets.',
    'Plain text only: no markdown, no headings with #, no emoji. Use the student\'s first name. No sign-off name unless given.',
    `Language: ${LANGUAGES[language] ?? 'English'}. Tone: ${tone}. Length: ${LENGTHS[length] ?? LENGTHS.medium}.`,
    `Return JSON only: {"drafts": [ ... ]} with exactly ${n} clearly different draft${n === 1 ? '' : 's'} as strings.`,
  ].join('\n')
}

/** The drafts in a model answer; tolerant of a bare-text reply. */
export function parseDrafts(raw: string, n: number): string[] {
  const o = parseJsonObject<{ drafts?: unknown }>(raw)
  const list = o && Array.isArray(o.drafts) ? o.drafts.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  if (list.length) return list.slice(0, n)
  const t = raw.replace(/```(?:json)?/gi, '').trim()
  return t ? [t] : []
}

async function draft(c: Ctx) {
  if (!c.id.institution) throw forbidden('drafting works inside a school')
  const b = await readJSON<DraftRequest>(c.req)
  const kind = (b.kind ?? '') as DraftKind
  if (!DRAFT_KINDS.includes(kind)) throw badRequest(`kind must be one of ${DRAFT_KINDS.join(', ')}`)
  const tone = TONES.includes(b.tone as typeof TONES[number]) ? b.tone! : 'warm'
  const length = LENGTHS[b.length ?? ''] ? b.length! : 'medium'
  const language = LANGUAGES[b.language ?? ''] ? b.language! : 'en'
  const n = Math.max(1, Math.min(3, Math.floor(Number(b.variants ?? 2)) || 2))
  const ctx = await draftContext(c, kind, b)
  if (!aiConfigured(c.env)) return ok({ drafts: [], label: 'AI draft', configured: false, message: NOT_CONFIGURED_MSG })
  await assistantRateLimit(c)
  const notes = clip(b.notes, 1500), current = clip(b.current, 3000)
  const prompt = `Task: ${ctx.task}\n\nFacts:\n${ctx.facts}` +
    (notes ? `\n\nPoints the writer wants covered:\n${notes}` : '') +
    (current ? `\n\nTheir current text (improve on it, keep what is good):\n"""${current}"""` : '')
  const raw = await aiGenerate(c.env, c.db, draftSystem(language, tone, length, n), prompt, { maxTokens: 4000 })
  return ok({ drafts: parseDrafts(raw, n), label: 'AI draft', configured: true, kind, language, tone, length, model: AI_MODEL })
}

async function translate(c: Ctx) {
  if (!c.id.institution) throw forbidden('translation works inside a school')
  const b = await readJSON<{ text?: string; title?: string; language?: string }>(c.req)
  const text = clip(b.text, 8000), title = clip(b.title, 300)
  const language = b.language === 'te' || b.language === 'hi' || b.language === 'en' ? b.language : ''
  if (!text) throw badRequest('text is required')
  if (!language) throw badRequest('language must be te, hi or en')
  if (!aiConfigured(c.env)) return ok({ configured: false, message: NOT_CONFIGURED_MSG, original: { title, text } })
  await assistantRateLimit(c)
  const system = `Translate a school notice into ${LANGUAGES[language]}. Keep names, dates, times, amounts, class names and [placeholders] exactly. ` +
    'Natural, simple wording a parent would use; not word-for-word. Return JSON only: {"title": "...", "text": "..."} (title empty if none given).'
  const raw = await aiGenerate(c.env, c.db, system, `Title: ${title}\n\nText:\n${text}`, { maxTokens: 3000 })
  const o = parseJsonObject<{ title?: string; text?: string }>(raw)
  return ok({
    configured: true, label: 'AI translation', language,
    original: { title, text },
    translated: { title: (o?.title ?? '').trim(), text: (o?.text ?? raw).trim() },
  })
}

export function registerDrafting(r: Router): void {
  r.get('/ai/status', 'auth', async (c) => ok({ configured: aiConfigured(c.env), kinds: DRAFT_KINDS, languages: Object.keys(LANGUAGES) }))
  r.post('/ai/draft', 'auth', draft)
  r.post('/ai/translate', 'auth', translate)
}
