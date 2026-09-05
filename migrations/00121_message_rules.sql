-- Number claimed at 00103; may be renumbered at integration.
-- Renumbered from 00103 at integration: another session deployed 00120 while
-- this was in flight, and goose refuses a migration below the current version.
-- +goose Up
--
-- Reminder plans: the two automations a school actually asks for, expressed in
-- the trigger-rule table that already exists.
--
-- What is deliberately NOT here:
--
--   no second rules table   message_trigger_rules (00044) already holds event,
--                           condition, audience, channel, template, quiet
--                           hours, is_active and the last-run report. A
--                           parallel `reminder_plans` table would be the same
--                           row again, with a second sweep, a second dedupe
--                           scheme and two screens that disagree about whether
--                           a parent has been chased.
--   no second sender        queueWith and DispatchMessages stay the only road
--                           out of the building, so the recipient allowlist
--                           added in 00101 still guards every message.
--   no second scheduler     the cron entry added in 3233b89 (under asynq then;
--                           River's schedule now) drains the queue;
--                           this adds one cron entry that fills it.
--
-- So what this migration adds is five columns describing an operating policy
-- that a bursar can state in words -- start chasing after N days, again every
-- M days, at most K times; tell a guardian about an absence, but not before
-- the register has plausibly been taken, and not if the family already
-- explained it -- plus the statuses and indexes that policy needs.

-- ------------------------------------------------------- 1. the plan columns

-- Which operating shape this rule is, or NULL for a plain rule authored on the
-- generic trigger screen.
--
-- The distinction is load-bearing rather than cosmetic. A plan rule's
-- occurrences are produced by a finder that knows about repetition and
-- suppression; the generic sweep's finder for the same event is not, and would
-- key the same invoice differently. Both running over one rule is how a parent
-- gets chased twice on the same morning, so loadRules in messaging.go excludes
-- plan rules and this column is what it excludes on.
ALTER TABLE message_trigger_rules ADD COLUMN IF NOT EXISTS plan_kind text;

-- How often to come back, in days. 0 is "say it once and stop".
--
-- Days rather than a cron string on purpose: the question a bursar is
-- answering is "how often do we chase", and every answer they have ever given
-- to it is a number of days. A cron expression would be a second thing to get
-- wrong, and the one thing it buys -- "only on Tuesdays" -- nobody has asked
-- for.
ALTER TABLE message_trigger_rules ADD COLUMN IF NOT EXISTS repeat_days integer NOT NULL DEFAULT 0;

-- The cap. A rule with no cap and a repeat is a rule that chases a family
-- until somebody notices, which for a hardship case is the difference between
-- a reminder and harassment.
ALTER TABLE message_trigger_rules ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 1;

-- Not before this time of day, India/Kolkata.
--
-- This is a gate on producing the occurrence at all, not a send_after. An
-- absence alert fired at 08:00 is a message about a register nobody has taken
-- yet: half the school is unmarked, so half the school is not yet absent.
-- Holding a message that should never have been created merely delays the
-- wrong answer. Waiting to ask the question means the answer is right when it
-- is finally asked.
ALTER TABLE message_trigger_rules ADD COLUMN IF NOT EXISTS send_at_time time;

-- Leave the families who already told us alone.
--
-- The parent portal's one-tap absence report writes a leave_requests row
-- (subject_kind='student', status pending or approved) -- see
-- reportChildAbsence in internal/api/portal_requests.go. A school that asks a
-- parent to tell it, and then texts that parent to say their child is missing,
-- has taught them the button does nothing.
ALTER TABLE message_trigger_rules ADD COLUMN IF NOT EXISTS skip_explained boolean NOT NULL DEFAULT true;

ALTER TABLE message_trigger_rules DROP CONSTRAINT IF EXISTS message_trigger_rules_plan_kind;
ALTER TABLE message_trigger_rules ADD CONSTRAINT message_trigger_rules_plan_kind
    CHECK (plan_kind IS NULL OR plan_kind IN ('fee_reminder','absence_alert'));

-- A repeat with one attempt is a contradiction the screen must not be able to
-- save: it reads as "every 7 days" and behaves as "once".
ALTER TABLE message_trigger_rules DROP CONSTRAINT IF EXISTS message_trigger_rules_repeat;
ALTER TABLE message_trigger_rules ADD CONSTRAINT message_trigger_rules_repeat
    CHECK (repeat_days BETWEEN 0 AND 365
       AND max_attempts BETWEEN 1 AND 12
       AND (repeat_days = 0 OR max_attempts > 1));

COMMENT ON COLUMN message_trigger_rules.plan_kind IS
    'fee_reminder | absence_alert, or NULL for a plain rule. Plan rules are driven by runMessagePlans in internal/api/message_rules.go and are excluded from the generic sweep, because their occurrence keys carry an attempt number the generic finder knows nothing about.';
COMMENT ON COLUMN message_trigger_rules.repeat_days IS
    'Days between chases. 0 sends once. The attempt number is derived from days overdue rather than stored, so a sweep that did not run for a week resumes at the right chase instead of restarting at the first.';
COMMENT ON COLUMN message_trigger_rules.max_attempts IS
    'How many times one occurrence may be chased in total, first included.';
COMMENT ON COLUMN message_trigger_rules.send_at_time IS
    'Do not look for occurrences before this time of day (Asia/Kolkata). For absence alerts this is "after the register is taken", which is a different thing from holding a message once created.';
COMMENT ON COLUMN message_trigger_rules.skip_explained IS
    'Skip an absence the family already explained through the portal, and cancel a queued alert if they explain it before it goes out.';

-- The plan runner's own query.
CREATE INDEX IF NOT EXISTS message_trigger_rules_plans
    ON message_trigger_rules (institution_id, plan_kind)
 WHERE plan_kind IS NOT NULL;

-- ------------------------------------- 2. a message withdrawn before it went

-- 'cancelled' is not 'failed' and not 'suppressed'.
--
--   failed      the provider would not take it, and it is on a retry schedule.
--   suppressed  the recipient allowlist held it at the door (00101).
--   cancelled   the reason for sending it stopped being true.
--
-- The last is the one this migration is for. A fee reminder queued on Monday
-- and paid on Tuesday must not go out on Wednesday, and the parent who paid
-- must be able to see, on the log screen, that the school stopped chasing them
-- rather than that the message vanished. Reusing 'failed' would put it back on
-- the retry schedule to be sent four more times, which is the exact opposite.
--
-- This is the same shape as the admissions campaign worker, where converting a
-- lead marks its pending touches 'skipped' rather than deleting them
-- (stopEnrolment, internal/api/admissions_growth.go).
ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_status_check
    CHECK (status = ANY (ARRAY['queued','sent','delivered','failed','bounced','read','suppressed','cancelled']));

-- What the cancellation pass and the plan screen both select on: this rule's
-- own rows. Without it, withdrawing settled reminders is a sequential scan of
-- the whole log once per plan per sweep.
CREATE INDEX IF NOT EXISTS message_log_by_rule
    ON message_log (institution_id, source_id, status)
 WHERE source_kind = 'trigger_rule';

-- No new table, so no RLS block: message_trigger_rules and message_log both
-- already have ENABLE + FORCE ROW LEVEL SECURITY and a policy on
-- app_current_institution() / app_is_platform_admin(), and 00042 grants
-- app_user on every table in the schema. Adding columns inherits all of it;
-- adding a table would have meant repeating it, which is the argument for not
-- adding one.

-- +goose Down

DROP INDEX IF EXISTS message_log_by_rule;
DROP INDEX IF EXISTS message_trigger_rules_plans;

-- Fold cancelled rows back into a status the old constraint permits before
-- reinstating it, or the ALTER fails on any school that ever stopped chasing a
-- settled invoice. 'failed' is the honest landing place: it did not go out.
UPDATE message_log SET status = 'failed' WHERE status = 'cancelled';

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_status_check
    CHECK (status = ANY (ARRAY['queued','sent','delivered','failed','bounced','read','suppressed']));

ALTER TABLE message_trigger_rules DROP CONSTRAINT IF EXISTS message_trigger_rules_repeat;
ALTER TABLE message_trigger_rules DROP CONSTRAINT IF EXISTS message_trigger_rules_plan_kind;

ALTER TABLE message_trigger_rules
    DROP COLUMN IF EXISTS skip_explained,
    DROP COLUMN IF EXISTS send_at_time,
    DROP COLUMN IF EXISTS max_attempts,
    DROP COLUMN IF EXISTS repeat_days,
    DROP COLUMN IF EXISTS plan_kind;
