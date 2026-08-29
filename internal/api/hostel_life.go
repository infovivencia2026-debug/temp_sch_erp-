package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* A warden's day.

   The hostel module could allocate a bed and nothing else. The three things a
   warden does between allocations are letting boarders out, chasing repairs
   and feeding people — and the first is the one a school gets sued over.

   The outpass is deliberately two approvals and two timestamps rather than a
   status flag. The warden permits it, the guardian consents to it, the gate
   records the leaving and the return. A single "approved" boolean cannot
   answer the question that matters at ten at night: who is out, and who said
   they could be. */

// --- outpasses -----------------------------------------------------------------

type outpassRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	Room        *string `json:"room,omitempty"`
	Reason      string  `json:"reason"`
	Destination *string `json:"destination,omitempty"`
	EscortName  *string `json:"escort_name,omitempty"`
	EscortPhone *string `json:"escort_phone,omitempty"`
	ExpectedOut string  `json:"expected_out"`
	ExpectedIn  string  `json:"expected_in"`
	Status      string  `json:"status"`
	ApprovedBy  *string `json:"approved_by,omitempty"`
	ConsentBy   *string `json:"guardian_consent_by,omitempty"`
	ActualOut   *string `json:"actual_out,omitempty"`
	ActualIn    *string `json:"actual_in,omitempty"`
	Note        *string `json:"decision_note,omitempty"`
	// Overdue is the only thing on this screen that should ever be red: a
	// boarder who is out and past the hour they said they would be back.
	Overdue     bool `json:"overdue"`
	OverdueMins int  `json:"overdue_minutes"`
}

// listOutpasses is the warden's board, and a family's own history.
//
// One endpoint, narrowed by who asks: a guardian sees their children's passes,
// the warden sees the block. That is what makes it safe to leave open to
// families, who need to consent to a trip they cannot otherwise see.
func (s *Server) listOutpasses(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	id := httpx.IdentityFrom(r.Context())

	mine := "TRUE"
	args := []any{nullString(r.URL.Query().Get("status"))}
	if !id.Can(rbac.HostelRead) {
		if len(res.StudentIDs) == 0 {
			respond(w, r, []outpassRow{}, nil)
			return
		}
		mine = "o.student_id = ANY($2)"
		args = append(args, res.StudentIDs)
	}

	items, err := collect(s, r, `
		SELECT o.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       hr.room_no, o.reason, o.destination, o.escort_name, o.escort_phone,
		       to_char(o.expected_out,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(o.expected_in,'YYYY-MM-DD"T"HH24:MI'),
		       o.status, ua.full_name, ug.full_name,
		       to_char(o.actual_out,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(o.actual_in,'YYYY-MM-DD"T"HH24:MI'),
		       o.decision_note,
		       o.status = 'out' AND o.expected_in < now(),
		       GREATEST(0, EXTRACT(epoch FROM now() - o.expected_in) / 60)::int
		  FROM hostel_outpasses o
		  JOIN students st ON st.id = o.student_id
		  LEFT JOIN hostel_allocations ha
		         ON ha.student_id = o.student_id AND ha.vacated_on IS NULL
		  LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
		  LEFT JOIN users ua ON ua.id = o.approved_by
		  LEFT JOIN users ug ON ug.id = o.guardian_consent_by
		 WHERE ($1::text IS NULL OR o.status = $1)
		   AND `+mine+`
		 ORDER BY
		   -- Anyone overdue first, then anyone currently out, then the rest.
		   (o.status = 'out' AND o.expected_in < now()) DESC,
		   (o.status = 'out') DESC,
		   o.expected_out DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (outpassRow, error) {
			var v outpassRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.AdmissionNo, &v.Room,
				&v.Reason, &v.Destination, &v.EscortName, &v.EscortPhone,
				&v.ExpectedOut, &v.ExpectedIn, &v.Status, &v.ApprovedBy,
				&v.ConsentBy, &v.ActualOut, &v.ActualIn, &v.Note,
				&v.Overdue, &v.OverdueMins)
		})
	respond(w, r, items, err)
}

type outpassRequest struct {
	StudentID   string `json:"student_id"`
	Reason      string `json:"reason"`
	Destination string `json:"destination,omitempty"`
	EscortName  string `json:"escort_name,omitempty"`
	EscortPhone string `json:"escort_phone,omitempty"`
	ExpectedOut string `json:"expected_out"`
	ExpectedIn  string `json:"expected_in"`
}

func (s *Server) createOutpass(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req outpassRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why the boarder is leaving")
		return
	}
	if req.ExpectedOut == "" || req.ExpectedIn == "" {
		httpx.BadRequest(w, r, "expected_out and expected_in are required")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		if len(res.StudentIDs) == 0 {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		student = res.StudentIDs[0]
	}
	if !res.AllStudents && !res.OwnsStudent(student) && !id.Can(rbac.HostelWrite) {
		httpx.NotFound(w, r)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO hostel_outpasses (institution_id, student_id, requested_by,
			                              reason, destination, escort_name, escort_phone,
			                              expected_out, expected_in)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
			        $8::timestamptz,$9::timestamptz)
			RETURNING id::text`,
			id.InstitutionID, student, id.UserID, req.Reason, req.Destination,
			req.EscortName, req.EscortPhone, req.ExpectedOut, req.ExpectedIn).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": "requested"})
}

type outpassDecision struct {
	// approve | reject | consent | out | in | cancel
	Action string `json:"action"`
	Note   string `json:"note,omitempty"`
}

var (
	errRejectNeedsNote = errors.New("say why it is being refused. A rejection with no reason is an argument the warden has to have twice")
	errNoConsent       = errors.New("the guardian has not consented yet; a warden's permission alone is not enough to let a boarder off campus")
)

/*
decideOutpass moves a pass along.

	The gate cannot mark a boarder out until both the warden has approved and a
	guardian has consented. That order is the whole point of the table: the
	commonest hostel incident is a child leaving on a permission their parents
	were never asked about, and a flag nobody checks would not prevent it.
*/
func (s *Server) decideOutpass(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	passID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid outpass id")
		return
	}
	var req outpassDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Action == "reject" && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, errRejectNeedsNote.Error())
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	staff := id.Can(rbac.HostelWrite)

	// Only the hostel may permit or record movement; only a family may consent.
	switch req.Action {
	case "approve", "reject", "out", "in":
		if !staff {
			httpx.Denied(w, r, "only the hostel can permit or record a boarder's movement")
			return
		}
	case "consent":
		if len(res.StudentIDs) == 0 && !staff {
			httpx.Denied(w, r, "only a guardian can consent to their child leaving")
			return
		}
	case "cancel":
	default:
		httpx.BadRequest(w, r,
			"action must be approve, reject, consent, out, in or cancel")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Action == "consent" && len(res.StudentIDs) > 0 {
			var owned bool
			if err := tx.QueryRow(r.Context(), `
				SELECT student_id = ANY($2) FROM hostel_outpasses WHERE id = $1`,
				passID, res.StudentIDs).Scan(&owned); err != nil {
				return err
			}
			if !owned {
				return errNotYourChild
			}
		}

		if req.Action == "out" {
			var approved, consented bool
			if err := tx.QueryRow(r.Context(), `
				SELECT approved_at IS NOT NULL, guardian_consent_at IS NOT NULL
				  FROM hostel_outpasses WHERE id = $1`, passID).
				Scan(&approved, &consented); err != nil {
				return err
			}
			if !approved || !consented {
				return errNoConsent
			}
		}

		var sql string
		switch req.Action {
		case "approve":
			sql = `UPDATE hostel_outpasses
			          SET status='approved', approved_by=$2, approved_at=now(),
			              decision_note=COALESCE(NULLIF($3,''), decision_note),
			              updated_at=now() WHERE id=$1`
		case "reject":
			sql = `UPDATE hostel_outpasses
			          SET status='rejected', approved_by=$2, approved_at=now(),
			              decision_note=$3, updated_at=now() WHERE id=$1`
		case "consent":
			sql = `UPDATE hostel_outpasses
			          SET guardian_consent_by=$2, guardian_consent_at=now(),
			              decision_note=COALESCE(NULLIF($3,''), decision_note),
			              updated_at=now() WHERE id=$1`
		case "out":
			sql = `UPDATE hostel_outpasses
			          SET status='out', actual_out=now(), gate_by=$2,
			              gate_note=COALESCE(NULLIF($3,''), gate_note),
			              updated_at=now() WHERE id=$1`
		case "in":
			sql = `UPDATE hostel_outpasses
			          SET status='returned', actual_in=now(), gate_by=$2,
			              gate_note=COALESCE(NULLIF($3,''), gate_note),
			              updated_at=now() WHERE id=$1`
		case "cancel":
			sql = `UPDATE hostel_outpasses
			          SET status='cancelled', approved_by=$2,
			              decision_note=COALESCE(NULLIF($3,''), decision_note),
			              updated_at=now() WHERE id=$1`
		}
		tag, err := tx.Exec(r.Context(), sql, passID, id.UserID, req.Note)
		if err == nil && tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return err
	})
	switch {
	case errors.Is(err, errNotYourChild), errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNoConsent):
		httpx.Error(w, r, http.StatusConflict, "no_consent", errNoConsent.Error())
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": passID.String(), "action": req.Action})
}

// --- complaints -------------------------------------------------------------------

type hostelComplaintRow struct {
	ID          string  `json:"id"`
	StudentName *string `json:"student_name,omitempty"`
	Room        *string `json:"room,omitempty"`
	Category    string  `json:"category"`
	Subject     string  `json:"subject"`
	Detail      *string `json:"detail,omitempty"`
	Priority    string  `json:"priority"`
	Status      string  `json:"status"`
	Resolution  *string `json:"resolution,omitempty"`
	CreatedAt   string  `json:"created_at"`
	OpenDays    int     `json:"open_days"`
}

func (s *Server) listHostelComplaints(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT hc.id::text, concat_ws(' ', st.first_name, st.last_name), hr.room_no,
		       hc.category, hc.subject, hc.detail, hc.priority, hc.status,
		       hc.resolution, to_char(hc.created_at,'YYYY-MM-DD'),
		       EXTRACT(day FROM now() - hc.created_at)::int
		  FROM hostel_complaints hc
		  LEFT JOIN students st ON st.id = hc.student_id
		  LEFT JOIN hostel_rooms hr ON hr.id = hc.room_id
		 WHERE ($1::text IS NULL OR hc.status = $1)
		 ORDER BY
		   CASE hc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
		                    WHEN 'normal' THEN 2 ELSE 3 END,
		   hc.created_at
		 LIMIT 200`, []any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (hostelComplaintRow, error) {
			var v hostelComplaintRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.Room, &v.Category, &v.Subject,
				&v.Detail, &v.Priority, &v.Status, &v.Resolution, &v.CreatedAt, &v.OpenDays)
		})
	respond(w, r, items, err)
}

type complaintRequest struct {
	StudentID string `json:"student_id,omitempty"`
	RoomID    string `json:"room_id,omitempty"`
	Category  string `json:"category,omitempty"`
	Subject   string `json:"subject"`
	Detail    string `json:"detail,omitempty"`
	Priority  string `json:"priority,omitempty"`
	// Set when resolving an existing one.
	Status     string `json:"status,omitempty"`
	Resolution string `json:"resolution,omitempty"`
}

func (s *Server) raiseHostelComplaint(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req complaintRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Subject) == "" {
		httpx.BadRequest(w, r, "the complaint needs a subject")
		return
	}
	if req.Category == "" {
		req.Category = "other"
	}
	if req.Priority == "" {
		req.Priority = "normal"
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO hostel_complaints (institution_id, student_id, room_id, raised_by,
			                               category, subject, detail, priority)
			VALUES ($1,NULLIF($2,'')::uuid,NULLIF($3,'')::uuid,$4,$5,$6,NULLIF($7,''),$8)
			RETURNING id::text`,
			id.InstitutionID, req.StudentID, req.RoomID, id.UserID,
			req.Category, req.Subject, req.Detail, req.Priority).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": "open"})
}

// resolveHostelComplaint closes one out. The schema refuses a resolved
// complaint with no resolution, so the boarder is always told what was done.
func (s *Server) resolveHostelComplaint(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid complaint id")
		return
	}
	var req complaintRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status == "" {
		req.Status = "resolved"
	}
	if (req.Status == "resolved" || req.Status == "closed") &&
		strings.TrimSpace(req.Resolution) == "" {
		httpx.BadRequest(w, r, "say what was done. A complaint closed silently is one raised again next week")
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE hostel_complaints
			   SET status = $2, resolution = NULLIF($3,''),
			       resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() END,
			       updated_at = now()
			 WHERE id = $1`, cid, req.Status, req.Resolution)
		found = err == nil && tag.RowsAffected() > 0
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
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid.String(), "status": req.Status})
}

// --- mess ---------------------------------------------------------------------------

type messRow struct {
	ID     string  `json:"id"`
	Date   string  `json:"on_date"`
	Meal   string  `json:"meal"`
	Items  string  `json:"items"`
	Served *int    `json:"served_count,omitempty"`
	Notes  *string `json:"notes,omitempty"`
}

func (s *Server) listMessMenu(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT id::text, to_char(on_date,'YYYY-MM-DD'), meal, items, served_count, notes
		  FROM mess_menus
		 WHERE on_date BETWEEN $1 AND $2
		 ORDER BY on_date,
		   CASE meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1
		             WHEN 'snacks' THEN 2 ELSE 3 END`,
		[]any{rng.From, rng.To},
		func(rows pgx.Rows) (messRow, error) {
			var v messRow
			return v, rows.Scan(&v.ID, &v.Date, &v.Meal, &v.Items, &v.Served, &v.Notes)
		})
	respond(w, r, items, err)
}

// The meals a hostel serves, in the order the day runs. Checked here as well
// as by the table constraint so a typo comes back as a sentence rather than a
// constraint name.
var mealNames = []string{"breakfast", "lunch", "snacks", "dinner"}

type messMeal struct {
	Meal   string `json:"meal"`
	Items  string `json:"items"`
	Served *int   `json:"served_count,omitempty"`
	Notes  string `json:"notes,omitempty"`
}

// messRequest is a day, not a meal. A warden writes the board for tomorrow in
// one sitting; four separate saves would leave a half-written day on screen if
// the third one failed.
type messRequest struct {
	Date  string     `json:"on_date"`
	Meals []messMeal `json:"meals"`
}

func (s *Server) setMessMenu(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req messRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Date == "" {
		httpx.BadRequest(w, r, "on_date is required")
		return
	}
	for _, m := range req.Meals {
		if !slices.Contains(mealNames, m.Meal) {
			httpx.BadRequest(w, r, "unknown meal "+m.Meal)
			return
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, m := range req.Meals {
			// An emptied box means the meal is not being served, which is a
			// real thing to say on a fast day. Blanking it removes the row
			// rather than storing an empty menu.
			if strings.TrimSpace(m.Items) == "" {
				if _, err := tx.Exec(r.Context(),
					`DELETE FROM mess_menus WHERE institution_id=$1 AND on_date=$2::date AND meal=$3`,
					id.InstitutionID, req.Date, m.Meal); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO mess_menus (institution_id, on_date, meal, items, served_count, notes)
				VALUES ($1,$2::date,$3,$4,$5,NULLIF($6,''))
				ON CONFLICT (institution_id, on_date, meal)
				DO UPDATE SET items = EXCLUDED.items,
				              served_count = EXCLUDED.served_count,
				              notes = EXCLUDED.notes`,
				id.InstitutionID, req.Date, m.Meal, m.Items, m.Served, m.Notes); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"on_date": req.Date, "meals": len(req.Meals)})
}
