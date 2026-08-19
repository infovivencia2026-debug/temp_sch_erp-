-- +goose Up
-- A remark about a member of staff.
--
-- student_remarks has existed since 00029 and records what a teacher observed
-- about a child. There was no table for the other direction, and the catalogue
-- carried four entries implying there was: "Remarks", "Class Teacher Remarks",
-- "Staff remarks" and "Teacher remarks" all pointed at screens that read the
-- student table, so a head of department opening "Teacher remarks" was shown
-- remarks teachers had written about children.
--
-- Who may write one is deliberately wide and the reasons differ:
--
--   A head of department, about somebody in their department. This is the
--   ordinary case and the one the appraisal cycle is built on.
--
--   The principal, about anybody. Someone has to be able to write the remark
--   the head of department is the subject of.
--
--   A parent, about a teacher who teaches their child. A school that accepts
--   praise and complaints only by telephone has no record of either, and the
--   teacher never learns about the praise at all.
--
-- The subject of the remark always reads it. A record about somebody that they
-- cannot see is a file kept on them, which is a different thing from feedback
-- and is not what this is for. There is no private variant for that reason —
-- unlike student_remarks, where a teacher's working note about a child is
-- genuinely their own.

CREATE TABLE IF NOT EXISTS staff_remarks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Whom it is about. A user rather than an employee: a remark from a parent
    -- is about the person who taught their child, and the teacher reads it
    -- signed in as themselves.
    subject_user_id uuid       NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Who wrote it. Kept on the row rather than derived, and never null: an
    -- unattributed remark about a member of staff is a rumour with a
    -- timestamp.
    author_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Which relationship licensed it, recorded at the time. A parent whose
    -- child leaves the school, or a HOD who moves department, does not
    -- retrospectively lose the right to have said this.
    author_role    text        NOT NULL,

    -- The child it concerns, where a parent wrote it. Null otherwise.
    student_id     uuid        REFERENCES students(id) ON DELETE SET NULL,

    kind           text        NOT NULL DEFAULT 'feedback',
    body           text        NOT NULL,
    observed_on    date        NOT NULL DEFAULT CURRENT_DATE,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_remarks_kind_check
        CHECK (kind IN ('feedback', 'commendation', 'concern', 'appraisal')),
    CONSTRAINT staff_remarks_author_role_check
        CHECK (author_role IN ('hod', 'principal', 'parent')),
    CONSTRAINT staff_remarks_body_present
        CHECK (nullif(btrim(body), '') IS NOT NULL),
    -- Writing a remark about yourself is either a mistake or a way of putting
    -- praise in your own file.
    CONSTRAINT staff_remarks_not_self CHECK (subject_user_id <> author_user_id)
);

CREATE INDEX IF NOT EXISTS staff_remarks_subject
    ON staff_remarks (subject_user_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS staff_remarks_author
    ON staff_remarks (author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_remarks_institution
    ON staff_remarks (institution_id);

ALTER TABLE staff_remarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_remarks FORCE ROW LEVEL SECURITY;

-- The same tenant policy every other table in this schema carries. The
-- narrower question — which of this school's remarks a given person may read —
-- is the handler's, because it depends on whether they are the subject, the
-- author, or the person who runs the department.
CREATE POLICY staff_remarks_tenant ON staff_remarks
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS staff_remarks;
