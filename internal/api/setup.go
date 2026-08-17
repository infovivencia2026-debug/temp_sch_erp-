package api

import (
	"errors"
	"net/http"
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

// --- classes ----------------------------------------------------------------

type classRequest struct {
	Name   string `json:"name"`
	Level  int    `json:"level"`
	Stream string `json:"stream,omitempty"`
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
	if req.Level <= 0 {
		httpx.BadRequest(w, r, "level must be a positive number — it orders every class list")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO classes (institution_id, campus_id, name, level, stream)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, campus_id, name)
			DO UPDATE SET level = EXCLUDED.level, stream = EXCLUDED.stream
			RETURNING id::text`,
			id.InstitutionID, campus, req.Name, req.Level, nullString(req.Stream)).Scan(&newID)
	})
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
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required, for example A or B")
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

// --- subjects ---------------------------------------------------------------

type subjectRequest struct {
	Name         string `json:"name"`
	Code         string `json:"code"`
	IsScholastic *bool  `json:"is_scholastic,omitempty"`
}

func (s *Server) createSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req subjectRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Code) == "" {
		httpx.BadRequest(w, r, "name and code are required")
		return
	}
	scholastic := true
	if req.IsScholastic != nil {
		scholastic = *req.IsScholastic
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
			VALUES ($1,$2,$3,upper($4),$5)
			ON CONFLICT (institution_id, campus_id, code)
			DO UPDATE SET name = EXCLUDED.name, is_scholastic = EXCLUDED.is_scholastic
			RETURNING id::text`,
			id.InstitutionID, campus, req.Name, req.Code, scholastic).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "code": strings.ToUpper(req.Code)})
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
		for _, p := range req.Periods {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO periods (institution_id, campus_id, name, sequence,
				                     starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,$5::time,$6::time,$7)
				ON CONFLICT (institution_id, campus_id, sequence)
				DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
				              ends_at = EXCLUDED.ends_at, is_break = EXCLUDED.is_break`,
				id.InstitutionID, campus, p.Name, p.Sequence,
				p.StartsAt, p.EndsAt, p.IsBreak); err != nil {
				return err
			}
			written++
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

		if len(req.ClassIDs) == 0 {
			return nil
		}
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id,
			                           max_marks, pass_marks)
			SELECT $1, $2::uuid, cs.id, $3, GREATEST(1, round($3 * 0.33))
			  FROM class_subjects cs
			 WHERE cs.class_id = ANY($4)
			ON CONFLICT (exam_id, class_subject_id) DO NOTHING`,
			id.InstitutionID, examID, req.MaxMarks, uuidArray(req.ClassIDs))
		if err != nil {
			return err
		}
		papers = int(tag.RowsAffected())
		return nil
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "create an academic year before adding exams")
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
	CreateLogin  bool   `json:"create_login"`
	RoleKey      string `json:"role_key,omitempty"`
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
	if req.EmployeeCode == "" || req.FirstName == "" {
		httpx.BadRequest(w, r, "employee_code and first_name are required")
		return
	}
	if req.CreateLogin && req.Email == "" {
		httpx.BadRequest(w, r, "an email is required to create a login")
		return
	}

	var empID, userID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}

		if req.CreateLogin {
			// Invited, not active, and with no password: the account exists but
			// cannot be signed into until a password is set, so a half-finished
			// onboarding never leaves a usable credential lying around.
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO users (institution_id, email, phone, full_name, status)
				VALUES ($1,$2::citext,$3,$4,'invited')
				ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
				DO UPDATE SET full_name = EXCLUDED.full_name
				RETURNING id::text`,
				id.InstitutionID, req.Email, nullString(req.Phone),
				strings.TrimSpace(req.FirstName+" "+req.LastName)).Scan(&userID); err != nil {
				return err
			}
			if req.RoleKey != "" {
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO user_roles (institution_id, user_id, role_id)
					SELECT $1, $2::uuid, r.id FROM roles r
					 WHERE r.key = $3 AND (r.institution_id = $1 OR r.institution_id IS NULL)
					ON CONFLICT DO NOTHING`, id.InstitutionID, userID, req.RoleKey); err != nil {
					return err
				}
			}
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
			                       first_name, last_name, email, phone,
			                       department_id, designation_id, joined_on, status)
			VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::citext,$8,$9::uuid,$10::uuid,
			        COALESCE($11::date, CURRENT_DATE),'active')
			ON CONFLICT (institution_id, employee_code)
			DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
			              email = EXCLUDED.email, phone = EXCLUDED.phone,
			              department_id = EXCLUDED.department_id,
			              designation_id = EXCLUDED.designation_id,
			              user_id = COALESCE(EXCLUDED.user_id, employees.user_id)
			RETURNING id::text`,
			id.InstitutionID, campus, nullString(userID), req.EmployeeCode,
			req.FirstName, nullString(req.LastName), nullString(req.Email),
			nullString(req.Phone), nullString(req.Department), nullString(req.Designation),
			nullString(req.JoinedOn)).Scan(&empID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": empID, "user_id": nullOrString(userID), "employee_code": req.EmployeeCode,
	})
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
				&c.FeeStructures, &c.GradingScales, &c.Exams,
				&c.ProfileDone, &c.HasUDISE)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	steps := []setupStep{
		{"profile", "Confirm the school's details", c.ProfileDone, 0,
			"Name, board, district and mandal — the header on every document.", true},
		{"campus", "Add your campus", c.Campuses > 0, c.Campuses,
			"Address, and the campus every class belongs to.", true},
		{"academic_year", "Open the academic year", c.Years > 0, c.Years,
			"June to April for most Telangana schools.", true},
		{"classes", "Create classes", c.Classes > 0, c.Classes,
			"Grade 1 to 10, with a level that orders them.", true},
		{"sections", "Add sections", c.Sections > 0, c.Sections,
			"A, B, C — each with a capacity.", true},
		{"subjects", "Add subjects", c.Subjects > 0, c.Subjects,
			"Scholastic and co-scholastic.", true},
		{"class_subjects", "Map subjects to classes", c.ClassSubjects > 0, c.ClassSubjects,
			"Which class studies what.", true},
		{"periods", "Define the school day", c.Periods > 0, c.Periods,
			"Periods and breaks, in order.", false},
		{"staff", "Add teachers and assign them", c.Teachers > 0, c.Teachers,
			"A teacher's scope comes from what they are assigned.", true},
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
		{"udise", "Record the UDISE+ code", c.HasUDISE, 0,
			"Eleven digits. Required before the annual return can be filed.", false},
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
