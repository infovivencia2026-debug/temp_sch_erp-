-- +goose Up
-- The rest of a librarian's year: holds, the annual stock audit, and the
-- textbook indent.
--
-- The library could catalogue a book, issue it and fine you for keeping it.
-- Everything else a librarian does — telling the next person the book is back,
-- proving to an inspection that the register matches the shelves, and getting
-- next year's NCERT sets in before June — had nowhere to live.

/* A hold on a title, not on a copy.

   A reader wants Wings of Fire, not accession number 4471. Reserving a
   specific copy would leave someone waiting behind a book that is lost while
   three identical ones sit on the shelf. */
CREATE TABLE library_reservations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    title_id        uuid        NOT NULL REFERENCES library_titles(id) ON DELETE CASCADE,
    -- Exactly one of these. Both students and staff borrow, and a single
    -- "borrower_id" column pointing at two tables cannot have a foreign key.
    student_id      uuid        REFERENCES students(id) ON DELETE CASCADE,
    employee_id     uuid        REFERENCES employees(id) ON DELETE CASCADE,
    placed_at       timestamptz NOT NULL DEFAULT now(),
    status          text        NOT NULL DEFAULT 'waiting',
    -- Set when a copy comes back and this hold is next in line. The copy is
    -- named because the reader is coming to collect that physical book, and
    -- the counter needs to know which one to keep behind the desk.
    ready_copy_id   uuid        REFERENCES library_copies(id) ON DELETE SET NULL,
    ready_at        timestamptz,
    -- A book held indefinitely for someone who never comes is a book nobody
    -- can borrow. The shelf gets it back when this passes.
    collect_by      date,
    cancelled_reason text,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT library_reservations_one_borrower
        CHECK ((student_id IS NULL) <> (employee_id IS NULL)),
    CONSTRAINT library_reservations_status
        CHECK (status IN ('waiting','ready','collected','expired','cancelled')),
    CONSTRAINT library_reservations_ready_has_copy
        CHECK (status <> 'ready' OR ready_copy_id IS NOT NULL)
);

/* One live hold per reader per title.

   COALESCE to a sentinel rather than naming the nullable columns directly: a
   NULL is distinct from every other NULL, so a unique index over
   (title_id, student_id, employee_id) would let one reader queue for the same
   book as many times as they liked and quietly enforce nothing. */
CREATE UNIQUE INDEX library_reservations_one_per_reader
    ON library_reservations (
        title_id,
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(employee_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE status IN ('waiting', 'ready');

-- The queue, in the order it formed.
CREATE INDEX library_reservations_queue
    ON library_reservations (title_id, placed_at)
 WHERE status = 'waiting';

/* The annual stock audit.

   Two tables because an audit is an event with a beginning and an end, and the
   scans are what happened during it. Recording only "last seen on" against
   each copy would make it impossible to say which year a book went missing,
   which is the one thing an auditor asks. */
CREATE TABLE library_stock_audits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    name            text        NOT NULL,
    opened_on       date        NOT NULL DEFAULT current_date,
    closed_on       date,
    -- What the librarian concluded. Required to close, because an audit that
    -- ends with unexplained missing books and no note is not an audit.
    remarks         text,
    opened_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT library_stock_audits_closed_has_remarks
        CHECK (closed_on IS NULL OR nullif(btrim(remarks), '') IS NOT NULL)
);

-- One open audit per campus. Two people scanning into different audits would
-- each conclude half the shelf is missing.
CREATE UNIQUE INDEX library_stock_audits_one_open
    ON library_stock_audits (
        institution_id,
        COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE closed_on IS NULL;

CREATE TABLE library_audit_scans (
    audit_id        uuid        NOT NULL REFERENCES library_stock_audits(id) ON DELETE CASCADE,
    copy_id         uuid        NOT NULL REFERENCES library_copies(id) ON DELETE CASCADE,
    scanned_at      timestamptz NOT NULL DEFAULT now(),
    scanned_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    -- Where it actually was, when that is not where the register says. The
    -- commonest audit finding is not a missing book but a misshelved one.
    found_rack      text,
    PRIMARY KEY (audit_id, copy_id)
);

/* The NCERT textbook indent.

   A different thing from the library's own stock: these are consumable sets
   bought per child per class every year, ordered in February and handed out in
   June. Tracking them as library copies would put four hundred identical
   Class 6 mathematics books into the accession register, which is not what an
   accession register is for. */
CREATE TABLE textbook_indents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    academic_year_id uuid       REFERENCES academic_years(id) ON DELETE SET NULL,
    class_id        uuid        NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    subject_id      uuid        REFERENCES subjects(id) ON DELETE SET NULL,
    title           text        NOT NULL,
    publisher       text        NOT NULL DEFAULT 'NCERT',
    -- Three counts, three different moments. Requested in February, received
    -- from the depot in May, issued to children in June — and the gaps between
    -- them are the whole reason to track it.
    qty_requested   integer     NOT NULL,
    qty_received    integer     NOT NULL DEFAULT 0,
    qty_issued      integer     NOT NULL DEFAULT 0,
    unit_price_paise bigint,
    indent_no       text,
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT textbook_indents_counts
        CHECK (qty_requested > 0 AND qty_received >= 0 AND qty_issued >= 0),
    -- You cannot hand out books you never received.
    CONSTRAINT textbook_indents_issued_within_received
        CHECK (qty_issued <= qty_received)
);

CREATE INDEX textbook_indents_year ON textbook_indents (institution_id, academic_year_id, class_id);

ALTER TABLE library_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE library_stock_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_stock_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE textbook_indents ENABLE ROW LEVEL SECURITY;
ALTER TABLE textbook_indents FORCE ROW LEVEL SECURITY;
ALTER TABLE library_audit_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_audit_scans FORCE ROW LEVEL SECURITY;

CREATE POLICY library_reservations_tenant ON library_reservations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY library_stock_audits_tenant ON library_stock_audits
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY textbook_indents_tenant ON textbook_indents
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- Scans carry no institution_id of their own; the audit they belong to does,
-- and they cascade from it.
CREATE POLICY library_audit_scans_tenant ON library_audit_scans
    USING (EXISTS (SELECT 1 FROM library_stock_audits a
                    WHERE a.id = audit_id
                      AND (a.institution_id = app_current_institution()
                           OR app_is_platform_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM library_stock_audits a
                         WHERE a.id = audit_id
                           AND (a.institution_id = app_current_institution()
                                OR app_is_platform_admin())));

-- +goose Down
DROP TABLE IF EXISTS textbook_indents;
DROP TABLE IF EXISTS library_audit_scans;
DROP TABLE IF EXISTS library_stock_audits;
DROP TABLE IF EXISTS library_reservations;
