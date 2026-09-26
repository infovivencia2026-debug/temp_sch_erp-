/* Imports every module that registers a job handler (registerJob), so the
   handler table is complete when src/index.ts loads. Add one import line per
   module; order does not matter. */
export {}
import './background/school-jobs'
import './background/messaging-bridge'
import './background/housekeeping'
import './background/transport'
import './messaging'
