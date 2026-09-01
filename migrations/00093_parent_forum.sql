-- Claimed as 00093; may be renumbered at integration if another agent's
-- migration lands first. Content is order-independent beyond requiring 00001
-- (sections, enrollments, users, guardians, support_tickets), 00082 (the
-- grievance columns on support_tickets and grievance_updates) and 00083
-- (student_content_moderation, whose CHECK this file widens).
--
-- No block comments anywhere in this file. goose's statement splitter cuts on
-- a semicolon it finds inside a slash-star comment, which has cost four runs.
-- +goose Up

-- ==========================================================
-- The parent community forum
-- ==========================================================
--
-- The third forum in this codebase and the first one for adults. The other two
-- -- student_wall_posts and homework_forum_threads, both 00083 -- are children
-- writing to children. This is parents writing to parents, and the risk is not
-- the same risk.
--
-- What is deliberately reused rather than rebuilt:
--
--   student_content_moderation   00083's one takedown trail. Its content_kind
--                                CHECK is widened below to carry
--                                'parent_forum_thread' and 'parent_forum_post'
--                                rather than a second, differently-shaped log
--                                being created here. A school asked "was this
--                                ever taken down, by whom, and why" must not
--                                have to be told which of two tables to look
--                                in, and the two would drift on the day one of
--                                them gained a column.
--
--   support_tickets              00082's grievance hub. A forum post that is
--                                really a complaint about a named teacher is
--                                converted into a ticket, not deleted -- see
--                                converted_ticket_id below. The forum has no
--                                complaint-handling machinery of its own and
--                                must never grow any, because the hub already
--                                enforces the one rule that matters: a
--                                grievance about a member of staff is not
--                                visible to that member of staff.
--
--   sections, enrollments        The audience. There is no forum membership
--                                table: who may read 8-B's forum is exactly
--                                who has a child enrolled in 8-B, which the
--                                enrolment already says. A membership table
--                                would be a second answer to that question and
--                                would be wrong the day a child transfers.

-- ---------------------------------------------------------- moderation trail

-- Widen 00083's log rather than create a second one.
--
-- The column was always documented as "text rather than a foreign key because
-- the referent is in one of two tables"; it is now one of four. The row is a
-- log and is never joined back for authorization, so nothing depends on the
-- set being small.
ALTER TABLE student_content_moderation
    DROP CONSTRAINT IF EXISTS student_content_moderation_content_kind_check;
ALTER TABLE student_content_moderation
    ADD CONSTRAINT student_content_moderation_content_kind_check
        CHECK (content_kind IN ('wall_post', 'forum_thread', 'forum_post',
                                'parent_forum_thread', 'parent_forum_post'));

-- 'converted' is the action this feature adds: a moderator moved a post into
-- the grievance hub instead of deleting it. It is a takedown -- the thread
-- stops being public -- so it belongs in the takedown trail beside 'removed',
-- and the distinction between the two is the whole argument of this file.
ALTER TABLE student_content_moderation
    DROP CONSTRAINT IF EXISTS student_content_moderation_action_check;
ALTER TABLE student_content_moderation
    ADD CONSTRAINT student_content_moderation_action_check
        CHECK (action IN ('submitted', 'approved', 'rejected', 'removed',
                          'restored', 'reported', 'converted', 'locked',
                          'unlocked', 'pinned', 'unpinned'));

-- ---------------------------------------------------------------- settings

-- Whether this school pre-moderates its parent forum.
--
-- The default is false, and that is a recommendation, not an oversight. The
-- student wall pre-moderates because its authors are children and the cost of
-- pre-moderation there is latency on a compliment. Here the authors are named
-- adults whose accountability is the guardian record behind them, and the
-- traffic is "the 8-B trip leaves at what time" -- a forum where that answer
-- appears twelve hours later, after an adult has read it, is a forum nobody
-- uses, and a coordination tool nobody uses is not safer, it is just absent.
--
-- The switch exists because that judgement is the school's to revisit. A
-- school that has been burned turns premoderate on and the same queue, the
-- same reasons and the same trail carry it; nothing else in the feature
-- changes shape. A boolean in Go would have made that a deployment.
--
-- Keyed on the institution, not the campus: this is a policy about how the
-- school talks to its parents, and two campuses of one school disagreeing
-- about it is a support call, not a feature.
CREATE TABLE parent_forum_settings (
    institution_id     uuid        PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    premoderate        boolean     NOT NULL DEFAULT false,
    -- Rate limits. Counted across every status, exactly as the wall counts
    -- them: a rejected or removed post that bought a fresh allowance would
    -- make the limit a suggestion.
    daily_thread_limit integer     NOT NULL DEFAULT 5,
    daily_post_limit   integer     NOT NULL DEFAULT 30,
    updated_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT parent_forum_settings_thread_limit CHECK (daily_thread_limit BETWEEN 1 AND 100),
    CONSTRAINT parent_forum_settings_post_limit   CHECK (daily_post_limit   BETWEEN 1 AND 500)
);

COMMENT ON COLUMN parent_forum_settings.premoderate IS
    'false by default: parents are named adults and a pre-moderated coordination forum is an unused one. True routes every new thread and reply through the pending queue, using the same reasons and the same trail.';

-- ----------------------------------------------------------------- threads

-- One conversation, scoped to one section.
--
-- section_id is NOT NULL and there is no school-wide variant. A school-wide
-- parent forum, a class forum and a topic forum are three different products,
-- and the class-scoped one is the only one whose audience is defined by a fact
-- the school already holds. Every read is narrowed to sections the caller has
-- a child enrolled in, in the SQL rather than in the client -- this codebase
-- has already shipped one leak where every parent saw every circular.
--
-- author_user_id is the account and author_guardian_id the person. Both, and
-- both NOT NULL: the account is who the server authenticated, the guardian is
-- the name and relation the forum prints. There is no anonymous mode and there
-- must not be one. Accountability is most of what keeps a parents' forum
-- civil, and an anonymous parents' forum about named teachers is the exact
-- artefact this feature has to avoid being.
CREATE TABLE parent_forum_threads (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id     uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id         uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    author_user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_guardian_id uuid        NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
    -- The child whose enrolment admitted the author to this section. Recorded
    -- so a takedown can be explained to the right family and so a parent whose
    -- child has left can be seen to have left the forum with them.
    via_student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- A closed list. Free text becomes a mood, and 'complaint' is deliberately
    -- absent: a complaint is a grievance and has its own tracked, private,
    -- SLA'd route. What the forum does with one that arrives anyway is convert
    -- it, not host it.
    category           text        NOT NULL DEFAULT 'general'
                                   CHECK (category IN ('general', 'event', 'trip',
                                                       'volunteering', 'logistics',
                                                       'lost_found', 'question')),
    title              text        NOT NULL,
    body               text        NOT NULL,
    -- pending exists only where the school has turned premoderate on.
    -- converted is a takedown with somewhere to go: the thread is off the
    -- board and converted_ticket_id says where the concern went.
    status             text        NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('pending', 'open', 'rejected',
                                                     'removed', 'converted')),
    -- Locked: readable, not repliable. Distinct from removed, which is gone.
    -- A thread that has run its course is closed, not deleted, and the
    -- difference is visible to the parents who wrote in it.
    locked_at          timestamptz,
    locked_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    lock_reason        text,
    -- Pinned by staff. The trip letter stays at the top of 8-B for a week.
    pinned_at          timestamptz,
    pinned_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    moderated_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    moderated_at       timestamptz,
    moderation_note    text,
    -- Where the concern went when a moderator decided it was a grievance.
    -- ON DELETE SET NULL rather than CASCADE: deleting a ticket must not
    -- delete the record that a thread was converted into one.
    converted_ticket_id uuid       REFERENCES support_tickets(id) ON DELETE SET NULL,
    -- Stored rather than derived so the per-day rate limit is an index lookup.
    -- CURRENT_DATE in an index expression is not IMMUTABLE.
    posted_on          date        NOT NULL DEFAULT CURRENT_DATE,
    -- Bumped by every visible reply. A forum ordered by opening date buries
    -- the conversation that is actually happening.
    last_activity_at   timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT parent_forum_threads_title
        CHECK (nullif(btrim(title), '') IS NOT NULL AND length(btrim(title)) <= 200),
    CONSTRAINT parent_forum_threads_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 4000),
    CONSTRAINT parent_forum_threads_lock_complete
        CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
    CONSTRAINT parent_forum_threads_pin_complete
        CHECK ((pinned_at IS NULL) = (pinned_by IS NULL)),
    CONSTRAINT parent_forum_threads_moderation_complete
        CHECK ((moderated_at IS NULL) = (moderated_by IS NULL)),
    -- A thread off the board names the adult who took it off. Half a record of
    -- a takedown reads as settled and is worse than none -- the same rule
    -- 00083 applies to a child's post, for the same reason.
    CONSTRAINT parent_forum_threads_off_board_moderated
        CHECK (status NOT IN ('rejected', 'removed', 'converted')
               OR moderated_at IS NOT NULL),
    -- Converted means converted. A status of 'converted' with no ticket is a
    -- takedown wearing the word that promised the parent it was not one.
    CONSTRAINT parent_forum_threads_converted_has_ticket
        CHECK ((status = 'converted') = (converted_ticket_id IS NOT NULL))
);

-- The board as it is read: one section, pinned first, then most recently
-- active. The status column is in the key because every parent-facing read
-- filters on it.
CREATE INDEX parent_forum_threads_board
    ON parent_forum_threads (institution_id, section_id, status, last_activity_at DESC);
-- The rate-limit lookup, and "which parent opens twelve threads a day".
CREATE INDEX parent_forum_threads_author_day
    ON parent_forum_threads (institution_id, author_user_id, posted_on);
-- The moderator's queue: what is waiting, and what has been reported. Partial
-- so it stays small on a school that does not pre-moderate.
CREATE INDEX parent_forum_threads_pending
    ON parent_forum_threads (institution_id, created_at)
 WHERE status = 'pending';

COMMENT ON COLUMN parent_forum_threads.converted_ticket_id IS
    'The grievance this thread became. A post that is really a complaint about a named teacher is moved into the hub, where the subject_employee_id exclusion applies — deleting it would destroy the concern along with the post.';
COMMENT ON COLUMN parent_forum_threads.author_guardian_id IS
    'The named guardian. There is no anonymous mode: an anonymous parents forum discussing named teachers is the failure this feature is shaped to avoid.';

-- ------------------------------------------------------------------- posts

-- A reply.
--
-- is_staff mirrors 00083's homework_forum_posts exactly: a member of staff
-- replying carries no guardian row and must not be forced through one to
-- answer a question about their own trip. The two columns move together and
-- the CHECK enforces it, so "who wrote this" has one answer.
CREATE TABLE parent_forum_posts (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id     uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    thread_id          uuid        NOT NULL REFERENCES parent_forum_threads(id) ON DELETE CASCADE,
    author_user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Null exactly when the author is staff.
    author_guardian_id uuid        REFERENCES guardians(id) ON DELETE CASCADE,
    is_staff           boolean     NOT NULL DEFAULT false,
    body               text        NOT NULL,
    status             text        NOT NULL DEFAULT 'visible'
                                   CHECK (status IN ('pending', 'visible', 'rejected', 'removed')),
    moderated_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    moderated_at       timestamptz,
    moderation_note    text,
    posted_on          date        NOT NULL DEFAULT CURRENT_DATE,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT parent_forum_posts_body
        CHECK (nullif(btrim(body), '') IS NOT NULL AND length(btrim(body)) <= 4000),
    CONSTRAINT parent_forum_posts_author
        CHECK (is_staff = (author_guardian_id IS NULL)),
    CONSTRAINT parent_forum_posts_moderation_complete
        CHECK ((moderated_at IS NULL) = (moderated_by IS NULL)),
    CONSTRAINT parent_forum_posts_off_board_moderated
        CHECK (status NOT IN ('rejected', 'removed') OR moderated_at IS NOT NULL)
);

CREATE INDEX parent_forum_posts_thread
    ON parent_forum_posts (institution_id, thread_id, created_at);
CREATE INDEX parent_forum_posts_author_day
    ON parent_forum_posts (institution_id, author_user_id, posted_on);
CREATE INDEX parent_forum_posts_pending
    ON parent_forum_posts (institution_id, created_at)
 WHERE status = 'pending';

-- ---------------------------------------------------------------- reports

-- One reader flagging one thing for an adult to read.
--
-- A report does NOT hide anything, which is 00083's rule and is kept here for
-- the same reason: a report that auto-hid would be a heckler's veto, and on a
-- parents' forum the first use of it would be against the parent raising the
-- uncomfortable question. It enqueues, it does not act.
--
-- Separate from student_content_moderation because a report needs a UNIQUE
-- constraint and the log must never have one -- the log is append-only history
-- and a second removal of the same post is a second row. Both are still
-- written: the report row is the queue, and logStudentContent records the
-- event in the one trail, in the same transaction.
--
-- content_id is NOT NULL and content_kind constrained, so the pair is total.
-- No COALESCE sentinel is needed anywhere in this file: the unique index below
-- names only NOT NULL columns, which is the only shape that actually enforces
-- anything. A nullable column inside a UNIQUE index enforces nothing at all,
-- because a NULL is distinct from every other NULL.
CREATE TABLE parent_forum_reports (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    content_kind   text        NOT NULL
                               CHECK (content_kind IN ('parent_forum_thread', 'parent_forum_post')),
    content_id     uuid        NOT NULL,
    reported_by    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason         text        NOT NULL,
    -- Cleared when a moderator has looked, whatever they decided. An unhandled
    -- report and a report that was considered and dismissed must not look the
    -- same, or the queue is either forever growing or silently emptied.
    handled_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    handled_at     timestamptz,
    outcome        text        CHECK (outcome IS NULL
                                      OR outcome IN ('upheld', 'dismissed', 'converted')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT parent_forum_reports_reason
        CHECK (nullif(btrim(reason), '') IS NOT NULL AND length(btrim(reason)) <= 1000),
    CONSTRAINT parent_forum_reports_handled_complete
        CHECK ((handled_at IS NULL) = (handled_by IS NULL)),
    CONSTRAINT parent_forum_reports_outcome_handled
        CHECK ((outcome IS NULL) = (handled_at IS NULL))
);

-- One open report per person per item. Without it a parent who reloads the
-- form files four identical reports and the queue reads as four people
-- objecting, which is exactly the number a moderator weighs. Every column in
-- the key is NOT NULL, so the index enforces what it says it does.
CREATE UNIQUE INDEX parent_forum_reports_one_open
    ON parent_forum_reports (content_kind, content_id, reported_by)
 WHERE handled_at IS NULL;

-- The moderator's queue: unhandled first, oldest first, because the report
-- that has sat for three days is the one doing the damage.
CREATE INDEX parent_forum_reports_queue
    ON parent_forum_reports (institution_id, created_at)
 WHERE handled_at IS NULL;
CREATE INDEX parent_forum_reports_content
    ON parent_forum_reports (institution_id, content_kind, content_id, created_at DESC);

-- ---------------------------------------------------------- row level security

ALTER TABLE parent_forum_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_forum_settings FORCE  ROW LEVEL SECURITY;
ALTER TABLE parent_forum_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_forum_threads  FORCE  ROW LEVEL SECURITY;
ALTER TABLE parent_forum_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_forum_posts    FORCE  ROW LEVEL SECURITY;
ALTER TABLE parent_forum_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_forum_reports  FORCE  ROW LEVEL SECURITY;

CREATE POLICY parent_forum_settings_tenant ON parent_forum_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY parent_forum_threads_tenant ON parent_forum_threads
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY parent_forum_posts_tenant ON parent_forum_posts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY parent_forum_reports_tenant ON parent_forum_reports
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON parent_forum_settings TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON parent_forum_threads  TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON parent_forum_posts    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON parent_forum_reports  TO app_user;

-- +goose Down
DROP TABLE IF EXISTS parent_forum_reports;
DROP TABLE IF EXISTS parent_forum_posts;
DROP TABLE IF EXISTS parent_forum_threads;
DROP TABLE IF EXISTS parent_forum_settings;

-- Put 00083's two CHECKs back exactly as they were, so a down-migration leaves
-- the shared log in the shape the migration before this one left it. The
-- parent-forum log rows go first: the narrower CHECK cannot be re-added while
-- rows it forbids are still present, and those rows point at tables that no
-- longer exist by this line.
DELETE FROM student_content_moderation
 WHERE content_kind IN ('parent_forum_thread', 'parent_forum_post')
    OR action IN ('converted', 'locked', 'unlocked', 'pinned', 'unpinned');
ALTER TABLE student_content_moderation
    DROP CONSTRAINT IF EXISTS student_content_moderation_content_kind_check;
ALTER TABLE student_content_moderation
    ADD CONSTRAINT student_content_moderation_content_kind_check
        CHECK (content_kind IN ('wall_post', 'forum_thread', 'forum_post'));

ALTER TABLE student_content_moderation
    DROP CONSTRAINT IF EXISTS student_content_moderation_action_check;
ALTER TABLE student_content_moderation
    ADD CONSTRAINT student_content_moderation_action_check
        CHECK (action IN ('submitted', 'approved', 'rejected', 'removed',
                          'restored', 'reported'));
