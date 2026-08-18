-- Renumbered from 00036: another domain merged into that slot first.
-- Content unchanged.
-- +goose Up
-- What a child does at school that nothing in the schema already records.
--
-- Most of the student portal is a narrower view of tables that exist already:
-- class_subjects and subjects carry the course list, study_materials carries the
-- resource hub, marks and report_cards carry the academic record,
-- library_reservations carries the book hold queue, students.apaar_id carries
-- the APAAR, holidays and terms and exam_subjects carry the calendar. None of
-- that is copied here — a second table holding the same fact is only ever the
-- one that disagrees with the office.
--
-- What is genuinely absent is everything the child does alongside the syllabus:
-- studying with each other, keeping a portfolio, applying abroad, losing a water
-- bottle, opening a locker, going to a club night, banking credits, and staying
-- in touch after they leave.

/* Studying together, and who is teaching whom.

   Peer tutoring and a study group are the same object seen from two sides: a
   group with a member marked 'tutor' is peer tutoring, and one without is a
   study group. Modelling them separately produced two screens that listed the
   same Thursday lunchtime meeting twice.

   section_id, not class_id: a group meets, and Grade 6-A and 6-B do not share a
   room at lunch. class_subject_id is nullable because "revision, generally" is a
   real group and forcing a subject on it would file it under whichever one the
   organiser picked first. */
CREATE TABLE study_groups (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    section_id        uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    class_subject_id  uuid        REFERENCES class_subjects(id) ON DELETE SET NULL,
    -- The student who called the meeting. Not a user id: the organiser is a
    -- classmate, and the roster this hangs off is keyed by student.
    organiser_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    name              text        NOT NULL,
    topic             text,
    -- Free text on purpose. "Tuesdays and Thursdays, second lunch" is how
    -- children actually arrange this, and a recurrence rule would be a
    -- timetable the school does not own.
    meets_when        text,
    venue             text,
    -- NULL means "as many as turn up". A zero would read as a closed group,
    -- which is what is_open already says.
    capacity          integer     CHECK (capacity IS NULL OR capacity > 0),
    is_open           boolean     NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT study_groups_name CHECK (nullif(btrim(name), '') IS NOT NULL)
);

CREATE INDEX study_groups_section ON study_groups (institution_id, section_id, is_open);

/* One group of a given name per section, while it is open.

   Twelve children each pressing "create" on the same arrangement produced
   twelve groups and no meeting. Closed groups are excluded so next term's
   "Algebra revision" is not blocked by last term's. */
CREATE UNIQUE INDEX study_groups_one_open
    ON study_groups (section_id, lower(btrim(name)))
 WHERE is_open;

CREATE TABLE study_group_members (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    group_id       uuid        NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- 'tutor' is what makes this peer tutoring rather than a study group.
    role           text        NOT NULL DEFAULT 'member'
                               CHECK (role IN ('tutor', 'member')),
    joined_at      timestamptz NOT NULL DEFAULT now(),
    -- Kept rather than deleted: a child who left a group and rejoined has a
    -- history, and the count of who was there on a given week is the only
    -- evidence the tutoring happened.
    left_at        timestamptz
);

/* One live membership per child per group.

   left_at is nullable, so it cannot be a key column — a NULL there would make
   every row distinct and the index would admit the duplicate it exists to
   refuse. The predicate carries the "live" instead. */
CREATE UNIQUE INDEX study_group_members_one_live
    ON study_group_members (group_id, student_id)
 WHERE left_at IS NULL;

CREATE INDEX study_group_members_student
    ON study_group_members (institution_id, student_id)
 WHERE left_at IS NULL;

/* The child's own evidence of themselves.

   student_achievements already holds what the school awarded, and this is
   deliberately not that: it is what the child did, entered by the child, and
   the two are shown side by side rather than merged. A school prize and a
   self-declared hackathon are different kinds of claim and a university reading
   the portfolio is entitled to see which is which.

   is_shared is the child's decision, not the school's. A half-finished poem in
   a portfolio is not a submission, and defaulting it visible would teach
   children to keep their drafts somewhere else. */
CREATE TABLE student_portfolio_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind           text        NOT NULL DEFAULT 'project'
                               CHECK (kind IN ('project', 'essay', 'artwork', 'performance',
                                               'certificate', 'competition', 'internship',
                                               'volunteering', 'other')),
    title          text        NOT NULL,
    description    text,
    subject_id     uuid        REFERENCES subjects(id) ON DELETE SET NULL,
    happened_on    date,
    -- Either a link out or a file already uploaded through the portal. Both
    -- nullable: a portfolio entry with neither is still a claim worth recording.
    evidence_url   text,
    file_id        uuid        REFERENCES files(id) ON DELETE SET NULL,
    is_shared      boolean     NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_portfolio_items_title CHECK (nullif(btrim(title), '') IS NOT NULL)
);

CREATE INDEX student_portfolio_items_student
    ON student_portfolio_items (institution_id, student_id, happened_on DESC);

/* One entry per title per day per child.

   happened_on is nullable and would silently void this index if it were a bare
   key column, so the coalesce supplies a date no event can have. A double-tap
   on a slow connection is the whole reason this exists. */
CREATE UNIQUE INDEX student_portfolio_items_no_duplicates
    ON student_portfolio_items
       (student_id, lower(btrim(title)), COALESCE(happened_on, '0001-01-01'::date));

/* Applying abroad, tracked by the child rather than by a counsellor's inbox.

   The guidance in "guidance counsellor" is the structure, not an adviser: a
   pipeline of statuses, the entrance exam each place wants, and the deadline.
   Indian families lose places to the deadline far more often than to the essay,
   and a list sorted by what closes next is the whole intervention.

   The fee is stored in paise like every other amount in this schema, and it is
   the rupee equivalent the family should plan for rather than the foreign
   figure on the prospectus. A family budgets in rupees; a currency column would
   invite a screen that adds dollars to pounds. */
CREATE TABLE university_shortlist_entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id          uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    university          text        NOT NULL,
    country             text        NOT NULL,
    course              text,
    -- "Fall 2028", "Michaelmas 2027". Free text because every country names
    -- its intakes differently and none of them agree with an Indian term.
    intake              text,
    application_deadline date,
    entrance_exams      text,
    annual_fee_paise    bigint      CHECK (annual_fee_paise IS NULL OR annual_fee_paise >= 0),
    scholarship_sought  boolean     NOT NULL DEFAULT false,
    status              text        NOT NULL DEFAULT 'researching'
                                    CHECK (status IN ('researching', 'shortlisted', 'applied',
                                                      'interview', 'offer', 'rejected',
                                                      'accepted', 'withdrawn')),
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT university_shortlist_entries_university
        CHECK (nullif(btrim(university), '') IS NOT NULL)
);

CREATE INDEX university_shortlist_entries_student
    ON university_shortlist_entries (institution_id, student_id, application_deadline);

/* One row per course per university per child.

   course is nullable — "Oxford, something" is a real early entry — so it is
   coalesced to the empty string rather than left to make every row unique. */
CREATE UNIQUE INDEX university_shortlist_entries_once
    ON university_shortlist_entries
       (student_id, lower(btrim(university)), lower(btrim(COALESCE(course, ''))));

/* The noticeboard by the staff room, which is where this actually lives today.

   Campus-wide rather than class-wide on purpose: a bottle left in the hall is
   found by whoever walks past, and a board only their own section could read
   would never reunite anything. It carries no personal data beyond the name of
   the person to go and see, which is what a paper notice carries too.

   'lost' and 'found' in one table because the board is one board. Two tables
   produced two screens and nobody cross-checked them. */
CREATE TABLE lost_found_items (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id        uuid        NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    kind             text        NOT NULL CHECK (kind IN ('lost', 'found')),
    title            text        NOT NULL,
    description      text,
    category         text,
    place            text,
    on_date          date        NOT NULL DEFAULT CURRENT_DATE,
    -- Who to go and see. The user id is who posted it; the student id is set
    -- when that was a child, so the board can say "Grade 6-A" rather than
    -- publishing a phone number.
    reported_by      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reporter_student_id uuid     REFERENCES students(id) ON DELETE SET NULL,
    status           text        NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open', 'claimed', 'returned', 'closed')),
    -- Closing is an event with an author. "Who said this was returned" is the
    -- first question when the owner says it never was.
    resolved_at      timestamptz,
    resolved_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    resolution_note  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lost_found_items_title CHECK (nullif(btrim(title), '') IS NOT NULL),
    -- A resolved item names who resolved it; half a record of a returned bag is
    -- worse than none, because it reads as settled.
    CONSTRAINT lost_found_items_resolution_complete
        CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
    CONSTRAINT lost_found_items_resolved_status
        CHECK ((status IN ('returned', 'closed')) = (resolved_at IS NOT NULL))
);

CREATE INDEX lost_found_items_board
    ON lost_found_items (institution_id, campus_id, status, on_date DESC);

/* The locker itself, and the combination the child is entitled to be told.

   The combination is stored recoverable and that is the feature, not an
   oversight: the entire point of the screen is to tell a child who has
   forgotten it what it is. What protects it is that it is returned by exactly
   one endpoint, to exactly one student, and that asking leaves a row in the
   access log. It must never appear in a list.

   student_id is nullable because a locker exists before it is allotted and
   again after the child leaves. released_on is what ends a tenancy; the row is
   kept so "who had locker 214 last year" is answerable. */
CREATE TABLE student_lockers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid        NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    locker_no      text        NOT NULL,
    location       text,
    student_id     uuid        REFERENCES students(id) ON DELETE SET NULL,
    combination    text,
    assigned_on    date,
    released_on    date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_lockers_no CHECK (nullif(btrim(locker_no), '') IS NOT NULL),
    -- An allotted locker has a start date, and a released one was allotted
    -- first. Neither half is meaningful alone.
    CONSTRAINT student_lockers_assignment_complete
        CHECK ((student_id IS NULL) = (assigned_on IS NULL)),
    CONSTRAINT student_lockers_released_after_assigned
        CHECK (released_on IS NULL OR (assigned_on IS NOT NULL AND released_on >= assigned_on))
);

CREATE UNIQUE INDEX student_lockers_number
    ON student_lockers (institution_id, campus_id, lower(btrim(locker_no)));

/* One live locker per child.

   student_id is nullable, so the unassigned rows are excluded by the predicate
   rather than coalesced: two empty lockers are not a duplicate of each other,
   and a sentinel uuid would make them one. */
CREATE UNIQUE INDEX student_lockers_one_live
    ON student_lockers (institution_id, student_id)
 WHERE student_id IS NOT NULL AND released_on IS NULL;

/* Every time the locker was touched, and every time the combination was read.

   'combination_viewed' is the row that matters. A locker forced open is
   discovered eventually; a combination quietly looked up by someone who should
   not have it leaves no trace at all unless the lookup itself is the event. */
CREATE TABLE locker_access_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    locker_id      uuid        NOT NULL REFERENCES student_lockers(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- Who was holding the phone. Separate from student_id because a parent
    -- reading their child's locker log is a different actor from the child.
    actor_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
    action         text        NOT NULL
                               CHECK (action IN ('opened', 'closed', 'combination_viewed',
                                                 'reported_jammed', 'reported_tampered')),
    happened_at    timestamptz NOT NULL DEFAULT now(),
    note           text
);

CREATE INDEX locker_access_events_locker
    ON locker_access_events (locker_id, happened_at DESC);

/* A club night, and who said they were coming.

   Capacity is why this is ticketed rather than announced: the drama club's
   hall seats ninety and the announcement reaches nine hundred. NULL capacity
   means the hall is not the constraint.

   min_class_level and max_class_level target the event by classes.level rather
   than by naming sections, so a senior debate does not appear on a Grade 6
   calendar and the club does not have to relist every section each year. */
CREATE TABLE club_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id         uuid        NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    club_name         text        NOT NULL,
    title             text        NOT NULL,
    description       text,
    venue             text,
    starts_at         timestamptz NOT NULL,
    ends_at           timestamptz,
    capacity          integer     CHECK (capacity IS NULL OR capacity > 0),
    ticket_price_paise bigint     NOT NULL DEFAULT 0
                                  CHECK (ticket_price_paise >= 0),
    booking_closes_at timestamptz,
    min_class_level   integer,
    max_class_level   integer,
    status            text        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('draft', 'open', 'closed', 'cancelled', 'done')),
    created_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT club_events_title CHECK (nullif(btrim(title), '') IS NOT NULL),
    CONSTRAINT club_events_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT club_events_level_range
        CHECK (min_class_level IS NULL OR max_class_level IS NULL
               OR max_class_level >= min_class_level)
);

CREATE INDEX club_events_upcoming
    ON club_events (institution_id, campus_id, starts_at);

/* One event per club per title per start.

   A club posting the same night twice fills the hall twice and nobody knows
   which ticket is valid. */
CREATE UNIQUE INDEX club_events_once
    ON club_events (institution_id, campus_id, lower(btrim(club_name)),
                    lower(btrim(title)), starts_at);

/* The pass, and the scan at the door.

   code is what the gate reads. It is generated by the server and never derived
   from the ticket id, because an id in a URL is guessable in a way a random
   code is not — the same reasoning as the pickup pass, and for the same reason:
   the thing being controlled is physical entry. */
CREATE TABLE club_event_tickets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    event_id       uuid        NOT NULL REFERENCES club_events(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    code           text        NOT NULL,
    booked_at      timestamptz NOT NULL DEFAULT now(),
    status         text        NOT NULL DEFAULT 'booked'
                               CHECK (status IN ('booked', 'checked_in', 'cancelled')),
    checked_in_at  timestamptz,
    checked_in_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at   timestamptz,
    CONSTRAINT club_event_tickets_code_format CHECK (code ~ '^[A-Z0-9]{8}$'),
    -- A scanned ticket names the moment and the person who scanned it. Half of
    -- that pair is a check-in nobody can account for.
    CONSTRAINT club_event_tickets_checkin_complete
        CHECK ((checked_in_at IS NULL) = (checked_in_by IS NULL)),
    CONSTRAINT club_event_tickets_checkin_status
        CHECK ((status = 'checked_in') = (checked_in_at IS NOT NULL)),
    CONSTRAINT club_event_tickets_cancel_status
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX club_event_tickets_code
    ON club_event_tickets (institution_id, code);

/* One live ticket per child per event.

   Cancelled tickets are excluded so a child who changed their mind can book
   again, and so a cancelled code can never be presented at the door alongside
   its replacement. */
CREATE UNIQUE INDEX club_event_tickets_one_live
    ON club_event_tickets (event_id, student_id)
 WHERE status <> 'cancelled';

/* Credits banked against the APAAR, under NEP's Academic Bank of Credits.

   The APAAR itself already lives on students.apaar_id and is not copied here.
   What is copied, deliberately, is the APAAR as it read on the day of the
   deposit: a mistyped APAAR gets corrected later, and a receipt that silently
   changes to match is not a receipt.

   Credits are numeric rather than integer because a half credit is a real
   award for a short module, and rounding it away at the schema is a decision
   the schema is not entitled to make. */
CREATE TABLE abc_credit_entries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id       uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id uuid        REFERENCES academic_years(id) ON DELETE SET NULL,
    apaar_id         text,
    course_title     text        NOT NULL,
    subject_id       uuid        REFERENCES subjects(id) ON DELETE SET NULL,
    credits          numeric(5,2) NOT NULL CHECK (credits > 0),
    level            text        CHECK (level IS NULL OR level IN ('school', 'vocational',
                                                                   'skill', 'co_curricular')),
    session_label    text,
    grade            text,
    status           text        NOT NULL DEFAULT 'earned'
                                 CHECK (status IN ('earned', 'deposited', 'redeemed', 'withdrawn')),
    deposited_on     date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT abc_credit_entries_course CHECK (nullif(btrim(course_title), '') IS NOT NULL),
    -- 'deposited' is a claim about the national register, and a deposit with no
    -- date cannot be reconciled against it.
    CONSTRAINT abc_credit_entries_deposit_dated
        CHECK (status <> 'deposited' OR deposited_on IS NOT NULL)
);

CREATE INDEX abc_credit_entries_student
    ON abc_credit_entries (institution_id, student_id);

/* One deposit per course per session per child.

   Both academic_year_id and session_label are nullable, and either left bare
   would make every row distinct — the credits would then double on a retried
   deposit, which is the one failure an academic bank must not have. */
CREATE UNIQUE INDEX abc_credit_entries_once
    ON abc_credit_entries
       (student_id, lower(btrim(course_title)),
        COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(btrim(COALESCE(session_label, ''))));

/* Staying in touch after the last day.

   Keyed by student rather than by user: the leaver's login is disabled when
   they leave, and an alumni record that dies with the account is the reason
   schools keep this in a spreadsheet instead.

   The two visibility flags are separate because they answer different
   questions. is_listed decides whether the person appears in the directory at
   all; show_contact decides whether their email and phone travel with them.
   Registering to be findable is not the same as publishing a phone number, and
   collapsing the two is how a directory becomes a mailing list. */
CREATE TABLE alumni_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    registered_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    batch_year      integer     NOT NULL CHECK (batch_year BETWEEN 1900 AND 2200),
    current_status  text        NOT NULL DEFAULT 'school'
                                CHECK (current_status IN ('school', 'higher_secondary',
                                                          'undergraduate', 'postgraduate',
                                                          'working', 'entrepreneur', 'other')),
    institution_name text,
    employer        text,
    designation     text,
    city            text,
    country         text,
    contact_email   text,
    contact_phone   text,
    profile_url     text,
    willing_to_mentor boolean   NOT NULL DEFAULT false,
    willing_to_post_jobs boolean NOT NULL DEFAULT false,
    is_listed       boolean     NOT NULL DEFAULT true,
    show_contact    boolean     NOT NULL DEFAULT false,
    bio             text,
    -- The school confirming this is really its own leaver. An unverified
    -- profile is still listed; it is simply not vouched for.
    verified_at     timestamptz,
    verified_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alumni_profiles_verification_complete
        CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);

CREATE UNIQUE INDEX alumni_profiles_student
    ON alumni_profiles (institution_id, student_id);

CREATE INDEX alumni_profiles_batch
    ON alumni_profiles (institution_id, batch_year)
 WHERE is_listed;

/* What the alumni bring back: a job, an internship, a fortnight of work
   experience.

   min_class_level gates it by classes.level for the same reason club events
   are gated: a graduate role advertised to a Grade 6 child is noise, and worse,
   it is noise the school published.

   The stipend is monthly and in paise, like every other amount here. */
CREATE TABLE alumni_job_posts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    posted_by       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Set when the poster is an alumnus rather than the school office, so the
    -- board can say who is offering it.
    alumni_id       uuid        REFERENCES alumni_profiles(id) ON DELETE SET NULL,
    kind            text        NOT NULL DEFAULT 'internship'
                                CHECK (kind IN ('job', 'internship', 'apprenticeship',
                                                'volunteering', 'work_experience')),
    title           text        NOT NULL,
    organisation    text        NOT NULL,
    location        text,
    is_remote       boolean     NOT NULL DEFAULT false,
    description     text,
    eligibility     text,
    stipend_paise   bigint      CHECK (stipend_paise IS NULL OR stipend_paise >= 0),
    min_class_level integer,
    apply_url       text,
    apply_email     text,
    closes_on       date,
    status          text        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'closed', 'filled')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alumni_job_posts_title CHECK (nullif(btrim(title), '') IS NOT NULL),
    CONSTRAINT alumni_job_posts_organisation
        CHECK (nullif(btrim(organisation), '') IS NOT NULL)
);

CREATE INDEX alumni_job_posts_board
    ON alumni_job_posts (institution_id, status, closes_on);

/* One live post per organisation per title.

   Reposting the same internship each week is how a board becomes unreadable,
   and a closed post must not block the genuine repeat next year. */
CREATE UNIQUE INDEX alumni_job_posts_once
    ON alumni_job_posts (institution_id, lower(btrim(organisation)), lower(btrim(title)))
 WHERE status = 'open';

/* A child putting their hand up for a post.

   Not an application: the school does not run the hiring, and pretending
   otherwise would leave children waiting on a status this system will never
   learn. It records interest and hands the poster a list. */
CREATE TABLE alumni_job_interests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    post_id        uuid        NOT NULL REFERENCES alumni_job_posts(id) ON DELETE CASCADE,
    student_id     uuid        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    withdrawn_at   timestamptz
);

-- One live expression of interest per child per post; withdrawing and changing
-- your mind again must work, so the predicate carries the "live".
CREATE UNIQUE INDEX alumni_job_interests_one_live
    ON alumni_job_interests (post_id, student_id)
 WHERE withdrawn_at IS NULL;

CREATE INDEX alumni_job_interests_student
    ON alumni_job_interests (institution_id, student_id);

ALTER TABLE study_groups                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_groups                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE study_group_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_group_members          FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_portfolio_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_portfolio_items      FORCE  ROW LEVEL SECURITY;
ALTER TABLE university_shortlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_shortlist_entries FORCE  ROW LEVEL SECURITY;
ALTER TABLE lost_found_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lost_found_items             FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_lockers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_lockers              FORCE  ROW LEVEL SECURITY;
ALTER TABLE locker_access_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE locker_access_events         FORCE  ROW LEVEL SECURITY;
ALTER TABLE club_events                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_events                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE club_event_tickets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_event_tickets           FORCE  ROW LEVEL SECURITY;
ALTER TABLE abc_credit_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE abc_credit_entries           FORCE  ROW LEVEL SECURITY;
ALTER TABLE alumni_profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_profiles              FORCE  ROW LEVEL SECURITY;
ALTER TABLE alumni_job_posts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_job_posts             FORCE  ROW LEVEL SECURITY;
ALTER TABLE alumni_job_interests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE alumni_job_interests         FORCE  ROW LEVEL SECURITY;

CREATE POLICY study_groups_tenant ON study_groups
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY study_group_members_tenant ON study_group_members
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_portfolio_items_tenant ON student_portfolio_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY university_shortlist_entries_tenant ON university_shortlist_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY lost_found_items_tenant ON lost_found_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY student_lockers_tenant ON student_lockers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY locker_access_events_tenant ON locker_access_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY club_events_tenant ON club_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY club_event_tickets_tenant ON club_event_tickets
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY abc_credit_entries_tenant ON abc_credit_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_profiles_tenant ON alumni_profiles
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_job_posts_tenant ON alumni_job_posts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY alumni_job_interests_tenant ON alumni_job_interests
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS alumni_job_interests;
DROP TABLE IF EXISTS alumni_job_posts;
DROP TABLE IF EXISTS alumni_profiles;
DROP TABLE IF EXISTS abc_credit_entries;
DROP TABLE IF EXISTS club_event_tickets;
DROP TABLE IF EXISTS club_events;
DROP TABLE IF EXISTS locker_access_events;
DROP TABLE IF EXISTS student_lockers;
DROP TABLE IF EXISTS lost_found_items;
DROP TABLE IF EXISTS university_shortlist_entries;
DROP TABLE IF EXISTS student_portfolio_items;
DROP TABLE IF EXISTS study_group_members;
DROP TABLE IF EXISTS study_groups;
