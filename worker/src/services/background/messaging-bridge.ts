import type { Env } from '../../env'
import type { Institution } from '../../tenant'
import { registerJob } from '../jobs'
import { jobSchool } from './schools'
import { sendReportDigest } from './report-digest'
import { dispatchMessages } from '../messaging'
import { runMessagePlans } from '../message_rules'

/* The jobs that hand work to the messaging feature (Go's queue.Messaging):
   draining message_log, the reminder plans and the report digests.
   message:plans runs the reminder plans (services/message_rules.ts). */

registerJob<{ limit?: number }>('message:dispatch', async (env, job) => {
  // The cron enqueues the messaging port's 'message.send' sweep; this Go
  // name is kept so a job queued under it still drains the school.
  const { inst, db } = await jobSchool(env, job)
  const res = await dispatchMessages(env, db, inst.id, job.payload.limit ?? 50)
  if (res.sent || res.failed) console.log('message dispatch', { institution_id: inst.id, ...res })
})
registerJob('message:plans', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  await runMessagePlans(env, inst.id, db)
})
registerJob('report:digest_daily', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  await sendReportDigest(env, inst, db, 'daily')
})
registerJob('report:digest_weekly', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  await sendReportDigest(env, inst, db, 'weekly')
})
