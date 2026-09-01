package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/* Clubs, coaching and electives, and the money they cost.

   A school runs a robotics club on Wednesdays and swimming coaching on Mondays
   and Thursdays. Children sign up, most of it costs money, and none of it was
   anywhere: the register was a notebook in the coordinator's bag, the money
   was cash against a list, and the child's own record said nothing about the
   thing they spend four hours a week doing.

   THE FEE IS THE POINT, and it is why this is not just another list.

   Enrolling a child in a paid activity raises a real invoice, through the same
   numbering the rest of the finance module uses. Three things follow, and all
   three are the reason this is not a spreadsheet:

     the family sees it on their own Fees page beside the tuition, with the
     same Pay button, rather than being asked for cash on a Wednesday;

     the accounts office sees it in the ledger and in the defaulters list,
     so a school actually collects it;

     and leaving the club stops the charge, because the enrolment knows which
     invoice it raised.

   WHAT IS FROZEN AND WHAT IS NOT. The price lives on the activity, so putting
   it up next term is one row. What a child owes is copied onto the enrolment
   at the moment they join, so a family that signed up at ₹2,500 keeps owing
   ₹2,500 when the club raises its price in April. Charging retrospectively
   because a price moved is the thing a school gets complained about.
*/

type activityRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Schedule    *string `json:"schedule,omitempty"`
	Venue       *string `json:"venue,omitempty"`
	Coordinator *string `json:"coordinator,omitempty"`
	FeePaise    int64   `json:"fee_paise"`
	Capacity    int     `json:"capacity"`
	Enrolled    int     `json:"enrolled"`
	IsActive    bool    `json:"is_active"`
	Notes       *string `json:"notes,omitempty"`
}

func (s *Server) listActivities(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.name, a.category, a.schedule, a.venue,
		       concat_ws(' ', e.first_name, e.last_name),
		       a.fee_paise, a.capacity,
		       (SELECT count(*)::int FROM student_activities sa
		         WHERE sa.activity_id = a.id AND sa.status = 'enrolled'),
		       a.is_active, a.notes
		  FROM activities a
		  LEFT JOIN employees e ON e.id = a.coordinator_id
		 ORDER BY a.is_active DESC, a.category, a.name`, nil,
		func(rows pgx.Rows) (activityRow, error) {
			var v activityRow
			var coord *string
			err := rows.Scan(&v.ID, &v.Name, &v.Category, &v.Schedule, &v.Venue,
				&coord, &v.FeePaise, &v.Capacity, &v.Enrolled, &v.IsActive, &v.Notes)
			if coord != nil && strings.TrimSpace(*coord) != "" {
				v.Coordinator = coord
			}
			return v, err
		})
	respond(w, r, items, err)
}

type activityWriteRequest struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Category    string `json:"category,omitempty"`
	Schedule    string `json:"schedule,omitempty"`
	Venue       string `json:"venue,omitempty"`
	Coordinator string `json:"coordinator_id,omitempty"`
	// In rupees, as a school talks about it. A screen that asks for paise is a
	// screen where somebody eventually charges twenty-five rupees.
	Fee      float64 `json:"fee"`
	Capacity int     `json:"capacity,omitempty"`
	IsActive *bool   `json:"is_active,omitempty"`
	Notes    string  `json:"notes,omitempty"`
}

func (s *Server) saveActivity(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req activityWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpx.BadRequest(w, r, "an activity needs a name")
		return
	}
	if req.Fee < 0 {
		httpx.BadRequest(w, r, "a fee cannot be less than nothing")
		return
	}
	if req.Fee > 100000 {
		httpx.BadRequest(w, r,
			"that is over ₹1,00,000 for one activity — if it is right, raise it "+
				"as a fee head so it appears on the bill in its own right")
		return
	}
	if req.Capacity < 0 {
		httpx.BadRequest(w, r, "a capacity cannot be less than nothing")
		return
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		category = "Club"
	}
	paise := int64(req.Fee*100 + 0.5)
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			aid, err := uuid.Parse(req.ID)
			if err != nil {
				return err
			}
			/* Changing the price changes it for children who join FROM NOW.
			   Everyone already enrolled keeps the figure copied onto their own
			   row, so this cannot re-bill a family retrospectively. */
			return tx.QueryRow(r.Context(), `
				UPDATE activities
				   SET name = $2, category = $3, schedule = NULLIF($4,''),
				       venue = NULLIF($5,''), coordinator_id = $6::uuid,
				       fee_paise = $7, capacity = $8, is_active = $9,
				       notes = NULLIF($10,'')
				 WHERE id = $1 RETURNING id::text`,
				aid, name, category, req.Schedule, req.Venue,
				nullString(req.Coordinator), paise, req.Capacity, active,
				req.Notes).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO activities (institution_id, name, category, schedule, venue,
			                        coordinator_id, fee_paise, capacity, is_active, notes)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6::uuid,$7,$8,$9,NULLIF($10,''))
			RETURNING id::text`,
			id.InstitutionID, name, category, req.Schedule, req.Venue,
			nullString(req.Coordinator), paise, req.Capacity, active, req.Notes).
			Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.BadRequest(w, r, "there is already an activity called that")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "name": name})
}

// --- one child's activities, and the money -------------------------------

var errActivityFull = errors.New("activity is full")

type enrolActivityRequest struct {
	ActivityID string `json:"activity_id"`
	/* A school that lets a child in free — a scholarship, a sibling
	   concession, a coach's own child — needs to say so at the moment of
	   enrolling, not correct a bill afterwards. */
	WaiveFee bool   `json:"waive_fee,omitempty"`
	Notes    string `json:"notes,omitempty"`
}

func (s *Server) enrolInActivity(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req enrolActivityRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	aid, err := uuid.Parse(strings.TrimSpace(req.ActivityID))
	if err != nil {
		httpx.BadRequest(w, r, "choose an activity")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var (
		enrolID, invoiceNo string
		charged            int64
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var allowed bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&allowed); err != nil {
			return err
		}

		var name string
		var fee int64
		var capacity, taken int
		var isActive bool
		if err := tx.QueryRow(r.Context(), `
			SELECT a.name, a.fee_paise, a.capacity, a.is_active,
			       (SELECT count(*)::int FROM student_activities sa
			         WHERE sa.activity_id = a.id AND sa.status = 'enrolled')
			  FROM activities a WHERE a.id = $1 FOR UPDATE`, aid).
			Scan(&name, &fee, &capacity, &isActive, &taken); err != nil {
			return err
		}
		if !isActive {
			return errors.New("that activity has been wound up")
		}
		/* Counted under FOR UPDATE, so two clerks enrolling the last child at
		   once cannot both be told there was room. */
		if capacity > 0 && taken >= capacity {
			return errActivityFull
		}
		if req.WaiveFee {
			fee = 0
		}
		charged = fee

		var invoiceID *uuid.UUID
		if fee > 0 {
			/* A real invoice, through the same numbering the rest of finance
			   uses. Not a note on the enrolment: the family must see it on
			   their own Fees page beside the tuition with the same Pay button,
			   and the accounts office must see it in the ledger and in the
			   defaulters list. */
			no, err := fees.NextNumber(r.Context(), tx, id.InstitutionID, "invoice")
			if err != nil {
				return err
			}
			invoiceNo = no
			var iid uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO invoices (institution_id, campus_id, student_id,
				                      academic_year_id, invoice_no, issued_on,
				                      due_on, gross_paise, discount_paise,
				                      fine_paise, status)
				SELECT $1, st.campus_id, st.id,
				       (SELECT id FROM academic_years WHERE is_current LIMIT 1),
				       $2, CURRENT_DATE,
				       -- A fortnight, which is what a school gives for a club
				       -- fee. The tuition instalment dates are set by the fee
				       -- plan and have nothing to do with this.
				       CURRENT_DATE + 14, $3, 0, 0, 'unpaid'
				  FROM students st WHERE st.id = $4
				RETURNING id`, id.InstitutionID, no, fee, sid).Scan(&iid); err != nil {
				return err
			}
			invoiceID = &iid
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO invoice_lines (institution_id, invoice_id, description,
				                           amount_paise, discount_paise)
				VALUES ($1, $2, $3, $4, 0)`,
				id.InstitutionID, iid, name, fee); err != nil {
				return err
			}
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO student_activities (institution_id, student_id, activity_id,
			                                academic_year_id, invoice_id, fee_paise,
			                                notes)
			VALUES ($1,$2,$3,
			        (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			        $4, $5, NULLIF($6,''))
			RETURNING id::text`,
			id.InstitutionID, sid, aid, invoiceID, charged, req.Notes).
			Scan(&enrolID); err != nil {
			return err
		}

		// The family is told, because a charge nobody announced is a charge
		// somebody rings the office about.
		if charged > 0 {
			body := name + " — ₹" + strconv.FormatFloat(float64(charged)/100, 'f', 2, 64) +
				", due in a fortnight. It is on your fees page and can be paid there."
			people, err := tx.Query(r.Context(), `
				SELECT g.user_id FROM student_guardians sg
				  JOIN guardians g ON g.id = sg.guardian_id
				 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL
				UNION
				SELECT u.id FROM students st JOIN users u ON u.id = st.user_id
				 WHERE st.id = $1`, sid)
			if err != nil {
				return err
			}
			var to []uuid.UUID
			for people.Next() {
				var u uuid.UUID
				if err := people.Scan(&u); err != nil {
					people.Close()
					return err
				}
				to = append(to, u)
			}
			people.Close()
			if err := people.Err(); err != nil {
				return err
			}
			for _, u := range to {
				st := sid
				if err := notify(r, tx, id.InstitutionID, u, &st, "fee_due",
					"Enrolled in "+name, body, "/portal/fees", "invoice",
					invoiceID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, errActivityFull):
		httpx.Error(w, r, http.StatusConflict, "activity_full",
			"that activity is full — raise its capacity or put the child on the list")
		return
	case isUniqueViolation(err):
		httpx.BadRequest(w, r, "this child is already enrolled in that activity")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Forbidden(w, r, "this child is not one you can edit")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": enrolID, "charged_paise": charged, "invoice_no": invoiceNo,
	})
}

/*
Leaving an activity, and what happens to the money.

	An unpaid bill is CANCELLED: the family never owed it for a club the child
	attended twice. A bill already paid is left alone and the office is told to
	refund it if they mean to — this endpoint will not silently move money that
	has been receipted, because a refund is a decision with a person behind it.
*/
func (s *Server) leaveActivity(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	eid, err := uuid.Parse(chiURLParam(r, "enrolID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid enrolment id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 3)

	var cancelledInvoice, paidAlready bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var invoiceID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			UPDATE student_activities sa
			   SET status = 'left', left_on = CURRENT_DATE
			 WHERE sa.id = $1 AND sa.student_id = $2 AND sa.status = 'enrolled'
			   AND EXISTS (SELECT 1 FROM students st
			                WHERE st.id = sa.student_id AND `+pred+`)
			RETURNING sa.invoice_id`,
			append([]any{eid, sid}, args...)...).Scan(&invoiceID); err != nil {
			return err
		}
		if invoiceID == nil {
			return nil
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE invoices SET status = 'cancelled',
			                    cancelled_reason = 'Left the activity',
			                    updated_at = now()
			 WHERE id = $1 AND paid_paise = 0 AND status <> 'cancelled'`, invoiceID)
		if err != nil {
			return err
		}
		cancelledInvoice = tag.RowsAffected() > 0
		if !cancelledInvoice {
			// Either already cancelled, or money has been taken against it.
			return tx.QueryRow(r.Context(),
				`SELECT paid_paise > 0 FROM invoices WHERE id = $1`, invoiceID).
				Scan(&paidAlready)
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"that enrolment is already closed, or is not one you can edit")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"left":              true,
		"invoice_cancelled": cancelledInvoice,
		// Said plainly rather than left for the office to discover: money
		// already receipted is not moved by a button on a club register.
		"already_paid": paidAlready,
	})
}
