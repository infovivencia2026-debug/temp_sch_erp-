-- Renumbered above 00080 when operational-erp merged into sony. Production had
-- already applied sony's 00080, and goose refuses a migration numbered below
-- the current version -- so these four had to move up rather than the school's
-- database having to move back. Content is unchanged and order-independent of
-- everything between.
-- +goose Up
-- The KPI weight rule was stated three times and the three did not agree.
--
-- The handler (hr_growth.go) accepts 99.99 to 100.01 and says why in a
-- comment: "because 33.33 three times is 99.99 and refusing that would make
-- thirds unusable". The screen accepted the same band. The trigger below
-- tested `total <> 100` exactly, on a numeric(5,2).
--
-- So a set of three equal KPIs saved cleanly, showed as balanced, and then
-- every employee in that role was skipped at raise time -- reported honestly
-- by raiseAppraisals, but on a different card, later, as a list of names.
-- Thirds only actually worked when someone typed 33.33/33.33/33.34.
--
-- Relaxed rather than tightened, because the handler's comment is the
-- intent: three equal KPIs is an ordinary way to weight a role, and making a
-- user round one of them up by a hundredth to satisfy arithmetic they cannot
-- see is the wrong half of the disagreement to keep.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION appraisal_weights_must_total_100() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    total numeric;
BEGIN
    total := appraisal_weights_total(NEW.cycle_id, NEW.designation_id);
    -- A hundredth of a percent of slack, matching the handler exactly.
    IF ABS(total - 100) > 0.01 THEN
        RAISE EXCEPTION
            'the KPI weights for this role total %, not 100; fix the cycle before raising appraisals',
            total USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION appraisal_weights_must_total_100() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    total numeric;
BEGIN
    total := appraisal_weights_total(NEW.cycle_id, NEW.designation_id);
    IF total <> 100 THEN
        RAISE EXCEPTION
            'the KPI weights for this role total %, not 100; fix the cycle before raising appraisals',
            total USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
