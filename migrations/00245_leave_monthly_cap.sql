-- +goose Up
--
-- HOW MANY OF THE YEAR'S LEAVES MAY BE SPENT IN ONE MONTH.
--
-- The quota was annual and only annual, so twelve casual leaves could be taken
-- in the first fortnight of June and the rule the school actually keeps -- one
-- a month, two a month, no more than three of anything in a month -- could not
-- be written down anywhere. Schools keep it because a class cannot lose the
-- same teacher for a fortnight; without it the quota is a rule about the year
-- and no rule at all about the term.
--
-- Null means no monthly limit, which is what every existing type gets: nothing
-- a school has already set changes meaning today.
ALTER TABLE leave_policy_rules ADD COLUMN IF NOT EXISTS
    max_per_month numeric(5,1);

DO $$ BEGIN
    ALTER TABLE leave_policy_rules ADD CONSTRAINT leave_policy_rules_per_month
        CHECK (max_per_month IS NULL OR max_per_month > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- +goose StatementBegin
/*
The application is refused past the monthly limit.

	Refused here rather than merely charged later, because a limit is a thing
	the school wants observed, not a price it wants paid: somebody applying for
	their third casual leave of the month should be told now, not discover it
	on the payslip. Days already approved in the same month are counted, and a
	spell crossing a month boundary counts against the month it starts in --
	the same convention the annual quota uses.
*/
CREATE OR REPLACE FUNCTION leave_request_obeys_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    rule       leave_policy_rules%ROWTYPE;
    gender     text;
    taken      numeric;
BEGIN
    IF NEW.subject_kind <> 'staff' OR NEW.leave_type_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO rule FROM leave_policy_rules WHERE leave_type_id = NEW.leave_type_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.is_half_day AND NOT rule.allow_half_day THEN
        RAISE EXCEPTION 'this leave type cannot be taken as a half day'
            USING ERRCODE = 'check_violation';
    END IF;
    IF rule.max_consecutive_days IS NOT NULL AND NEW.days > rule.max_consecutive_days THEN
        RAISE EXCEPTION 'at most % consecutive day(s) of this leave may be taken',
            rule.max_consecutive_days USING ERRCODE = 'check_violation';
    END IF;
    IF rule.notice_days > 0 AND NEW.from_date < CURRENT_DATE + rule.notice_days THEN
        RAISE EXCEPTION 'this leave needs % day(s) notice', rule.notice_days
            USING ERRCODE = 'check_violation';
    END IF;
    IF rule.applies_to_gender IS NOT NULL THEN
        SELECT e.gender INTO gender FROM employees e WHERE e.id = NEW.employee_id;
        IF gender IS DISTINCT FROM rule.applies_to_gender THEN
            RAISE EXCEPTION 'this leave type is available to % staff only', rule.applies_to_gender
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF rule.max_per_month IS NOT NULL THEN
        -- Rejected requests are not spent days; pending ones are, or two
        -- applications sent the same morning both pass and the month is over.
        SELECT COALESCE(sum(r.days), 0) INTO taken
          FROM leave_requests r
         WHERE r.employee_id = NEW.employee_id
           AND r.leave_type_id = NEW.leave_type_id
           AND r.subject_kind = 'staff'
           AND r.status IN ('pending','approved')
           AND date_trunc('month', r.from_date) = date_trunc('month', NEW.from_date);
        IF taken + NEW.days > rule.max_per_month THEN
            RAISE EXCEPTION 'at most % day(s) of this leave may be taken in one month, and % are already booked',
                rule.max_per_month, taken USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE leave_policy_rules DROP CONSTRAINT IF EXISTS leave_policy_rules_per_month;
ALTER TABLE leave_policy_rules DROP COLUMN IF EXISTS max_per_month;
