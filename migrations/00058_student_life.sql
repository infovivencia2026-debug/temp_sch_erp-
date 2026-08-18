-- Claimed as 00058 at the time of writing; may be renumbered at integration if
-- another agent's migration lands first. Content is order-independent beyond
-- requiring 00037 (lost_found_items, students) and 00041 (virtual_class_sessions).
-- +goose Up

-- Six student screens that share one property: almost all of them are children
-- writing where other children can read. Nothing here is a broadcast channel
-- for the school; every row has a child's name on it, and every table that can
-- carry a child's words about another child carries a moderation state and a
-- takedown trail beside it.
--
-- Deliberately reused rather than rebuilt:
--   lost_found_items          00037 already holds the board. This adds the
--                             photo and the claim, not a second board.
--   virtual_class_sessions    00041 already holds the live class. Hand-raises
--                             are a child table on it; there is no second
--                             session model here and there must never be.
--   timetable_entries, homework, exam_subjects, holidays, club_events
--                             are the diary. The only new storage the diary
--                             needs is the child's own note against a date.

-- ============================================================ lost and found

-- The photo, and the question that stands between a bag and whoever clicks
-- first.
--
-- file_id is the only supported link into files, minted by
-- POST /api/v1/files/presign. photo_url is the fallback that keeps the feature
-- usable on a deployment where object storage is unconfigured and presign
-- answers 503 -- without it the photo half of a "photo board" would be dead in
-- production while looking finished.
--
-- claim_prompt is the finder's question: "what is on the sticker", "what is
-- inside the front pocket". It is asked of the claimant and the answer is not
-- shown to anyone but the finder and the office. Nullable because a found
-- umbrella needs no interrogation; when it is null the claim is still recorded
-- and still has to be approved, it just carries no secret to check.
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS file_id      uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS photo_url    text;
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS claim_prompt text;

-- Who physically walked away with it, and who handed it over.
--
-- 00037 has resolved_by/resolved_at, which record who marked the notice
-- settled. That is not the same fact: the office clerk who closes a stale
-- notice is not the person who released a bag. released_to_student_id is the
-- child it went to, released_by the adult or pupil who handed it across.
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS released_to_student_id uuid REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS released_by            uuid REFERENCES users(id)    ON DELETE SET NULL;
ALTER TABLE lost_found_items ADD COLUMN IF NOT EXISTS released_at timestamptz;

-- A claim on a found item, and the thing the claimant knew.
--
-- answer is the whole feature. The board shows a photo; the claimant must
-- describe something the photo does not show before the item is released. The
-- answer is stored, not compared -- there is no string equality that survives
-- "a red bus sticker" versus "sticker of a bus, red". A person decides, and
-- the row records which person and when, so a wrong release is answerable
-- rather than anonymous.
CREATE TABLE lost_found_claims (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    item_id        uuid        NOT NULL REFERENCES lost_found_items(id) ON DELETE CASCADE,
    -- The child claiming, and the account that submitted for them. A parent
    -- may claim on behalf of a six-year-old; the claim is still the child's.
    claimant_student_id uuid   NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    claimed_by     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answer         text        NOT NULL,
    status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    decided_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    decided_at     timestamptz,
    decision_note  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lost_found_claims_answer
        CHECK (nullif(btrim(answer), '') IS NOT NULL),
    -- A decided claim names its decider. Half a record of a released bag reads
    -- as settled and is worse than none.
    CONSTRAINT lost_found_claims_decision_complete
        CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
    CONSTRAINT lost_found_claims_decided_status
        CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL))
);

-- One live claim per child per item. Without this a child who reloads the form
-- files four claims and the finder sees four identical answers and cannot tell
-- whether that is one person or four. Withdrawn and rejected rows are excluded
-- so a child who got the answer wrong once may try again.
CREATE UNIQUE INDEX lost_found_claims_one_open
    ON lost_found_claims (item_id, claimant_student_id)
 WHERE status IN ('pending', 'approved');

CREATE INDEX lost_found_claims_item
    ON lost_found_claims (institution_id, item_id, created_at DESC);
CREATE INDEX lost_found_claims_mine
    ON lost_found_claims (institution_id, claimant_student_id, created_at DESC);

-- ================================================== moderation, shared

-- One takedown trail for every kind of student-authored public content.
--
-- The wall and the homework forum have the same problem and must not get two
-- differently-shaped answers to it: an adult must be able to remove a post
-- immediately, and the removal must leave a row naming who removed it and why.
-- A second, differently-shaped log would mean the wall and the forum disagree
-- about whether something was ever taken down, which is exactly the question
-- asked when a parent complains.
--
-- content_kind is text rather than a foreign key because the referent is in
-- one of two tables. The row is a log, never joined back for authorization.
CREATE TABLE student_content_moderation (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    content_kind   text        NOT NULL
                               CHECK (content_kind IN ('wall_post', 'forum_thread', 'forum_post')),
    content_id     uuid        NOT NULL,
    action         text        NOT NULL
                               CHECK (action IN ('submitted', 'approved', 'rejected',
                                                 'removed', 'restored', 'reported')),
    -- Null when the actor is the system, which it is for 'submitted'.
    actor_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
    reason         text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX student_content_moderation_content
    ON student_content_moderation (institution_id, content_kind, content_id, created_at DESC);
CREATE INDEX student_content_moderation_recent
    ON student_content_moderation (institution_id, created_at DESC);

-- ==================================================== the student wall

-- A child recognising another child for something specific.
--
-- status defaults to 'pending' and the wall shows only 'published'. This is
-- pre-moderation and it is the deliberate choice: post-moderation means the
-- unkind post is visible for the hours between being written and being read by
-- an adult, and on a wall of children those are the hours that do the damage.
-- The cost is latency on a compliment, which is the cheaper failure.
--
-- subject_student_id is who is being recognised and is NOT NULL: a recognition
-- with no recipient is a status update, and a wall of status updates is the
-- popularity contest this table is shaped to prevent. author and subject must
-- differ, enforced below -- self-recognition is the same failure in one row.
CREATE TABLE student_wall_posts (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid        NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    author_student_id  uuid    NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    author_user_id     uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_student_id uuid    NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- What the recognition is for. A closed list, because "something specific"
    -- is the whole requirement and a free-text category becomes a mood.
    category       text        NOT NULL
                               CHECK (category IN ('helped_with_work', 'returned_something',
                                                   'kindness', 'teamwork', 'courage',
                                                   'looked_after_someone')),
    body           text        NOT NULL,
    status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
    moderated_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    moderated_at   timestamptz,
    moderation_note text,
    -- Stored rather than derived so the per-day rate limit can be an index
    -- lookup. CURRENT_DATE in an index expression is not IMMUTABLE.
    posted_on      date        NOT NULL DEFAULT CURRENT_DATE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_wall_posts_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 500),
    CONSTRAINT student_wall_posts_not_self
        CHECK (author_student_id <> subject_student_id),
    CONSTRAINT student_wall_posts_moderation_complete
        CHECK ((moderated_at IS NULL) = (moderated_by IS NULL)),
    CONSTRAINT student_wall_posts_moderated_status
        CHECK (status = 'pending' OR moderated_at IS NOT NULL)
);

-- The wall as it is read: published first, newest first, per campus.
CREATE INDEX student_wall_posts_board
    ON student_wall_posts (institution_id, campus_id, status, created_at DESC);
-- The rate-limit lookup and the "who keeps praising the same person" question,
-- which is how a wall becomes a means of exclusion.
CREATE INDEX student_wall_posts_author_day
    ON student_wall_posts (institution_id, author_student_id, posted_on);
CREATE INDEX student_wall_posts_subject
    ON student_wall_posts (institution_id, subject_student_id, created_at DESC);
-- The moderation queue.
CREATE INDEX student_wall_posts_pending
    ON student_wall_posts (institution_id, created_at)
 WHERE status = 'pending';

COMMENT ON COLUMN student_wall_posts.status IS
    'pending until an adult approves. The wall renders published only; the rate limit counts every status, so spamming rejected posts does not buy a fresh allowance.';

-- ========================================== classmate homework help forum

-- A thread hanging off one homework, or off a subject when the question is not
-- about a set task.
--
-- Exactly one of homework_id and class_subject_id is required. A thread with
-- neither cannot be routed to a teacher; a thread with both invites two
-- different answers to "whose homework is this".
CREATE TABLE homework_forum_threads (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id     uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    homework_id      uuid      REFERENCES homework(id) ON DELETE CASCADE,
    class_subject_id uuid      REFERENCES class_subjects(id) ON DELETE CASCADE,
    author_student_id uuid     NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    author_user_id    uuid     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          text        NOT NULL,
    body           text        NOT NULL,
    status         text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'resolved', 'removed')),
    -- Set the moment a teacher takes it down, so the API can answer "why is my
    -- thread gone" without reading the log.
    removed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    removed_at     timestamptz,
    removal_reason text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT homework_forum_threads_title
        CHECK (nullif(btrim(title), '') IS NOT NULL),
    CONSTRAINT homework_forum_threads_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 2000),
    CONSTRAINT homework_forum_threads_anchor
        CHECK ((homework_id IS NULL) <> (class_subject_id IS NULL)),
    CONSTRAINT homework_forum_threads_removal_complete
        CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
    CONSTRAINT homework_forum_threads_removed_status
        CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

CREATE INDEX homework_forum_threads_section
    ON homework_forum_threads (institution_id, section_id, status, created_at DESC);
CREATE INDEX homework_forum_threads_homework
    ON homework_forum_threads (institution_id, homework_id, created_at DESC);

-- A reply, and whether it is a hint or the answer.
--
-- kind is the anti-copying mechanism and it is enforced in the API, not just
-- recorded: a post marked 'solution' is withheld from every student but its
-- author until the homework's due date has passed. Staff always see it. A
-- forum where the top reply is the worked answer is a homework-copying
-- service with a discussion board bolted on, and the difference between the
-- two products is exactly this column.
--
-- 'hint' and 'question' are visible immediately -- a child asking a follow-up
-- or nudging someone toward the method is the thing the feature is for.
CREATE TABLE homework_forum_posts (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    thread_id      uuid        NOT NULL REFERENCES homework_forum_threads(id) ON DELETE CASCADE,
    -- Null when a teacher replies: staff are not students and must not be
    -- forced through a students row to answer a question about their own work.
    author_student_id uuid     REFERENCES students(id) ON DELETE CASCADE,
    author_user_id    uuid     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_staff       boolean     NOT NULL DEFAULT false,
    kind           text        NOT NULL DEFAULT 'hint'
                               CHECK (kind IN ('question', 'hint', 'solution')),
    body           text        NOT NULL,
    status         text        NOT NULL DEFAULT 'visible'
                               CHECK (status IN ('visible', 'removed')),
    removed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    removed_at     timestamptz,
    removal_reason text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT homework_forum_posts_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 2000),
    CONSTRAINT homework_forum_posts_author
        CHECK (is_staff = (author_student_id IS NULL)),
    CONSTRAINT homework_forum_posts_removal_complete
        CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
    CONSTRAINT homework_forum_posts_removed_status
        CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

CREATE INDEX homework_forum_posts_thread
    ON homework_forum_posts (institution_id, thread_id, created_at);
CREATE INDEX homework_forum_posts_author
    ON homework_forum_posts (institution_id, author_student_id, created_at DESC);

COMMENT ON COLUMN homework_forum_posts.kind IS
    'question | hint | solution. A solution is hidden from other students until the homework due date passes; staff always see it.';

-- ====================================================== the digital diary

-- The child's own note against a date.
--
-- Everything else the diary shows -- periods, homework, tests, events, closures
-- -- already exists and is read, never copied. This table holds the one thing
-- the school does not already know: what the child wrote for themselves.
--
-- Deliberately private. There is no share flag and no teacher read path: a
-- diary a teacher can read is not a diary, and a child who learns that theirs
-- is readable stops using it honestly, which destroys the only value it has.
CREATE TABLE student_diary_notes (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The account that wrote it. A parent keeping a young child's diary is a
    -- real case; the note still belongs to the child's day.
    author_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    on_date        date        NOT NULL,
    -- What this note is against. A reminder to pack a PE kit is not the same
    -- as a note about a maths problem, and the day view groups by it.
    kind           text        NOT NULL DEFAULT 'note'
                               CHECK (kind IN ('note', 'reminder', 'homework', 'revision', 'personal')),
    body           text        NOT NULL,
    -- Ticked off. A reminder with no way to close it becomes noise by Friday.
    done_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_diary_notes_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 2000)
);

CREATE INDEX student_diary_notes_day
    ON student_diary_notes (institution_id, student_id, on_date, created_at);

-- ================================================= display preferences

-- One row per account: how this person wants the product to look.
--
-- The values are constrained to what the design system already implements --
-- index.css carries a light palette and a .dark override, and a data-density
-- dial with three steps. Nothing here invents a palette, and 'system' is not a
-- fourth theme but "follow the operating system", which the client resolves.
--
-- This exists because localStorage is per-device: a child who sets dark mode on
-- the lab machine gets the default again on the tablet at home, which reads as
-- the setting not working. The client keeps writing localStorage for a fast
-- first paint and reconciles against this row once the session loads.
--
-- Keyed on the user, not the student: the preference is about eyes, not
-- enrolment, and a teacher wants it as much as a child does.
CREATE TABLE user_display_preferences (
    user_id        uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    theme          text        NOT NULL DEFAULT 'system'
                               CHECK (theme IN ('system', 'light', 'dark')),
    density        text        NOT NULL DEFAULT 'comfortable'
                               CHECK (density IN ('compact', 'comfortable', 'relaxed')),
    -- Whether the child wants the first-run tour again. Not styling; the only
    -- other per-account display fact the shell already keeps in localStorage.
    reduce_motion  boolean     NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_display_preferences IS
    'Per-account display choices, restricted to options the existing design system already implements. Adding a value here without adding the palette to index.css yields a setting that does nothing.';

-- ============================================ virtual classroom hand-raise

-- A hand up in a live class, and whether anyone picked it.
--
-- Hangs off virtual_class_sessions from 00041. There is no second session
-- model here and there must not be one: a hand-raise that does not point at
-- the meeting the class actually sat in cannot answer any of the questions the
-- feature exists for.
--
-- There is no video integration on this deployment, so raised_at is written by
-- the child's own client pressing a button and answered_at by the teacher's.
-- That is the honest shape: this is the record, not the stream, and no column
-- here pretends to have been observed by a provider.
--
-- The value is the pattern, not the event. Two questions justify the table:
-- which children never raise a hand, and which raise one and are never called
-- on. The second needs answered_at nullable and a lowered_at that distinguishes
-- "put it down again" from "was ignored" -- without that separation an
-- unanswered raise and a withdrawn one look identical and the report is a lie.
CREATE TABLE virtual_class_hand_raises (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    session_id     uuid        NOT NULL REFERENCES virtual_class_sessions(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    raised_by      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    raised_at      timestamptz NOT NULL DEFAULT now(),
    -- The child took it down themselves.
    lowered_at     timestamptz,
    -- The teacher called on them.
    answered_at    timestamptz,
    answered_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- Optional: what they wanted to say. A child who types the question while
    -- waiting is easier to call on in order.
    note           text,
    CONSTRAINT virtual_class_hand_raises_answer_complete
        CHECK ((answered_at IS NULL) = (answered_by IS NULL)),
    -- A hand cannot be both withdrawn and answered; whichever happened, the
    -- other did not.
    CONSTRAINT virtual_class_hand_raises_one_outcome
        CHECK (lowered_at IS NULL OR answered_at IS NULL),
    CONSTRAINT virtual_class_hand_raises_order
        CHECK ((lowered_at  IS NULL OR lowered_at  >= raised_at)
           AND (answered_at IS NULL OR answered_at >= raised_at))
);

-- One hand at a time per child per session. A child hammering the button files
-- forty raises and the teacher's queue is unusable; the API raises again only
-- after the previous one is lowered or answered.
CREATE UNIQUE INDEX virtual_class_hand_raises_one_up
    ON virtual_class_hand_raises (session_id, student_id)
 WHERE lowered_at IS NULL AND answered_at IS NULL;

-- The teacher's live queue: oldest hand first, which is the fair order.
CREATE INDEX virtual_class_hand_raises_queue
    ON virtual_class_hand_raises (institution_id, session_id, raised_at);
-- The pattern over time, per child.
CREATE INDEX virtual_class_hand_raises_student
    ON virtual_class_hand_raises (institution_id, student_id, raised_at DESC);

-- ==================================================== row level security

ALTER TABLE lost_found_claims           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lost_found_claims           FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_content_moderation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_content_moderation  FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_wall_posts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_wall_posts          FORCE  ROW LEVEL SECURITY;
ALTER TABLE homework_forum_threads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE homework_forum_threads      FORCE  ROW LEVEL SECURITY;
ALTER TABLE homework_forum_posts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE homework_forum_posts        FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_diary_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_diary_notes         FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_display_preferences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_display_preferences    FORCE  ROW LEVEL SECURITY;
ALTER TABLE virtual_class_hand_raises   ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_class_hand_raises   FORCE  ROW LEVEL SECURITY;

CREATE POLICY lost_found_claims_tenant ON lost_found_claims
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY student_content_moderation_tenant ON student_content_moderation
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY student_wall_posts_tenant ON student_wall_posts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY homework_forum_threads_tenant ON homework_forum_threads
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY homework_forum_posts_tenant ON homework_forum_posts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY student_diary_notes_tenant ON student_diary_notes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY user_display_preferences_tenant ON user_display_preferences
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY virtual_class_hand_raises_tenant ON virtual_class_hand_raises
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON lost_found_claims          TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_content_moderation TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_wall_posts         TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON homework_forum_threads     TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON homework_forum_posts       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_diary_notes        TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_display_preferences   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON virtual_class_hand_raises  TO app_user;

-- +goose Down
DROP TABLE IF EXISTS virtual_class_hand_raises;
DROP TABLE IF EXISTS user_display_preferences;
DROP TABLE IF EXISTS student_diary_notes;
DROP TABLE IF EXISTS homework_forum_posts;
DROP TABLE IF EXISTS homework_forum_threads;
DROP TABLE IF EXISTS student_wall_posts;
DROP TABLE IF EXISTS student_content_moderation;
DROP TABLE IF EXISTS lost_found_claims;

ALTER TABLE lost_found_items
    DROP COLUMN IF EXISTS released_at,
    DROP COLUMN IF EXISTS released_by,
    DROP COLUMN IF EXISTS released_to_student_id,
    DROP COLUMN IF EXISTS claim_prompt,
    DROP COLUMN IF EXISTS photo_url,
    DROP COLUMN IF EXISTS file_id;
