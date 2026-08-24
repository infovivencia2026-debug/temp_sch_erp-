package api

import (
	"encoding/json"
	"net/http"
	"strings"

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

func quota(n float64) *float64 { return &n }

// The leave every Indian school gives, and roughly how much of it. Numbers a
// school will edit; names it will recognise.
var starterLeaveTypes = []leaveType{
	{Code: "CL", Name: "Casual leave", AppliesTo: "staff", AnnualQuota: quota(12), IsPaid: true},
	{Code: "SL", Name: "Sick leave", AppliesTo: "staff", AnnualQuota: quota(12), IsPaid: true},
	{Code: "EL", Name: "Earned leave", AppliesTo: "staff", AnnualQuota: quota(15), IsPaid: true, CarryFwd: true},
	{Code: "ML", Name: "Maternity leave", AppliesTo: "staff", AnnualQuota: quota(180), IsPaid: true},
	{Code: "LOP", Name: "Leave without pay", AppliesTo: "staff", IsPaid: false},
	{Code: "SICK", Name: "Sick leave", AppliesTo: "student", IsPaid: true},
	{Code: "FUNC", Name: "Family function", AppliesTo: "student", IsPaid: true},
}

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
		"items": out, "suggested": starterLeaveTypes,
	})
}

func (s *Server) saveLeaveType(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		Starters bool `json:"starters"`
		leaveType
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a leave type.")
		return
	}

	wanted := []leaveType{}
	if in.Starters {
		wanted = starterLeaveTypes
	} else {
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
		wanted = append(wanted, leaveType{
			Code: code, Name: name, AppliesTo: in.AppliesTo,
			AnnualQuota: in.AnnualQuota, IsPaid: in.IsPaid, CarryFwd: in.CarryFwd,
		})
	}

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
