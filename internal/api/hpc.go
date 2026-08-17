package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The NEP 2020 Holistic Progress Card.

   Everything else in this codebase's assessment path counts marks. That is
   CCE, and NEP replaced it: the HPC asks how a child is developing across
   three domains — cognitive, affective, psychomotor — gathered from four
   points of view, and reports it differently at each stage of school.

   Two things make it awkward, and both are handled here rather than in the
   client.

   The 360 loop. A teacher, the child, a classmate and a parent each rate the
   same competency. Their views are kept side by side and never averaged into
   one number, because where they disagree is the useful part: a child who
   rates themselves "beginner" at something their teacher calls "proficient"
   is the conversation the card exists to start.

   The stage. CBSE grades the same competency four different ways depending on
   the class, and a card that shows a Class 3 child a number is not merely ugly
   — it is against the framework. The stage is derived from the class level, so
   nobody has to remember to set it. */

// stage maps a class level to the CBSE academic stage that governs how the
// card reports. Derived rather than stored: a class knows its level, and a
// second field would be one more thing to get out of step at promotion time.
func stageFor(level int) string {
	switch {
	case level <= 2:
		return "foundational"
	case level <= 5:
		return "preparatory"
	case level <= 8:
		return "middle"
	case level <= 10:
		return "secondary"
	default:
		return "senior_secondary"
	}
}

// reportingFor describes how a stage is allowed to be reported. The rule the
// framework is strictest about is the first one.
type reporting struct {
	Stage string `json:"stage"`
	Label string `json:"stage_label"`
	// Numeric is false for Classes 1–5. The card shows descriptors only; no
	// marks, no percentage, no rank.
	Numeric bool   `json:"numeric_grades"`
	Scale   string `json:"scale"`
	Note    string `json:"note"`
}

func reportingFor(stage string) reporting {
	switch stage {
	case "foundational":
		return reporting{stage, "Foundational (Classes 1–2)", false, "descriptors",
			"Descriptive only. No marks, percentage or rank at this stage."}
	case "preparatory":
		return reporting{stage, "Preparatory (Classes 3–5)", false, "descriptors",
			"Descriptive only. No marks, percentage or rank at this stage."}
	case "middle":
		return reporting{stage, "Middle (Classes 6–8)", true, "5-point A–E",
			"Marks alongside a five-point grade, with co-scholastic domains."}
	case "secondary":
		return reporting{stage, "Secondary (Classes 9–10)", true, "9-point A1–E + CGPA",
			"Marks, a nine-point grade and a cumulative grade point average."}
	default:
		return reporting{stage, "Senior Secondary (Classes 11–12)", true, "percentage, best of five",
			"Subject marks and a best-of-five percentage."}
	}
}

// descriptor turns an averaged 1–4 level into the word the card prints. The
// framework's vocabulary, not a school's invention.
func descriptor(level float64) string {
	switch {
	case level == 0:
		return "Not yet observed"
	case level < 1.75:
		return "Beginner"
	case level < 2.75:
		return "Progressing"
	case level < 3.5:
		return "Proficient"
	default:
		return "Advanced"
	}
}

// ninePoint is the CBSE Secondary scale. Returned with its grade point so the
// CGPA is the average of points, not of percentages — which is what a memo
// from the board actually shows.
func ninePoint(pct float64) (string, float64) {
	switch {
	case pct >= 91:
		return "A1", 10
	case pct >= 81:
		return "A2", 9
	case pct >= 71:
		return "B1", 8
	case pct >= 61:
		return "B2", 7
	case pct >= 51:
		return "C1", 6
	case pct >= 41:
		return "C2", 5
	case pct >= 33:
		return "D", 4
	default:
		return "E", 0
	}
}

// fivePoint is the Middle stage scale.
func fivePoint(pct float64) string {
	switch {
	case pct >= 81:
		return "A"
	case pct >= 61:
		return "B"
	case pct >= 41:
		return "C"
	case pct >= 33:
		return "D"
	default:
		return "E"
	}
}

// --- reading the card ----------------------------------------------------------

type hpcView struct {
	StudentID   string    `json:"student_id"`
	StudentName string    `json:"student_name"`
	ClassName   string    `json:"class_name"`
	SectionName string    `json:"section_name"`
	Reporting   reporting `json:"reporting"`

	Domains []hpcDomain `json:"domains"`
	// Scholastic is empty at the foundational and preparatory stages, where
	// numbers are not reported at all.
	Scholastic []hpcSubject `json:"scholastic"`
	Percentage *float64     `json:"percentage,omitempty"`
	Grade      *string      `json:"grade,omitempty"`
	CGPA       *float64     `json:"cgpa,omitempty"`
	Attendance *float64     `json:"attendance_percent,omitempty"`

	// Incomplete is what the framework calls a card that cannot yet be issued,
	// and what the exam controller needs before results day rather than after.
	Incomplete []string `json:"incomplete"`
	Ready      bool     `json:"ready"`
}

type hpcDomain struct {
	Domain       string          `json:"domain"`
	Label        string          `json:"label"`
	Competencies []hpcCompetency `json:"competencies"`
}

type hpcCompetency struct {
	ID          string `json:"id"`
	Code        string `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// One entry per point of view. Absent views are simply missing rather than
	// zero: "the parent has not commented" is not "the parent rated 0".
	Views      []hpcView360 `json:"views"`
	Descriptor string       `json:"descriptor"`
	// Gap is set when the child's own view differs from the teacher's by more
	// than a step, which is the thing a parent-teacher meeting is for.
	Gap bool `json:"self_teacher_gap"`
}

type hpcView360 struct {
	Role       string  `json:"role"`
	By         *string `json:"by,omitempty"`
	Level      *int    `json:"level,omitempty"`
	Descriptor string  `json:"descriptor,omitempty"`
	Note       *string `json:"note,omitempty"`
}

type hpcSubject struct {
	Subject    string   `json:"subject"`
	Obtained   float64  `json:"obtained"`
	Max        float64  `json:"max"`
	Percentage float64  `json:"percentage"`
	Grade      string   `json:"grade"`
	GradePoint *float64 `json:"grade_point,omitempty"`
}

var domainLabels = map[string]string{
	"cognitive":   "Cognitive development",
	"affective":   "Socio-emotional development",
	"psychomotor": "Physical development and the arts",
}

// getHolisticCard assembles one child's HPC.
func (s *Server) getHolisticCard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	studentID, ok := s.hpcStudent(w, r)
	if !ok {
		return
	}
	termID := nullString(r.URL.Query().Get("term_id"))

	out := hpcView{StudentID: studentID.String(), Domains: []hpcDomain{},
		Scholastic: []hpcSubject{}, Incomplete: []string{}}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var level int
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       COALESCE(c.name,''), COALESCE(sec.name,''), COALESCE(c.level, 1)
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id AND e.status = 'active'
			       ORDER BY e.enrolled_on DESC LIMIT 1) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $1`, studentID).
			Scan(&out.StudentName, &out.ClassName, &out.SectionName, &level); err != nil {
			return err
		}
		out.Reporting = reportingFor(stageFor(level))

		// --- the three domains, with every point of view ---------------------
		rows, err := tx.Query(r.Context(), `
			SELECT co.id::text, co.domain, co.code, co.name, COALESCE(co.description,''),
			       ob.observer_role, u.full_name, ob.level, ob.note
			  FROM hpc_competencies co
			  LEFT JOIN hpc_observations ob
			    ON ob.competency_id = co.id
			   AND ob.student_id = $1
			   AND ($2::uuid IS NULL OR ob.term_id = $2::uuid)
			  LEFT JOIN users u ON u.id = ob.observed_by
			 WHERE co.is_active
			   AND (cardinality(co.stages) = 0 OR $3 = ANY(co.stages))
			 ORDER BY co.domain, co.sequence, co.code, ob.observer_role`,
			studentID, termID, out.Reporting.Stage)
		if err != nil {
			return err
		}
		defer rows.Close()

		byDomain := map[string]*hpcDomain{}
		var order []string
		var cur *hpcCompetency
		var curID string
		for rows.Next() {
			var cid, domain, code, name, desc string
			var role, by, note *string
			var lvl *int
			if err := rows.Scan(&cid, &domain, &code, &name, &desc,
				&role, &by, &lvl, &note); err != nil {
				return err
			}
			d, seen := byDomain[domain]
			if !seen {
				d = &hpcDomain{Domain: domain, Label: domainLabels[domain]}
				byDomain[domain] = d
				order = append(order, domain)
			}
			if cid != curID {
				// Views starts as an empty slice, not nil: a nil slice marshals
				// to null and every client then has to handle two shapes for
				// "nobody has commented".
				d.Competencies = append(d.Competencies,
					hpcCompetency{ID: cid, Code: code, Name: name, Description: desc,
						Views: []hpcView360{}})
				cur = &d.Competencies[len(d.Competencies)-1]
				curID = cid
			}
			if role != nil {
				v := hpcView360{Role: *role, By: by, Level: lvl, Note: note}
				if lvl != nil {
					v.Descriptor = descriptor(float64(*lvl))
				}
				cur.Views = append(cur.Views, v)
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// The headline descriptor is the teacher's, not an average of all four.
		// A parent's generous rating must not lift the school's assessment.
		for _, name := range []string{"cognitive", "affective", "psychomotor"} {
			d, ok := byDomain[name]
			if !ok {
				continue
			}
			rated := 0
			for i := range d.Competencies {
				c := &d.Competencies[i]
				var teacher, self float64
				for _, v := range c.Views {
					if v.Level == nil {
						continue
					}
					switch v.Role {
					case "teacher":
						teacher = float64(*v.Level)
					case "self":
						self = float64(*v.Level)
					}
				}
				c.Descriptor = descriptor(teacher)
				c.Gap = teacher > 0 && self > 0 && abs(teacher-self) > 1
				if teacher > 0 {
					rated++
				}
			}
			if rated == 0 {
				out.Incomplete = append(out.Incomplete,
					domainLabels[name]+" has no teacher observations yet")
			} else if rated < len(d.Competencies) {
				out.Incomplete = append(out.Incomplete,
					itoa(len(d.Competencies)-rated)+" competencies in "+
						strings.ToLower(domainLabels[name])+" are still unrated")
			}
			out.Domains = append(out.Domains, *d)
		}
		_ = order

		// --- the scholastic half, only where the stage allows numbers --------
		if out.Reporting.Numeric {
			mrows, err := tx.Query(r.Context(), `
				SELECT sub.name, sum(COALESCE(m.marks_obtained,0))::float8,
				       sum(COALESCE(es.max_marks,0))::float8
				  FROM marks m
				  JOIN exam_subjects  es ON es.id = m.exam_subject_id
				  JOIN class_subjects cs ON cs.id = es.class_subject_id
				  JOIN subjects      sub ON sub.id = cs.subject_id
				  JOIN exams          ex ON ex.id = es.exam_id
				 WHERE m.student_id = $1
				   AND ($2::uuid IS NULL OR ex.term_id = $2::uuid)
				 GROUP BY sub.name ORDER BY sub.name`, studentID, termID)
			if err != nil {
				return err
			}
			defer mrows.Close()
			var totalObt, totalMax, points float64
			for mrows.Next() {
				var sj hpcSubject
				if err := mrows.Scan(&sj.Subject, &sj.Obtained, &sj.Max); err != nil {
					return err
				}
				if sj.Max > 0 {
					sj.Percentage = sj.Obtained / sj.Max * 100
				}
				switch out.Reporting.Stage {
				case "middle":
					sj.Grade = fivePoint(sj.Percentage)
				default:
					g, gp := ninePoint(sj.Percentage)
					sj.Grade, sj.GradePoint = g, &gp
					points += gp
				}
				totalObt += sj.Obtained
				totalMax += sj.Max
				out.Scholastic = append(out.Scholastic, sj)
			}
			if err := mrows.Err(); err != nil {
				return err
			}
			if len(out.Scholastic) == 0 {
				out.Incomplete = append(out.Incomplete, "no marks entered for this term")
			} else if totalMax > 0 {
				pct := totalObt / totalMax * 100
				out.Percentage = &pct
				if out.Reporting.Stage == "middle" {
					g := fivePoint(pct)
					out.Grade = &g
				} else {
					g, _ := ninePoint(pct)
					out.Grade = &g
					cgpa := points / float64(len(out.Scholastic))
					out.CGPA = &cgpa
				}
			}
		}

		// Attendance belongs on the card at every stage; it is the one number
		// a foundational card may carry, because it is a fact rather than a
		// judgement.
		var att *float64
		if err := tx.QueryRow(r.Context(), `
			SELECT round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
			             / NULLIF(count(*),0), 1)::float8
			  FROM student_attendance WHERE student_id = $1`, studentID).Scan(&att); err != nil {
			return err
		}
		out.Attendance = att
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Ready = len(out.Incomplete) == 0
	httpx.JSON(w, http.StatusOK, out)
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// hpcStudent resolves which child is being asked about and refuses anyone
// outside the caller's scope. A parent may name their own child; a teacher may
// name a child in their sections; the office may name anyone.
func (s *Server) hpcStudent(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return uuid.Nil, false
	}
	q := r.URL.Query().Get("student_id")
	if q == "" {
		// No id means "me or mine", which is how a student and a parent arrive.
		if len(res.StudentIDs) > 0 {
			return res.StudentIDs[0], true
		}
		httpx.BadRequest(w, r, "student_id is required")
		return uuid.Nil, false
	}
	sid, perr := uuid.Parse(q)
	if perr != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return uuid.Nil, false
	}
	if res.AllStudents || res.OwnsStudent(sid) {
		return sid, true
	}

	/* A teacher reaches a child through the sections they teach.

	   Left out at first, and the result was a teacher who could file an
	   observation for a child and then not read the card it went onto — the
	   write path checked sections, the read path did not. The same rule has to
	   hold on both or the feature is half usable. */
	id := httpx.IdentityFrom(r.Context())
	var reachable bool
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM enrollments e
			                WHERE e.student_id = $1 AND e.status = 'active'
			                  AND e.section_id = ANY($2))`,
			sid, res.SectionIDs).Scan(&reachable)
	}); err != nil {
		httpx.Internal(w, r, err)
		return uuid.Nil, false
	}
	if reachable {
		return sid, true
	}
	// Same answer as a child who does not exist, so the endpoint cannot be
	// used to discover which ids are real.
	httpx.NotFound(w, r)
	return uuid.Nil, false
}

// --- recording an observation ---------------------------------------------------

type hpcObservationRequest struct {
	StudentID    string `json:"student_id"`
	CompetencyID string `json:"competency_id"`
	TermID       string `json:"term_id,omitempty"`
	// Omitted for a teacher; a student rating themselves sends "self", a
	// guardian "parent". Never trusted blindly — see the check below.
	ObserverRole string `json:"observer_role,omitempty"`
	Level        *int   `json:"level,omitempty"`
	Note         string `json:"note,omitempty"`
}

var errWrongObserver = errors.New("that is not a view you may record")

// recordObservation stores one point of view.
//
// The observer role is checked against who is actually signed in. Letting the
// client name the role would allow a parent to file the teacher's assessment,
// which is the one thing a 360 card must never permit.
func (s *Server) recordObservation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req hpcObservationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	competency, err := uuid.Parse(req.CompetencyID)
	if err != nil {
		httpx.BadRequest(w, r, "competency_id must be a uuid")
		return
	}
	if req.Level != nil && (*req.Level < 1 || *req.Level > 4) {
		httpx.BadRequest(w, r,
			"level must be 1 (beginner), 2 (progressing), 3 (proficient) or 4 (advanced)")
		return
	}
	if req.Level == nil && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "give a level, a note, or both")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Who is allowed to say what.
	role := strings.TrimSpace(req.ObserverRole)
	staff := id.Can("academics.marks.write")
	switch {
	case role == "" && staff:
		role = "teacher"
	case role == "":
		role = "self"
	}
	if (role == "teacher" && !staff) || (role == "peer" && staff) {
		httpx.Denied(w, r, errWrongObserver.Error())
		return
	}

	var student uuid.UUID
	if req.StudentID != "" {
		student, err = uuid.Parse(req.StudentID)
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
	} else if len(res.StudentIDs) > 0 {
		student = res.StudentIDs[0]
	} else {
		httpx.BadRequest(w, r, "student_id is required")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* A teacher may rate a child in their own sections; a family may rate
		   their own child; nobody may rate a stranger.

		   Checked in SQL rather than in Go because "is enrolled in one of my
		   sections" is a fact about the database, and the alternative is
		   loading every student id the caller can reach in order to compare
		   one of them. */
		if !res.AllStudents && !res.OwnsStudent(student) {
			var reachable bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM enrollments e
				                WHERE e.student_id = $1 AND e.status = 'active'
				                  AND e.section_id = ANY($2))`,
				student, res.SectionIDs).Scan(&reachable); err != nil {
				return err
			}
			if !reachable {
				return errNotYourChild
			}
		}

		_, err := tx.Exec(r.Context(), `
			INSERT INTO hpc_observations (institution_id, student_id, competency_id,
			                              term_id, academic_year_id, observer_role,
			                              observed_by, level, note)
			VALUES ($1,$2,$3,$4::uuid,
			        (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			        $5,$6,$7,NULLIF($8,''))
			ON CONFLICT (student_id, competency_id, observer_role,
			             COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid),
			             COALESCE(observed_by, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET level = EXCLUDED.level, note = EXCLUDED.note,
			              updated_at = now()`,
			id.InstitutionID, student, competency, nullString(req.TermID),
			role, id.UserID, req.Level, req.Note)
		return err
	})
	if errors.Is(err, errNotYourChild) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"recorded": role})
}

// listCompetencies is what the observation screen is built from.
func (s *Server) listCompetencies(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID          string   `json:"id"`
		Domain      string   `json:"domain"`
		Label       string   `json:"domain_label"`
		Code        string   `json:"code"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Stages      []string `json:"stages"`
	}
	items, err := collect(s, r, `
		SELECT id::text, domain, code, name, COALESCE(description,''), stages
		  FROM hpc_competencies
		 WHERE is_active
		   AND ($1::text IS NULL OR domain = $1)
		 ORDER BY domain, sequence, code`,
		[]any{nullString(r.URL.Query().Get("domain"))},
		func(rows pgx.Rows) (row, error) {
			var v row
			err := rows.Scan(&v.ID, &v.Domain, &v.Code, &v.Name, &v.Description, &v.Stages)
			v.Label = domainLabels[v.Domain]
			return v, err
		})
	respond(w, r, items, err)
}
