-- +goose Up
-- "This section is done."
--
-- The office works the absentee list one section at a time and, once every
-- family in it has been rung, closes the section for the day. That closing is
-- a fact worth keeping separately from the per-child call log: the review of a
-- past day needs to say "1-A was finished at 10:40 by Shirisha" even when a
-- section had a single absentee whose row never changed from its default.
-- Idempotent: an earlier run of this migration under its pre-renumber number
-- already created the table on some databases, so every object is created only
-- if absent and the policy is dropped-then-recreated. That makes the renumbered
-- migration safe to run whether or not the table is already there.
CREATE TABLE IF NOT EXISTS absence_followup_section_done (
    institution_id uuid NOT NULL,
    section_id     uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    on_date        date NOT NULL,
    done_by        uuid,
    done_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (section_id, on_date)
);
CREATE INDEX IF NOT EXISTS absence_followup_section_done_institution_id_idx
    ON absence_followup_section_done (institution_id);

ALTER TABLE absence_followup_section_done ENABLE ROW LEVEL SECURITY;
ALTER TABLE absence_followup_section_done FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS absence_followup_section_done_tenant ON absence_followup_section_done;
CREATE POLICY absence_followup_section_done_tenant ON absence_followup_section_done
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON absence_followup_section_done TO app_user;

-- +goose Down
DROP TABLE IF EXISTS absence_followup_section_done;
