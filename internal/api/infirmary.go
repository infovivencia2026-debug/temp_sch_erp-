package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The sick room, and the rest of the boarding house.

   Two registers here are the ones a school is asked to produce after something
   has gone wrong: what was given to a child and on whose authority, and who
   took a boarder off the premises. Everything else on these screens is a paper
   book in most Indian schools.

   Nothing here keeps a second copy of a child's allergies. student_health is
   the master file; these handlers join to it and show what it says at the
   moment a nurse is about to hand over a tablet. A duplicated allergy is not a
   convenience, it is a way for somebody to read the stale one.
*/

// mountInfirmary hangs the clinic and the remaining hostel registers off the
// operations group. Paths are relative: the caller owns the /ops prefix.
func (s *Server) mountInfirmary(r chi.Router) {
	// The clinic. Reading a child's medical record is HealthRead, which the
	// nurse, the counsellor and operations hold; writing one is HealthWrite,
	// which only the nurse and the principal do.
	r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/infirmary/visits", s.listInfirmaryVisits)
	r.With(httpx.RequirePermission(rbac.HealthWrite)).Post("/infirmary/visits", s.recordInfirmaryVisit)
	r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/infirmary/medications", s.listMedicationRegister)
	r.With(httpx.RequirePermission(rbac.HealthWrite)).Post("/infirmary/medications", s.recordMedication)
	r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/infirmary/checkups", s.listHealthCheckups)
	r.With(httpx.RequirePermission(rbac.HealthWrite)).Post("/infirmary/checkups", s.saveHealthCheckup)
	r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/infirmary/camps", s.listHealthCamps)
	r.With(httpx.RequirePermission(rbac.HealthWrite)).Post("/infirmary/camps", s.saveHealthCamp)
	r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/infirmary/camps/{id}/seen", s.listCampAttendance)
	r.With(httpx.RequirePermission(rbac.HealthWrite)).Post("/infirmary/camps/{id}/seen", s.recordCampAttendance)

	// The warden's registers. Gated on the hostel rather than on health, even
	// the sick-bay mark in the prep register: a warden ticking "in the sick
	// bay" is recording where a boarder was, not what is wrong with them.
	r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/night-study", s.listNightStudy)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/night-study", s.markNightStudy)
	r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/room-checks", s.listRoomChecks)
	r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/room-checks/{id}/items", s.listRoomCheckItems)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/room-checks", s.saveRoomCheck)
	r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/visits", s.listHostelVisits)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/visits", s.signHostelVisitorIn)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/visits/{id}/out", s.signHostelVisitorOut)
	r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/laundry", s.listLaundry)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/laundry", s.sendLaundry)
	r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/laundry/{id}/return", s.returnLaundry)
}

// indiaToday is the current date in the only timezone this product has. A box
// running UTC rolls over at half past five in the evening local, which would
// blank the nurse's register every evening.
func indiaToday() string { return nowInIndia().Format(time.DateOnly) }

// dayOrToday reads ?on_date=, falling back to the Indian date.
func dayOrToday(r *http.Request) string {
	if v := strings.TrimSpace(r.URL.Query().Get("on_date")); v != "" {
		return v
	}
	return indiaToday()
}

/*
optionalUUID reads a query parameter that narrows a list to one person.

	Absent and malformed are deliberately different. Blank means "the whole
	day"; a typo means the caller asked for a child who cannot exist, and
	quietly widening that to every clinical record in the school is exactly the
	sort of leak nobody notices.
*/
func optionalUUID(raw string) (*uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	v, err := uuid.Parse(raw)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// --- the nurse's day ---------------------------------------------------------

type infirmaryVisitRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Class       *string `json:"class_name,omitempty"`
	Date        string  `json:"on_date"`
	ArrivedAt   string  `json:"arrived_at"`
	Complaint   string  `json:"complaint"`
	Temperature *string `json:"temperature_c,omitempty"`
	Pulse       *int    `json:"pulse_bpm,omitempty"`
	BP          *string `json:"bp,omitempty"`
	Observation *string `json:"observations,omitempty"`
	Treatment   *string `json:"treatment,omitempty"`
	Rested      *int    `json:"rested_minutes,omitempty"`
	Outcome     string  `json:"outcome"`
	ReferredTo  *string `json:"referred_to,omitempty"`
	ParentTold  bool    `json:"parent_informed"`
	SeenBy      string  `json:"seen_by"`
	// Read from the master file, never stored here. The two facts a nurse must
	// see before treating a child she has not met.
	Allergies *string `json:"allergies,omitempty"`
	Chronic   *string `json:"chronic_conditions,omitempty"`
	Blood     *string `json:"blood_group,omitempty"`
	Doses     int     `json:"doses_given"`
}

/*
listInfirmaryVisits is both the day's register and one child's history.

	One endpoint answering two questions, chosen by whether a student is named.
	The nurse opens the day; the class teacher asking why a child keeps
	disappearing after lunch opens the child, and wants every visit rather than
	today's.
*/
func (s *Server) listInfirmaryVisits(w http.ResponseWriter, r *http.Request) {
	student, err := optionalUUID(r.URL.Query().Get("student_id"))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}

	items, err := collect(s, r, `
		SELECT v.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       NULLIF(concat_ws('-', c.name, sec.name), ''),
		       to_char(v.on_date,'YYYY-MM-DD'),
		       to_char(v.arrived_at,'YYYY-MM-DD"T"HH24:MI'),
		       v.complaint, v.temperature_c::text, v.pulse_bpm, v.bp,
		       v.observations, v.treatment, v.rested_minutes, v.outcome,
		       v.referred_to, v.parent_informed_at IS NOT NULL, v.seen_by_name,
		       sh.allergies, sh.chronic_conditions, st.blood_group,
		       (SELECT count(*) FROM medication_administrations m
		         WHERE m.visit_id = v.id)::int
		  FROM infirmary_visits v
		  JOIN students st ON st.id = v.student_id
		  LEFT JOIN student_health sh ON sh.student_id = st.id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ($1::uuid IS NULL AND v.on_date = $2::date
		        OR $1::uuid IS NOT NULL AND v.student_id = $1::uuid)
		 ORDER BY v.arrived_at DESC
		 LIMIT 200`, []any{student, dayOrToday(r)},
		func(rows pgx.Rows) (infirmaryVisitRow, error) {
			var v infirmaryVisitRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Class, &v.Date, &v.ArrivedAt, &v.Complaint, &v.Temperature,
				&v.Pulse, &v.BP, &v.Observation, &v.Treatment, &v.Rested,
				&v.Outcome, &v.ReferredTo, &v.ParentTold, &v.SeenBy,
				&v.Allergies, &v.Chronic, &v.Blood, &v.Doses)
		})
	respond(w, r, items, err)
}

type infirmaryVisitRequest struct {
	StudentID   string `json:"student_id"`
	Complaint   string `json:"complaint"`
	Temperature string `json:"temperature_c,omitempty"`
	Pulse       *int   `json:"pulse_bpm,omitempty"`
	BP          string `json:"bp,omitempty"`
	Observation string `json:"observations,omitempty"`
	Treatment   string `json:"treatment,omitempty"`
	Rested      *int   `json:"rested_minutes,omitempty"`
	Outcome     string `json:"outcome,omitempty"`
	ReferredTo  string `json:"referred_to,omitempty"`
	// A tick, not a timestamp. The server stamps the hour so a visit cannot be
	// recorded as having told the parents an hour before anyone rang them.
	ParentInformed bool `json:"parent_informed,omitempty"`
}

var visitOutcomes = []string{
	"returned_to_class", "rested", "sent_home", "referred", "hospitalised", "observed",
}

var errParentNotTold = errors.New(
	"a child who leaves the premises cannot be signed out until the family has been told")

func (s *Server) recordInfirmaryVisit(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req infirmaryVisitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Complaint) == "" {
		httpx.BadRequest(w, r, "say what the child came in with")
		return
	}
	if req.Outcome == "" {
		req.Outcome = "returned_to_class"
	}
	if !slices.Contains(visitOutcomes, req.Outcome) {
		httpx.BadRequest(w, r, "unknown outcome "+req.Outcome)
		return
	}
	// Both of these mean the child left the school's care, and the schema
	// refuses either without the family having been told. Checked here as well
	// so the nurse reads a sentence rather than a constraint name.
	if (req.Outcome == "sent_home" || req.Outcome == "hospitalised") && !req.ParentInformed {
		httpx.BadRequest(w, r, errParentNotTold.Error())
		return
	}
	if (req.Outcome == "referred" || req.Outcome == "hospitalised") &&
		strings.TrimSpace(req.ReferredTo) == "" {
		httpx.BadRequest(w, r, "name where the child was sent — a referral to nobody is not a referral")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO infirmary_visits
			    (institution_id, student_id, on_date, complaint, temperature_c,
			     pulse_bpm, bp, observations, treatment, rested_minutes, outcome,
			     referred_to, parent_informed_at, seen_by, seen_by_name)
			VALUES ($1,$2,$3::date,$4,NULLIF($5,'')::numeric,$6,NULLIF($7,''),
			        NULLIF($8,''),NULLIF($9,''),$10,$11,NULLIF($12,''),
			        CASE WHEN $13 THEN now() END,$14,$15)
			RETURNING id::text`,
			id.InstitutionID, student, indiaToday(), req.Complaint, req.Temperature,
			req.Pulse, req.BP, req.Observation, req.Treatment, req.Rested,
			req.Outcome, req.ReferredTo, req.ParentInformed, id.UserID, id.FullName).
			Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "outcome": req.Outcome})
}

// --- the medication register --------------------------------------------------

type medicationRow struct {
	ID          string `json:"id"`
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
	AdmissionNo string `json:"admission_no"`
	Medicine    string `json:"medicine"`
	Dose        string `json:"dose"`
	Route       string `json:"route"`
	// Who allowed it, kept apart from who gave it. The whole point of the row.
	Authority     string  `json:"authority"`
	AuthorisedBy  string  `json:"authorised_by_name"`
	AuthorityRef  *string `json:"authority_ref,omitempty"`
	AuthorisedOn  *string `json:"authorised_on,omitempty"`
	HasPrescript  bool    `json:"has_prescription_file"`
	AdministredBy string  `json:"administered_by_name"`
	AdministredAt string  `json:"administered_at"`
	WitnessedBy   *string `json:"witnessed_by_name,omitempty"`
	Refused       bool    `json:"refused"`
	Reaction      *string `json:"adverse_reaction,omitempty"`
	ParentTold    bool    `json:"parent_informed"`
	Notes         *string `json:"notes,omitempty"`
	// The master file again. A dose about to be given to a child with a
	// recorded allergy is the one row on this screen that should stop somebody.
	Allergies *string `json:"allergies,omitempty"`
}

func (s *Server) listMedicationRegister(w http.ResponseWriter, r *http.Request) {
	student, err := optionalUUID(r.URL.Query().Get("student_id"))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	// Everything that went wrong, across the whole period rather than one day.
	// A refusal or a reaction is reviewed in a meeting, not at the trolley.
	incidents := r.URL.Query().Get("incidents") == "true"

	items, err := collect(s, r, `
		SELECT m.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       m.medicine, m.dose, m.route, m.authority, m.authorised_by_name,
		       m.authority_ref, to_char(m.authorised_on,'YYYY-MM-DD'),
		       m.authority_file_id IS NOT NULL,
		       m.administered_by_name,
		       to_char(m.administered_at,'YYYY-MM-DD"T"HH24:MI'),
		       m.witnessed_by_name, m.refused, m.adverse_reaction,
		       m.parent_informed_at IS NOT NULL, m.notes, sh.allergies
		  FROM medication_administrations m
		  JOIN students st ON st.id = m.student_id
		  LEFT JOIN student_health sh ON sh.student_id = st.id
		 WHERE ($1::uuid IS NOT NULL AND m.student_id = $1::uuid
		        OR $1::uuid IS NULL AND $3::bool AND (m.refused OR m.adverse_reaction IS NOT NULL)
		        OR $1::uuid IS NULL AND NOT $3::bool
		           AND m.administered_at >= $2::date AND m.administered_at < $2::date + 1)
		 ORDER BY m.administered_at DESC
		 LIMIT 200`, []any{student, dayOrToday(r), incidents},
		func(rows pgx.Rows) (medicationRow, error) {
			var v medicationRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Medicine, &v.Dose, &v.Route, &v.Authority, &v.AuthorisedBy,
				&v.AuthorityRef, &v.AuthorisedOn, &v.HasPrescript,
				&v.AdministredBy, &v.AdministredAt, &v.WitnessedBy, &v.Refused,
				&v.Reaction, &v.ParentTold, &v.Notes, &v.Allergies)
		})
	respond(w, r, items, err)
}

type medicationRequest struct {
	StudentID string `json:"student_id"`
	VisitID   string `json:"visit_id,omitempty"`
	Medicine  string `json:"medicine"`
	Dose      string `json:"dose"`
	Route     string `json:"route,omitempty"`

	// doctor_prescription | parent_consent | standing_order | emergency
	Authority       string `json:"authority"`
	AuthorisedBy    string `json:"authorised_by_name"`
	AuthorityRef    string `json:"authority_ref,omitempty"`
	AuthorityFileID string `json:"authority_file_id,omitempty"`
	AuthorisedOn    string `json:"authorised_on,omitempty"`

	// Who gave it. Defaults to the signed-in user, which is the usual case, but
	// can be overridden: a warden often records a dose the matron handed over.
	AdministeredBy string `json:"administered_by_name,omitempty"`
	AdministeredAt string `json:"administered_at,omitempty"`
	WitnessedBy    string `json:"witnessed_by_name,omitempty"`
	Refused        bool   `json:"refused,omitempty"`
	Reaction       string `json:"adverse_reaction,omitempty"`
	ParentInformed bool   `json:"parent_informed,omitempty"`
	Notes          string `json:"notes,omitempty"`
}

var (
	medicationRoutes     = []string{"oral", "topical", "inhaled", "drops", "injection", "other"}
	medicationAuthority  = []string{"doctor_prescription", "parent_consent", "standing_order", "emergency"}
	errNoAuthority       = errors.New("say who authorised this dose — a parent by name or the prescribing doctor")
	errNoPrescriptProof  = errors.New("a prescription needs its number or a scan attached; 'the doctor said so' is not a record")
	errEmergencyNoReason = errors.New("an emergency dose given without anyone's permission must say in the notes why it could not wait")
	errNotToldOfIncident = errors.New("a refusal or a reaction has to be told to the family before it is filed")
)

/*
recordMedication writes one dose into the register.

	The row this endpoint refuses to write is the point of it. A dose with no
	named authority, a prescription nobody can produce, an emergency with no
	explanation, or a bad reaction the family has not been told about are each
	rejected here rather than saved and argued about later. The same rules are
	CHECK constraints, so a second writer cannot get round them; these exist so
	the nurse reads a sentence instead of a constraint name.
*/
func (s *Server) recordMedication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req medicationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Medicine) == "" || strings.TrimSpace(req.Dose) == "" {
		httpx.BadRequest(w, r, "name the medicine and the dose given")
		return
	}
	if req.Route == "" {
		req.Route = "oral"
	}
	if !slices.Contains(medicationRoutes, req.Route) {
		httpx.BadRequest(w, r, "unknown route "+req.Route)
		return
	}
	if !slices.Contains(medicationAuthority, req.Authority) {
		httpx.BadRequest(w, r,
			"authority must be doctor_prescription, parent_consent, standing_order or emergency")
		return
	}
	if strings.TrimSpace(req.AuthorisedBy) == "" {
		httpx.BadRequest(w, r, errNoAuthority.Error())
		return
	}
	if req.Authority == "doctor_prescription" &&
		strings.TrimSpace(req.AuthorityRef) == "" && req.AuthorityFileID == "" {
		httpx.BadRequest(w, r, errNoPrescriptProof.Error())
		return
	}
	if req.Authority == "emergency" && strings.TrimSpace(req.Notes) == "" {
		httpx.BadRequest(w, r, errEmergencyNoReason.Error())
		return
	}
	if (req.Refused || strings.TrimSpace(req.Reaction) != "") && !req.ParentInformed {
		httpx.BadRequest(w, r, errNotToldOfIncident.Error())
		return
	}
	if strings.TrimSpace(req.AdministeredBy) == "" {
		req.AdministeredBy = id.FullName
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO medication_administrations
			    (institution_id, student_id, visit_id, medicine, dose, route,
			     authority, authorised_by_name, authority_ref, authority_file_id,
			     authorised_on, administered_by, administered_by_name,
			     administered_at, witnessed_by_name, refused, adverse_reaction,
			     parent_informed_at, notes)
			VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,NULLIF($9,''),
			        NULLIF($10,'')::uuid,NULLIF($11,'')::date,$12,$13,
			        COALESCE(NULLIF($14,'')::timestamptz, now()),
			        NULLIF($15,''),$16,NULLIF($17,''),
			        CASE WHEN $18 THEN now() END,NULLIF($19,''))
			RETURNING id::text`,
			id.InstitutionID, student, req.VisitID, req.Medicine, req.Dose,
			req.Route, req.Authority, req.AuthorisedBy, req.AuthorityRef,
			req.AuthorityFileID, req.AuthorisedOn, id.UserID, req.AdministeredBy,
			req.AdministeredAt, req.WitnessedBy, req.Refused, req.Reaction,
			req.ParentInformed, req.Notes).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "authority": req.Authority})
}

// --- the annual checkup ---------------------------------------------------------

type checkupRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Class       *string `json:"class_name,omitempty"`
	Year        string  `json:"academic_year"`
	Date        string  `json:"on_date"`
	Camp        *string `json:"camp,omitempty"`
	Height      *string `json:"height_cm,omitempty"`
	Weight      *string `json:"weight_kg,omitempty"`
	BMI         *string `json:"bmi,omitempty"`
	VisionLeft  *string `json:"vision_left,omitempty"`
	VisionRight *string `json:"vision_right,omitempty"`
	Spectacles  bool    `json:"wears_spectacles"`
	Hearing     *string `json:"hearing,omitempty"`
	Dental      *string `json:"dental,omitempty"`
	DentalNotes *string `json:"dental_notes,omitempty"`
	Haemoglobin *string `json:"haemoglobin_gdl,omitempty"`
	Immunised   *bool   `json:"immunisation_upto_date,omitempty"`
	ReferredTo  *string `json:"referred_to,omitempty"`
	Remarks     *string `json:"remarks,omitempty"`
	ExaminedBy  *string `json:"examined_by,omitempty"`
}

func (s *Server) listHealthCheckups(w http.ResponseWriter, r *http.Request) {
	year, err := optionalUUID(r.URL.Query().Get("academic_year_id"))
	if err != nil {
		httpx.BadRequest(w, r, "academic_year_id must be a uuid")
		return
	}
	camp, err := optionalUUID(r.URL.Query().Get("camp_id"))
	if err != nil {
		httpx.BadRequest(w, r, "camp_id must be a uuid")
		return
	}

	items, err := collect(s, r, `
		SELECT hc.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       NULLIF(concat_ws('-', c.name, sec.name), ''),
		       ay.name, to_char(hc.on_date,'YYYY-MM-DD'), hcamp.name,
		       hc.height_cm::text, hc.weight_kg::text, hc.bmi::text,
		       hc.vision_left, hc.vision_right, hc.wears_spectacles, hc.hearing,
		       hc.dental, hc.dental_notes, hc.haemoglobin_gdl::text,
		       hc.immunisation_upto_date, hc.referred_to, hc.remarks, hc.examined_by
		  FROM health_checkups hc
		  JOIN students st ON st.id = hc.student_id
		  JOIN academic_years ay ON ay.id = hc.academic_year_id
		  LEFT JOIN health_camps hcamp ON hcamp.id = hc.camp_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ($1::uuid IS NULL OR hc.academic_year_id = $1::uuid)
		   AND ($2::uuid IS NULL OR hc.camp_id = $2::uuid)
		 ORDER BY hc.on_date DESC, st.admission_no
		 LIMIT 400`, []any{year, camp},
		func(rows pgx.Rows) (checkupRow, error) {
			var v checkupRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Class, &v.Year, &v.Date, &v.Camp, &v.Height, &v.Weight, &v.BMI,
				&v.VisionLeft, &v.VisionRight, &v.Spectacles, &v.Hearing,
				&v.Dental, &v.DentalNotes, &v.Haemoglobin, &v.Immunised,
				&v.ReferredTo, &v.Remarks, &v.ExaminedBy)
		})
	respond(w, r, items, err)
}

type checkupRequest struct {
	StudentID string `json:"student_id"`
	// Optional: resolved from the child's own enrolment when absent, which is
	// what a school actually means by "this year's checkup".
	AcademicYearID string `json:"academic_year_id,omitempty"`
	CampID         string `json:"camp_id,omitempty"`
	Date           string `json:"on_date,omitempty"`
	Height         string `json:"height_cm,omitempty"`
	Weight         string `json:"weight_kg,omitempty"`
	VisionLeft     string `json:"vision_left,omitempty"`
	VisionRight    string `json:"vision_right,omitempty"`
	Spectacles     bool   `json:"wears_spectacles,omitempty"`
	Hearing        string `json:"hearing,omitempty"`
	Dental         string `json:"dental,omitempty"`
	DentalNotes    string `json:"dental_notes,omitempty"`
	Haemoglobin    string `json:"haemoglobin_gdl,omitempty"`
	Immunised      *bool  `json:"immunisation_upto_date,omitempty"`
	ReferredTo     string `json:"referred_to,omitempty"`
	Remarks        string `json:"remarks,omitempty"`
	ExaminedBy     string `json:"examined_by,omitempty"`
}

var errCheckupHasNoYear = errors.New(
	"this child is not enrolled in any year and no year was named, so the checkup has nothing to belong to")

/*
saveHealthCheckup files one child's measurements for one year.

	An upsert rather than an insert, because the year is the identity of the
	record: the eye test happens in July and the dental camp in November, and
	both belong to the same annual card. Inserting would give the child two
	cards, each half filled in, and the state's own reporting counts cards.

	bmi is not accepted from the client at all — it is generated in the
	database from the height and weight in the same row, so a screen and a
	report cannot disagree about whether a child is underweight.
*/
func (s *Server) saveHealthCheckup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req checkupRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Date == "" {
		req.Date = indiaToday()
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The year the card belongs to: the one named, else the child's own
		   active enrolment, else the school's current year. Resolved here
		   rather than on the client so a camp operator filing four hundred
		   cards cannot put half of them in last year. */
		var year uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(
			    NULLIF($1,'')::uuid,
			    (SELECT e.academic_year_id FROM enrollments e
			      WHERE e.student_id = $2 AND e.status = 'active'
			      ORDER BY e.created_at DESC LIMIT 1),
			    (SELECT ay.id FROM academic_years ay
			      WHERE ay.is_current ORDER BY ay.starts_on DESC LIMIT 1))`,
			req.AcademicYearID, student).Scan(&year); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errCheckupHasNoYear
			}
			return err
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO health_checkups
			    (institution_id, student_id, academic_year_id, camp_id, on_date,
			     height_cm, weight_kg, vision_left, vision_right, wears_spectacles,
			     hearing, dental, dental_notes, haemoglobin_gdl,
			     immunisation_upto_date, referred_to, remarks, examined_by)
			VALUES ($1,$2,$3,NULLIF($4,'')::uuid,$5::date,
			        NULLIF($6,'')::numeric,NULLIF($7,'')::numeric,
			        NULLIF($8,''),NULLIF($9,''),$10,NULLIF($11,''),
			        NULLIF($12,''),NULLIF($13,''),NULLIF($14,'')::numeric,
			        $15,NULLIF($16,''),NULLIF($17,''),NULLIF($18,''))
			ON CONFLICT (institution_id, student_id, academic_year_id) DO UPDATE
			   SET camp_id      = COALESCE(EXCLUDED.camp_id, health_checkups.camp_id),
			       on_date      = EXCLUDED.on_date,
			       -- COALESCE throughout: the dental van fills in three columns
			       -- and knows nothing about the child's height. Overwriting
			       -- with nulls would empty the card each time somebody adds to
			       -- it, which is how a year of measurements disappears.
			       height_cm    = COALESCE(EXCLUDED.height_cm, health_checkups.height_cm),
			       weight_kg    = COALESCE(EXCLUDED.weight_kg, health_checkups.weight_kg),
			       vision_left  = COALESCE(EXCLUDED.vision_left, health_checkups.vision_left),
			       vision_right = COALESCE(EXCLUDED.vision_right, health_checkups.vision_right),
			       wears_spectacles = EXCLUDED.wears_spectacles,
			       hearing      = COALESCE(EXCLUDED.hearing, health_checkups.hearing),
			       dental       = COALESCE(EXCLUDED.dental, health_checkups.dental),
			       dental_notes = COALESCE(EXCLUDED.dental_notes, health_checkups.dental_notes),
			       haemoglobin_gdl = COALESCE(EXCLUDED.haemoglobin_gdl, health_checkups.haemoglobin_gdl),
			       immunisation_upto_date =
			           COALESCE(EXCLUDED.immunisation_upto_date, health_checkups.immunisation_upto_date),
			       referred_to  = COALESCE(EXCLUDED.referred_to, health_checkups.referred_to),
			       remarks      = COALESCE(EXCLUDED.remarks, health_checkups.remarks),
			       examined_by  = COALESCE(EXCLUDED.examined_by, health_checkups.examined_by),
			       updated_at   = now()
			RETURNING id::text`,
			id.InstitutionID, student, year, req.CampID, req.Date, req.Height,
			req.Weight, req.VisionLeft, req.VisionRight, req.Spectacles,
			req.Hearing, req.Dental, req.DentalNotes, req.Haemoglobin,
			req.Immunised, req.ReferredTo, req.Remarks, req.ExaminedBy).Scan(&newID)
	})
	switch {
	case errors.Is(err, errCheckupHasNoYear):
		httpx.BadRequest(w, r, errCheckupHasNoYear.Error())
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

// --- health programme camps -------------------------------------------------------

type healthCampRow struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Programme  string  `json:"programme"`
	Agency     *string `json:"agency,omitempty"`
	DoctorLead *string `json:"doctor_lead,omitempty"`
	Date       string  `json:"on_date"`
	EndsOn     *string `json:"ends_on,omitempty"`
	Venue      *string `json:"venue,omitempty"`
	Notes      *string `json:"notes,omitempty"`
	Seen       int     `json:"seen"`
	Referred   int     `json:"referred"`
	// Referrals nobody has closed out. The number that makes a camp worth
	// having run.
	Outstanding int `json:"follow_ups_outstanding"`
	Checkups    int `json:"checkups_filed"`
}

func (s *Server) listHealthCamps(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT hc.id::text, hc.name, hc.programme, hc.agency, hc.doctor_lead,
		       to_char(hc.on_date,'YYYY-MM-DD'), to_char(hc.ends_on,'YYYY-MM-DD'),
		       hc.venue, hc.notes,
		       (SELECT count(*) FROM health_camp_attendance a WHERE a.camp_id = hc.id)::int,
		       (SELECT count(*) FROM health_camp_attendance a
		         WHERE a.camp_id = hc.id AND a.referred)::int,
		       (SELECT count(*) FROM health_camp_attendance a
		         WHERE a.camp_id = hc.id AND a.referred AND a.follow_up_done_at IS NULL)::int,
		       (SELECT count(*) FROM health_checkups k WHERE k.camp_id = hc.id)::int
		  FROM health_camps hc
		 ORDER BY hc.on_date DESC
		 LIMIT 100`, nil,
		func(rows pgx.Rows) (healthCampRow, error) {
			var v healthCampRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Programme, &v.Agency,
				&v.DoctorLead, &v.Date, &v.EndsOn, &v.Venue, &v.Notes,
				&v.Seen, &v.Referred, &v.Outstanding, &v.Checkups)
		})
	respond(w, r, items, err)
}

type healthCampRequest struct {
	Name       string `json:"name"`
	Programme  string `json:"programme,omitempty"`
	Agency     string `json:"agency,omitempty"`
	DoctorLead string `json:"doctor_lead,omitempty"`
	Date       string `json:"on_date,omitempty"`
	EndsOn     string `json:"ends_on,omitempty"`
	Venue      string `json:"venue,omitempty"`
	Notes      string `json:"notes,omitempty"`
}

var campProgrammes = []string{
	"rbsk", "state_school_health", "ngo", "dental", "eye", "immunisation", "school_own",
}

func (s *Server) saveHealthCamp(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req healthCampRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "the camp needs a name")
		return
	}
	if req.Programme == "" {
		req.Programme = "school_own"
	}
	if !slices.Contains(campProgrammes, req.Programme) {
		httpx.BadRequest(w, r, "unknown programme "+req.Programme)
		return
	}
	if req.Date == "" {
		req.Date = indiaToday()
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO health_camps (institution_id, name, programme, agency,
			                          doctor_lead, on_date, ends_on, venue, notes)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6::date,
			        NULLIF($7,'')::date,NULLIF($8,''),NULLIF($9,''))
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.Programme, req.Agency, req.DoctorLead,
			req.Date, req.EndsOn, req.Venue, req.Notes).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "name": req.Name})
}

type campAttendanceRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Class       *string `json:"class_name,omitempty"`
	Findings    *string `json:"findings,omitempty"`
	Treatment   *string `json:"treatment_given,omitempty"`
	Referred    bool    `json:"referred"`
	ReferredTo  *string `json:"referred_to,omitempty"`
	FollowUpOn  *string `json:"follow_up_on,omitempty"`
	FollowedUp  bool    `json:"followed_up"`
	FollowUpNot *string `json:"follow_up_note,omitempty"`
	// A referral whose follow-up date has passed with nothing recorded. The
	// only red row on the screen.
	Overdue bool `json:"follow_up_overdue"`
}

func (s *Server) listCampAttendance(w http.ResponseWriter, r *http.Request) {
	camp, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid camp id")
		return
	}
	items, err := collect(s, r, `
		SELECT a.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       NULLIF(concat_ws('-', c.name, sec.name), ''),
		       a.findings, a.treatment_given, a.referred, a.referred_to,
		       to_char(a.follow_up_on,'YYYY-MM-DD'),
		       a.follow_up_done_at IS NOT NULL, a.follow_up_note,
		       a.referred AND a.follow_up_done_at IS NULL
		           AND a.follow_up_on IS NOT NULL AND a.follow_up_on < $2::date
		  FROM health_camp_attendance a
		  JOIN students st ON st.id = a.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE a.camp_id = $1
		 -- Referrals still open first: they are the reason to open this list.
		 ORDER BY (a.referred AND a.follow_up_done_at IS NULL) DESC,
		          a.follow_up_on NULLS LAST, st.admission_no
		 LIMIT 500`, []any{camp, indiaToday()},
		func(rows pgx.Rows) (campAttendanceRow, error) {
			var v campAttendanceRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Class, &v.Findings, &v.Treatment, &v.Referred, &v.ReferredTo,
				&v.FollowUpOn, &v.FollowedUp, &v.FollowUpNot, &v.Overdue)
		})
	respond(w, r, items, err)
}

type campAttendanceRequest struct {
	StudentID  string `json:"student_id"`
	Findings   string `json:"findings,omitempty"`
	Treatment  string `json:"treatment_given,omitempty"`
	Referred   bool   `json:"referred,omitempty"`
	ReferredTo string `json:"referred_to,omitempty"`
	FollowUpOn string `json:"follow_up_on,omitempty"`
	// Set when closing a referral out.
	FollowedUp   bool   `json:"followed_up,omitempty"`
	FollowUpNote string `json:"follow_up_note,omitempty"`
}

/*
recordCampAttendance notes one child seen at one camp.

	An upsert on the camp and the child: a screening team calls a child back to
	recheck a reading, and the second look corrects the first rather than
	creating a second child. Closing the referral out later comes through the
	same door, which is why followed_up is a field and not a separate endpoint.
*/
func (s *Server) recordCampAttendance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	camp, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid camp id")
		return
	}
	var req campAttendanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Referred && strings.TrimSpace(req.ReferredTo) == "" {
		httpx.BadRequest(w, r, "name where the child was referred — a referral to nobody is not a referral")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO health_camp_attendance
			    (institution_id, camp_id, student_id, findings, treatment_given,
			     referred, referred_to, follow_up_on, follow_up_done_at, follow_up_note)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,NULLIF($7,''),
			        NULLIF($8,'')::date, CASE WHEN $9 THEN now() END, NULLIF($10,''))
			ON CONFLICT (camp_id, student_id) DO UPDATE
			   SET findings        = COALESCE(EXCLUDED.findings, health_camp_attendance.findings),
			       treatment_given = COALESCE(EXCLUDED.treatment_given, health_camp_attendance.treatment_given),
			       referred        = EXCLUDED.referred,
			       referred_to     = COALESCE(EXCLUDED.referred_to, health_camp_attendance.referred_to),
			       follow_up_on    = COALESCE(EXCLUDED.follow_up_on, health_camp_attendance.follow_up_on),
			       -- Only ever set, never cleared: a follow-up that happened
			       -- did happen, and unticking a box does not undo the visit.
			       follow_up_done_at = COALESCE(health_camp_attendance.follow_up_done_at,
			                                    EXCLUDED.follow_up_done_at),
			       follow_up_note  = COALESCE(EXCLUDED.follow_up_note, health_camp_attendance.follow_up_note)
			RETURNING id::text`,
			id.InstitutionID, camp, student, req.Findings, req.Treatment,
			req.Referred, req.ReferredTo, req.FollowUpOn, req.FollowedUp,
			req.FollowUpNote).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "camp_id": camp.String()})
}

// --- night study roll call --------------------------------------------------------

type nightStudyRow struct {
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Block       string  `json:"block"`
	RoomNo      string  `json:"room_no"`
	ID          *string `json:"id,omitempty"`
	// Empty when nobody has marked this boarder yet, which is the state the
	// screen exists to show.
	Status      string  `json:"status"`
	MinutesLate *int    `json:"minutes_late,omitempty"`
	Remarks     *string `json:"remarks,omitempty"`
	Hall        *string `json:"hall,omitempty"`
	MarkedAt    *string `json:"marked_at,omitempty"`
	MarkedBy    *string `json:"marked_by,omitempty"`
	// A boarder the gate has signed out is not missing from prep; marking them
	// absent would start a search for a child the warden released themselves.
	OnOutpass bool `json:"on_outpass"`
}

/*
listNightStudy is the prep register, every current boarder on it.

	A LEFT JOIN rather than a list of marks, so the sheet arrives with the
	unmarked children on it. A register that shows only what has been ticked
	cannot answer the question a warden asks at nine o'clock, which is who is
	missing.
*/
func (s *Server) listNightStudy(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	if session != "evening" {
		session = "night"
	}
	items, err := collect(s, r, `
		SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, hb.name, hr.room_no,
		       n.id::text, COALESCE(n.status, ''), n.minutes_late, n.remarks,
		       n.hall, to_char(n.marked_at,'YYYY-MM-DD"T"HH24:MI'), u.full_name,
		       EXISTS (SELECT 1 FROM hostel_outpasses o
		                WHERE o.student_id = st.id AND o.status = 'out')
		  FROM hostel_allocations ha
		  JOIN students st ON st.id = ha.student_id
		  JOIN hostel_rooms hr ON hr.id = ha.room_id
		  JOIN hostel_blocks hb ON hb.id = hr.block_id
		  LEFT JOIN night_study_attendance n
		         ON n.student_id = st.id AND n.on_date = $1::date AND n.session = $2
		  LEFT JOIN users u ON u.id = n.marked_by
		 WHERE ha.vacated_on IS NULL
		 ORDER BY hb.name, hr.room_no, st.admission_no
		 LIMIT 1000`, []any{dayOrToday(r), session},
		func(rows pgx.Rows) (nightStudyRow, error) {
			var v nightStudyRow
			return v, rows.Scan(&v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Block, &v.RoomNo, &v.ID, &v.Status, &v.MinutesLate,
				&v.Remarks, &v.Hall, &v.MarkedAt, &v.MarkedBy, &v.OnOutpass)
		})
	respond(w, r, items, err)
}

type nightStudyMark struct {
	StudentID   string `json:"student_id"`
	Status      string `json:"status"`
	MinutesLate *int   `json:"minutes_late,omitempty"`
	Remarks     string `json:"remarks,omitempty"`
}

// nightStudyRequest is a sitting, not a boarder. A warden ticks down the hall
// and saves once; forty separate calls would leave a half-taken register on
// screen the moment one of them failed.
type nightStudyRequest struct {
	Date    string           `json:"on_date,omitempty"`
	Session string           `json:"session,omitempty"`
	Hall    string           `json:"hall,omitempty"`
	Marks   []nightStudyMark `json:"marks"`
}

var nightStudyStatuses = []string{
	"present", "absent", "late", "excused", "sick_bay", "on_outpass",
}

func (s *Server) markNightStudy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req nightStudyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Date == "" {
		req.Date = indiaToday()
	}
	if req.Session == "" {
		req.Session = "night"
	}
	if req.Session != "evening" && req.Session != "night" {
		httpx.BadRequest(w, r, "session must be evening or night")
		return
	}
	if len(req.Marks) == 0 {
		httpx.BadRequest(w, r, "nothing to mark")
		return
	}

	students := make([]uuid.UUID, len(req.Marks))
	for i, m := range req.Marks {
		student, err := uuid.Parse(m.StudentID)
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		students[i] = student
		if !slices.Contains(nightStudyStatuses, m.Status) {
			httpx.BadRequest(w, r, "unknown status "+m.Status)
			return
		}
		// An excusal nobody has to justify is how prep quietly becomes optional.
		if m.Status == "excused" && strings.TrimSpace(m.Remarks) == "" {
			httpx.BadRequest(w, r, "say why "+m.StudentID+" is excused from prep")
			return
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for i, m := range req.Marks {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO night_study_attendance
				    (institution_id, student_id, on_date, session, hall, status,
				     minutes_late, remarks, marked_by)
				VALUES ($1,$2,$3::date,$4,NULLIF($5,''),$6,$7,NULLIF($8,''),$9)
				ON CONFLICT (institution_id, student_id, on_date, session) DO UPDATE
				   SET hall = EXCLUDED.hall, status = EXCLUDED.status,
				       minutes_late = EXCLUDED.minutes_late,
				       remarks = EXCLUDED.remarks,
				       marked_by = EXCLUDED.marked_by, marked_at = now()`,
				id.InstitutionID, students[i], req.Date, req.Session, req.Hall,
				m.Status, m.MinutesLate, m.Remarks, id.UserID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"on_date": req.Date, "session": req.Session, "marked": len(req.Marks)})
}

// --- room inventory checklists ------------------------------------------------------

type roomCheckRow struct {
	ID          string  `json:"id"`
	RoomID      string  `json:"room_id"`
	Block       string  `json:"block"`
	RoomNo      string  `json:"room_no"`
	StudentID   *string `json:"student_id,omitempty"`
	StudentName *string `json:"student_name,omitempty"`
	AdmissionNo *string `json:"admission_no,omitempty"`
	Kind        string  `json:"kind"`
	Date        string  `json:"on_date"`
	CheckedBy   *string `json:"checked_by,omitempty"`
	Signed      bool    `json:"boarder_signed"`
	Remarks     *string `json:"remarks,omitempty"`
	Items       int     `json:"items"`
	Faults      int     `json:"faults"`
	// Total recoverable against the boarder, in paise like every other amount.
	ChargePaise int64 `json:"charge_paise"`
}

func (s *Server) listRoomChecks(w http.ResponseWriter, r *http.Request) {
	room, err := optionalUUID(r.URL.Query().Get("room_id"))
	if err != nil {
		httpx.BadRequest(w, r, "room_id must be a uuid")
		return
	}
	items, err := collect(s, r, `
		SELECT rc.id::text, hr.id::text, hb.name, hr.room_no,
		       st.id::text, NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		       st.admission_no, rc.kind, to_char(rc.on_date,'YYYY-MM-DD'),
		       u.full_name, rc.boarder_signed, rc.remarks,
		       (SELECT count(*) FROM room_inventory_items i
		         WHERE i.check_id = rc.id)::int,
		       (SELECT count(*) FROM room_inventory_items i
		         WHERE i.check_id = rc.id AND i.condition IN ('damaged','missing'))::int,
		       (SELECT COALESCE(sum(i.charge_paise),0) FROM room_inventory_items i
		         WHERE i.check_id = rc.id)::bigint
		  FROM room_inventory_checks rc
		  JOIN hostel_rooms hr ON hr.id = rc.room_id
		  JOIN hostel_blocks hb ON hb.id = hr.block_id
		  LEFT JOIN students st ON st.id = rc.student_id
		  LEFT JOIN users u ON u.id = rc.checked_by
		 WHERE ($1::uuid IS NULL OR rc.room_id = $1::uuid)
		   AND ($2::text IS NULL OR rc.kind = $2)
		 ORDER BY rc.on_date DESC, hb.name, hr.room_no
		 LIMIT 200`, []any{room, nullString(r.URL.Query().Get("kind"))},
		func(rows pgx.Rows) (roomCheckRow, error) {
			var v roomCheckRow
			return v, rows.Scan(&v.ID, &v.RoomID, &v.Block, &v.RoomNo, &v.StudentID,
				&v.StudentName, &v.AdmissionNo, &v.Kind, &v.Date, &v.CheckedBy,
				&v.Signed, &v.Remarks, &v.Items, &v.Faults, &v.ChargePaise)
		})
	respond(w, r, items, err)
}

type roomCheckItemRow struct {
	ID          string  `json:"id"`
	Item        string  `json:"item"`
	Expected    int     `json:"expected"`
	Found       int     `json:"found"`
	Condition   string  `json:"condition"`
	DamageNote  *string `json:"damage_note,omitempty"`
	ChargePaise int64   `json:"charge_paise"`
}

func (s *Server) listRoomCheckItems(w http.ResponseWriter, r *http.Request) {
	check, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid check id")
		return
	}
	items, err := collect(s, r, `
		SELECT id::text, item, expected, found, condition, damage_note, charge_paise
		  FROM room_inventory_items
		 WHERE check_id = $1
		 ORDER BY lower(item)`, []any{check},
		func(rows pgx.Rows) (roomCheckItemRow, error) {
			var v roomCheckItemRow
			return v, rows.Scan(&v.ID, &v.Item, &v.Expected, &v.Found,
				&v.Condition, &v.DamageNote, &v.ChargePaise)
		})
	respond(w, r, items, err)
}

type roomCheckItem struct {
	Item        string `json:"item"`
	Expected    int    `json:"expected"`
	Found       int    `json:"found"`
	Condition   string `json:"condition,omitempty"`
	DamageNote  string `json:"damage_note,omitempty"`
	ChargePaise int64  `json:"charge_paise,omitempty"`
}

type roomCheckRequest struct {
	RoomID string `json:"room_id"`
	// Absent for a walk of an empty room between terms, which is a real thing
	// a warden does and not something to blame a child for.
	StudentID string          `json:"student_id,omitempty"`
	Kind      string          `json:"kind"`
	Date      string          `json:"on_date,omitempty"`
	Signed    bool            `json:"boarder_signed,omitempty"`
	Remarks   string          `json:"remarks,omitempty"`
	Items     []roomCheckItem `json:"items"`
}

var (
	roomCheckKinds  = []string{"check_in", "check_out", "routine"}
	itemConditions  = []string{"good", "worn", "damaged", "missing"}
	errChargeNoNote = errors.New("a charge needs a line saying what was broken; a family cannot be billed for a number")
)

/*
saveRoomCheck writes one inspection and its whole checklist together.

	The lines are replaced rather than merged, because a checklist is written in
	one sitting with the boarder standing in the doorway; merging would leave
	last term's broken chair on this term's sheet. The upsert is on the same key
	as the unique index, so walking the same room twice in a day corrects the
	morning's list rather than filing a second one.
*/
func (s *Server) saveRoomCheck(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req roomCheckRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	room, err := uuid.Parse(req.RoomID)
	if err != nil {
		httpx.BadRequest(w, r, "room_id must be a uuid")
		return
	}
	if !slices.Contains(roomCheckKinds, req.Kind) {
		httpx.BadRequest(w, r, "kind must be check_in, check_out or routine")
		return
	}
	if req.Date == "" {
		req.Date = indiaToday()
	}
	for i := range req.Items {
		it := &req.Items[i]
		if strings.TrimSpace(it.Item) == "" {
			httpx.BadRequest(w, r, "every line needs the name of the thing checked")
			return
		}
		if it.Condition == "" {
			it.Condition = "good"
		}
		if !slices.Contains(itemConditions, it.Condition) {
			httpx.BadRequest(w, r, "unknown condition "+it.Condition)
			return
		}
		if it.Expected == 0 {
			it.Expected = 1
		}
		if it.Found > it.Expected {
			httpx.BadRequest(w, r, "more "+it.Item+" found than the room is meant to have")
			return
		}
		if it.ChargePaise > 0 && strings.TrimSpace(it.DamageNote) == "" {
			httpx.BadRequest(w, r, errChargeNoNote.Error())
			return
		}
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO room_inventory_checks
			    (institution_id, room_id, student_id, kind, on_date, checked_by,
			     boarder_signed, remarks)
			VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5::date,$6,$7,NULLIF($8,''))
			ON CONFLICT (institution_id, room_id,
			             COALESCE(student_id,'00000000-0000-0000-0000-000000000000'::uuid),
			             kind, on_date)
			DO UPDATE SET checked_by = EXCLUDED.checked_by,
			              boarder_signed = EXCLUDED.boarder_signed,
			              remarks = EXCLUDED.remarks
			RETURNING id::text`,
			id.InstitutionID, room, req.StudentID, req.Kind, req.Date,
			id.UserID, req.Signed, req.Remarks).Scan(&newID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM room_inventory_items WHERE check_id = $1`, newID); err != nil {
			return err
		}
		for _, it := range req.Items {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO room_inventory_items
				    (institution_id, check_id, item, expected, found, condition,
				     damage_note, charge_paise)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8)`,
				id.InstitutionID, newID, it.Item, it.Expected, it.Found,
				it.Condition, it.DamageNote, it.ChargePaise); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "items": len(req.Items)})
}

// --- the hostel visitor log -----------------------------------------------------------

type hostelVisitRow struct {
	ID           string  `json:"id"`
	PassNo       string  `json:"pass_no"`
	VisitorName  string  `json:"visitor_name"`
	Phone        *string `json:"phone,omitempty"`
	Relationship string  `json:"relationship"`
	StudentID    string  `json:"student_id"`
	StudentName  string  `json:"student_name"`
	AdmissionNo  string  `json:"admission_no"`
	Block        *string `json:"block,omitempty"`
	RoomNo       *string `json:"room_no,omitempty"`
	InAt         string  `json:"in_at"`
	OutAt        *string `json:"out_at,omitempty"`
	MetIn        *string `json:"met_in,omitempty"`
	Released     bool    `json:"boarder_released"`
	ExpectedBack *string `json:"expected_back,omitempty"`
	ReturnedAt   *string `json:"returned_at,omitempty"`
	PermittedBy  *string `json:"permitted_by,omitempty"`
	OnSite       bool    `json:"on_site"`
	// A boarder released to a relative and past the hour they were due back.
	// The only red row here, and the reason the log is worth keeping.
	Overdue bool    `json:"overdue"`
	Remarks *string `json:"remarks,omitempty"`
}

func (s *Server) listHostelVisits(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT hv.id::text, v.pass_no, v.full_name, v.phone, hv.relationship,
		       st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, hb.name, hr.room_no,
		       to_char(v.in_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(v.out_at,'YYYY-MM-DD"T"HH24:MI'),
		       hv.met_in, hv.boarder_released,
		       to_char(hv.expected_back,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(hv.returned_at,'YYYY-MM-DD"T"HH24:MI'),
		       up.full_name, v.out_at IS NULL,
		       hv.boarder_released AND hv.returned_at IS NULL
		           AND hv.expected_back < now(),
		       hv.remarks
		  FROM hostel_visits hv
		  JOIN visitors v ON v.id = hv.visitor_id
		  JOIN students st ON st.id = hv.student_id
		  LEFT JOIN hostel_allocations ha
		         ON ha.student_id = hv.student_id AND ha.vacated_on IS NULL
		  LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
		  LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
		  LEFT JOIN users up ON up.id = hv.permitted_by
		 WHERE ($1::bool IS TRUE OR v.on_date = $2::date)
		   AND ($3::bool IS NOT TRUE OR v.out_at IS NULL)
		 -- Still on the premises first, then the rest of the day backwards.
		 ORDER BY (v.out_at IS NULL) DESC, v.in_at DESC
		 LIMIT 200`,
		[]any{r.URL.Query().Get("all") == "true", dayOrToday(r),
			r.URL.Query().Get("on_site") == "true"},
		func(rows pgx.Rows) (hostelVisitRow, error) {
			var v hostelVisitRow
			return v, rows.Scan(&v.ID, &v.PassNo, &v.VisitorName, &v.Phone,
				&v.Relationship, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Block, &v.RoomNo, &v.InAt, &v.OutAt, &v.MetIn, &v.Released,
				&v.ExpectedBack, &v.ReturnedAt, &v.PermittedBy, &v.OnSite,
				&v.Overdue, &v.Remarks)
		})
	respond(w, r, items, err)
}

type hostelVisitRequest struct {
	StudentID    string `json:"student_id"`
	Name         string `json:"full_name"`
	Relationship string `json:"relationship"`
	Phone        string `json:"phone,omitempty"`
	IDType       string `json:"id_type,omitempty"`
	IDLast4      string `json:"id_last4,omitempty"`
	MetIn        string `json:"met_in,omitempty"`
	// The boarder physically left with them, rather than sitting in the
	// parlour. The difference between a visit and a collection.
	Released     bool   `json:"boarder_released,omitempty"`
	ExpectedBack string `json:"expected_back,omitempty"`
	Remarks      string `json:"remarks,omitempty"`
}

var (
	errHostelVisitorBlocked = errors.New(
		"this visitor is on the school's block list and must not be admitted or given a boarder")
	errReleaseNeedsTime = errors.New(
		"say when the boarder is due back — a child let off the premises with no hour named is discovered missing at lights-out")
)

/*
signHostelVisitorIn admits a relative and, if the warden allows it, releases
the boarder into their care.

	The gate pass goes into visitors, the same table the front desk writes to,
	and this is deliberate. A warden signing in a boarder's uncle at six in the
	evening is the same physical event as reception signing in a supplier at
	eleven in the morning, and a school needs one answer to "who is inside" and
	one block list. Two registers would mean a relative barred by a custody
	order refused at the gate and admitted at the hostel — which is the exact
	failure the block list was built for.

	The block list is therefore re-checked here rather than assumed. It is the
	same query the front desk runs; repeating a read is not a second source of
	truth, and skipping it would be.
*/
func (s *Server) signHostelVisitorIn(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req hostelVisitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Relationship) == "" {
		httpx.BadRequest(w, r, "name the visitor and how they are related to the boarder")
		return
	}
	if req.Released && req.ExpectedBack == "" {
		httpx.BadRequest(w, r, errReleaseNeedsTime.Error())
		return
	}

	var newID, pass, blocked string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(max(reason), '')
			  FROM visitor_blocklist
			 WHERE lower(full_name) = lower($1)
			   AND (phone IS NULL OR $2 = '' OR phone = $2)
			   AND effective_from <= current_date
			   AND (effective_to IS NULL OR effective_to >= current_date)`,
			req.Name, req.Phone).Scan(&blocked); err != nil {
			return err
		}
		if blocked != "" {
			return errHostelVisitorBlocked
		}

		var visitorID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO visitors
			    (institution_id, pass_no, full_name, phone, id_type, id_last4,
			     purpose, student_id, issued_by, remarks)
			SELECT $1,
			       -- The day's next pass number, allocated inside the
			       -- transaction so the hostel and the front desk cannot hand
			       -- out the same one at the same moment.
			       lpad((COALESCE(max(v.pass_no::int), 0) + 1)::text, 3, '0'),
			       $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''),
			       'Hostel visit', $6, $7, NULLIF($8,'')
			  FROM visitors v
			 WHERE v.institution_id = $1 AND v.on_date = current_date
			   AND v.pass_no ~ '^[0-9]+$'
			RETURNING id::text, pass_no`,
			id.InstitutionID, req.Name, req.Phone, req.IDType, req.IDLast4,
			student, id.UserID, req.Remarks).Scan(&visitorID, &pass); err != nil {
			return err
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO hostel_visits
			    (institution_id, visitor_id, student_id, relationship, permitted_by,
			     met_in, boarder_released, expected_back, remarks)
			VALUES ($1,$2::uuid,$3,$4,$5,NULLIF($6,''),$7,
			        NULLIF($8,'')::timestamptz,NULLIF($9,''))
			RETURNING id::text`,
			id.InstitutionID, visitorID, student, req.Relationship, id.UserID,
			req.MetIn, req.Released, req.ExpectedBack, req.Remarks).Scan(&newID)
	})
	switch {
	case errors.Is(err, errHostelVisitorBlocked):
		httpx.Error(w, r, http.StatusConflict, "visitor_blocked", errHostelVisitorBlocked.Error())
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "pass_no": pass})
}

/*
signHostelVisitorOut closes the visit.

	Two facts, not one: the visitor leaving the premises and the boarder coming
	back. They are usually the same moment and occasionally are not — a child
	dropped at the gate an hour after the uncle drove off — so the return is
	only stamped on a boarder who was actually released.
*/
func (s *Server) signHostelVisitorOut(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	visitID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid visit id")
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE hostel_visits hv
			   SET returned_at = CASE WHEN hv.boarder_released
			                          THEN COALESCE(hv.returned_at, now()) END
			 WHERE hv.id = $1`, visitID)
		if err != nil {
			return err
		}
		found = tag.RowsAffected() > 0
		if !found {
			return nil
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE visitors v
			   SET out_at = COALESCE(v.out_at, now()), closed_by = $2
			  FROM hostel_visits hv
			 WHERE hv.id = $1 AND v.id = hv.visitor_id`, visitID, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": visitID.String(), "status": "closed"})
}

// --- laundry -----------------------------------------------------------------------

type laundryRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Block       *string `json:"block,omitempty"`
	RoomNo      *string `json:"room_no,omitempty"`
	TokenNo     string  `json:"token_no"`
	Vendor      *string `json:"vendor,omitempty"`
	SentOn      string  `json:"sent_on"`
	DueOn       *string `json:"due_on,omitempty"`
	ItemsSent   int     `json:"items_sent"`
	Detail      *string `json:"item_detail,omitempty"`
	ReturnedOn  *string `json:"returned_on,omitempty"`
	ItemsBack   *int    `json:"items_returned,omitempty"`
	Status      string  `json:"status"`
	ChargePaise int64   `json:"charge_paise"`
	DamageNote  *string `json:"damage_note,omitempty"`
	// Out past its due date. The bundle a warden has to chase the vendor about.
	Overdue bool `json:"overdue"`
}

func (s *Server) listLaundry(w http.ResponseWriter, r *http.Request) {
	student, err := optionalUUID(r.URL.Query().Get("student_id"))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	items, err := collect(s, r, `
		SELECT l.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       hb.name, hr.room_no, l.token_no, l.vendor,
		       to_char(l.sent_on,'YYYY-MM-DD'), to_char(l.due_on,'YYYY-MM-DD'),
		       l.items_sent, l.item_detail, to_char(l.returned_on,'YYYY-MM-DD'),
		       l.items_returned, l.status, l.charge_paise, l.damage_note,
		       l.status = 'sent' AND l.due_on IS NOT NULL AND l.due_on < $3::date
		  FROM hostel_laundry l
		  JOIN students st ON st.id = l.student_id
		  LEFT JOIN hostel_allocations ha
		         ON ha.student_id = l.student_id AND ha.vacated_on IS NULL
		  LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
		  LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
		 WHERE ($1::uuid IS NULL OR l.student_id = $1::uuid)
		   AND ($2::text IS NULL OR l.status = $2)
		 -- Still out first, oldest first: the bundle nobody has chased.
		 ORDER BY (l.status = 'sent') DESC, l.sent_on DESC
		 LIMIT 300`,
		[]any{student, nullString(r.URL.Query().Get("status")), indiaToday()},
		func(rows pgx.Rows) (laundryRow, error) {
			var v laundryRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.Block, &v.RoomNo, &v.TokenNo, &v.Vendor, &v.SentOn, &v.DueOn,
				&v.ItemsSent, &v.Detail, &v.ReturnedOn, &v.ItemsBack, &v.Status,
				&v.ChargePaise, &v.DamageNote, &v.Overdue)
		})
	respond(w, r, items, err)
}

type laundrySendRequest struct {
	StudentID string `json:"student_id"`
	TokenNo   string `json:"token_no"`
	Vendor    string `json:"vendor,omitempty"`
	SentOn    string `json:"sent_on,omitempty"`
	DueOn     string `json:"due_on,omitempty"`
	Items     int    `json:"items_sent"`
	Detail    string `json:"item_detail,omitempty"`
	Charge    int64  `json:"charge_paise,omitempty"`
}

func (s *Server) sendLaundry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req laundrySendRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.TokenNo) == "" {
		httpx.BadRequest(w, r, "the bundle needs the token number handed to the boarder")
		return
	}
	if req.Items <= 0 {
		httpx.BadRequest(w, r, "count the items going out — a bundle with no count settles no argument")
		return
	}
	if req.SentOn == "" {
		req.SentOn = indiaToday()
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO hostel_laundry
			    (institution_id, student_id, token_no, vendor, sent_on, due_on,
			     items_sent, item_detail, charge_paise, recorded_by)
			VALUES ($1,$2,$3,NULLIF($4,''),$5::date,NULLIF($6,'')::date,$7,
			        NULLIF($8,''),$9,$10)
			RETURNING id::text`,
			id.InstitutionID, student, req.TokenNo, req.Vendor, req.SentOn,
			req.DueOn, req.Items, req.Detail, req.Charge, id.UserID).Scan(&newID)
	})
	if isUniqueViolation(err) {
		// The token is on a physical tag the boarder keeps. Two bundles under
		// one number on one day is the only way this register loses a blazer.
		httpx.Error(w, r, http.StatusConflict, "token_in_use",
			"token "+req.TokenNo+" is already on a bundle sent today")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "token_no": req.TokenNo})
}

var (
	errShortNeedsNote = errors.New(
		"say what is missing — a bundle counted back short with no note is an argument the warden loses next week")
	errMoreBackThanSent = errors.New("more came back than was ever sent out")
)

type laundryReturnRequest struct {
	ItemsReturned int    `json:"items_returned"`
	ReturnedOn    string `json:"returned_on,omitempty"`
	DamageNote    string `json:"damage_note,omitempty"`
	Charge        *int64 `json:"charge_paise,omitempty"`
}

/*
returnLaundry counts a bundle back in.

	The status is worked out from the count rather than sent by the client. A
	warden who returns nine of ten shirts and ticks "returned" has recorded the
	opposite of what happened, and the missing shirt is the only thing anybody
	will ask about.
*/
func (s *Server) returnLaundry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid laundry id")
		return
	}
	var req laundryReturnRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ItemsReturned < 0 {
		httpx.BadRequest(w, r, "items_returned cannot be negative")
		return
	}
	if req.ReturnedOn == "" {
		req.ReturnedOn = indiaToday()
	}

	var status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Read the count out first and hold the row. The schema refuses a short
		// bundle with no note, and a constraint name is no use to the warden
		// holding nine shirts; this turns it into a sentence before the write.
		var sent int
		if err := tx.QueryRow(r.Context(),
			`SELECT items_sent FROM hostel_laundry WHERE id = $1 FOR UPDATE`,
			batchID).Scan(&sent); err != nil {
			return err
		}
		if req.ItemsReturned > sent {
			return errMoreBackThanSent
		}
		if req.ItemsReturned < sent && strings.TrimSpace(req.DamageNote) == "" {
			return errShortNeedsNote
		}
		return tx.QueryRow(r.Context(), `
			UPDATE hostel_laundry
			   SET returned_on = $2::date,
			       items_returned = $3,
			       -- Derived, never taken on trust: short is short.
			       status = CASE WHEN $3 = 0 THEN 'lost'
			                     WHEN $3 < items_sent THEN 'short'
			                     ELSE 'returned' END,
			       damage_note = NULLIF($4,''),
			       charge_paise = COALESCE($5, charge_paise)
			 WHERE id = $1
			RETURNING status`,
			batchID, req.ReturnedOn, req.ItemsReturned, req.DamageNote, req.Charge).
			Scan(&status)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errShortNeedsNote), errors.Is(err, errMoreBackThanSent):
		httpx.BadRequest(w, r, err.Error())
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": batchID.String(), "status": status})
}
