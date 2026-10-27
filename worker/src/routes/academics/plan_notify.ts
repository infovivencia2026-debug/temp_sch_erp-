import type { Ctx } from '../../router'
import { notifyHoldersStmts, notifyStmt } from '../../notify_holders'

/* Who hears about a lesson plan (security audit, 2026-10-27). A submitted
   plan reaches its subject's heads, or, where the subject has none, whoever
   holds academics.write. A decided plan reaches its teacher. */

const REVIEW_LINK = '/go/academics/lesson_plans'
const HEAD_LINK = '/go/academics/subject_overview'
const TEACHER_LINK = '/go/teaching/lesson_plans_content'

interface PlanFacts { teacher_user_id: string | null; institution_id: string; subject_id: string; subject: string; week_of: string }

async function facts(c: Ctx, planId: string): Promise<PlanFacts | null> {
  return c.db.prepare(`SELECT lp.teacher_user_id, lp.institution_id, cs.subject_id, sub.name AS subject, lp.week_of
      FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
     WHERE lp.id = ?`).bind(planId).first<PlanFacts>()
}

export async function notifyPlanSubmitted(c: Ctx, planId: string): Promise<void> {
  const p = await facts(c, planId)
  if (!p) return
  const title = `Lesson plan to review: ${p.subject}, week of ${p.week_of}`
  const heads = await c.db.prepare(`SELECT head_user_id AS id FROM subject_heads WHERE subject_id = ? AND head_user_id IS NOT ?`)
    .bind(p.subject_id, c.id.userId).all<{ id: string }>()
  const stmts = heads.results.length
    ? heads.results.map((h) => notifyStmt(c.db, p.institution_id, h.id, 'lesson_plan_submitted', title, '', HEAD_LINK, 'lesson_plan', planId))
    : await notifyHoldersStmts(c.db, p.institution_id, 'academics.write', c.id.userId, 'lesson_plan_submitted', title, '', REVIEW_LINK, 'lesson_plan', planId)
  if (stmts.length) await c.db.batch(stmts)
}

export async function notifyPlanDecided(c: Ctx, planId: string, decision: string, remarks: string): Promise<void> {
  const p = await facts(c, planId)
  if (!p?.teacher_user_id || p.teacher_user_id === c.id.userId) return
  await notifyStmt(c.db, p.institution_id, p.teacher_user_id, 'lesson_plan_decided',
    `Lesson plan ${decision}: ${p.subject}, week of ${p.week_of}`, remarks, TEACHER_LINK, 'lesson_plan', planId).run()
}
