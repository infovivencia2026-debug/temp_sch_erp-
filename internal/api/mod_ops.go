package api

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
)

/* Modules 6-10 — communication, timetable generation, statutory compliance
   exports, payroll, and the operations desks. */

// ------------------------------------------------------------ communication

type circularRequest struct {
	Title        string   `json:"title"`
	Body         string   `json:"body"`
	Kind         string   `json:"kind,omitempty"`
	AudienceRole string   `json:"audience_role,omitempty"`
	SectionIDs   []string `json:"section_ids,omitempty"`
	RequiresAck  bool     `json:"requires_ack"`
	SendSMS      bool     `json:"send_sms"`
}

// publishCircular posts an announcement and optionally pushes it as SMS.
//
// Targeting is by role and, optionally, by section. A circular aimed at
// "Class 8 parents" must not reach the whole school, which is the difference
// between a notice board and a communication tool.
func (s *Server) publishCircular(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req circularRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "title and body are required")
		return
	}
	if req.Kind == "" {
		req.Kind = "circular"
	}
	if req.AudienceRole == "" {
		req.AudienceRole = "all"
	}

	var annID uuid.UUID
	var recipients int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO announcements (institution_id, title, body, kind, audience_role,
			                           requires_ack, publish_at, created_by)
			VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
			RETURNING id`,
			id.InstitutionID, req.Title, req.Body, req.Kind, req.AudienceRole,
			req.RequiresAck, id.UserID).Scan(&annID); err != nil {
			return err
		}
		for _, raw := range req.SectionIDs {
			sid, err := uuid.Parse(raw)
			if err != nil {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO announcement_sections (announcement_id, section_id, institution_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, annID, sid, id.InstitutionID); err != nil {
				return err
			}
		}
		// Count who it actually reaches, so the author sees the blast radius
		// before wondering why nobody replied.
		return tx.QueryRow(r.Context(), `
			SELECT count(DISTINCT g.user_id)
			  FROM students st
			  JOIN student_guardians sg ON sg.student_id = st.id
			  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
			  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status='active'
			 WHERE st.status = 'active'
			   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))`,
			uuidArray(req.SectionIDs)).Scan(&recipients)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	queued := 0
	if req.SendSMS {
		// One task per recipient: a DLT rejection for one number must not lose
		// the rest of the circular.
		_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT DISTINCT g.user_id
				  FROM students st
				  JOIN student_guardians sg ON sg.student_id = st.id
				  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
				  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status='active'
				 WHERE st.status='active'
				   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))`,
				uuidArray(req.SectionIDs))
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var uid uuid.UUID
				if err := rows.Scan(&uid); err != nil {
					return err
				}
				if _, err := s.Queue.Enqueue(r.Context(), queue.TypeMessageSend,
					queue.MessageSendPayload{
						Envelope: queue.Envelope{
							InstitutionID: id.InstitutionID, ActorUserID: id.UserID,
							RequestID: httpx.RequestIDFrom(r.Context()), JobID: uuid.New(),
						},
						Channel: "sms", TemplateKey: "circular.published", ToUserID: uid,
						Vars: map[string]any{"title": req.Title},
					}, queue.HeavyOptions()...); err == nil {
					queued++
				}
			}
			return rows.Err()
		})
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": annID.String(), "recipients": recipients, "sms_queued": queued,
	})
}

type circularRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	Audience    string `json:"audience_role"`
	RequiresAck bool   `json:"requires_ack"`
	PublishedAt string `json:"published_at"`
	Acks        int    `json:"acknowledgements"`
	Sections    int    `json:"sections"`
	// Whether the caller has signed this one. The total count answers the
	// office's question ("how many parents have read it"); this answers the
	// parent's ("is there anything still waiting on me"), and a screen built
	// for a family needs the second.
	Mine bool   `json:"acknowledged_by_me"`
	Body string `json:"body,omitempty"`
}

func (s *Server) listCirculars(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.title, a.kind, a.audience_role, a.requires_ack,
		       to_char(a.publish_at,'YYYY-MM-DD'),
		       (SELECT count(*) FROM announcement_acks ak WHERE ak.announcement_id = a.id)::int,
		       (SELECT count(*) FROM announcement_sections s2 WHERE s2.announcement_id = a.id)::int,
		       EXISTS (SELECT 1 FROM announcement_acks ak
		                WHERE ak.announcement_id = a.id AND ak.user_id = $1),
		       a.body
		  FROM announcements a
		 ORDER BY a.publish_at DESC LIMIT 200`,
		[]any{httpx.IdentityFrom(r.Context()).UserID},
		func(rows pgx.Rows) (circularRow, error) {
			var v circularRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Kind, &v.Audience, &v.RequiresAck,
				&v.PublishedAt, &v.Acks, &v.Sections, &v.Mine, &v.Body)
		})
	respond(w, r, items, err)
}

// ackCircular records a parent's acknowledgement — the read receipt a school
// needs when a circular carries consent or a fee deadline.
//
// announcement_acks.student_id is NOT NULL: an acknowledgement is always on
// behalf of a particular child, because a guardian with two children may need
// to consent for one and not the other. The child is taken from the caller's
// resolved scope, so it cannot be forged.
func (s *Server) ackCircular(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	annID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid circular id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.BadRequest(w, r,
			"only a student or guardian can acknowledge a circular")
		return
	}
	target := res.StudentIDs[0]
	if q := r.URL.Query().Get("student_id"); q != "" {
		sid, perr := uuid.Parse(q)
		if perr != nil || !res.OwnsStudent(sid) {
			httpx.NotFound(w, r)
			return
		}
		target = sid
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO announcement_acks (announcement_id, user_id, institution_id, student_id, acked_at)
			VALUES ($1,$2,$3,$4, now())
			-- Conflict target must be the full primary key.
			ON CONFLICT (announcement_id, user_id, student_id)
			DO UPDATE SET acked_at = now()`,
			annID, id.UserID, id.InstitutionID, target)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"acknowledged": true})
}

// ---------------------------------------------------------------- timetable

type generateTimetableRequest struct {
	SectionID      string `json:"section_id"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	Replace        bool   `json:"replace"`
}

// generateTimetable fills a section's grid without clashes.
//
// Greedy assignment, not an optimiser: walk the week period by period and place
// the subject with the largest remaining requirement whose teacher is free at
// that slot. A genetic solver produces prettier timetables but is impossible to
// explain to a head of department who wants to know why 8-B has no Physics on
// Tuesday. Greedy is predictable and re-runnable.
func (s *Server) generateTimetable(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req generateTimetableRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sectionID, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}

	type slot struct {
		periodID uuid.UUID
		weekday  int
	}
	type subject struct {
		classSubjectID uuid.UUID
		teacherID      *uuid.UUID
		remaining      int
	}

	placed, clashes := 0, 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var yearID uuid.UUID
		if req.AcademicYearID != "" {
			yearID, _ = uuid.Parse(req.AcademicYearID)
		}
		if yearID == uuid.Nil {
			if err := tx.QueryRow(r.Context(),
				`SELECT academic_year_id FROM sections WHERE id = $1`, sectionID).Scan(&yearID); err != nil {
				return err
			}
		}

		if req.Replace {
			if _, err := tx.Exec(r.Context(),
				`DELETE FROM timetable_entries WHERE section_id = $1 AND academic_year_id = $2`,
				sectionID, yearID); err != nil {
				return err
			}
		}

		// Teaching slots: Monday-Saturday, excluding breaks.
		var slots []slot
		rows, err := tx.Query(r.Context(),
			`SELECT id FROM periods WHERE NOT is_break ORDER BY sequence`)
		if err != nil {
			return err
		}
		var periods []uuid.UUID
		for rows.Next() {
			var p uuid.UUID
			if err := rows.Scan(&p); err != nil {
				rows.Close()
				return err
			}
			periods = append(periods, p)
		}
		rows.Close()
		for wd := 1; wd <= 6; wd++ {
			for _, p := range periods {
				slots = append(slots, slot{periodID: p, weekday: wd})
			}
		}

		// Every subject the class offers, with its assigned teacher. Periods per
		// week are spread evenly across the available slots.
		var subs []subject
		srows, err := tx.Query(r.Context(), `
			SELECT cs.id,
			       (SELECT sst.teacher_user_id FROM section_subject_teachers sst
			         WHERE sst.class_subject_id = cs.id AND sst.section_id = $1 LIMIT 1)
			  FROM class_subjects cs
			  JOIN sections sec ON sec.class_id = cs.class_id
			 WHERE sec.id = $1
			 ORDER BY cs.id`, sectionID)
		if err != nil {
			return err
		}
		for srows.Next() {
			var sub subject
			if err := srows.Scan(&sub.classSubjectID, &sub.teacherID); err != nil {
				srows.Close()
				return err
			}
			subs = append(subs, sub)
		}
		srows.Close()
		if len(subs) == 0 || len(slots) == 0 {
			return nil
		}

		per := len(slots) / len(subs)
		if per == 0 {
			per = 1
		}
		for i := range subs {
			subs[i].remaining = per
		}

		// Teacher occupancy across the whole school, so a teacher shared by two
		// sections is not double-booked.
		busy := map[string]bool{}
		brows, err := tx.Query(r.Context(), `
			SELECT teacher_user_id, weekday, period_id
			  FROM timetable_entries
			 WHERE teacher_user_id IS NOT NULL AND academic_year_id = $1`, yearID)
		if err != nil {
			return err
		}
		for brows.Next() {
			var t uuid.UUID
			var wd int
			var p uuid.UUID
			if err := brows.Scan(&t, &wd, &p); err != nil {
				brows.Close()
				return err
			}
			busy[fmt.Sprintf("%s|%d|%s", t, wd, p)] = true
		}
		brows.Close()

		for _, sl := range slots {
			// Largest remaining requirement first, so subjects finish evenly
			// rather than one filling Monday entirely.
			sort.SliceStable(subs, func(a, b int) bool { return subs[a].remaining > subs[b].remaining })
			for i := range subs {
				if subs[i].remaining <= 0 {
					continue
				}
				key := ""
				if subs[i].teacherID != nil {
					key = fmt.Sprintf("%s|%d|%s", *subs[i].teacherID, sl.weekday, sl.periodID)
					if busy[key] {
						clashes++
						continue
					}
				}
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO timetable_entries (institution_id, academic_year_id, section_id,
					                               period_id, weekday, class_subject_id, teacher_user_id)
					VALUES ($1,$2,$3,$4,$5,$6,$7)
					ON CONFLICT DO NOTHING`,
					id.InstitutionID, yearID, sectionID, sl.periodID, sl.weekday,
					subs[i].classSubjectID, subs[i].teacherID); err != nil {
					return err
				}
				if key != "" {
					busy[key] = true
				}
				subs[i].remaining--
				placed++
				break
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"periods_placed": placed, "clashes_avoided": clashes,
	})
}

type substitutionRequest struct {
	TimetableEntryID string `json:"timetable_entry_id"`
	OnDate           string `json:"on_date"`
	SubstituteUserID string `json:"substitute_user_id"`
	Reason           string `json:"reason,omitempty"`
}

// createSubstitution assigns a proxy teacher for one day's period.
func (s *Server) createSubstitution(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req substitutionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	entryID, err := uuid.Parse(req.TimetableEntryID)
	if err != nil {
		httpx.BadRequest(w, r, "timetable_entry_id must be a uuid")
		return
	}
	subID, err := uuid.Parse(req.SubstituteUserID)
	if err != nil {
		httpx.BadRequest(w, r, "substitute_user_id must be a uuid")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The proxy must actually be free, or the substitution just moves the
		// problem to another class.
		var busy bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM timetable_entries te
			   WHERE te.teacher_user_id = $1
			     AND te.weekday = extract(isodow FROM $2::date)::int
			     AND te.period_id = (SELECT period_id FROM timetable_entries WHERE id = $3))`,
			subID, req.OnDate, entryID).Scan(&busy); err != nil {
			return err
		}
		if busy {
			return errProxyBusy
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO substitutions (institution_id, timetable_entry_id, on_date,
			                           substitute_user_id, reason, created_by)
			VALUES ($1,$2,$3::date,$4,$5,$6)`,
			id.InstitutionID, entryID, req.OnDate, subID, nullString(req.Reason), id.UserID)
		return err
	})
	if errors.Is(err, errProxyBusy) {
		httpx.Error(w, r, http.StatusConflict, "proxy_busy",
			"that teacher already has a class in this period")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"substituted": true})
}

var errProxyBusy = errors.New("substitute teacher is not free")

// ---------------------------------------------------------------- compliance

type udiseRow struct {
	AdmissionNo string  `json:"admission_no"`
	Name        string  `json:"name"`
	APAARID     *string `json:"apaar_id,omitempty"`
	DateOfBirth *string `json:"date_of_birth,omitempty"`
	Gender      *string `json:"gender,omitempty"`
	Category    *string `json:"category,omitempty"`
	ClassName   *string `json:"class_name,omitempty"`
	IsRTE       bool    `json:"is_rte"`
	Aadhaar     bool    `json:"aadhaar_consent"`
	Issues      string  `json:"issues"`
}

// getUDISEExport builds the annual return and flags rows that will be rejected.
//
// The validation is the point. UDISE+ rejects the whole file on field errors,
// so the useful output is not the data but the list of children whose records
// are incomplete, produced early enough to fix before the deadline.
func (s *Server) getUDISEExport(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.apaar_id, to_char(st.date_of_birth,'YYYY-MM-DD'),
		       st.gender, st.category, c.name, st.is_rte, st.aadhaar_consent,
		       trim(both ', ' FROM concat_ws(', ',
		         CASE WHEN st.date_of_birth IS NULL THEN 'date of birth missing' END,
		         CASE WHEN st.gender   IS NULL THEN 'gender missing' END,
		         CASE WHEN st.category IS NULL THEN 'social category missing' END,
		         CASE WHEN st.apaar_id IS NULL THEN 'APAAR ID not issued' END,
		         CASE WHEN NOT st.aadhaar_consent THEN 'Aadhaar consent not recorded' END,
		         CASE WHEN c.name IS NULL THEN 'not enrolled in a class' END))
		  FROM students st
		  LEFT JOIN LATERAL (
		      SELECT e.class_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status='active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		 WHERE st.status = 'active'
		 ORDER BY st.admission_no`, nil,
		func(rows pgx.Rows) (udiseRow, error) {
			var v udiseRow
			return v, rows.Scan(&v.AdmissionNo, &v.Name, &v.APAARID, &v.DateOfBirth,
				&v.Gender, &v.Category, &v.ClassName, &v.IsRTE, &v.Aadhaar, &v.Issues)
		})
	respond(w, r, items, err)
}

type apaarUpdateRequest struct {
	StudentID      string `json:"student_id"`
	APAARID        string `json:"apaar_id"`
	AadhaarConsent bool   `json:"aadhaar_consent"`
}

// setAPAARID records a student's APAAR (One Nation One Student) identifier.
func (s *Server) setAPAARID(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req apaarUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sid, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	// APAAR is a 12-digit identifier; a typo here fails the whole return.
	apaar := strings.TrimSpace(req.APAARID)
	if apaar != "" && len(apaar) != 12 {
		httpx.BadRequest(w, r, "apaar_id must be 12 digits")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE students SET apaar_id = $2, aadhaar_consent = $3, updated_at = now()
			 WHERE id = $1`, sid, nullString(apaar), req.AadhaarConsent)
		return err
	})
	if err != nil {
		// APAAR is one identifier per student nationally. A duplicate is a data
		// error the clerk must resolve, not an internal fault — telling them
		// "something went wrong" would send them to IT instead of to the record
		// that already holds the number.
		if strings.Contains(err.Error(), "students_apaar_id") {
			httpx.Error(w, r, http.StatusConflict, "apaar_already_used",
				"that APAAR ID is already assigned to another student")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"student_id": sid.String(), "apaar_id": apaar})
}

// ------------------------------------------------------------------- payroll

type payrollRunRequest struct {
	Month int `json:"month"`
	Year  int `json:"year"`
}

// runPayroll computes a month's salaries from each employee's structure.
//
// Loss of pay is derived from staff attendance rather than entered by hand:
// paid days are the month's days minus recorded absences, and every earning is
// pro-rated on that. A locked run is never recomputed — a payslip already
// issued must keep its numbers.
func (s *Server) runPayroll(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req payrollRunRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Month < 1 || req.Month > 12 || req.Year < 2000 {
		httpx.BadRequest(w, r, "month must be 1-12 and year must be valid")
		return
	}

	var runID uuid.UUID
	var employees int
	var gross, deduction, net int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		err := tx.QueryRow(r.Context(), `
			INSERT INTO payroll_runs (institution_id, period_month, period_year, status, run_by)
			VALUES ($1,$2,$3,'draft',$4)
			ON CONFLICT (institution_id, period_year, period_month) DO UPDATE
			   SET run_by = EXCLUDED.run_by
			RETURNING id, status`, id.InstitutionID, req.Month, req.Year, id.UserID).
			Scan(&runID, &status)
		if err != nil {
			return err
		}
		if status == "locked" || status == "paid" {
			return errPayrollLocked
		}

		// Recompute from scratch: a re-run must amend, never accumulate.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM payslips WHERE payroll_run_id = $1`, runID); err != nil {
			return err
		}

		daysInMonth := time.Date(req.Year, time.Month(req.Month)+1, 0, 0, 0, 0, 0, time.UTC).Day()

		rows, err := tx.Query(r.Context(), `
			SELECT e.id, ss.id, ss.ctc_paise,
			       -- staff_attendance keys on user_id, not employee_id, so loss
			       -- of pay is counted through the employee's linked account.
			       COALESCE((SELECT count(*) FROM staff_attendance sa
			                  WHERE sa.user_id = e.user_id
			                    AND sa.status = 'absent'
			                    AND extract(month FROM sa.on_date) = $1
			                    AND extract(year  FROM sa.on_date) = $2), 0)::int
			  FROM employees e
			  JOIN salary_structures ss ON ss.employee_id = e.id
			   AND ss.effective_from <= make_date($2,$1,1)
			   AND (ss.effective_to IS NULL OR ss.effective_to >= make_date($2,$1,1))
			 WHERE e.status = 'active' AND e.user_id IS NOT NULL`, req.Month, req.Year)
		if err != nil {
			return err
		}
		type emp struct {
			id, structure uuid.UUID
			ctc           int64
			absent        int
		}
		var emps []emp
		for rows.Next() {
			var e emp
			if err := rows.Scan(&e.id, &e.structure, &e.ctc, &e.absent); err != nil {
				rows.Close()
				return err
			}
			emps = append(emps, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, e := range emps {
			paidDays := float64(daysInMonth - e.absent)
			if paidDays < 0 {
				paidDays = 0
			}
			ratio := paidDays / float64(daysInMonth)

			var earn, deduct int64
			breakup := map[string]int64{}
			crows, err := tx.Query(r.Context(), `
				SELECT sc.code, sc.kind, ssi.amount_paise
				  FROM salary_structure_items ssi
				  JOIN salary_components sc ON sc.id = ssi.component_id
				 WHERE ssi.salary_structure_id = $1
				 ORDER BY sc.sequence`, e.structure)
			if err != nil {
				return err
			}
			for crows.Next() {
				var code, kind string
				var amt int64
				if err := crows.Scan(&code, &kind, &amt); err != nil {
					crows.Close()
					return err
				}
				switch kind {
				case "earning":
					// Earnings pro-rate on paid days; deductions do not.
					v := int64(float64(amt) * ratio)
					earn += v
					breakup[code] = v
				case "deduction":
					deduct += amt
					breakup[code] = -amt
				}
			}
			crows.Close()

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO payslips (institution_id, payroll_run_id, employee_id, paid_days,
				                      lop_days, gross_paise, deduction_paise, net_paise, breakup)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				id.InstitutionID, runID, e.id, paidDays, e.absent,
				earn, deduct, earn-deduct, breakup); err != nil {
				return err
			}
			employees++
			gross += earn
			deduction += deduct
			net += earn - deduct
		}

		_, err = tx.Exec(r.Context(), `
			UPDATE payroll_runs SET status='processed', employees=$2,
			       gross_paise=$3, deduction_paise=$4, net_paise=$5
			 WHERE id = $1`, runID, employees, gross, deduction, net)
		return err
	})
	if errors.Is(err, errPayrollLocked) {
		httpx.Error(w, r, http.StatusConflict, "payroll_locked",
			"this month's payroll is locked; payslips already issued cannot be recomputed")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"payroll_run_id": runID.String(), "employees": employees,
		"gross_paise": gross, "deduction_paise": deduction, "net_paise": net,
	})
}

var errPayrollLocked = errors.New("payroll run is locked")

type payslipRow struct {
	EmployeeCode string `json:"employee_code"`
	FullName     string `json:"full_name"`
	PaidDays     string `json:"paid_days"`
	LOPDays      string `json:"lop_days"`
	Gross        int64  `json:"gross_paise"`
	Deduction    int64  `json:"deduction_paise"`
	Net          int64  `json:"net_paise"`
	Breakup      any    `json:"breakup"`
}

func (s *Server) listPayslips(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		       ps.paid_days::text, ps.lop_days::text,
		       ps.gross_paise, ps.deduction_paise, ps.net_paise, ps.breakup
		  FROM payslips ps
		  JOIN employees e ON e.id = ps.employee_id
		  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
		 WHERE ($1::int IS NULL OR pr.period_month = $1)
		   AND ($2::int IS NULL OR pr.period_year = $2)
		 ORDER BY e.employee_code`,
		[]any{nullInt(r.URL.Query().Get("month")), nullInt(r.URL.Query().Get("year"))},
		func(rows pgx.Rows) (payslipRow, error) {
			var v payslipRow
			return v, rows.Scan(&v.EmployeeCode, &v.FullName, &v.PaidDays, &v.LOPDays,
				&v.Gross, &v.Deduction, &v.Net, &v.Breakup)
		})
	respond(w, r, items, err)
}

// ---------------------------------------------------------------- operations

type issueBookRequest struct {
	CopyID    string `json:"copy_id"`
	StudentID string `json:"student_id,omitempty"`
	DueInDays int    `json:"due_in_days,omitempty"`
}

// issueBook lends a copy, refusing if it is already out.
func (s *Server) issueBook(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req issueBookRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	copyID, err := uuid.Parse(req.CopyID)
	if err != nil {
		httpx.BadRequest(w, r, "copy_id must be a uuid")
		return
	}
	if req.DueInDays <= 0 {
		req.DueInDays = 14
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var out bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM library_loans WHERE copy_id=$1 AND returned_on IS NULL)`,
			copyID).Scan(&out); err != nil {
			return err
		}
		if out {
			return errCopyOnLoan
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO library_loans (institution_id, copy_id, student_id, issued_on, due_on, issued_by)
			VALUES ($1,$2,$3::uuid, CURRENT_DATE, CURRENT_DATE + $4::int, $5)`,
			id.InstitutionID, copyID, nullString(req.StudentID), req.DueInDays, id.UserID)
		return err
	})
	if errors.Is(err, errCopyOnLoan) {
		httpx.Error(w, r, http.StatusConflict, "already_issued", "that copy is already on loan")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"issued": true, "due_in_days": req.DueInDays})
}

var errCopyOnLoan = errors.New("copy already on loan")

type returnBookRequest struct {
	FinePerDayPaise int64 `json:"fine_per_day_paise,omitempty"`
}

// returnBook closes a loan and computes the overdue fine.
func (s *Server) returnBook(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	loanID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid loan id")
		return
	}
	var req returnBookRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	if req.FinePerDayPaise <= 0 {
		req.FinePerDayPaise = 100 // ₹1/day is the common default
	}

	var fine int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE library_loans
			   SET returned_on = CURRENT_DATE,
			       fine_paise = GREATEST(0, (CURRENT_DATE - due_on)) * $2
			 WHERE id = $1 AND returned_on IS NULL
			 RETURNING fine_paise`, loanID, req.FinePerDayPaise).Scan(&fine)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no open loan with that id")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"returned": true, "fine_paise": fine})
}

type allocateHostelRequest struct {
	RoomID    string `json:"room_id"`
	StudentID string `json:"student_id"`
	BedNo     int    `json:"bed_no"`
}

// allocateHostelBed puts a boarder in a bed, refusing an occupied one.
func (s *Server) allocateHostelBed(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req allocateHostelRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	roomID, err := uuid.Parse(req.RoomID)
	if err != nil {
		httpx.BadRequest(w, r, "room_id must be a uuid")
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.BedNo <= 0 {
		req.BedNo = 1
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var beds int
		if err := tx.QueryRow(r.Context(),
			`SELECT beds FROM hostel_rooms WHERE id = $1`, roomID).Scan(&beds); err != nil {
			return err
		}
		if req.BedNo > beds {
			return fmt.Errorf("room has only %d beds", beds)
		}
		// The partial unique indexes enforce one live allocation per bed and per
		// student; this insert simply surfaces the violation as a clean error.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO hostel_allocations (institution_id, room_id, student_id, bed_no)
			VALUES ($1,$2,$3,$4)`, id.InstitutionID, roomID, studentID, req.BedNo)
		return err
	})
	if err != nil {
		if strings.Contains(err.Error(), "hostel_allocations_bed") {
			httpx.Error(w, r, http.StatusConflict, "bed_occupied", "that bed is already allocated")
			return
		}
		if strings.Contains(err.Error(), "hostel_allocations_student") {
			httpx.Error(w, r, http.StatusConflict, "already_allocated",
				"that student already occupies a bed; vacate it first")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"allocated": true})
}

type hostelRow struct {
	// RoomID was missing, which made the occupancy list unusable for the one
	// thing a warden does with it: put a child in a free bed. Every row named
	// a room the client could not then refer to.
	RoomID   string  `json:"room_id"`
	Block    string  `json:"block"`
	RoomNo   string  `json:"room_no"`
	Floor    *int    `json:"floor,omitempty"`
	Beds     int     `json:"beds"`
	Occupied int     `json:"occupied"`
	Free     int     `json:"free"`
	Gender   *string `json:"gender,omitempty"`
}

func (s *Server) listHostelOccupancy(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT hr.id::text, hb.name, hr.room_no, hr.floor, hr.beds,
		       (SELECT count(*) FROM hostel_allocations ha
		         WHERE ha.room_id = hr.id AND ha.vacated_on IS NULL)::int,
		       (hr.beds - (SELECT count(*) FROM hostel_allocations ha
		                    WHERE ha.room_id = hr.id AND ha.vacated_on IS NULL))::int,
		       hb.gender
		  FROM hostel_rooms hr
		  JOIN hostel_blocks hb ON hb.id = hr.block_id
		 ORDER BY hb.name, hr.room_no`, nil,
		func(rows pgx.Rows) (hostelRow, error) {
			var v hostelRow
			return v, rows.Scan(&v.RoomID, &v.Block, &v.RoomNo, &v.Floor, &v.Beds,
				&v.Occupied, &v.Free, &v.Gender)
		})
	respond(w, r, items, err)
}

type stockMoveRequest struct {
	ItemID    string `json:"item_id"`
	Kind      string `json:"kind"`
	Quantity  int    `json:"quantity"`
	Reference string `json:"reference,omitempty"`
	Remarks   string `json:"remarks,omitempty"`
}

// moveStock records a receipt, issue, return or adjustment. The running
// balance is maintained by a trigger, so on_hand can never disagree with the
// movement history.
func (s *Server) moveStock(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req stockMoveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	itemID, err := uuid.Parse(req.ItemID)
	if err != nil {
		httpx.BadRequest(w, r, "item_id must be a uuid")
		return
	}
	valid := map[string]bool{"receipt": true, "issue": true, "adjustment": true, "return": true}
	if !valid[req.Kind] {
		httpx.BadRequest(w, r, "kind must be receipt, issue, adjustment or return")
		return
	}
	if req.Quantity == 0 {
		httpx.BadRequest(w, r, "quantity must not be zero")
		return
	}

	var onHand int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Kind == "issue" {
			var available int
			if err := tx.QueryRow(r.Context(),
				`SELECT on_hand FROM inventory_items WHERE id = $1 FOR UPDATE`,
				itemID).Scan(&available); err != nil {
				return err
			}
			// Refuse to issue stock that is not there. A negative balance is
			// never a real state, and it corrupts every subsequent count.
			if req.Quantity > available {
				return fmt.Errorf("only %d in stock", available)
			}
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
			                                 reference, remarks, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			id.InstitutionID, itemID, req.Kind, req.Quantity,
			nullString(req.Reference), nullString(req.Remarks), id.UserID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT on_hand FROM inventory_items WHERE id = $1`, itemID).Scan(&onHand)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"on_hand": onHand})
}

type stockRow struct {
	ID       string  `json:"id"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Category *string `json:"category,omitempty"`
	Unit     string  `json:"unit"`
	OnHand   int     `json:"on_hand"`
	Reorder  int     `json:"reorder_level"`
	Low      bool    `json:"below_reorder"`
}

func (s *Server) listStock(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, code, name, category, unit, on_hand, reorder_level,
		       on_hand <= reorder_level
		  FROM inventory_items ORDER BY name`, nil,
		func(rows pgx.Rows) (stockRow, error) {
			var v stockRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Category, &v.Unit,
				&v.OnHand, &v.Reorder, &v.Low)
		})
	respond(w, r, items, err)
}

func nullInt(s string) any {
	if s == "" {
		return nil
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return nil
	}
	return n
}

// --- library catalogue --------------------------------------------------------

type titleRow struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Author    *string `json:"author,omitempty"`
	ISBN      *string `json:"isbn,omitempty"`
	Category  *string `json:"category,omitempty"`
	Copies    int     `json:"copies"`
	Available int     `json:"available"`
}

/*
listLibraryTitles is the catalogue: what the library holds and how much of it
is on the shelf right now.

	The circulation screen could issue and return, and nothing could answer
	"do we have this book" — which is the question actually asked at the
	counter, usually by a child holding a slip. Availability is computed from
	open loans rather than read off library_copies.status, because the status
	column drifts the moment anything writes a loan without updating it, and
	the loan table is the record that decides.
*/
func (s *Server) listLibraryTitles(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	items, err := collect(s, r, `
		SELECT t.id::text, t.title, t.author, t.isbn, t.category,
		       count(cp.id)::int,
		       count(cp.id) FILTER (
		         WHERE NOT EXISTS (
		           SELECT 1 FROM library_loans l
		            WHERE l.copy_id = cp.id AND l.returned_on IS NULL))::int
		  FROM library_titles t
		  LEFT JOIN library_copies cp ON cp.title_id = t.id
		 WHERE ($1 = '' OR t.title ILIKE '%' || $1 || '%'
		                OR COALESCE(t.author,'') ILIKE '%' || $1 || '%'
		                OR COALESCE(t.isbn,'')   ILIKE '%' || $1 || '%')
		 GROUP BY t.id, t.title, t.author, t.isbn, t.category
		 ORDER BY t.title
		 LIMIT 300`, []any{q},
		func(rows pgx.Rows) (titleRow, error) {
			var v titleRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Author, &v.ISBN, &v.Category,
				&v.Copies, &v.Available)
		})
	respond(w, r, items, err)
}

type copyRow struct {
	ID          string  `json:"id"`
	AccessionNo string  `json:"accession_no"`
	Barcode     *string `json:"barcode,omitempty"`
	Rack        *string `json:"rack,omitempty"`
	OnLoanTo    *string `json:"on_loan_to,omitempty"`
	DueOn       *string `json:"due_on,omitempty"`
}

// listTitleCopies lists the physical copies of one title, and who holds each.
func (s *Server) listTitleCopies(w http.ResponseWriter, r *http.Request) {
	titleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid title id")
		return
	}
	items, err := collect(s, r, `
		SELECT cp.id::text, cp.accession_no, cp.barcode, cp.rack,
		       COALESCE(concat_ws(' ', st.first_name, st.last_name),
		                concat_ws(' ', e.first_name,  e.last_name)),
		       to_char(l.due_on,'YYYY-MM-DD')
		  FROM library_copies cp
		  LEFT JOIN library_loans l ON l.copy_id = cp.id AND l.returned_on IS NULL
		  LEFT JOIN students  st ON st.id = l.student_id
		  LEFT JOIN employees e  ON e.id = l.employee_id
		 WHERE cp.title_id = $1
		 ORDER BY cp.accession_no`, []any{titleID},
		func(rows pgx.Rows) (copyRow, error) {
			var v copyRow
			return v, rows.Scan(&v.ID, &v.AccessionNo, &v.Barcode, &v.Rack,
				&v.OnLoanTo, &v.DueOn)
		})
	respond(w, r, items, err)
}

// --- hostel boarders ----------------------------------------------------------

type boarderRow struct {
	AllocationID string `json:"allocation_id"`
	StudentID    string `json:"student_id"`
	Name         string `json:"name"`
	AdmissionNo  string `json:"admission_no"`
	BedNo        int    `json:"bed_no"`
	AllocatedOn  string `json:"allocated_on"`
	Class        string `json:"class_name,omitempty"`
}

// listRoomBoarders names who is in a room. Occupancy counts tell a warden a
// bed is taken; roll call needs to know by whom.
func (s *Server) listRoomBoarders(w http.ResponseWriter, r *http.Request) {
	roomID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid room id")
		return
	}
	items, err := collect(s, r, `
		SELECT ha.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       ha.bed_no, to_char(ha.allocated_on,'YYYY-MM-DD'),
		       COALESCE(c.name || '-' || sec.name, '')
		  FROM hostel_allocations ha
		  JOIN students st ON st.id = ha.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ha.room_id = $1 AND ha.vacated_on IS NULL
		 ORDER BY ha.bed_no`, []any{roomID},
		func(rows pgx.Rows) (boarderRow, error) {
			var v boarderRow
			return v, rows.Scan(&v.AllocationID, &v.StudentID, &v.Name, &v.AdmissionNo,
				&v.BedNo, &v.AllocatedOn, &v.Class)
		})
	respond(w, r, items, err)
}

// --- infirmary ----------------------------------------------------------------

type healthRow struct {
	StudentID   string  `json:"student_id"`
	Name        string  `json:"name"`
	AdmissionNo string  `json:"admission_no"`
	Class       string  `json:"class_name,omitempty"`
	BloodGroup  *string `json:"blood_group,omitempty"`
	Allergies   *string `json:"allergies,omitempty"`
	Chronic     *string `json:"chronic_conditions,omitempty"`
	Doctor      *string `json:"doctor_name,omitempty"`
	DoctorPhone *string `json:"doctor_phone,omitempty"`
}

/*
listHealthRecords is the clinic's master file.

	Ordered so that the children with something recorded come first. A nurse
	opening this in an emergency is looking for the allergy or the chronic
	condition, and burying those under a hundred blank rows is the difference
	between finding it and not.
*/
func (s *Server) listHealthRecords(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	onlyFlagged := r.URL.Query().Get("flagged") == "true"
	items, err := collect(s, r, `
		SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, COALESCE(c.name || '-' || sec.name, ''),
		       st.blood_group, sh.allergies, sh.chronic_conditions,
		       sh.doctor_name, sh.doctor_phone
		  FROM students st
		  LEFT JOIN student_health sh ON sh.student_id = st.id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ($1 = '' OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $1 || '%'
		                OR st.admission_no ILIKE '%' || $1 || '%')
		   AND (NOT $2::bool
		        OR sh.allergies IS NOT NULL OR sh.chronic_conditions IS NOT NULL)
		 ORDER BY (sh.allergies IS NULL AND sh.chronic_conditions IS NULL),
		          st.admission_no
		 LIMIT 300`, []any{q, onlyFlagged},
		func(rows pgx.Rows) (healthRow, error) {
			var v healthRow
			return v, rows.Scan(&v.StudentID, &v.Name, &v.AdmissionNo, &v.Class,
				&v.BloodGroup, &v.Allergies, &v.Chronic, &v.Doctor, &v.DoctorPhone)
		})
	respond(w, r, items, err)
}

// --- transport routes ---------------------------------------------------------

type routeRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Code      *string `json:"code,omitempty"`
	Vehicle   *string `json:"vehicle,omitempty"`
	DistanceK *string `json:"distance_km,omitempty"`
	Stops     int     `json:"stops"`
	Riders    int     `json:"riders"`
	Active    bool    `json:"is_active"`
}

// listRoutes gives the transport office its routes with the two numbers that
// decide everything: how many stops, and how many children ride.
func (s *Server) listRoutes(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rt.id::text, rt.name, rt.code, v.registration_no,
		       rt.distance_km::text,
		       (SELECT count(*) FROM route_stops rs WHERE rs.route_id = rt.id)::int,
		       (SELECT count(*) FROM transport_allocations ta
		         WHERE ta.route_id = rt.id AND ta.valid_to IS NULL)::int,
		       rt.is_active
		  FROM routes rt
		  LEFT JOIN vehicles v ON v.id = rt.vehicle_id
		 ORDER BY rt.name`, nil,
		func(rows pgx.Rows) (routeRow, error) {
			var v routeRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Code, &v.Vehicle, &v.DistanceK,
				&v.Stops, &v.Riders, &v.Active)
		})
	respond(w, r, items, err)
}

type stopRow struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Sequence   int     `json:"sequence"`
	PickupTime *string `json:"pickup_time,omitempty"`
	DropTime   *string `json:"drop_time,omitempty"`
	FarePaise  int64   `json:"fare_paise"`
	Riders     int     `json:"riders"`
}

// listRouteStops is the run in order, with who boards where.
func (s *Server) listRouteStops(w http.ResponseWriter, r *http.Request) {
	routeID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid route id")
		return
	}
	items, err := collect(s, r, `
		SELECT rs.id::text, rs.name, rs.sequence,
		       to_char(rs.pickup_time,'HH24:MI'), to_char(rs.drop_time,'HH24:MI'),
		       COALESCE(rs.fare_paise,0),
		       (SELECT count(*) FROM transport_allocations ta
		         WHERE ta.pickup_stop_id = rs.id AND ta.valid_to IS NULL)::int
		  FROM route_stops rs
		 WHERE rs.route_id = $1
		 ORDER BY rs.sequence`, []any{routeID},
		func(rows pgx.Rows) (stopRow, error) {
			var v stopRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Sequence, &v.PickupTime,
				&v.DropTime, &v.FarePaise, &v.Riders)
		})
	respond(w, r, items, err)
}
