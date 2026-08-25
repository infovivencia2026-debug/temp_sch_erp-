package api

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/entitlement"
	"github.com/school-erp/erp/internal/httpx"
)

/* The price list, editable by the person who sets the prices.

   Plans were seeded and read-only: a vendor could see what a school could be
   sold and could not add a tier, change a cap, or put the price up without an
   edit to the database. That is the one screen in the vendor's own workspace
   that exists to be changed.

   The rule that makes it safe is on the subscription, not here. A school's
   agreed price is fixed at signing (see 00154), so editing a plan changes what
   the NEXT school pays and nothing about the ones already on it. Without that,
   raising the price of "Pro" would silently re-price every existing customer
   and the vendor would watch MRR jump on money nobody had agreed to.

   Retiring rather than deleting, for the same reason: a plan somebody is still
   paying for cannot be removed, and a plan nobody should be sold any more
   should not sit on the list waiting to be picked by accident. */

var planCodeRe = regexp.MustCompile(`^[a-z][a-z0-9_]{1,30}$`)

var (
	errPlanCodeTaken = errors.New("a plan with that code already exists")
	errPlanInUse     = errors.New("schools are on that plan")
)

type planWriteRequest struct {
	Code        string   `json:"code,omitempty"`
	Name        string   `json:"name"`
	PricePaise  int64    `json:"price_paise"`
	MaxStudents *int     `json:"max_students,omitempty"`
	MaxCampuses *int     `json:"max_campuses,omitempty"`
	Modules     []string `json:"modules"`
	Sequence    int      `json:"sequence,omitempty"`
}

// validate checks the parts a vendor can get wrong, in the words they used.
func (p *planWriteRequest) validate() error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("a plan needs a name — it is what a school sees on its invoice")
	}
	if p.PricePaise < 0 {
		return errors.New("a price cannot be negative")
	}
	if p.MaxStudents != nil && *p.MaxStudents < 0 {
		return errors.New("a student cap cannot be negative")
	}
	if p.MaxCampuses != nil && *p.MaxCampuses < 0 {
		return errors.New("a campus cap cannot be negative")
	}
	/* A module that does not exist would switch nothing on and read as though
	   it had. Checked against the same list entitlement enforces, so the two
	   cannot drift into disagreeing about what a module is called. */
	for _, m := range p.Modules {
		if !entitlement.Known(m) {
			return errors.New("there is no module called " + m)
		}
	}
	return nil
}

// createPlan adds a tier to what a school can be sold.
func (s *Server) createPlan(w http.ResponseWriter, r *http.Request) {
	var req planWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.ToLower(strings.TrimSpace(req.Code))
	if !planCodeRe.MatchString(req.Code) {
		httpx.BadRequest(w, r,
			"the code is the plan's permanent name: lower case letters, numbers and underscores, starting with a letter")
		return
	}
	if err := req.validate(); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if req.Modules == nil {
		req.Modules = []string{}
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM plans WHERE code = $1)`, req.Code).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return errPlanCodeTaken
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO plans (code, name, price_paise, max_students, max_campuses,
			                   modules, sequence)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			req.Code, strings.TrimSpace(req.Name), req.PricePaise,
			req.MaxStudents, req.MaxCampuses, req.Modules, req.Sequence)
		return err
	})
	if errors.Is(err, errPlanCodeTaken) {
		httpx.Error(w, r, http.StatusConflict, "code_taken",
			"a plan with that code already exists. The code is permanent — pick another, or edit the existing plan.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"code": req.Code})
}

/*
updatePlan changes what the next school will be sold.

	The code is not editable. It is what every subscription points at, and
	renaming it would either orphan those rows or silently move schools between
	plans — so the name, price and caps are the changeable parts, and the code
	is the thing they hang from.
*/
func (s *Server) updatePlan(w http.ResponseWriter, r *http.Request) {
	code := strings.ToLower(strings.TrimSpace(chiURLParam(r, "code")))
	var req planWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Code != "" && strings.ToLower(req.Code) != code {
		httpx.BadRequest(w, r,
			"a plan's code cannot be changed — every subscription points at it. Create a new plan and move the schools across.")
		return
	}
	if err := req.validate(); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if req.Modules == nil {
		req.Modules = []string{}
	}

	var onIt int
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE plans
			   SET name = $2, price_paise = $3, max_students = $4,
			       max_campuses = $5, modules = $6, sequence = $7
			 WHERE code = $1`,
			code, strings.TrimSpace(req.Name), req.PricePaise,
			req.MaxStudents, req.MaxCampuses, req.Modules, req.Sequence)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		/* How many schools this did NOT re-price, reported back.

		   A vendor raising a price wants to know it took effect, and the
		   honest answer is "for nobody yet". Saying so here is what stops
		   somebody assuming their existing customers just went up. */
		return tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM subscriptions
			  WHERE plan_code = $1 AND status IN ('active','trial')`, code).Scan(&onIt)
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
		"code": code, "schools_keeping_their_price": onIt,
	})
}

/*
retirePlan takes a tier off what can be sold, without touching who is on it.

	Not a delete. A plan somebody is still paying for cannot be removed without
	orphaning their subscription, and a plan nobody should be sold any more
	should not sit on the list waiting to be picked by mistake. Retired is the
	answer to both: gone from the picker, still readable by the schools on it,
	and reversible.
*/
func (s *Server) retirePlan(w http.ResponseWriter, r *http.Request) {
	code := strings.ToLower(strings.TrimSpace(chiURLParam(r, "code")))
	restore := r.URL.Query().Get("restore") == "1"

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var set any
		if !restore {
			set = "now()"
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE plans SET retired_at = CASE WHEN $2::bool THEN NULL ELSE now() END
			 WHERE code = $1`, code, restore)
		if err != nil {
			return err
		}
		_ = set
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"code": code, "retired": !restore})
}
