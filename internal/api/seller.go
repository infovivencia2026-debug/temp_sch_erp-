package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The vendor's own back office.

   Everything else in this codebase describes how a school runs. This describes
   how a school becomes a customer: provisioned, priced, entitled, supported
   and — the step that decides whether any of it was worth selling — handed a
   set of credentials that works.

   The cycle is deliberate and short:

     1. the school buys
     2. the vendor provisions the tenant, its first campus and its first
        administrator in one transaction, and reads out the credentials
     3. the principal signs in and is shown round

   Step 2 used to be a shell command on the server, which meant a salesperson
   could not close a sale without an engineer. Step 3 did not exist at all: the
   principal arrived at an empty system with no data and no instructions, which
   is where most of the industry's 60-70% implementation failure rate lives.

   None of this is reachable from a school account. The permission is
   platform.tenants.write, which no institution role holds, and a seller who
   needs to see inside a school does so by impersonation that the school can
   read in its own audit trail. */

// --- the customer list -------------------------------------------------------

type tenantRow struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Short        string  `json:"short_name"`
	District     *string `json:"district,omitempty"`
	Status       string  `json:"status"`
	Students     int     `json:"students"`
	Staff        int     `json:"staff"`
	Plan         *string `json:"plan,omitempty"`
	PlanName     *string `json:"plan_name,omitempty"`
	Subscription *string `json:"subscription_status,omitempty"`
	RenewsOn     *string `json:"renews_on,omitempty"`
	LicensedFor  *int    `json:"licensed_students,omitempty"`
	// OverBy is how far past the licensed headcount the school has grown. The
	// number a renewal conversation actually turns on.
	OverBy int `json:"over_by"`
	// SetupPercent is how far through first-run setup they have got. A school
	// stuck at 20% three weeks after handover is the one to telephone.
	SetupPercent int     `json:"setup_percent"`
	LastSignIn   *string `json:"last_sign_in,omitempty"`
	CreatedOn    string  `json:"created_on"`
}

// listTenants is the seller's customer directory: who is on the system, on
// what plan, how far they have got, and who is drifting.
func (s *Server) listTenants(w http.ResponseWriter, r *http.Request) {
	items := []tenantRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, i.short_name, i.district, i.status,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int,
			       (SELECT count(*) FROM employees e
			         WHERE e.institution_id = i.id AND e.status = 'active')::int,
			       sub.plan_code, p.name, sub.status,
			       to_char(sub.renews_on, 'YYYY-MM-DD'), sub.licensed_students,
			       to_char(i.created_at, 'YYYY-MM-DD'),
			       to_char((SELECT max(u.last_login_at) FROM users u
			                 WHERE u.institution_id = i.id), 'YYYY-MM-DD'),
			       -- Setup progress, counted the same way the wizard counts it
			       -- so the seller and the school see the same number.
			       (
			         (i.district IS NOT NULL AND i.affiliation_board IS NOT NULL)::int +
			         (EXISTS (SELECT 1 FROM campuses c WHERE c.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM academic_years a WHERE a.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM classes c WHERE c.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM sections se WHERE se.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM subjects su WHERE su.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM employees e WHERE e.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM students st WHERE st.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM fee_heads f WHERE f.institution_id = i.id))::int +
			         (EXISTS (SELECT 1 FROM exams x WHERE x.institution_id = i.id))::int
			       ) * 10
			  FROM institutions i
			  LEFT JOIN subscriptions sub
			    ON sub.institution_id = i.id AND sub.status <> 'cancelled'
			  LEFT JOIN plans p ON p.code = sub.plan_code
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tenantRow
			if err := rows.Scan(&v.ID, &v.Name, &v.Short, &v.District, &v.Status,
				&v.Students, &v.Staff, &v.Plan, &v.PlanName, &v.Subscription,
				&v.RenewsOn, &v.LicensedFor, &v.CreatedOn, &v.LastSignIn,
				&v.SetupPercent); err != nil {
				return err
			}
			if v.LicensedFor != nil && v.Students > *v.LicensedFor {
				v.OverBy = v.Students - *v.LicensedFor
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type planRow struct {
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	PricePaise  int64    `json:"price_paise"`
	MaxStudents *int     `json:"max_students,omitempty"`
	MaxCampuses *int     `json:"max_campuses,omitempty"`
	Modules     []string `json:"modules"`
	Schools     int      `json:"schools"`
}

func (s *Server) listPlans(w http.ResponseWriter, r *http.Request) {
	items := []planRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT p.code, p.name, p.price_paise, p.max_students, p.max_campuses,
			       p.modules,
			       (SELECT count(*) FROM subscriptions sub
			         WHERE sub.plan_code = p.code AND sub.status <> 'cancelled')::int
			  FROM plans p ORDER BY p.sequence, p.price_paise`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v planRow
			if err := rows.Scan(&v.Code, &v.Name, &v.PricePaise, &v.MaxStudents,
				&v.MaxCampuses, &v.Modules, &v.Schools); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// --- provisioning ------------------------------------------------------------

type provisionRequest struct {
	SchoolName string `json:"school_name"`
	ShortName  string `json:"short_name,omitempty"`
	District   string `json:"district,omitempty"`
	State      string `json:"state,omitempty"`
	Board      string `json:"affiliation_board,omitempty"`
	PlanCode   string `json:"plan_code"`
	// Who receives the credentials — the owner, principal or whoever the
	// school nominates. They become the school's first administrator.
	AdminName     string `json:"admin_name"`
	AdminEmail    string `json:"admin_email,omitempty"`
	AdminPhone    string `json:"admin_phone,omitempty"`
	AdminUsername string `json:"admin_username,omitempty"`
	TrialDays     int    `json:"trial_days,omitempty"`
}

var (
	errNoPlan      = errors.New("unknown plan")
	errNameTaken   = errors.New("a school with that name already exists")
	errNoAdminName = errors.New("the first administrator needs a name")
)

// provisionTenant creates a school, its first campus, its first administrator
// and its subscription in one transaction, and returns the credentials to hand
// over.
//
// One transaction on purpose. A half-provisioned tenant — a school with no
// administrator, or an administrator with no school — is worse than a failed
// sale, because it looks finished and nobody can sign in to find out.
func (s *Server) provisionTenant(w http.ResponseWriter, r *http.Request) {
	var req provisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.SchoolName = strings.TrimSpace(req.SchoolName)
	req.AdminName = strings.TrimSpace(req.AdminName)
	if req.SchoolName == "" {
		httpx.BadRequest(w, r, "the school needs a name")
		return
	}
	if req.AdminName == "" {
		httpx.BadRequest(w, r, errNoAdminName.Error())
		return
	}
	if req.AdminEmail == "" && req.AdminPhone == "" && req.AdminUsername == "" {
		httpx.BadRequest(w, r,
			"give the administrator an email, a phone number or a username — "+
				"without one of the three they cannot sign in")
		return
	}

	short := strings.TrimSpace(req.ShortName)
	if short == "" {
		short = deriveShortName(req.SchoolName)
	}
	username := strings.ToLower(strings.TrimSpace(req.AdminUsername))
	password, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out struct {
		InstitutionID string `json:"institution_id"`
		UserID        string `json:"user_id"`
		Slug          string `json:"slug"`
	}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if req.PlanCode != "" {
			var ok bool
			if err := tx.QueryRow(r.Context(),
				`SELECT true FROM plans WHERE code = $1`, req.PlanCode).Scan(&ok); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return errNoPlan
				}
				return err
			}
		}

		slug := slugify(req.SchoolName)
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO institutions (name, short_name, slug, district, state,
			                          affiliation_board, status)
			VALUES ($1,$2,$3::citext,$4,$5,$6,'active')
			RETURNING id::text, slug::text`,
			req.SchoolName, short, slug, nullString(req.District),
			nullString(req.State), nullString(req.Board)).
			Scan(&out.InstitutionID, &out.Slug); err != nil {
			if isUniqueViolation(err) {
				return errNameTaken
			}
			return err
		}

		// A campus, because every scoped table needs one and asking the
		// principal to invent one before they can do anything is a poor first
		// instruction. They rename it in the setup wizard.
		var campusID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO campuses (institution_id, name, code)
			VALUES ($1::uuid, 'Main Campus', 'MAIN') RETURNING id::text`,
			out.InstitutionID).Scan(&campusID); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, email, phone, username, full_name,
			                   password_hash, status)
			VALUES ($1::uuid, $2::citext, $3, $4::citext, $5, $6, 'active')
			RETURNING id::text`,
			out.InstitutionID, nullString(req.AdminEmail), nullString(req.AdminPhone),
			nullString(username), req.AdminName, hash).Scan(&out.UserID); err != nil {
			if isUniqueViolation(err) {
				return errors.New("that email, phone or username is already in use")
			}
			return err
		}

		// The whole institution_admin bundle, seeded per tenant by the same
		// path a normal school uses, so the first account is not a special case.
		instUUID, err := uuid.Parse(out.InstitutionID)
		if err != nil {
			return err
		}
		if err := rbac.SeedInstitution(r.Context(), tx, instUUID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO user_roles (user_id, role_id, institution_id)
			SELECT $1::uuid, r.id, $2::uuid FROM roles r
			 WHERE r.key = 'institution_admin' AND r.institution_id = $2::uuid
			ON CONFLICT DO NOTHING`, out.UserID, out.InstitutionID); err != nil {
			return err
		}

		if req.PlanCode != "" {
			trial := req.TrialDays
			if trial <= 0 {
				trial = 30
			}
			var cap *int
			_ = tx.QueryRow(r.Context(),
				`SELECT max_students FROM plans WHERE code = $1`, req.PlanCode).Scan(&cap)
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO subscriptions (institution_id, plan_code, status,
				                           started_on, trial_ends_on, renews_on,
				                           licensed_students)
				VALUES ($1::uuid, $2, 'trial', CURRENT_DATE,
				        CURRENT_DATE + make_interval(days => $3::int),
				        CURRENT_DATE + interval '1 year', $4)`,
				out.InstitutionID, req.PlanCode, trial, cap); err != nil {
				return err
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, errNoPlan):
		httpx.BadRequest(w, r, "that plan does not exist")
		return
	case errors.Is(err, errNameTaken):
		httpx.Error(w, r, http.StatusConflict, "name_taken", errNameTaken.Error())
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}

	// The handover. Shown once and never retrievable: the hash is all that is
	// stored, so a seller who closes this dialog resets the password rather
	// than looking it up.
	signIn := username
	if signIn == "" {
		signIn = req.AdminEmail
	}
	if signIn == "" {
		signIn = req.AdminPhone
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"institution_id": out.InstitutionID,
		"user_id":        out.UserID,
		"school":         req.SchoolName,
		"admin_name":     req.AdminName,
		"sign_in_as":     signIn,
		"password":       password,
		"note": "Hand these to the school. The password is shown once and is not " +
			"stored — if it is lost, reset it rather than looking it up. They are " +
			"asked to change it on first sign-in.",
	})
}

// slugify makes a URL-safe tenant slug from a school's name.
func slugify(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "school"
	}
	// Collisions are possible and cheap to avoid; the slug is not shown to
	// anyone who would mind eight hex characters.
	return out + "-" + uuid.NewString()[:8]
}

// --- subscription changes -----------------------------------------------------

type subscriptionRequest struct {
	PlanCode string `json:"plan_code,omitempty"`
	Status   string `json:"status,omitempty"`
	RenewsOn string `json:"renews_on,omitempty"`
	Licensed *int   `json:"licensed_students,omitempty"`
	Notes    string `json:"notes,omitempty"`
}

var subscriptionStatuses = []option{
	{"trial", "Trial"},
	{"active", "Active"},
	{"past_due", "Past due"},
	{"suspended", "Suspended"},
	{"cancelled", "Cancelled"},
}

// setSubscription changes a school's plan, term or standing.
//
// Suspending sets the institution's own status too, which is what actually
// stops sign-in: a subscription row nobody checks would let a non-paying
// school carry on indefinitely.
func (s *Server) setSubscription(w http.ResponseWriter, r *http.Request) {
	instID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid institution id")
		return
	}
	var req subscriptionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status != "" {
		if err := oneOf("status", req.Status, subscriptionStatuses); err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO subscriptions (institution_id, plan_code, status, renews_on,
			                           licensed_students, notes)
			VALUES ($1, COALESCE(NULLIF($2,''), 'starter'),
			        COALESCE(NULLIF($3,''), 'trial'), NULLIF($4,'')::date, $5, NULLIF($6,''))
			ON CONFLICT (institution_id) WHERE status <> 'cancelled'
			DO UPDATE SET plan_code = COALESCE(NULLIF($2,''), subscriptions.plan_code),
			              status    = COALESCE(NULLIF($3,''), subscriptions.status),
			              renews_on = COALESCE(NULLIF($4,'')::date, subscriptions.renews_on),
			              licensed_students = COALESCE($5, subscriptions.licensed_students),
			              notes     = COALESCE(NULLIF($6,''), subscriptions.notes),
			              updated_at = now()`,
			instID, req.PlanCode, req.Status, req.RenewsOn, req.Licensed,
			req.Notes); err != nil {
			return err
		}

		// A suspended subscription must actually lock the door.
		switch req.Status {
		case "suspended", "cancelled":
			_, err := tx.Exec(r.Context(),
				`UPDATE institutions SET status = 'suspended' WHERE id = $1`, instID)
			return err
		case "trial", "active":
			_, err := tx.Exec(r.Context(),
				`UPDATE institutions SET status = 'active' WHERE id = $1`, instID)
			return err
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"institution_id": instID.String()})
}

// resetTenantAdmin issues a fresh password for a school's administrator, which
// is what a seller does when the handover note is lost.
func (s *Server) resetTenantAdmin(w http.ResponseWriter, r *http.Request) {
	instID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid institution id")
		return
	}
	password, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var name, signIn string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE users SET password_hash = $2, status = 'active'
			 WHERE id = (
			   SELECT u.id FROM users u
			     JOIN user_roles ur ON ur.user_id = u.id
			     JOIN roles r ON r.id = ur.role_id
			    WHERE u.institution_id = $1 AND r.key = 'institution_admin'
			    ORDER BY u.created_at LIMIT 1)
			 RETURNING full_name, COALESCE(username::text, email::text, phone, '')`,
			instID, hash).Scan(&name, &signIn)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.BadRequest(w, r, "that school has no administrator to reset")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"admin_name": name, "sign_in_as": signIn, "password": password,
		"note": "Shown once. The previous password no longer works.",
	})
}

// --- the school's first morning ------------------------------------------------

type tourState struct {
	// Seen is false exactly once per person: on the morning the credentials
	// they were handed first work.
	Seen        bool    `json:"seen"`
	CompletedAt *string `json:"completed_at,omitempty"`
	Role        string  `json:"role"`
	SchoolName  string  `json:"school_name"`
	IsFirstUser bool    `json:"is_first_user"`
}

// getTour reports whether this person has been shown round, and who they are,
// so the client can pick the right introduction — a principal setting a school
// up needs a different first ten minutes from a teacher joining one already
// running.
func (s *Server) getTour(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var st tourState
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT u.tour_completed_at IS NOT NULL,
			       to_char(u.tour_completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       COALESCE((SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
			                  WHERE ur.user_id = u.id ORDER BY r.key LIMIT 1), ''),
			       COALESCE(i.name, ''),
			       -- The first account in a school is the one the vendor handed
			       -- over, and the only one that arrives to an empty system.
			       u.id = (SELECT u2.id FROM users u2
			                WHERE u2.institution_id = u.institution_id
			                ORDER BY u2.created_at LIMIT 1)
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.id = $1`, id.UserID).
			Scan(&st.Seen, &st.CompletedAt, &st.Role, &st.SchoolName, &st.IsFirstUser)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

type tourRequest struct {
	// Replay puts the tour back, for someone who dismissed it too fast or is
	// showing a colleague.
	Replay bool `json:"replay,omitempty"`
}

func (s *Server) setTour(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req tourRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	at := "now()"
	if req.Replay {
		at = "NULL"
	}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE users SET tour_completed_at = `+at+` WHERE id = $1`, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"seen": !req.Replay})
}

// --- support ------------------------------------------------------------------

type ticketRow struct {
	ID        string  `json:"id"`
	School    *string `json:"school,omitempty"`
	Subject   string  `json:"subject"`
	Category  string  `json:"category"`
	Priority  string  `json:"priority"`
	Status    string  `json:"status"`
	RaisedBy  *string `json:"raised_by,omitempty"`
	CreatedAt string  `json:"created_at"`
	OpenDays  int     `json:"open_days"`
}

func (s *Server) listTickets(w http.ResponseWriter, r *http.Request) {
	items := []ticketRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text, i.name, t.subject, t.category, t.priority, t.status,
			       u.full_name, to_char(t.created_at, 'YYYY-MM-DD'),
			       EXTRACT(day FROM now() - t.created_at)::int
			  FROM support_tickets t
			  LEFT JOIN institutions i ON i.id = t.institution_id
			  LEFT JOIN users u ON u.id = t.raised_by
			 WHERE t.status <> 'closed'
		   -- A parent's complaint about a named teacher is the school's
		   -- business, not the software vendor's. support_tickets carries
		   -- both, so the vendor's queue asks for its own.
		   AND t.audience = 'vendor'
			 ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
			                          WHEN 'normal' THEN 2 ELSE 3 END,
			          t.created_at`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v ticketRow
			if err := rows.Scan(&v.ID, &v.School, &v.Subject, &v.Category, &v.Priority,
				&v.Status, &v.RaisedBy, &v.CreatedAt, &v.OpenDays); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
