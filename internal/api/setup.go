package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* School setup.

   Everything below exists so a school can start on its own. Until now the
   application could operate a school beautifully but could not create one:
   classes, sections, subjects, periods, fee heads and exams all had to be
   inserted by hand in SQL, which makes onboarding a database job rather than
   an administrator's.

   The handlers are deliberately uniform — validate, upsert on the table's real
   unique key, return the row — because setup screens are the part of an ERP
   that gets extended most often and inconsistency here compounds. */

// ensureCampus returns the caller's campus, creating a default one if the
// tenant has none. A brand new institution otherwise cannot create anything,
// since every academic table is campus-scoped.
func ensureCampus(r *http.Request, tx pgx.Tx, instID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(r.Context(),
		`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(r.Context(), `
			INSERT INTO campuses (institution_id, name, code)
			VALUES ($1,'Main Campus','MAIN') RETURNING id`, instID).Scan(&id)
	}
	return id, err
}

// --- academic year ----------------------------------------------------------

type academicYearRequest struct {
	Name      string `json:"name"`
	StartsOn  string `json:"starts_on"`
	EndsOn    string `json:"ends_on"`
	IsCurrent bool   `json:"is_current"`
	Board     string `json:"board,omitempty"`
}

// createAcademicYear opens a school year.
//
// Telangana runs June to April while the financial year runs April to March,
// so the dates are entered rather than derived from a single "year" field.
func (s *Server) createAcademicYear(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req academicYearRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name == "" || req.StartsOn == "" || req.EndsOn == "" {
		httpx.BadRequest(w, r, "name, starts_on and ends_on are required")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		// academic_years_one_current is a partial unique index allowing exactly
		// one current year per institution, so the previous one must be stood
		// down first or the insert fails.
		if req.IsCurrent {
			if _, err := tx.Exec(r.Context(),
				`UPDATE academic_years SET is_current = false WHERE is_current`); err != nil {
				return err
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on,
			                            is_current, board)
			VALUES ($1,$2,$3,$4::date,$5::date,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, campus, req.Name, req.StartsOn, req.EndsOn,
			req.IsCurrent, nullString(req.Board)).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "name": req.Name})
}

/*
classLevelFromName reads the year out of what the school calls the class.

	Level orders every class list in the product and decides which government
	norm a class is counted against, so it has to be right -- but it is almost
	always already written in the name, and asking for it twice is asking for a
	disagreement.

	The pre-school years come before the numbered ones and have no number of
	their own, so they are placed below 1 in the order a school says them.
	Anything with a number takes it: "Grade 6", "Class 6", "VI-A" fails and is
	told to add the number, which is better than guessing six and sorting a
	school's classes wrongly for a year.
*/
func classLevelFromName(name string) int {
	n := strings.ToLower(strings.TrimSpace(name))
	// Below Grade 1, in the order a school lists them. Negative so that adding
	// a year below later needs no renumbering of everything above.
	for _, pre := range []struct {
		match []string
		level int
	}{
		{[]string{"pre-nursery", "pre nursery", "playgroup", "play group"}, -4},
		{[]string{"nursery", "pre-kg", "pre kg", "prekg"}, -3},
		{[]string{"lkg", "l.k.g", "junior kg", "jr kg"}, -2},
		{[]string{"ukg", "u.k.g", "senior kg", "sr kg"}, -1},
	} {
		for _, m := range pre.match {
			if strings.Contains(n, m) {
				return pre.level
			}
		}
	}
	// The first run of digits. "Grade 10" is ten; "10th Standard" is ten.
	digits := ""
	for _, c := range n {
		if c >= '0' && c <= '9' {
			digits += string(c)
			continue
		}
		if digits != "" {
			break
		}
	}
	if digits == "" {
		return 0
	}
	v, err := strconv.Atoi(digits)
	if err != nil || v <= 0 || v > 15 {
		return 0
	}
	return v
}

// --- classes ----------------------------------------------------------------

type classRequest struct {
	Name   string `json:"name"`
	Level  int    `json:"level"`
	Stream string `json:"stream,omitempty"`
	/* THE SECTIONS BELONG TO THE CLASS, so they are made with it.

	   Sections were a step of their own: create Grade 1 to 10, move on, then
	   name A and B for each of the ten and give each a capacity. Two screens
	   for one thought -- nobody decides their classes without already knowing
	   how many sections each has -- and the second screen is the one people
	   leave half done, which is how a school ends up with classes no child can
	   be enrolled into.

	   Empty is allowed: a class may genuinely have no sections yet, and one
	   can still be added on its own later. */
	Sections []string `json:"sections,omitempty"`
	Capacity int      `json:"capacity,omitempty"`
}

func (s *Server) createClass(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req classRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	/* THE LEVEL IS IN THE NAME, so stop asking for it.

	   Somebody typing "Grade 6" was then required to type 6, which is asking a
	   person to restate what they have just written and to be blamed when the
	   two disagree -- and they do disagree: a class created as "Grade 9" with
	   level 8 sorts between the eighths and looks like a mistake in the
	   product rather than in the form.

	   The column stays and is not decorative: the statutory returns count
	   teachers against primary and upper-primary norms by it, and learning
	   content is gated on it. It is derived rather than dropped.

	   Still accepted where it is sent, because a school with its own scheme --
	   "Std VI", a stream that is not a year -- may need to say so, and the
	   importer's column still works. */
	level := req.Level
	if level == 0 {
		level = classLevelFromName(req.Name)
	}
	if level == 0 {
		httpx.BadRequest(w, r,
			"no year could be read from that name. Add the number, as in Grade 6")
		return
	}

	capacity := req.Capacity
	if capacity <= 0 {
		capacity = 40
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO classes (institution_id, campus_id, name, level, stream)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, campus_id, name)
			DO UPDATE SET level = EXCLUDED.level, stream = EXCLUDED.stream
			RETURNING id::text`,
			id.InstitutionID, campus, req.Name, level, nullString(req.Stream)).Scan(&newID); err != nil {
			return err
		}
		if len(req.Sections) == 0 {
			return nil
		}

		/* The sections, in the same transaction as the class.

		   Separately would mean a class could exist with the sections that
		   were meant to go in it having failed -- and the failure is silent,
		   because the class list looks complete. */
		var yearID string
		if err := tx.QueryRow(r.Context(), `
			SELECT id::text FROM academic_years
			 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
			return errNoAcademicYear
		}
		for _, raw := range req.Sections {
			name := strings.TrimSpace(raw)
			if name == "" {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO sections (institution_id, campus_id, class_id,
				                      academic_year_id, name, capacity)
				VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6)
				-- A re-save corrects the capacity rather than failing, which
				-- is what somebody expects from editing a row they can see.
				ON CONFLICT (class_id, academic_year_id, name)
				DO UPDATE SET capacity = EXCLUDED.capacity`,
				id.InstitutionID, campus, newID, yearID, name, capacity); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "open the academic year before adding sections to a class")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "name": req.Name})
}

// --- sections ---------------------------------------------------------------

type sectionRequest struct {
	ClassID        string `json:"class_id"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	Name           string `json:"name"`
	Capacity       int    `json:"capacity"`
	Room           string `json:"room,omitempty"`
	ClassTeacherID string `json:"class_teacher_id,omitempty"`
}

func (s *Server) createSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req sectionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	classID, err := uuid.Parse(req.ClassID)
	if err != nil {
		httpx.BadRequest(w, r, "class_id must be a uuid")
		return
	}
	/* Trimmed here, not just tested.

	   The check trimmed and the insert did not, so " A" and "A" were two
	   different sections past a unique constraint whose entire job is to stop
	   that — and a school pasting a column out of a spreadsheet gets the
	   leading space for free. A section name is whatever the school calls it,
	   Rose or Newton or 8-C, but it is not the whitespace around it. */
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r,
			"name is required — a letter, or whatever this school calls it: Rose, Newton, Blue")
		return
	}
	if req.Capacity <= 0 {
		req.Capacity = 40
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		yearID := req.AcademicYearID
		if yearID == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM academic_years
				 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
				return errNoAcademicYear
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
			                      name, capacity, room, class_teacher_id)
			VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8::uuid)
			ON CONFLICT (class_id, academic_year_id, name)
			DO UPDATE SET capacity = EXCLUDED.capacity, room = EXCLUDED.room,
			              class_teacher_id = COALESCE(EXCLUDED.class_teacher_id, sections.class_teacher_id)
			RETURNING id::text`,
			id.InstitutionID, campus, classID, yearID, req.Name, req.Capacity,
			nullString(req.Room), nullString(req.ClassTeacherID)).Scan(&newID)
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "create an academic year before adding sections")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "name": req.Name})
}

var errNoAcademicYear = errors.New("no academic year")

// An exam whose classes have no subjects attached: the papers cannot be built,
// and an exam with no papers blocks marks, moderation and every report card
// behind it.
var errNoClassSubjects = errors.New("no class subjects")

// --- subjects ---------------------------------------------------------------

type subjectRequest struct {
	Name         string `json:"name"`
	Code         string `json:"code"`
	IsScholastic *bool  `json:"is_scholastic,omitempty"`
}

/*
uniqueSubjectCode turns a subject's name into a short code nobody has to think

	about. Letters and digits only, upper-cased, cut to six -- "General
	Science" becomes GENERA, "Sanskrit" SANSKR -- and a counter appended if
	that is already taken, because a school may well run two subjects whose
	names begin the same way.

	Six rather than three: three collides constantly across a state syllabus
	(SOC, SOC, SCI, SCI) and the code is read by people in the timetable grid,
	where a truncation they can still recognise beats an abbreviation they
	cannot.
*/
func uniqueSubjectCode(ctx context.Context, tx pgx.Tx, inst, campus uuid.UUID,
	name string) (string, error) {

	var b strings.Builder
	for _, r := range strings.ToUpper(name) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
		if b.Len() == 6 {
			break
		}
	}
	base := b.String()
	if base == "" {
		base = "SUBJ"
	}

	for n := 0; n < 50; n++ {
		try := base
		if n > 0 {
			try = fmt.Sprintf("%s%d", base, n+1)
		}
		var taken bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM subjects
			                WHERE institution_id = $1 AND campus_id = $2 AND code = $3)`,
			inst, campus, try).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return try, nil
		}
	}
	// Fifty subjects sharing six leading letters is not a school; it is a bug
	// somewhere else, and a random tail beats an error the office cannot act on.
	return base + uuid.NewString()[:4], nil
}

func (s *Server) createSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req subjectRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "a subject needs a name")
		return
	}
	scholastic := true
	if req.IsScholastic != nil {
		scholastic = *req.IsScholastic
	}
	code := strings.ToUpper(strings.TrimSpace(req.Code))

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		/* A code is derived when none is given.

		   It used to be required, which made adding a subject a small quiz:
		   a school types "Sanskrit" and is asked for an abbreviation it has
		   never used, has no convention for, and which only exists because
		   the timetable grid is narrow. Derived from the name and made
		   unique, so the screen that needs one has one and nobody had to
		   invent it. */
		if code == "" {
			code, err = uniqueSubjectCode(r.Context(), tx, id.InstitutionID, campus, req.Name)
			if err != nil {
				return err
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
			VALUES ($1,$2,$3,upper($4),$5)
			ON CONFLICT (institution_id, campus_id, code)
			DO UPDATE SET name = EXCLUDED.name, is_scholastic = EXCLUDED.is_scholastic
			RETURNING id::text`,
			id.InstitutionID, campus, req.Name, code, scholastic).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "code": code})
}

// --- periods ----------------------------------------------------------------

type periodsRequest struct {
	Periods []struct {
		Name     string `json:"name"`
		Sequence int    `json:"sequence"`
		StartsAt string `json:"starts_at"`
		EndsAt   string `json:"ends_at"`
		IsBreak  bool   `json:"is_break"`
	} `json:"periods"`
	/* WHOSE DAY THIS IS.

	   A school with a primary section does not run one bell. The little ones
	   start later, finish earlier and take a longer lunch, and a timetable
	   that has Grade 1 changing lesson at 11:30 with Grade 10 is one the
	   primary staff ignore -- after which attendance is marked against periods
	   nobody sat.

	   Omitted, this is the school's own day, which is what every existing
	   caller means and still gets. Named, it is a second day, and the classes
	   listed run to it. */
	ScheduleName string   `json:"schedule_name,omitempty"`
	ClassIDs     []string `json:"class_ids,omitempty"`
}

// setPeriods defines the whole school day in one call.
//
// A day is entered as a unit, not period by period: the sequence numbers have
// to be contiguous and the times contiguous with them, and validating that is
// only possible with the whole set in hand.
func (s *Server) setPeriods(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req periodsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Periods) == 0 {
		httpx.BadRequest(w, r, "at least one period is required")
		return
	}
	seen := map[int]bool{}
	for _, p := range req.Periods {
		if p.Name == "" || p.StartsAt == "" || p.EndsAt == "" {
			httpx.BadRequest(w, r, "every period needs a name, a start time and an end time")
			return
		}
		if p.StartsAt >= p.EndsAt {
			httpx.BadRequest(w, r, p.Name+" ends before it starts")
			return
		}
		if seen[p.Sequence] {
			httpx.BadRequest(w, r, "two periods share the same sequence number")
			return
		}
		seen[p.Sequence] = true
	}

	written := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		/* Which day is being written, and the conflict target that matches
		   how periods are actually keyed.

		   This upserted ON CONFLICT (institution_id, campus_id, sequence),
		   and no such index exists -- periods are unique on
		   (bell_schedule_id, sequence). Postgres refuses a conflict target it
		   cannot match, so saving the school day failed outright rather than
		   updating anything. */
		var schedule uuid.UUID
		name := strings.TrimSpace(req.ScheduleName)
		if name == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id FROM bell_schedules
				 WHERE institution_id = $1
				 ORDER BY is_default DESC, created_at LIMIT 1`,
				id.InstitutionID).Scan(&schedule); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				if err := tx.QueryRow(r.Context(), `
					INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
					VALUES ($1,$2,'Standard day',true) RETURNING id`,
					id.InstitutionID, campus).Scan(&schedule); err != nil {
					return err
				}
			}
		} else {
			if err := tx.QueryRow(r.Context(), `
				SELECT id FROM bell_schedules
				 WHERE institution_id = $1 AND lower(name) = lower($2)`,
				id.InstitutionID, name).Scan(&schedule); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				// A second day is never the default: the school's own bell
				// stays the fallback for every class nobody has moved.
				if err := tx.QueryRow(r.Context(), `
					INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
					VALUES ($1,$2,$3,false) RETURNING id`,
					id.InstitutionID, campus, name).Scan(&schedule); err != nil {
					return err
				}
			}
		}

		for _, p := range req.Periods {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO periods (institution_id, campus_id, bell_schedule_id, name,
				                     sequence, starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,$5,$6::time,$7::time,$8)
				ON CONFLICT (bell_schedule_id, sequence)
				DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
				              ends_at = EXCLUDED.ends_at, is_break = EXCLUDED.is_break`,
				id.InstitutionID, campus, schedule, p.Name, p.Sequence,
				p.StartsAt, p.EndsAt, p.IsBreak); err != nil {
				return err
			}
			written++
		}

		/* A day nobody runs to is a day nobody notices is wrong.

		   Naming the classes here rather than on a separate screen is the
		   whole point: somebody defining the primary timings is thinking about
		   which classes are primary at that exact moment, and asking them
		   again later is how a second day gets created and never used. */
		if len(req.ClassIDs) > 0 {
			if _, err := tx.Exec(r.Context(), `
				UPDATE classes SET bell_schedule_id = $2
				 WHERE institution_id = $1 AND id = ANY($3::uuid[])`,
				id.InstitutionID, schedule, req.ClassIDs); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"periods": written})
}

// --- class subjects ---------------------------------------------------------

type classSubjectsRequest struct {
	ClassID    string   `json:"class_id"`
	SubjectIDs []string `json:"subject_ids"`
	MaxMarks   int      `json:"max_marks,omitempty"`
}

// setClassSubjects declares which subjects a class offers.
//
// Replaces the set rather than adding to it, so removing a subject from the
// list actually drops it — otherwise a mistake can only be undone in SQL.
func (s *Server) setClassSubjects(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req classSubjectsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	classID, err := uuid.Parse(req.ClassID)
	if err != nil {
		httpx.BadRequest(w, r, "class_id must be a uuid")
		return
	}
	if req.MaxMarks <= 0 {
		req.MaxMarks = 100
	}

	linked := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		wanted := uuidArray(req.SubjectIDs)
		// Only drop offerings nobody has been timetabled or examined against;
		// deleting those would cascade away real marks.
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM class_subjects cs
			 WHERE cs.class_id = $1
			   AND ($2::uuid[] IS NULL OR NOT (cs.subject_id = ANY($2)))
			   AND NOT EXISTS (SELECT 1 FROM exam_subjects es WHERE es.class_subject_id = cs.id)
			   AND NOT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.class_subject_id = cs.id)`,
			classID, wanted); err != nil {
			return err
		}
		for _, raw := range req.SubjectIDs {
			sid, err := uuid.Parse(raw)
			if err != nil {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO class_subjects (institution_id, class_id, subject_id, max_marks)
				VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
				id.InstitutionID, classID, sid, req.MaxMarks); err != nil {
				return err
			}
			linked++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"subjects": linked})
}

type assignTeacherRequest struct {
	SectionID      string `json:"section_id"`
	ClassSubjectID string `json:"class_subject_id"`
	TeacherUserID  string `json:"teacher_user_id"`
}

// assignTeacher puts a teacher on a subject for a section. This is what gives
// them scope over those students, so it is the single most consequential setup
// action in the system.
func (s *Server) assignTeacher(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req assignTeacherRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sec, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	cs, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	teacher, err := uuid.Parse(req.TeacherUserID)
	if err != nil {
		httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO section_subject_teachers (institution_id, section_id,
			                                      class_subject_id, teacher_user_id)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (section_id, class_subject_id)
			DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
			id.InstitutionID, sec, cs, teacher)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"assigned": true})
}

// --- fee setup --------------------------------------------------------------

type feeHeadRequest struct {
	Name        string `json:"name"`
	Code        string `json:"code"`
	IsRecurring *bool  `json:"is_recurring,omitempty"`
	IsTaxable   bool   `json:"is_taxable"`
	GSTRateBP   int    `json:"gst_rate_bp,omitempty"`
	HSNSAC      string `json:"hsn_sac,omitempty"`
}

func (s *Server) createFeeHead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feeHeadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name == "" || req.Code == "" {
		httpx.BadRequest(w, r, "name and code are required")
		return
	}
	if req.GSTRateBP < 0 || req.GSTRateBP > 10000 {
		httpx.BadRequest(w, r, "gst_rate_bp must be between 0 and 10000 (basis points)")
		return
	}
	recurring := true
	if req.IsRecurring != nil {
		recurring = *req.IsRecurring
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO fee_heads (institution_id, name, code, is_recurring,
			                       is_taxable, gst_rate_bp, hsn_sac)
			VALUES ($1,$2,upper($3),$4,$5,$6,$7)
			ON CONFLICT (institution_id, code)
			DO UPDATE SET name = EXCLUDED.name, is_recurring = EXCLUDED.is_recurring,
			              is_taxable = EXCLUDED.is_taxable, gst_rate_bp = EXCLUDED.gst_rate_bp,
			              hsn_sac = EXCLUDED.hsn_sac
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.Code, recurring,
			req.IsTaxable, req.GSTRateBP, nullString(req.HSNSAC)).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "code": strings.ToUpper(req.Code)})
}

type feeStructureRequest struct {
	Name           string `json:"name"`
	ClassID        string `json:"class_id,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	AppliesTo      string `json:"applies_to,omitempty"`
	Items          []struct {
		FeeHeadID    string `json:"fee_head_id"`
		InstalmentNo int    `json:"instalment_no"`
		AmountPaise  int64  `json:"amount_paise"`
		DueOn        string `json:"due_on,omitempty"`
	} `json:"items"`
}

// createFeeStructure defines what a class pays and when.
func (s *Server) createFeeStructure(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feeStructureRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	if len(req.Items) == 0 {
		httpx.BadRequest(w, r, "a fee structure needs at least one line")
		return
	}
	for _, it := range req.Items {
		if it.AmountPaise < 0 {
			httpx.BadRequest(w, r, "amounts cannot be negative")
			return
		}
	}
	if req.AppliesTo == "" {
		req.AppliesTo = "all"
	}

	var newID string
	var total int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		yearID := req.AcademicYearID
		if yearID == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM academic_years
				 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
				return errNoAcademicYear
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO fee_structures (institution_id, campus_id, academic_year_id,
			                            class_id, name, applies_to, is_active)
			VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,true)
			RETURNING id::text`,
			id.InstitutionID, campus, yearID, nullString(req.ClassID),
			req.Name, req.AppliesTo).Scan(&newID); err != nil {
			return err
		}
		for _, it := range req.Items {
			head, err := uuid.Parse(it.FeeHeadID)
			if err != nil {
				return err
			}
			inst := it.InstalmentNo
			if inst <= 0 {
				inst = 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id,
				                                 instalment_no, amount_paise, due_on)
				VALUES ($1,$2::uuid,$3,$4,$5,$6::date)
				ON CONFLICT (fee_structure_id, fee_head_id, instalment_no)
				DO UPDATE SET amount_paise = EXCLUDED.amount_paise, due_on = EXCLUDED.due_on`,
				id.InstitutionID, newID, head, inst, it.AmountPaise,
				nullString(it.DueOn)); err != nil {
				return err
			}
			total += it.AmountPaise
		}
		return nil
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "create an academic year before adding fee structures")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "name": req.Name, "lines": len(req.Items), "total_paise": total,
	})
}

/*
deleteFeeStructure removes a structure and everything priced under it.

	Fees are re-set every year, and until now nothing could be taken away: a
	structure typed with the wrong amounts, or last year's, stayed on the list
	for good and the only way past it was a second structure with a similar
	name. Two structures for one class is worse than none, because the office
	then has to know which is live.

	Safe to cascade. fee_structure_items, fee_fine_rules and
	fee_structure_versions hang off it and mean nothing without it; invoices do
	not reference it at all, so money already billed is untouched — a structure
	is the price list, not the receipt.
*/
func (s *Server) deleteFeeStructure(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee structure id")
		return
	}

	var name string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			DELETE FROM fee_structures WHERE id = $1 RETURNING name`,
			target).Scan(&name)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"deleted": name,
		"note":    "Invoices already raised are unaffected. This was the price list, not the bills.",
	})
}

type feeStructureRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	ClassName *string `json:"class_name,omitempty"`
	AppliesTo *string `json:"applies_to,omitempty"`
	Lines     int     `json:"lines"`
	TotalPais int64   `json:"total_paise"`
	Active    bool    `json:"is_active"`
}

func (s *Server) listFeeStructures(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT fs.id::text, fs.name, c.name, fs.applies_to,
		       (SELECT count(*) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id)::int,
		       COALESCE((SELECT sum(amount_paise) FROM fee_structure_items i
		                  WHERE i.fee_structure_id = fs.id), 0),
		       fs.is_active
		  FROM fee_structures fs
		  LEFT JOIN classes c ON c.id = fs.class_id
		 ORDER BY c.level NULLS FIRST, fs.name`, nil,
		func(rows pgx.Rows) (feeStructureRow, error) {
			var v feeStructureRow
			return v, rows.Scan(&v.ID, &v.Name, &v.ClassName, &v.AppliesTo,
				&v.Lines, &v.TotalPais, &v.Active)
		})
	respond(w, r, items, err)
}

// --- exams ------------------------------------------------------------------

type examRequest struct {
	Name           string `json:"name"`
	Kind           string `json:"kind,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	StartsOn       string `json:"starts_on,omitempty"`
	EndsOn         string `json:"ends_on,omitempty"`
	CCEComponent   string `json:"cce_component,omitempty"`
	Board          string `json:"board,omitempty"`
	GradingScaleID string `json:"grading_scale_id,omitempty"`
	// ClassIDs generates a paper per subject for each class named.
	ClassIDs []string `json:"class_ids,omitempty"`
	MaxMarks int      `json:"max_marks,omitempty"`
}

// createExam defines an exam and, optionally, every paper in it.
//
// Creating papers alongside the exam is what makes this usable: a term exam for
// four classes with five subjects each is twenty papers, and nobody is going to
// add them one at a time.
func (s *Server) createExam(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req examRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	if req.Kind == "" {
		req.Kind = "term"
	}
	if req.MaxMarks <= 0 {
		// The CCE default: formative papers are out of 20, summative out of 80.
		switch {
		case strings.HasPrefix(req.CCEComponent, "FA"):
			req.MaxMarks = 20
		case strings.HasPrefix(req.CCEComponent, "SA"):
			req.MaxMarks = 80
		default:
			req.MaxMarks = 100
		}
	}

	var examID string
	papers := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		yearID := req.AcademicYearID
		if yearID == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM academic_years
				 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
				return errNoAcademicYear
			}
		}

		scale := req.GradingScaleID
		if scale == "" {
			// Fall back to the institution's default scale so grades are derived
			// rather than left blank.
			_ = tx.QueryRow(r.Context(),
				`SELECT id::text FROM grading_scales ORDER BY is_default DESC LIMIT 1`).Scan(&scale)
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO exams (institution_id, campus_id, academic_year_id, name, kind,
			                   starts_on, ends_on, grading_scale_id, cce_component, board)
			VALUES ($1,$2,$3::uuid,$4,$5,$6::date,$7::date,$8::uuid,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, campus, yearID, req.Name, req.Kind,
			nullString(req.StartsOn), nullString(req.EndsOn), nullString(scale),
			nullString(req.CCEComponent), nullString(req.Board)).Scan(&examID); err != nil {
			return err
		}

		/* No classes named means every class, not no papers.

		   An exam with no papers is not an exam: nothing can be timetabled
		   against it, no marks can be entered, no report card can be built, and
		   the whole chain behind it — question paper approval, moderation, the
		   parent's result — has nothing to attach to. The form promises "a
		   paper is created for every subject each selected class studies", and
		   submitting it with nothing ticked used to return success and create
		   an empty shell. A silent no-op that reports 201 is worse than a
		   refusal, because the person who did it walks away believing it
		   worked.

		   So the empty case means what the sentence says: the whole school. A
		   school that genuinely wants a paperless exam row can delete the
		   papers; a school that ticked nothing by accident gets what it
		   expected. */
		allClasses := len(req.ClassIDs) == 0
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id,
			                           max_marks, pass_marks)
			SELECT $1, $2::uuid, cs.id, $3, GREATEST(1, round($3 * 0.33))
			  FROM class_subjects cs
			 WHERE $5::bool OR cs.class_id = ANY($4)
			ON CONFLICT (exam_id, class_subject_id) DO NOTHING`,
			id.InstitutionID, examID, req.MaxMarks, uuidArray(req.ClassIDs), allClasses)
		if err != nil {
			return err
		}
		papers = int(tag.RowsAffected())
		if papers == 0 {
			// The only way to get here is a school with no subjects attached to
			// its classes. Saying so beats an exam that looks scheduled.
			return errNoClassSubjects
		}
		return nil
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "create an academic year before adding exams")
		return
	}
	if errors.Is(err, errNoClassSubjects) {
		httpx.BadRequest(w, r,
			"no papers could be created, because none of the classes chosen have subjects attached yet. Set up class subjects first, then schedule the exam.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": examID, "name": req.Name, "papers": papers, "max_marks": req.MaxMarks,
	})
}

/*
Papers, added to an exam that already exists.

	Exams could only be created in the setup wizard, and the papers with them.
	Afterwards there was no route at all: an exam scheduled without papers — or
	one that gained a class in September — could never be given any, and every
	thing downstream hangs off papers existing. Marks entry says "no exam papers
	exist yet", question paper approval has nothing to approve, moderation has
	nothing to moderate, hall tickets have nothing to print, and report cards
	have nothing to total. One missing route stops five screens.

	Adding is idempotent: the unique index on (exam_id, class_subject_id) means
	running it twice adds the subjects that were missing and leaves the rest
	alone, which is what somebody who has just added a class actually wants.
*/
func (s *Server) addExamPapers(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	examID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		ClassIDs []string `json:"class_ids,omitempty"`
		MaxMarks int      `json:"max_marks,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.MaxMarks <= 0 {
		req.MaxMarks = 100
	}

	var added int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM exams WHERE id = $1)`, examID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			httpx.NotFound(w, r)
			return errStopped
		}
		all := len(req.ClassIDs) == 0
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id,
			                           max_marks, pass_marks)
			SELECT $1, $2, cs.id, $3, GREATEST(1, round($3 * 0.33))
			  FROM class_subjects cs
			 WHERE $5::bool OR cs.class_id = ANY($4)
			ON CONFLICT (exam_id, class_subject_id) DO NOTHING`,
			id.InstitutionID, examID, req.MaxMarks, uuidArray(req.ClassIDs), all)
		if err != nil {
			return err
		}
		added = int(tag.RowsAffected())
		if added == 0 {
			return errNoClassSubjects
		}
		return nil
	})
	if errors.Is(err, errStopped) {
		return
	}
	if errors.Is(err, errNoClassSubjects) {
		httpx.BadRequest(w, r,
			"nothing to add. Either every subject already has a paper in this exam, or the classes chosen have no subjects attached yet.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"papers_added": added})
}

// --- grading scale ----------------------------------------------------------

type gradingScaleRequest struct {
	Name      string `json:"name"`
	IsDefault bool   `json:"is_default"`
	Bands     []struct {
		Grade      string  `json:"grade"`
		MinPercent float64 `json:"min_percent"`
		MaxPercent float64 `json:"max_percent"`
		GradePoint float64 `json:"grade_point"`
	} `json:"bands"`
}

// createGradingScale defines the grade bands marks are mapped through.
//
// Bands are validated for gaps and overlaps before being written: a mark that
// falls between two bands produces a blank grade on a report card, which is
// discovered by a parent rather than by the school.
func (s *Server) createGradingScale(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req gradingScaleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || len(req.Bands) == 0 {
		httpx.BadRequest(w, r, "name and at least one band are required")
		return
	}
	for i, b := range req.Bands {
		if b.MinPercent > b.MaxPercent {
			httpx.BadRequest(w, r, "band "+b.Grade+" has its minimum above its maximum")
			return
		}
		for j, o := range req.Bands {
			if i != j && b.MinPercent <= o.MaxPercent && o.MinPercent <= b.MaxPercent {
				httpx.BadRequest(w, r, "bands "+b.Grade+" and "+o.Grade+" overlap")
				return
			}
		}
	}

	var scaleID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.IsDefault {
			if _, err := tx.Exec(r.Context(),
				`UPDATE grading_scales SET is_default = false WHERE is_default`); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO grading_scales (institution_id, name, is_default)
			VALUES ($1,$2,$3) RETURNING id::text`,
			id.InstitutionID, req.Name, req.IsDefault).Scan(&scaleID); err != nil {
			return err
		}
		for _, b := range req.Bands {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO grade_bands (institution_id, grading_scale_id, grade,
				                         min_percent, max_percent, grade_point)
				VALUES ($1,$2::uuid,$3,$4,$5,$6)`,
				id.InstitutionID, scaleID, b.Grade, b.MinPercent, b.MaxPercent,
				b.GradePoint); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": scaleID, "name": req.Name, "bands": len(req.Bands),
	})
}

/*
A phone number already used by somebody else at this school.

	Reported as a 409 rather than a 500 because it is a correctable mistake, and
	named rather than absorbed because two people sharing an email address is a
	school with one office mailbox while two sharing a mobile number is somebody
	typing the wrong one.
*/
var errPhoneInUse = errors.New("that phone number already belongs to somebody at this school")

// --- staff ------------------------------------------------------------------

type employeeRequest struct {
	EmployeeCode string `json:"employee_code"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name,omitempty"`
	Email        string `json:"email,omitempty"`
	Phone        string `json:"phone,omitempty"`
	Department   string `json:"department_id,omitempty"`
	Designation  string `json:"designation_id,omitempty"`
	JoinedOn     string `json:"joined_on,omitempty"`
	// permanent | contract | probation | part_time | visiting. Empty leaves the
	// column null, which is what every caller before recruitment existed did.
	EmploymentType string `json:"employment_type,omitempty"`
	CreateLogin    bool   `json:"create_login"`
	RoleKey        string `json:"role_key,omitempty"`
	/* MORE THAN ONE ROLE, because that is how a school of forty actually runs.

	   A head of department also teaches. A principal also keeps the accounts.
	   The front desk is also the person who adds a student. Until now this
	   took a single role, so a school with one person doing two jobs either
	   picked the smaller role and left them unable to do the other, or handed
	   out institution_admin -- which is every fee record and every salary as a
	   side effect.

	   user_roles has always been a join table; nothing in the schema believed
	   a person had one role. Only this form did.

	   RoleKey stays for the callers that send one, and is folded into the list
	   below rather than handled separately: two code paths for the same thing
	   is how one of them stops being tested. */
	RoleKeys []string `json:"role_keys,omitempty"`
}

// roles returns every role this appointment asks for, deduplicated, with the
// singular field folded in.
func (req employeeRequest) roles() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, k := range append([]string{req.RoleKey}, req.RoleKeys...) {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	return out
}

// createEmployee adds a staff member and, optionally, their login.
//
// Creating the user alongside the employee is the difference between a usable
// onboarding flow and a two-screen dance where half the staff end up with a
// personnel record and no way to sign in.
func (s *Server) createEmployee(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req employeeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if err := req.validate(); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	/* The add-staff form sends whatever the role dropdown offered, and until
	   now the dropdown offered the vendor's own workspace — a school's HR
	   could appoint somebody Seller Admin. Checked here rather than only in
	   the list, because a rule enforced by what the UI happens to show is not
	   a rule: the request can be made without the UI. */
	// Every role asked for, not just the first: a request naming faculty and
	// seller_admin must be refused as firmly as one naming seller_admin alone.
	for _, k := range req.roles() {
		if platformOnlyRoles[k] && !id.PlatformAdmin {
			httpx.Error(w, r, http.StatusForbidden, "platform_role",
				"that role belongs to the people who operate this installation, "+
					"not to a school. Pick one of your own school's roles.")
			return
		}
	}

	var empID, userID string
	var created bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		empID, userID, created, err = appointEmployee(r.Context(), tx, id.InstitutionID, campus, req)
		return err
	})
	if errors.Is(err, errPhoneInUse) {
		httpx.Error(w, r, http.StatusConflict, "phone_in_use",
			"that phone number already belongs to somebody at this school. "+
				"Check the number, or leave it blank if this person does not need one")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	/* SAY WHICH IT WAS.

	   appointEmployee upserts on (institution_id, employee_code) and has always
	   returned `(xmax = 0)` to say whether it inserted or updated. This handler
	   discarded it into `_`, so the response was identical either way and the
	   Add staff form reported success for both.

	   That is what "add staff is not working" looks like from the office: a
	   clerk types a code that is already in use -- T-014 is somebody who left
	   last year -- presses Add, gets no complaint, and no new person exists.
	   Worse, the existing employee has just been silently renamed to the person
	   they were trying to add.

	   The upsert itself stays. The bulk staff sheet is re-run deliberately to
	   correct a spelling, and turning that into a duplicate-key error would
	   break the import that a hundred rows depend on. What was missing was
	   telling the caller which of the two happened, so a form can say "added"
	   or "updated T-014" and a person can tell them apart. */
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": empID, "user_id": nullOrString(userID), "employee_code": req.EmployeeCode,
		"created": created,
	})
}

func (req employeeRequest) validate() error {
	if req.EmployeeCode == "" || req.FirstName == "" {
		return errors.New("employee_code and first_name are required")
	}
	if req.CreateLogin && req.Email == "" {
		return errors.New("an email is required to create a login")
	}
	return nil
}

/*
appointEmployee is the one way a person becomes a member of staff.

	Extracted from createEmployee so that recruitment's hire step (see
	hr_growth.go) walks the same path rather than growing a second INSERT.
	Two ways to create an employee is two sets of defaults, two ideas of what
	an invited login means, and — the reason it matters here — a hire that
	appears on the recruitment screen and nowhere payroll can see it.

	Callers supply the transaction and the campus so the appointment can be
	made atomic with whatever else the caller is doing: the hire marks the
	candidate joined in the same transaction, and neither half can land alone.
*/
func appointEmployee(ctx context.Context, tx pgx.Tx, instID, campus uuid.UUID,
	req employeeRequest) (empID, userID string, created bool, err error) {

	if req.CreateLogin {
		// Invited, not active, and with no password: the account exists but
		// cannot be signed into until a password is set, so a half-finished
		// onboarding never leaves a usable credential lying around.
		if err = tx.QueryRow(ctx, `
			INSERT INTO users (institution_id, email, phone, full_name, status)
			VALUES ($1,$2::citext,$3,$4,'invited')
			ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
			DO UPDATE SET full_name = EXCLUDED.full_name
			RETURNING id::text`,
			instID, req.Email, nullString(req.Phone),
			strings.TrimSpace(req.FirstName+" "+req.LastName)).Scan(&userID); err != nil {
			/* THE TABLE HAS TWO UNIQUE CONSTRAINTS AND THIS ANTICIPATED ONE.

			   users carries a unique index on (institution_id, email) and
			   another on (institution_id, phone). The ON CONFLICT above names
			   the first, so a duplicate email is absorbed and a duplicate
			   PHONE raises 23505 -- which this handler turned into a 500, and
			   the Add staff form renders a 500 as "something went wrong".

			   Measured on the live box: a clerk typing a number already held
			   by somebody at that school got that sentence, three times, with
			   nothing anywhere naming the number as the problem.

			   Not absorbed like the email. Two people sharing an email address
			   is a school with one office mailbox; two people sharing a mobile
			   number is somebody typing the wrong one, and quietly attaching
			   this appointment to whoever already has it would be worse than
			   refusing. Named, so the fix takes five seconds. */
			if uniqueViolationOn(err, "users_institution_phone") {
				return "", "", false, errPhoneInUse
			}
			return "", "", false, err
		}
		for _, roleKey := range req.roles() {
			/* Install the role if this school has not got it yet.

			   Librarian, transport manager and the receptionist are not seeded
			   into a new school; they arrive with their first holder. The
			   insert below selects from `roles`, so before this line an
			   appointment to one of them matched no row, inserted nothing, and
			   reported success — the staff member existed with no role and
			   signed in to an empty rail. Silent, because nothing failed. */
			if _, _, err = installOptionalRole(ctx, tx, instID, roleKey); err != nil {
				return "", "", false, err
			}
			if _, err = tx.Exec(ctx, `
				INSERT INTO user_roles (institution_id, user_id, role_id)
				SELECT $1, $2::uuid, r.id FROM roles r
				 WHERE r.key = $3 AND (r.institution_id = $1 OR r.institution_id IS NULL)
				ON CONFLICT DO NOTHING`, instID, userID, roleKey); err != nil {
				return "", "", false, err
			}
		}
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
		                       first_name, last_name, email, phone,
		                       department_id, designation_id, joined_on,
		                       employment_type, status, staff_number)
		VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::citext,$8,$9::uuid,$10::uuid,
		        COALESCE($11::date, CURRENT_DATE),$12,'active',
		        /* The next free four-digit number in this school.

		           Taken as max+1 rather than count+1 so a gap left by a deleted
		           row is never handed to two people, and floored at 1000 so the
		           first member of staff a school adds is 1000 and not 1. NULL
		           past 9999 rather than failing the insert: a school that
		           somehow has nine thousand staff should still be able to add
		           the next one, and it can be given a number by hand. */
		        (SELECT CASE WHEN COALESCE(max(staff_number), 999) < 9999
		                     THEN GREATEST(COALESCE(max(staff_number), 999) + 1, 1000)
		                END
		           FROM employees WHERE institution_id = $1))
		ON CONFLICT (institution_id, employee_code)
		DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
		              email = EXCLUDED.email, phone = EXCLUDED.phone,
		              department_id = EXCLUDED.department_id,
		              designation_id = EXCLUDED.designation_id,
		              employment_type = COALESCE(EXCLUDED.employment_type, employees.employment_type),
		              user_id = COALESCE(EXCLUDED.user_id, employees.user_id)
		RETURNING id::text, (xmax = 0)`,
		instID, campus, nullString(userID), req.EmployeeCode,
		req.FirstName, nullString(req.LastName), nullString(req.Email),
		nullString(req.Phone), nullString(req.Department), nullString(req.Designation),
		nullString(req.JoinedOn), nullString(req.EmploymentType)).Scan(&empID, &created)
	return empID, userID, created, err
}

func nullOrString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// --- setup readiness --------------------------------------------------------

type setupStep struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Done     bool   `json:"done"`
	Count    int    `json:"count"`
	Detail   string `json:"detail"`
	Blocking bool   `json:"blocking"`
}

// getSetupStatus tells a new school what it still has to do.
//
// An empty ERP is indistinguishable from a broken one, so the first screen a
// fresh tenant sees should be a checklist rather than a dashboard of zeroes.
func (s *Server) getSetupStatus(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var c struct {
		Campuses, Years, Classes, Sections, Subjects, Periods int
		ClassSubjects, Teachers, Students, FeeHeads           int
		FeeStructures, GradingScales, Exams                   int
		History                                               int
		ProfileDone, HasUDISE                                 bool
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM campuses)::int,
			       (SELECT count(*) FROM academic_years)::int,
			       (SELECT count(*) FROM classes)::int,
			       (SELECT count(*) FROM sections)::int,
			       (SELECT count(*) FROM subjects)::int,
			       (SELECT count(*) FROM periods)::int,
			       (SELECT count(*) FROM class_subjects)::int,
			       -- A teacher counts as assigned if they hold a subject in a
			       -- section OR are class teacher of one. Counting only subject
			       -- assignments told a school with class teachers in place that
			       -- it still had not started.
			       (SELECT count(*) FROM (
			           SELECT teacher_user_id FROM section_subject_teachers
			           UNION
			           SELECT class_teacher_id FROM sections WHERE class_teacher_id IS NOT NULL
			        ) x)::int,
			       (SELECT count(*) FROM students WHERE status='active')::int,
			       (SELECT count(*) FROM fee_heads)::int,
			       (SELECT count(*) FROM fee_structures)::int,
			       (SELECT count(*) FROM grading_scales)::int,
			       (SELECT count(*) FROM exams)::int,
			       -- Years carried across from before this system: a child's
			       -- and a teacher's, counted together, because the step is
			       -- one job and a school that did neither has not done it.
			       ((SELECT count(*) FROM student_year_history)
			        + (SELECT count(*) FROM employee_year_history))::int,
			       -- The school's own identity. Blank district and board mean
			       -- every report card and receipt prints an incomplete header.
			       COALESCE((SELECT district IS NOT NULL AND state IS NOT NULL
			                        AND affiliation_board IS NOT NULL
			                   FROM institutions WHERE id = $1), false),
			       COALESCE((SELECT udise_code IS NOT NULL
			                   FROM institutions WHERE id = $1), false)`,
			id.InstitutionID).
			Scan(&c.Campuses, &c.Years, &c.Classes, &c.Sections, &c.Subjects, &c.Periods,
				&c.ClassSubjects, &c.Teachers, &c.Students, &c.FeeHeads,
				&c.FeeStructures, &c.GradingScales, &c.Exams, &c.History,
				&c.ProfileDone, &c.HasUDISE)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	steps := []setupStep{
		{"profile", "Confirm the school's details", c.ProfileDone, 0,
			"Name, board, district and mandal. The header on every document.", true},
		{"campus", "Add your campus", c.Campuses > 0, c.Campuses,
			"Address, and the campus every class belongs to.", true},
		{"academic_year", "Open the academic year", c.Years > 0, c.Years,
			"June to April for most Telangana schools.", true},
		/* CLASSES AND SECTIONS ARE ONE STEP.

		   They were two, and the second was the one schools left half done --
		   which leaves classes no child can be enrolled into, a state that
		   looks finished from the class list. Nobody decides their classes
		   without already knowing how many sections each has, so they are
		   asked together and the step is done when both exist. */
		{"classes", "Create classes and their sections", c.Classes > 0 && c.Sections > 0,
			c.Classes,
			"Class 1 to 10, each with its sections and how many seats they hold.", true},
		{"subjects", "Add subjects", c.Subjects > 0, c.Subjects,
			"Scholastic and co-scholastic.", true},
		{"class_subjects", "Map subjects to classes", c.ClassSubjects > 0, c.ClassSubjects,
			"Which class studies what.", true},
		{"periods", "Define the school day", c.Periods > 0, c.Periods,
			"Periods and breaks, in order.", false},
		{"staff", "Add staff", c.Teachers > 0, c.Teachers,
			"Teachers, the office, accounts and HR. Each with the role that " +
				"matches the job.", true},
		{"students", "Enrol students", c.Students > 0, c.Students,
			"Admit individually or import from a spreadsheet.", true},
		{"grading", "Set up a grading scale", c.GradingScales > 0, c.GradingScales,
			"Marks cannot become grades without it.", false},
		{"fee_heads", "Define fee heads", c.FeeHeads > 0, c.FeeHeads,
			"Tuition, transport, lab.", false},
		{"fee_structures", "Build fee structures", c.FeeStructures > 0, c.FeeStructures,
			"What each class pays, and when.", false},
		{"exams", "Schedule an exam", c.Exams > 0, c.Exams,
			"Papers can be generated for every class at once.", false},
		/* THE STEP FOR A SCHOOL THAT IS NOT NEW.

		   Every step above assumes a school starting from nothing. Most are
		   not: they have been running for twenty years and are moving, and
		   the thing they ask first is whether their records come with them.
		   Never blocking -- a genuinely new school has no history and must not
		   be shown an outstanding task it can never complete. */
		{"history", "Carry your past years across", c.History > 0, c.History,
			"Optional, and only for a school that was running before this. " +
				"Past results, attendance and fees for children and staff, " +
				"uploaded once per file however many years it covers.", false},
		{"udise", "Record the UDISE+ code", c.HasUDISE, 0,
			"Eleven digits. Required before the annual return can be filed.", false},
		/* THE WAY OUT OF AN EVALUATION.

		   Marked done permanently, because it is not a task: a school that
		   never presses it has not left anything unfinished, and a step that
		   sits unticked forever makes a completed setup look incomplete. It is
		   here because this is where somebody looks when they want to start
		   again, and nowhere else in the product says how. */
		{"reset", "Clear everything and start again", true, 0,
			"For a school that has finished trying this out and wants to put " +
				"its real records in. Deletes what the school has recorded and " +
				"keeps the logins, the school's details and the academic year.", false},
	}

	done, blocking := 0, 0
	for _, st := range steps {
		if st.Done {
			done++
		} else if st.Blocking {
			blocking++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"steps": steps, "completed": done, "total": len(steps),
		"blocking_remaining": blocking,
		"ready":              blocking == 0,
	})
}

// --- grading scales, read and removed ---------------------------------------

type gradingScaleRow struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	IsDefault bool             `json:"is_default"`
	InUse     bool             `json:"in_use"`
	Bands     []gradingBandRow `json:"bands"`
}

type gradingBandRow struct {
	Grade      string   `json:"grade"`
	MinPercent float64  `json:"min_percent"`
	MaxPercent float64  `json:"max_percent"`
	GradePoint *float64 `json:"grade_point,omitempty"`
}

/*
listGradingScales shows what the school has already set up.

	The step saved a scale and then showed nothing but "1 already added", so
	the only way to see the bands you had entered was to enter them again and
	watch what happened. Every other setup step lists what is there; this one
	could not, because nothing served it.

	in_use is the reason a scale cannot always be removed: an exam that has
	been graded against a scale keeps meaning what it meant, and deleting the
	bands underneath it turns a marked paper into a mark with no grade.
*/
func (s *Server) listGradingScales(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT g.id::text, g.name, g.is_default,
		       EXISTS (SELECT 1 FROM exams e WHERE e.grading_scale_id = g.id),
		       COALESCE((SELECT json_agg(json_build_object(
		                          'grade', b.grade,
		                          'min_percent', b.min_percent,
		                          'max_percent', b.max_percent,
		                          'grade_point', b.grade_point)
		                        ORDER BY b.min_percent DESC)
		                   FROM grade_bands b WHERE b.grading_scale_id = g.id), '[]'::json)
		  FROM grading_scales g
		 ORDER BY g.is_default DESC, g.name`, nil,
		func(rows pgx.Rows) (gradingScaleRow, error) {
			var v gradingScaleRow
			return v, rows.Scan(&v.ID, &v.Name, &v.IsDefault, &v.InUse, &v.Bands)
		})
	respond(w, r, items, err)
}

// deleteGradingScale removes a scale and its bands.
//
// Refused where an exam has been graded against it. A scale is not a label on
// an exam, it is what turned that exam's marks into grades, and removing it
// leaves marked papers whose grades cannot be explained.
func (s *Server) deleteGradingScale(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	scaleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid grading scale id")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var used bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM exams WHERE grading_scale_id = $1)`,
			scaleID).Scan(&used); err != nil {
			return err
		}
		if used {
			return errScaleInUse
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM grade_bands WHERE grading_scale_id = $1`, scaleID); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM grading_scales WHERE id = $1`, scaleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	switch {
	case errors.Is(err, errScaleInUse):
		httpx.BadRequest(w, r,
			"an exam has been graded against this scale. Removing it would leave "+
				"marked papers whose grades cannot be explained. Edit the bands instead.")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

var errScaleInUse = errStr("grading scale is in use")
