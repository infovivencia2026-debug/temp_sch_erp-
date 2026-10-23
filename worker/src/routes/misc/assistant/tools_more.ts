import type { Ctx } from '../../../router'
import { can } from '../../../identity'
import { indiaToday } from '../../students/common'
import { findSection, readAs, refusal, rowsOf, screenLink, str, type Link } from './read'
import { fail, table, type ToolSpec } from './tools'

/* More read tools: finding a screen, the person's own help requests, the
   Help Centre's troubleshooters, homework due, what is waiting for approval
   and recent Class Status posts. Like tools.ts, each reads through the
   Worker's own route as the caller, so it sees exactly what the screen it
   mirrors would show that person, and nothing else. */

type Feature = { slug: string; name: string; summary?: string; in_scope?: boolean }
type Section = { slug: string; name: string; features: Feature[] }

/** Words of a name, lower case, for a loose match ("open attendance"). */
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['the', 'my', 'open', 'screen', 'page', 'go', 'to'].includes(w))

const openScreen: ToolSpec = {
  name: 'open_screen', label: 'Finding the screen',
  description: 'Find a screen the person can open, by name or what it is for ("attendance", "fee receipts", "class status"). Returns up to five screens with buttons that open them. Use it whenever the person asks to open or find a screen, and to name the real screen in an explanation.',
  params: { name: { type: 'STRING', description: 'The screen or task, in the person\'s words' } },
  required: ['name'],
  offer: () => true,
  run: async (c, a) => {
    const want = words(str(a, 'name'))
    if (want.length === 0) return fail('say which screen')
    const g = await readAs(c, '/catalog')
    if (g.status !== 200) return fail(refusal(g))
    const roles = (g.data.roles ?? []) as { sections: Section[] }[]
    const hits: { score: number; name: string; section: string; to: string }[] = []
    const seen = new Set<string>()
    for (const r of roles) for (const s of r.sections ?? []) for (const f of s.features ?? []) {
      if (f.in_scope === false) continue
      const to = `/go/${s.slug}/${f.slug}`
      if (seen.has(to)) continue
      seen.add(to)
      const name = words(f.name), about = words(f.summary ?? ''), sec = words(s.name)
      let score = 0
      for (const w of want) score += name.includes(w) ? 3 : sec.includes(w) ? 1 : about.includes(w) ? 1 : 0
      if (score > 0) hits.push({ score, name: f.name, section: s.name, to })
    }
    hits.sort((x, y) => y.score - x.score)
    const top = hits.slice(0, 5)
    if (top.length === 0) return { data: { found: 0, note: 'no screen by that name is open to this person' } }
    const links: Link[] = top.map((h) => ({ label: h.name, to: h.to }))
    return { ...table('Screens', top.map((h) => ({ name: h.name, section: h.section })), [['name', 'Screen'], ['section', 'Under']], (r) => top.find((h) => h.name === r.name)?.to ?? null), links }
  },
}

const myHelpRequests: ToolSpec = {
  name: 'my_help_requests', label: 'Reading your help requests',
  description: 'The person\'s own Help Centre requests (Report a problem) and their status: waiting, answered, resolved.',
  params: {},
  offer: (c) => !!c.id.institution,
  run: async (c) => {
    const g = await readAs(c, '/help/requests')
    if (g.status !== 200) return fail(refusal(g))
    const rows = rowsOf(g.data.items).map((r) => ({ ...r, who: r.with === 'vendor' ? 'XULO support' : 'School helpdesk' }))
    return { ...table('Your help requests', rows, [['subject', 'Subject'], ['stage', 'Status'], ['who', 'With'], ['error_ref', 'Ref'], ['created_at', 'Sent']]),
      links: [screenLink('help', 'Help Centre')] }
  },
}

const TROUBLE = ['sign_in', 'messages', 'fee_receipt', 'screen', 'attendance']
const troubleshoot: ToolSpec = {
  name: 'run_troubleshooter', label: 'Running the check',
  description: 'Run one of the Help Centre\'s checks and report each result: sign_in (why someone cannot sign in; who = their phone or email, staff with user access only), messages (why messages are not arriving), fee_receipt (a receipt number), screen (why a screen is missing; route = its address), attendance (why attendance is not showing; date optional).',
  params: {
    key: { type: 'STRING', description: 'Which check', enum: TROUBLE },
    who: { type: 'STRING', description: 'sign_in, messages: a phone or email (optional)' },
    receipt: { type: 'STRING', description: 'fee_receipt: the receipt number' },
    route: { type: 'STRING', description: 'screen: the screen address (optional)' },
    date: { type: 'STRING', description: 'attendance: YYYY-MM-DD (optional)' },
  },
  required: ['key'],
  offer: (c) => !!c.id.institution,
  run: async (c, a) => {
    const key = str(a, 'key')
    if (!TROUBLE.includes(key)) return fail('unknown check')
    const g = await readAs(c, `/help/troubleshoot/${key}`, { who: str(a, 'who'), receipt: str(a, 'receipt'), route: str(a, 'route'), date: str(a, 'date') })
    if (g.status !== 200) return fail(refusal(g))
    const checks = rowsOf(g.data.checks)
    return { ...table(String(g.data.title ?? 'Check'), checks, [['check', 'Check'], ['ok', 'OK'], ['detail', 'What it found']]), links: [screenLink('help', 'Help Centre')] }
  },
}

const homeworkDue: ToolSpec = {
  name: 'homework_due', label: 'Reading homework due',
  description: 'Homework due from today on: for a parent or student their own child\'s; for a teacher their sections\'; a class and section narrow it.',
  params: { class: { type: 'STRING', description: 'Class (optional)' }, section: { type: 'STRING', description: 'Section (optional)' } },
  offer: () => true,
  run: async (c, a) => {
    let section_id: string | undefined
    if (str(a, 'class')) {
      const f = await findSection(c, str(a, 'class'), str(a, 'section'))
      if (f.error) return fail(f.error)
      section_id = f.one?.id
    }
    const g = await readAs(c, '/homework', { section_id })
    if (g.status !== 200) return fail(refusal(g))
    const today = indiaToday()
    const rows = rowsOf(g.data).filter((r) => typeof r.due_on === 'string' && r.due_on >= today)
      .sort((x, y) => String(x.due_on).localeCompare(String(y.due_on)))
    return { ...table('Homework due', rows, [['student_name', 'For'], ['title', 'Homework'], ['subject', 'Subject'], ['class_name', 'Class'], ['section_name', 'Section'], ['due_on', 'Due'], ['submitted', 'Handed in']]),
      links: [screenLink('homework', 'Homework')] }
  },
}

const pendingApprovals: ToolSpec = {
  name: 'pending_approvals', label: 'Checking what is waiting',
  description: 'What is waiting for this person to approve: leave requests and Class Status posts held for approval, with counts.',
  params: {},
  offer: (c) => can(c.id, 'hr.leave.approve') || can(c.id, 'status.manage') || can(c.id, 'leave.approve'),
  run: async (c) => {
    const rows: Record<string, unknown>[] = []
    const stats: { label: string; value: number }[] = []
    if (can(c.id, 'hr.leave.approve') || can(c.id, 'leave.approve')) {
      const g = await readAs(c, '/hr/leave', { status: 'pending' })
      if (g.status === 200) {
        const r = rowsOf(g.data)
        stats.push({ label: 'Leave requests', value: r.length })
        for (const x of r) rows.push({ what: 'Leave', who: x.who, when: `${x.from_date ?? ''} to ${x.to_date ?? ''}` })
      }
    }
    if (can(c.id, 'status.manage')) {
      const g = await readAs(c, '/status/admin/posts')
      if (g.status === 200) {
        const r = rowsOf(g.data).filter((x) => x.status === 'pending')
        stats.push({ label: 'Class Status posts', value: r.length })
        for (const x of r) rows.push({ what: 'Class Status post', who: x.poster_name, when: x.created_at })
      }
    }
    if (stats.length === 0) return fail('not permitted: the person asking approves nothing')
    return { ...table('Waiting for approval', rows, [['what', 'What'], ['who', 'Who'], ['when', 'When']], undefined, { stats }),
      links: [screenLink('leave', 'Leave'), screenLink('class_status', 'Class Status')] }
  },
}

const classStatus: ToolSpec = {
  name: 'recent_class_status', label: 'Reading Class Status',
  description: 'Recent Class Status posts the person can see (photos, videos and text from teachers and the school, 24 hours, plus the pinned gallery), with likes.',
  params: {},
  offer: (c) => !!c.id.institution,
  run: async (c) => {
    const g = await readAs(c, '/status/feed')
    if (g.status !== 200) return fail(refusal(g))
    if (g.data.enabled === false) return { data: { enabled: false, note: 'Class Status is switched off for this school' } }
    const rows: Record<string, unknown>[] = []
    for (const ring of rowsOf(g.data.rings)) for (const p of rowsOf(ring.posts)) rows.push({ by: ring.as_school ? 'School' : ring.name, kind: p.media_kind, caption: p.caption ?? '', likes: p.likes, at: p.published_at, seen: p.seen })
    for (const p of rowsOf(g.data.gallery)) rows.push({ by: 'Gallery', kind: p.media_kind, caption: p.caption ?? '', likes: p.likes, at: p.published_at, seen: p.seen })
    rows.sort((x, y) => String(y.at).localeCompare(String(x.at)))
    return { ...table('Class Status', rows, [['by', 'By'], ['kind', 'Kind'], ['caption', 'Caption'], ['likes', 'Likes'], ['at', 'Posted']],
      undefined, { stats: [{ label: 'Unseen', value: Number(g.data.unseen ?? 0) }] }), links: [screenLink('class_status', 'Class Status')] }
  },
}

export const MORE_TOOLS: ToolSpec[] = [openScreen, myHelpRequests, troubleshoot, homeworkDue, pendingApprovals, classStatus]
