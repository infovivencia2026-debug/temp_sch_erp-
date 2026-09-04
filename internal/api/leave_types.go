package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The kinds of leave a school gives.

   leave_types has existed since the first migration, every leave request
   carries a leave_type_id, and the screens print a Type column — and nothing
   in the product could ever create one. Not a hidden screen: no endpoint at
   all. So the column was empty in every school on the installation, a leave
   request could not say whether it was casual or sick, and the balances a
   person is entitled to had nothing to hang off.

   Which makes the rest of leave weaker than it looks. "How many sick days do I
   have left" cannot be answered without types; neither can "she has exhausted
   her casual leave", which is the sentence an approver actually needs. The
   request still worked, because a type is nullable — the feature degraded
   quietly rather than failing, which is why it survived this long.

   Offered rather than imposed. A school with no types is asked whether it
   wants the usual Indian set, and nothing is created until they say so; a
   school that calls its leave something else adds its own.
*/

type leaveType struct {
	ID          string   `json:"id,omitempty"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	AppliesTo   string   `json:"applies_to"`
	AnnualQuota *float64 `json:"annual_quota,omitempty"`
	IsPaid      bool     `json:"is_paid"`
	CarryFwd    bool     `json:"carry_forward"`
}

/* NO SCHOOL STARTS WITH LEAVE IT DID NOT GRANT.

   Five types were carried here as a starting point -- casual, sick, earned,
   maternity, without pay -- with quotas of twelve and fifteen and a hundred
   and eighty. A school that had never opened the screen found them on its
   policy page and had to ask why it was offering earned leave it had never
   agreed and a quota nobody had set; and because leave feeds loss of pay, a
   number this product invented was a number a payslip would one day charge
   against.

   Nothing in the product ever asked for the list. It was reachable only by
   sending starters:true by hand, and one school has the five rows to show for
   it. A school now starts with none and names its own, which is the same rule
   the hours and the deduction already follow. */

func (s *Server) listLeaveTypes(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	// Narrowed when asked: a teacher applying for leave has no use for the
	// student list, and offering both is how somebody files their own absence
	// as a family function.
	applies := strings.TrimSpace(r.URL.Query().Get("applies_to"))

	out := []leaveType{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, code, name, applies_to, annual_quota, is_paid, carry_forward
			  FROM leave_types
			 WHERE ($1::text = '' OR applies_to = $1)
			 ORDER BY applies_to, name`, applies)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v leaveType
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.AppliesTo,
				&v.AnnualQuota, &v.IsPaid, &v.CarryFwd); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": out,
	})
}

func (s *Server) saveLeaveType(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		leaveType
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a leave type.")
		return
	}

	code := strings.ToUpper(strings.TrimSpace(in.Code))
	name := strings.TrimSpace(in.Name)
	if code == "" || name == "" {
		httpx.BadRequest(w, r, "A leave type needs a short code and a name.")
		return
	}
	if in.AppliesTo != "staff" && in.AppliesTo != "student" {
		httpx.BadRequest(w, r, "Leave applies either to staff or to students.")
		return
	}
	wanted := []leaveType{{
		Code: code, Name: name, AppliesTo: in.AppliesTo,
		AnnualQuota: in.AnnualQuota, IsPaid: in.IsPaid, CarryFwd: in.CarryFwd,
	}}

	var made int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, t := range wanted {
			// DO NOTHING rather than upsert: pressing "set these up" twice must
			// not overwrite a quota the school has since adjusted.
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO leave_types (institution_id, code, name, applies_to,
				                         annual_quota, is_paid, carry_forward)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, t.Code, t.Name, t.AppliesTo,
				t.AnnualQuota, t.IsPaid, t.CarryFwd)
			if err != nil {
				return err
			}
			made += int(tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"created": made})
}

/*
deleteLeaveType removes a kind of leave the school does not grant.

	Five types are offered as a starting point -- casual, sick, earned,
	maternity, leave without pay -- and a school that accepted them was then
	stuck with all five. A school with no earned leave had a row on its policy
	screen for earned leave, a quota it never agreed, and staff who could apply
	for it.

	Refused while anything refers to it rather than cascading. A leave type is
	how a day already taken is described: deleting it would turn last March's
	approved sick leave into a day with no explanation, and the payslip that
	charged nothing for it into one nobody can account for.
*/
func (s *Server) deleteLeaveType(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	typeID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid leave type id")
		return
	}
	var requests, balances int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM leave_requests r WHERE r.leave_type_id = t.id),
			       (SELECT count(*)::int FROM leave_balances b
			         WHERE b.leave_type_id = t.id AND (b.taken > 0 OR b.entitled > 0))
			  FROM leave_types t WHERE t.id = $1`, typeID).Scan(&requests, &balances); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		if requests > 0 || balances > 0 {
			return errRefInUse
		}
		// The rules go with it; nothing else points at a type nobody has used.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM leave_policy_rules WHERE leave_type_id = $1`, typeID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM leave_types WHERE id = $1`, typeID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r,
			plural(requests, "leave request", "leave requests")+" and "+
				plural(balances, "staff balance", "staff balances")+
				" refer to this type. It is how days already taken are described, so "+
				"removing it would leave those days with no explanation. Set its quota "+
				"to zero instead if the school no longer grants it")
		return
	}
	writeRefResult(w, r, err, "leave type", typeID)
}
