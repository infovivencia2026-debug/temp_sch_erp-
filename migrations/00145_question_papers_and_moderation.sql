-- +goose Up
-- The two checks a head of department does that the product did not know about.
--
-- Before an exam, somebody senior reads the paper: is it on the syllabus, is it
-- the right length for the time allowed, are the marks adding to the total on
-- the cover. After the exam, somebody senior reads the marks: has one section
-- come out twenty points below the other three because of who marked it.
--
-- Both were happening — on WhatsApp and on paper — and both were invisible
-- here. The consequence is not that a step was missing; it is that the record
-- of who approved what did not exist. When a paper goes out with a question
-- from next term's chapter, the school needs to know it was seen and by whom,
-- and "I think I sent it to sir" is not an answer.
--
-- Two tables, because they are two different objects with two different
-- lifetimes: a paper is approved once before the exam, and marks are moderated
-- per paper after it. Modelling them as one "approval" row with a kind column
-- would put an exam date and a moderation delta in the same row, most of it
-- null on either side.

-- ---------------------------------------------------------------------------
-- Question papers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_papers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- One paper is for one subject in one exam. exam_subjects already carries
    -- the class, the date, the duration and the maximum, so none of it is
    -- copied here — a paper whose max_marks disagreed with the exam it belongs
    -- to would be a second opinion on the same fact.
    exam_subject_id uuid NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,

    -- The paper itself. Nullable because a teacher may open the row and attach
    -- the file afterwards, and losing what they typed in the meantime would
    -- teach them to do it outside the product.
    file_id         uuid REFERENCES files(id) ON DELETE SET NULL,
    notes           text,

    submitted_by    uuid NOT NULL REFERENCES users(id),
    submitted_at    timestamptz NOT NULL DEFAULT now(),

    -- draft            the teacher is still working on it; nobody is waiting
    -- submitted        in the head of department's queue
    -- approved         may be printed
    -- changes_needed   sent back, with a reason the teacher can act on
    status          text NOT NULL DEFAULT 'draft',

    reviewed_by     uuid REFERENCES users(id),
    reviewed_at     timestamptz,
    -- Why it came back. Required when it comes back: "changes needed" with no
    -- sentence attached is a rejection the teacher cannot act on, and they will
    -- resubmit the same paper.
    review_note     text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT question_papers_status_check
        CHECK (status = ANY (ARRAY['draft', 'submitted', 'approved', 'changes_needed'])),
    CONSTRAINT question_papers_decided_together
        CHECK ((status IN ('draft', 'submitted')) = (reviewed_at IS NULL)),
    CONSTRAINT question_papers_reason_when_returned
        CHECK (status <> 'changes_needed' OR nullif(btrim(review_note), '') IS NOT NULL)
);

-- One live paper per exam subject. A second row is not a second draft, it is
-- two papers for one exam and nobody knowing which was printed. Resubmission
-- after changes updates the row, so the history of the decision stays attached
-- to the thing decided.
CREATE UNIQUE INDEX IF NOT EXISTS question_papers_one_per_subject
    ON question_papers (exam_subject_id);

-- The head of department's queue reads this.
CREATE INDEX IF NOT EXISTS question_papers_queue
    ON question_papers (institution_id, status, submitted_at);

ALTER TABLE question_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_papers FORCE ROW LEVEL SECURITY;

CREATE POLICY question_papers_tenant ON question_papers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- ---------------------------------------------------------------------------
-- Mark moderation
-- ---------------------------------------------------------------------------
-- marks already has approved_by and approved_at, and nothing ever wrote them.
-- That is the per-student half. This is the per-paper half: the decision the
-- head of department actually makes is about a whole paper — "this section's
-- Physics is five marks light" — and recording it once per student would be
-- five hundred copies of one judgement with no way to see it was one.
CREATE TABLE IF NOT EXISTS mark_moderations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    exam_subject_id uuid NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,

    -- What was done, in marks. Positive lifts the paper, negative pulls it
    -- down, zero means "read and left alone" — which is a decision, and the
    -- most common one, so it must be recordable.
    adjustment      numeric(5,2) NOT NULL DEFAULT 0,
    -- Why. A moderation with no reason cannot be defended to a parent, and it
    -- is a parent who will ask.
    reason          text NOT NULL,

    moderated_by    uuid NOT NULL REFERENCES users(id),
    moderated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mark_moderations_reason_present
        CHECK (nullif(btrim(reason), '') IS NOT NULL),
    -- A moderation larger than this is not moderation, it is re-marking the
    -- paper, and it should be done by changing the marks.
    CONSTRAINT mark_moderations_sane
        CHECK (adjustment BETWEEN -20 AND 20)
);

CREATE UNIQUE INDEX IF NOT EXISTS mark_moderations_one_per_subject
    ON mark_moderations (exam_subject_id);

ALTER TABLE mark_moderations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mark_moderations FORCE ROW LEVEL SECURITY;

CREATE POLICY mark_moderations_tenant ON mark_moderations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS mark_moderations;
DROP TABLE IF EXISTS question_papers;
