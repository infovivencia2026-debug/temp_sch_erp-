package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The front desk.

   Who came in, who rang, what arrived in the post, and who is booked to see
   the principal. Every one of these is a paper register in most Indian
   schools, and every one is asked for after something has gone wrong: who
   signed that man in, who took the call about the fee, where the board's
   envelope went. */

// --- visitors -------------------------------------------------------------

type visitorRow struct {
	ID       string  `json:"id"`
	PassNo   string  `json:"pass_no"`
	Name     string  `json:"full_name"`
	Phone    *string `json:"phone,omitempty"`
	IDType   *string `json:"id_type,omitempty"`
	IDLast4  *string `json:"id_last4,omitempty"`
	Purpose  string  `json:"purpose"`
	Host     *string `json:"host,omitempty"`
	Student  *string `json:"student,omitempty"`
	Vehicle  *string `json:"vehicle_no,omitempty"`
	InAt     string  `json:"in_at"`
	OutAt    *string `json:"out_at,omitempty"`
	IssuedBy *string `json:"issued_by,omitempty"`
	// Minutes on the premises, still counting for anyone who has not signed
	// out. The number the desk sorts by at closing time.
	Minutes int  `json:"minutes_on_site"`
	Inside  bool `json:"inside"`
}

func (s *Server) listVisitors(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT v.id::text, v.pass_no, v.full_name, v.phone, v.id_type, v.id_last4,
		       v.purpose,
		       NULLIF(concat_ws(' ', e.first_name, e.last_name), ''),
		       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		       v.vehicle_no,
		       to_char(v.in_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(v.out_at,'YYYY-MM-DD"T"HH24:MI'),
		       u.full_name,
		       (EXTRACT(epoch FROM COALESCE(v.out_at, now()) - v.in_at) / 60)::int,
		       v.out_at IS NULL
		  FROM visitors v
		  LEFT JOIN employees e ON e.id = v.host_employee_id
		  LEFT JOIN students st ON st.id = v.student_id
		  LEFT JOIN users u ON u.id = v.issued_by
		 WHERE v.on_date = COALESCE(NULLIF($1,'')::date, current_date)
		   AND ($2::bool IS NOT TRUE OR v.out_at IS NULL)
		 -- Still inside first, longest first. Both are the desk's own order.
		 ORDER BY (v.out_at IS NULL) DESC, v.in_at
		 LIMIT 300`,
		[]any{q.Get("on_date"), q.Get("inside") == "true"},
		func(rows pgx.Rows) (visitorRow, error) {
			var v visitorRow
			return v, rows.Scan(&v.ID, &v.PassNo, &v.Name, &v.Phone, &v.IDType,
				&v.IDLast4, &v.Purpose, &v.Host, &v.Student, &v.Vehicle,
				&v.InAt, &v.OutAt, &v.IssuedBy, &v.Minutes, &v.Inside)
		})
	respond(w, r, items, err)
}

type visitorRequest struct {
	Name      string `json:"full_name"`
	Phone     string `json:"phone,omitempty"`
	IDType    string `json:"id_type,omitempty"`
	IDLast4   string `json:"id_last4,omitempty"`
	Purpose   string `json:"purpose"`
	HostID    string `json:"host_employee_id,omitempty"`
	StudentID string `json:"student_id,omitempty"`
	Vehicle   string `json:"vehicle_no,omitempty"`
	Remarks   string `json:"remarks,omitempty"`
}

var errVisitorBlocked = errors.New("visitor is on the block list")

/*
signVisitorIn issues a gate pass.

	The block list is checked here rather than left to the receptionist's
	memory, because the case it exists for — a parent barred by a custody order
	— is exactly the case where the person at the desk is being told a
	convincing story.

	The pass number is allocated inside the transaction as the next one for the
	day, so two people at two counters cannot hand out the same number.
*/
func (s *Server) signVisitorIn(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req visitorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Purpose) == "" {
		httpx.BadRequest(w, r, "a pass needs a name and why they are here")
		return
	}

	var pass, newID, blockReason string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(max(reason), '')
			  FROM visitor_blocklist
			 WHERE lower(full_name) = lower($1)
			   AND (phone IS NULL OR $2 = '' OR phone = $2)
			   AND effective_from <= current_date
			   AND (effective_to IS NULL OR effective_to >= current_date)`,
			req.Name, req.Phone).Scan(&blockReason); err != nil {
			return err
		}
		if blockReason != "" {
			return errVisitorBlocked
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO visitors
			    (institution_id, pass_no, full_name, phone, id_type, id_last4,
			     purpose, host_employee_id, student_id, vehicle_no, remarks, issued_by)
			SELECT $1,
			       -- The day's next pass number, allocated inside the
			       -- transaction so two counters cannot issue the same one.
			       lpad((COALESCE(max(v.pass_no::int), 0) + 1)::text, 3, '0'),
			       $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6,
			       NULLIF($7,'')::uuid, NULLIF($8,'')::uuid, NULLIF($9,''),
			       NULLIF($10,''), $11
			  FROM visitors v
			 WHERE v.institution_id = $1 AND v.on_date = current_date
			   AND v.pass_no ~ '^[0-9]+$'
			RETURNING id::text, pass_no`,
			id.InstitutionID, req.Name, req.Phone, req.IDType, req.IDLast4,
			req.Purpose, req.HostID, req.StudentID, req.Vehicle, req.Remarks,
			id.UserID).Scan(&newID, &pass)
	})
	if errors.Is(err, errVisitorBlocked) {
		httpx.Error(w, r, http.StatusConflict, "blocked",
			"this person is on the block list: "+blockReason)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "pass_no": pass})
}

func (s *Server) signVisitorOut(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	visitorID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid visitor id")
		return
	}
	var minutes int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE visitors SET out_at = now(), closed_by = $2
			 WHERE id = $1 AND out_at IS NULL
			 RETURNING (EXTRACT(epoch FROM now() - in_at) / 60)::int`,
			visitorID, id.UserID).Scan(&minutes)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "already_out",
			"that pass has already been closed")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"minutes_on_site": minutes})
}

type blockRow struct {
	ID      string  `json:"id"`
	Name    string  `json:"full_name"`
	Phone   *string `json:"phone,omitempty"`
	Reason  string  `json:"reason"`
	From    string  `json:"effective_from"`
	To      *string `json:"effective_to,omitempty"`
	AddedBy *string `json:"added_by,omitempty"`
	InForce bool    `json:"in_force"`
}

func (s *Server) listBlocklist(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT b.id::text, b.full_name, b.phone, b.reason,
		       to_char(b.effective_from,'YYYY-MM-DD'),
		       to_char(b.effective_to,'YYYY-MM-DD'), u.full_name,
		       b.effective_from <= current_date
		         AND (b.effective_to IS NULL OR b.effective_to >= current_date)
		  FROM visitor_blocklist b
		  LEFT JOIN users u ON u.id = b.added_by
		 ORDER BY b.created_at DESC LIMIT 200`, nil,
		func(rows pgx.Rows) (blockRow, error) {
			var v blockRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Phone, &v.Reason, &v.From,
				&v.To, &v.AddedBy, &v.InForce)
		})
	respond(w, r, items, err)
}

type blockRequest struct {
	Name    string `json:"full_name"`
	Phone   string `json:"phone,omitempty"`
	IDLast4 string `json:"id_last4,omitempty"`
	Reason  string `json:"reason"`
	From    string `json:"effective_from,omitempty"`
	To      string `json:"effective_to,omitempty"`
}

func (s *Server) addToBlocklist(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req blockRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r,
			"a block needs a name and a reason — a list nobody can defend is worse than none")
		return
	}
	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO visitor_blocklist
			    (institution_id, full_name, phone, id_last4, reason,
			     effective_from, effective_to, added_by)
			VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,
			        COALESCE(NULLIF($6,'')::date, current_date),
			        NULLIF($7,'')::date, $8)
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.Phone, req.IDLast4, req.Reason,
			req.From, req.To, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- appointments ---------------------------------------------------------

type appointmentRow struct {
	ID       string  `json:"id"`
	With     *string `json:"with,omitempty"`
	Student  *string `json:"student,omitempty"`
	Visitor  string  `json:"visitor_name"`
	Phone    *string `json:"phone,omitempty"`
	OnDate   string  `json:"on_date"`
	StartsAt string  `json:"starts_at"`
	Minutes  int     `json:"minutes"`
	Purpose  string  `json:"purpose"`
	Status   string  `json:"status"`
	Outcome  *string `json:"outcome,omitempty"`
}

/*
listAppointments is a diary, so it looks forward by default.

	Every other list in the product reports on what has happened, and the
	shared date range obliges by ending today. A booking made for Thursday
	then vanishes from the screen that exists to show it, which is the one
	thing an appointment book must never do. An explicit range still wins,
	because the office also needs to look back at last week's meetings.
*/
func (s *Server) listAppointments(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	q := r.URL.Query()
	if q.Get("period") == "" && q.Get("from") == "" && q.Get("to") == "" {
		now := nowInIndia()
		rng.From = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		rng.To = rng.From.AddDate(0, 0, 30)
		rng.Label = "Next 30 days"
	}
	items, err := collect(s, r, `
		SELECT a.id::text,
		       NULLIF(concat_ws(' ', e.first_name, e.last_name), ''),
		       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		       a.visitor_name, a.phone, to_char(a.on_date,'YYYY-MM-DD'),
		       to_char(a.starts_at,'HH24:MI'), a.minutes, a.purpose,
		       a.status, a.outcome
		  FROM appointments a
		  LEFT JOIN employees e ON e.id = a.with_employee_id
		  LEFT JOIN students st ON st.id = a.student_id
		 WHERE a.on_date BETWEEN $1::date AND $2::date
		 ORDER BY a.on_date, a.starts_at
		 LIMIT 300`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (appointmentRow, error) {
			var v appointmentRow
			return v, rows.Scan(&v.ID, &v.With, &v.Student, &v.Visitor, &v.Phone,
				&v.OnDate, &v.StartsAt, &v.Minutes, &v.Purpose, &v.Status, &v.Outcome)
		})
	respond(w, r, items, err)
}

type appointmentRequest struct {
	ID        string `json:"id,omitempty"`
	WithID    string `json:"with_employee_id,omitempty"`
	StudentID string `json:"student_id,omitempty"`
	Visitor   string `json:"visitor_name"`
	Phone     string `json:"phone,omitempty"`
	OnDate    string `json:"on_date"`
	StartsAt  string `json:"starts_at"`
	Minutes   int    `json:"minutes,omitempty"`
	Purpose   string `json:"purpose"`
	Status    string `json:"status,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
}

func (s *Server) saveAppointment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req appointmentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.ID != "" {
		if req.Status == "met" && strings.TrimSpace(req.Outcome) == "" {
			httpx.BadRequest(w, r,
				"say what was agreed — a meeting recorded with nothing said is a record that somebody clicked a button")
			return
		}
		apptID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE appointments
				   SET status = COALESCE(NULLIF($2,''), status),
				       outcome = COALESCE(NULLIF($3,''), outcome)
				 WHERE id = $1`, apptID, req.Status, req.Outcome)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	if strings.TrimSpace(req.Visitor) == "" || req.OnDate == "" || req.StartsAt == "" {
		httpx.BadRequest(w, r, "a booking needs a name, a date and a time")
		return
	}
	if strings.TrimSpace(req.Purpose) == "" {
		httpx.BadRequest(w, r, "say what the meeting is about")
		return
	}
	if req.Minutes == 0 {
		req.Minutes = 15
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO appointments
			    (institution_id, with_employee_id, student_id, requested_by,
			     visitor_name, phone, on_date, starts_at, minutes, purpose)
			VALUES ($1,NULLIF($2,'')::uuid,NULLIF($3,'')::uuid,$4,$5,NULLIF($6,''),
			        $7::date,$8::time,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, req.WithID, req.StudentID, id.UserID, req.Visitor,
			req.Phone, req.OnDate, req.StartsAt, req.Minutes, req.Purpose).Scan(&newID)
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "slot_taken",
				"that person is already booked at that time")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- the telephone register -----------------------------------------------

type callRow struct {
	ID        string  `json:"id"`
	Direction string  `json:"direction"`
	Caller    string  `json:"caller_name"`
	Phone     *string `json:"phone,omitempty"`
	Student   *string `json:"student,omitempty"`
	About     string  `json:"about"`
	For       *string `json:"for,omitempty"`
	PassedOn  *string `json:"passed_on_at,omitempty"`
	Action    *string `json:"action_taken,omitempty"`
	TakenBy   *string `json:"taken_by,omitempty"`
	At        string  `json:"at_time"`
	// A message for somebody that has not reached them. The only thing on this
	// register that is anybody's outstanding work.
	Pending bool `json:"pending"`
}

func (s *Server) listCalls(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT c.id::text, c.direction, c.caller_name, c.phone,
		       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		       c.about,
		       NULLIF(concat_ws(' ', e.first_name, e.last_name), ''),
		       to_char(c.passed_on_at,'YYYY-MM-DD"T"HH24:MI'),
		       c.action_taken, u.full_name,
		       to_char(c.at_time,'YYYY-MM-DD"T"HH24:MI'),
		       c.for_employee_id IS NOT NULL AND c.passed_on_at IS NULL
		  FROM call_log c
		  LEFT JOIN students st ON st.id = c.student_id
		  LEFT JOIN employees e ON e.id = c.for_employee_id
		  LEFT JOIN users u ON u.id = c.taken_by
		 WHERE c.at_time::date BETWEEN $1::date AND $2::date
		 ORDER BY (c.for_employee_id IS NOT NULL AND c.passed_on_at IS NULL) DESC,
		          c.at_time DESC
		 LIMIT 300`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (callRow, error) {
			var v callRow
			return v, rows.Scan(&v.ID, &v.Direction, &v.Caller, &v.Phone, &v.Student,
				&v.About, &v.For, &v.PassedOn, &v.Action, &v.TakenBy, &v.At, &v.Pending)
		})
	respond(w, r, items, err)
}

type callRequest struct {
	ID        string `json:"id,omitempty"`
	Direction string `json:"direction,omitempty"`
	Caller    string `json:"caller_name"`
	Phone     string `json:"phone,omitempty"`
	StudentID string `json:"student_id,omitempty"`
	About     string `json:"about"`
	ForID     string `json:"for_employee_id,omitempty"`
	Action    string `json:"action_taken,omitempty"`
	PassedOn  bool   `json:"passed_on,omitempty"`
}

func (s *Server) saveCall(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req callRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.ID != "" {
		callID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE call_log
				   SET passed_on_at = CASE WHEN $2 THEN now() ELSE passed_on_at END,
				       action_taken = COALESCE(NULLIF($3,''), action_taken)
				 WHERE id = $1`, callID, req.PassedOn, req.Action)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	if strings.TrimSpace(req.Caller) == "" || strings.TrimSpace(req.About) == "" {
		httpx.BadRequest(w, r, "log who rang and what about")
		return
	}
	if req.Direction == "" {
		req.Direction = "in"
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO call_log
			    (institution_id, direction, caller_name, phone, student_id,
			     about, for_employee_id, action_taken, taken_by)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')::uuid,$6,
			        NULLIF($7,'')::uuid,NULLIF($8,''),$9)
			RETURNING id::text`,
			id.InstitutionID, req.Direction, req.Caller, req.Phone, req.StudentID,
			req.About, req.ForID, req.Action, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- the post -------------------------------------------------------------

type courierRow struct {
	ID          string  `json:"id"`
	Direction   string  `json:"direction"`
	OnDate      string  `json:"on_date"`
	Courier     *string `json:"courier,omitempty"`
	TrackingNo  *string `json:"tracking_no,omitempty"`
	FromParty   *string `json:"from_party,omitempty"`
	ToParty     *string `json:"to_party,omitempty"`
	Description string  `json:"description"`
	ReceivedBy  *string `json:"received_by,omitempty"`
	HandedOver  *string `json:"handed_over_at,omitempty"`
	Charges     *int64  `json:"charges_paise,omitempty"`
	// Arrived and still sitting at the desk. The register's whole purpose.
	Undelivered bool `json:"undelivered"`
}

func (s *Server) listCourier(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT id::text, direction, to_char(on_date,'YYYY-MM-DD'), courier,
		       tracking_no, from_party, to_party, description, received_by,
		       to_char(handed_over_at,'YYYY-MM-DD"T"HH24:MI'), charges_paise,
		       direction = 'in' AND handed_over_at IS NULL
		  FROM courier_log
		 WHERE on_date BETWEEN $1::date AND $2::date
		 ORDER BY (direction = 'in' AND handed_over_at IS NULL) DESC, on_date DESC
		 LIMIT 300`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (courierRow, error) {
			var v courierRow
			return v, rows.Scan(&v.ID, &v.Direction, &v.OnDate, &v.Courier,
				&v.TrackingNo, &v.FromParty, &v.ToParty, &v.Description,
				&v.ReceivedBy, &v.HandedOver, &v.Charges, &v.Undelivered)
		})
	respond(w, r, items, err)
}

type courierRequest struct {
	ID          string `json:"id,omitempty"`
	Direction   string `json:"direction,omitempty"`
	OnDate      string `json:"on_date,omitempty"`
	Courier     string `json:"courier,omitempty"`
	TrackingNo  string `json:"tracking_no,omitempty"`
	FromParty   string `json:"from_party,omitempty"`
	ToParty     string `json:"to_party,omitempty"`
	Description string `json:"description"`
	ReceivedBy  string `json:"received_by,omitempty"`
	Charges     *int64 `json:"charges_paise,omitempty"`
	HandOver    bool   `json:"hand_over,omitempty"`
}

func (s *Server) saveCourier(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req courierRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.ID != "" {
		if req.HandOver && strings.TrimSpace(req.ReceivedBy) == "" {
			httpx.BadRequest(w, r,
				"say who took it — an envelope signed for by nobody is the one that goes missing")
			return
		}
		itemID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE courier_log
				   SET handed_over_at = CASE WHEN $2 THEN now() ELSE handed_over_at END,
				       received_by = COALESCE(NULLIF($3,''), received_by)
				 WHERE id = $1`, itemID, req.HandOver, req.ReceivedBy)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	if strings.TrimSpace(req.Description) == "" {
		httpx.BadRequest(w, r, "say what it is")
		return
	}
	if req.Direction == "" {
		req.Direction = "in"
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO courier_log
			    (institution_id, direction, on_date, courier, tracking_no,
			     from_party, to_party, description, charges_paise, recorded_by)
			VALUES ($1,$2,COALESCE(NULLIF($3,'')::date, current_date),
			        NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
			        $8,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, req.Direction, req.OnDate, req.Courier,
			req.TrackingNo, req.FromParty, req.ToParty, req.Description,
			req.Charges, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}
