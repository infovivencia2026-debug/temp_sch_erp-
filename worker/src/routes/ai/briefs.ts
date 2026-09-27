import type { Ctx, Router } from '../../router'
import { badRequest, forbidden, isUUID, notFound, ok, readJSON } from '../../http'
import { can, resolveScope, studentPredicate } from '../students/common'
import { assistantRateLimit } from '../teaching/gemini'
import { aiConfigured, aiSettings, DEFAULT_DAILY_CAP, NOT_CONFIGURED_MSG, schoolToday, usageToday } from '../../services/ai/llm'
import { generatePrincipalBrief, generateStudent360, latestBrief, storedBrief, student360Inputs } from '../../services/ai/briefs'

/* The AI briefs on screen.

   GET  /ai/briefs/principal            today's morning brief (made now if the 07:00 run has not happened)
   POST /ai/briefs/principal            regenerate (force), on demand
   GET  /ai/briefs/student/{id}         the Student 360 paragraph if cached, with fresh=false when the data moved on
   POST /ai/briefs/student/{id}         write it (reuses the cache when nothing changed)
   GET  /portal/ai/weekly?student_id=   the latest weekly note for the caller's own child
   GET  /ai/settings, PUT /ai/settings  the school's AI switches and daily cap (institution.settings.write)

   The principal brief needs what the dashboard needs (institution.read) and,
   because it quotes fee totals, a school-wide view: students.read.all or a
   finance read permission. */

const principalOk = (c: Ctx) => can(c, 'institution.read') && (can(c, 'students.read.all') || can(c, 'finance.fees.read'))

async function staffSeesStudent(c: Ctx, sid: string): Promise<void> {
  if (!isUUID(sid)) throw badRequest('invalid student id')
  const scope = await resolveScope(c)
  if (!scope.allStudents && scope.sectionIds.length === 0) throw forbidden('the Student 360 summary is for staff')
  const p = studentPredicate({ ...scope, studentIds: [] }, 'st')
  const hit = await c.db.prepare(`SELECT 1 AS x FROM students st WHERE st.id = ? AND ${p.sql}`).bind(sid, ...p.args).first()
  if (!hit) throw notFound('no such student in your scope')
}

export function registerBriefs(r: Router): void {
  r.get('/ai/briefs/principal', 'auth', async (c) => {
    if (!principalOk(c)) throw forbidden('the morning brief is for the principal and school admins')
    const inst = c.id.institution!
    const today = schoolToday(inst.timezone)
    const b = (await storedBrief(c.db, 'principal_morning', '', today)) ?? await generatePrincipalBrief(c.env, c.db, inst, { by: c.id.userId })
    return ok({ brief: b, configured: aiConfigured(c.env), message: aiConfigured(c.env) ? undefined : NOT_CONFIGURED_MSG })
  })
  r.post('/ai/briefs/principal', 'auth', async (c) => {
    if (!principalOk(c)) throw forbidden('the morning brief is for the principal and school admins')
    await assistantRateLimit(c)
    const b = await generatePrincipalBrief(c.env, c.db, c.id.institution!, { by: c.id.userId, force: true })
    return ok({ brief: b, configured: aiConfigured(c.env), message: aiConfigured(c.env) ? undefined : NOT_CONFIGURED_MSG })
  })

  r.get('/ai/briefs/student/{id}', 'auth', async (c) => {
    await staffSeesStudent(c, c.params.id)
    const b = await storedBrief(c.db, 'student_360', c.params.id, '')
    const inp = b ? await student360Inputs(c.db, c.params.id) : null
    return ok({ brief: b, fresh: !!b && !!inp && inp.hash === b.inputs_hash, configured: aiConfigured(c.env) })
  })
  r.post('/ai/briefs/student/{id}', 'auth', async (c) => {
    await staffSeesStudent(c, c.params.id)
    if (!aiConfigured(c.env)) return ok({ brief: null, fresh: false, configured: false, message: NOT_CONFIGURED_MSG })
    await assistantRateLimit(c)
    const out = await generateStudent360(c.env, c.db, c.id.institution!.id, c.params.id, c.id.userId)
    return ok({ brief: out.brief, fresh: true, cached: out.cached, configured: true })
  })

  r.get('/portal/ai/weekly', 'self.profile.read', async (c) => {
    const scope = await resolveScope(c)
    const want = c.url.searchParams.get('student_id') ?? ''
    const sid = want ? (scope.studentIds.includes(want) ? want : '') : (scope.studentIds[0] ?? '')
    if (!sid) throw notFound()
    return ok({ student_id: sid, brief: await latestBrief(c.db, 'parent_weekly', sid) })
  })

  r.get('/ai/settings', 'institution.read', async (c) => {
    const s = await aiSettings(c.db)
    return ok({ ...s, default_daily_cap: DEFAULT_DAILY_CAP, used_today: await usageToday(c.db, schoolToday(c.id.institution?.timezone)), configured: aiConfigured(c.env) })
  })
  r.put('/ai/settings', 'institution.settings.write', async (c) => {
    const b = await readJSON<Record<string, unknown>>(c.req)
    const cur = await aiSettings(c.db)
    const cap = b.daily_cap === undefined ? cur.daily_cap : Number(b.daily_cap)
    if (!Number.isFinite(cap) || cap < 0 || cap > 100_000) throw badRequest('daily_cap must be between 0 and 100000')
    const flag = (k: keyof typeof cur) => (typeof b[k] === 'boolean' ? b[k] : cur[k]) as boolean
    const cfg = { daily_cap: Math.floor(cap), email_principal_brief: flag('email_principal_brief'), parent_weekly_sms: flag('parent_weekly_sms'), parent_weekly_email: flag('parent_weekly_email') }
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, 'ai', ?, ?)
        ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`)
      .bind(c.id.institution!.id, flag('enabled') ? 1 : 0, JSON.stringify(cfg)).run()
    return ok(await aiSettings(c.db))
  })
}
