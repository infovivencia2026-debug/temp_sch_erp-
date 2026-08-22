package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a person is paid, before anybody can be paid.

   Payroll would only ever run for staff who have a salary structure, and there
   was no way in the product to give anybody one. Not a hidden screen, not a
   screen behind the wrong permission: no endpoint at all wrote
   salary_structures, and salary_components was empty in every school on the
   installation. So "Run payroll" was a button that found nobody, month after
   month, and the register underneath it was permanently empty — while a menu
   entry called "Salary structure builder" pointed at that same screen and built
   nothing.

   Two things live here, because they have two different lifetimes. Components
   are the school's vocabulary — basic, HRA, provident fund — set up once and
   shared by everybody. A structure is one person's pay from one date, which
   changes when they are promoted.

   A raise is a new structure, not an edit. Editing would rewrite what somebody
   was paid last March, and a payslip already issued must keep the numbers it
   was issued with: the old row is closed the day before the new one starts, so
   the history reads as a career rather than as a current figure.
*/

type salaryComponent struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Sequence  int32   `json:"sequence"`
	IsPercent bool    `json:"is_percent"`
	PercentOf *string `json:"percent_of,omitempty"`
	Statutory bool    `json:"is_statutory"`
}

// The vocabulary every Indian school payslip is written in. Offered rather than
// imposed: a school with no components cannot type a salary, and asking them to
// invent the word "basic" before they can pay anybody is a blank page where a
// starting point belongs. Nothing is created until they ask for it.
var starterComponents = []salaryComponent{
	{Code: "BASIC", Name: "Basic pay", Kind: "earning", Sequence: 10},
	{Code: "DA", Name: "Dearness allowance", Kind: "earning", Sequence: 20},
	{Code: "HRA", Name: "House rent allowance", Kind: "earning", Sequence: 30,
		IsPercent: true, PercentOf: strptr("BASIC")},
	{Code: "CONVEY", Name: "Conveyance", Kind: "earning", Sequence: 40},
	{Code: "SPECIAL", Name: "Special allowance", Kind: "earning", Sequence: 50},
	{Code: "PF", Name: "Provident fund", Kind: "deduction", Sequence: 60,
		IsPercent: true, PercentOf: strptr("BASIC"), Statutory: true},
	{Code: "PT", Name: "Professional tax", Kind: "deduction", Sequence: 70, Statutory: true},
	{Code: "TDS", Name: "Income tax (TDS)", Kind: "deduction", Sequence: 80, Statutory: true},
}

func strptr(s string) *string { return &s }

// listSalaryComponents returns the school's pay components, and the starter set
// when it has none, so the screen can offer to create them in one click.
func (s *Server) listSalaryComponents(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := []salaryComponent{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, code, name, kind, sequence, is_percent, percent_of, is_statutory
			  FROM salary_components ORDER BY sequence, name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v salaryComponent
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.Kind, &v.Sequence,
				&v.IsPercent, &v.PercentOf, &v.Statutory); err != nil {
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
		"items": out, "suggested": starterComponents,
	})
}

// saveSalaryComponent adds or renames one component, or creates the starter set.
func (s *Server) saveSalaryComponent(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		Starters  bool    `json:"starters"`
		Code      string  `json:"code"`
		Name      string  `json:"name"`
		Kind      string  `json:"kind"`
		IsPercent bool    `json:"is_percent"`
		PercentOf *string `json:"percent_of"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a component.")
		return
	}

	wanted := []salaryComponent{}
	if in.Starters {
		wanted = starterComponents
	} else {
		code := strings.ToUpper(strings.TrimSpace(in.Code))
		name := strings.TrimSpace(in.Name)
		if code == "" || name == "" {
			httpx.BadRequest(w, r, "A component needs a short code and a name.")
			return
		}
		switch in.Kind {
		case "earning", "deduction", "employer_contribution":
		default:
			httpx.BadRequest(w, r, "A component is either something added to pay, something taken off, or the employer's own contribution.")
			return
		}
		wanted = append(wanted, salaryComponent{
			Code: code, Name: name, Kind: in.Kind, Sequence: 100,
			IsPercent: in.IsPercent, PercentOf: in.PercentOf,
		})
	}

	var made int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, c := range wanted {
			// ON CONFLICT DO NOTHING rather than upsert: pressing "set these up
			// for me" twice must not rewrite a component a school has since
			// adjusted.
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO salary_components
				       (institution_id, code, name, kind, sequence, is_percent,
				        percent_of, is_statutory)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, c.Code, c.Name, c.Kind, c.Sequence,
				c.IsPercent, c.PercentOf, c.Statutory)
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

type structureItem struct {
	ComponentID string   `json:"component_id"`
	Code        string   `json:"code"`
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Amount      int64    `json:"amount_paise"`
	Percent     *float64 `json:"percent,omitempty"`
}

type structureRow struct {
	EmployeeID string `json:"employee_id"`
	Code       string `json:"employee_code"`
	Name       string `json:"full_name"`
	// Null for somebody nobody has set a salary for — which is the state that
	// silently kept them out of every payroll run.
	StructureID   *string         `json:"structure_id,omitempty"`
	EffectiveFrom *string         `json:"effective_from,omitempty"`
	CTC           int64           `json:"ctc_paise"`
	Items         []structureItem `json:"items"`
}

// listSalaryStructures lists every active member of staff with their current
// pay, including the ones who have none.
func (s *Server) listSalaryStructures(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	out := []structureRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.employee_code,
			       concat_ws(' ', e.first_name, e.last_name),
			       ss.id::text, to_char(ss.effective_from, 'YYYY-MM-DD'),
			       COALESCE(ss.ctc_paise, 0)
			  FROM employees e
			  LEFT JOIN salary_structures ss
			    ON ss.employee_id = e.id AND ss.effective_to IS NULL
			 WHERE e.status = 'active'
			 ORDER BY e.employee_code`)
		if err != nil {
			return err
		}
		byStructure := map[string]int{}
		for rows.Next() {
			var v structureRow
			v.Items = []structureItem{}
			if err := rows.Scan(&v.EmployeeID, &v.Code, &v.Name,
				&v.StructureID, &v.EffectiveFrom, &v.CTC); err != nil {
				rows.Close()
				return err
			}
			if v.StructureID != nil {
				byStructure[*v.StructureID] = len(out)
			}
			out = append(out, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(byStructure) == 0 {
			return nil
		}

		// The lines, in one pass rather than one query per person.
		irows, err := tx.Query(r.Context(), `
			SELECT ssi.salary_structure_id::text, sc.id::text, sc.code, sc.name,
			       sc.kind, ssi.amount_paise, ssi.percent
			  FROM salary_structure_items ssi
			  JOIN salary_components sc ON sc.id = ssi.component_id
			 WHERE ssi.salary_structure_id = ANY($1)
			 ORDER BY sc.sequence, sc.name`, keysOf(byStructure))
		if err != nil {
			return err
		}
		defer irows.Close()
		for irows.Next() {
			var sid string
			var it structureItem
			if err := irows.Scan(&sid, &it.ComponentID, &it.Code, &it.Name,
				&it.Kind, &it.Amount, &it.Percent); err != nil {
				return err
			}
			if i, ok := byStructure[sid]; ok {
				out[i].Items = append(out[i].Items, it)
			}
		}
		return irows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func keysOf(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// saveSalaryStructure sets one person's pay from a date.
func (s *Server) saveSalaryStructure(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		EmployeeID    string `json:"employee_id"`
		EffectiveFrom string `json:"effective_from"`
		Items         []struct {
			ComponentID string   `json:"component_id"`
			Amount      int64    `json:"amount_paise"`
			Percent     *float64 `json:"percent"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a salary.")
		return
	}
	empID, err := uuid.Parse(strings.TrimSpace(in.EmployeeID))
	if err != nil {
		httpx.BadRequest(w, r, "Choose whose salary this is.")
		return
	}
	if strings.TrimSpace(in.EffectiveFrom) == "" {
		httpx.BadRequest(w, r, "Say which date this pay starts from.")
		return
	}
	if len(in.Items) == 0 {
		httpx.BadRequest(w, r, "A salary with no lines in it pays nothing. Add at least basic pay.")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Close the old one the day before the new one starts.

		   Not deleted: payslips already issued point at the run, not at the
		   structure, but the structure is the record of what was agreed and
		   when. A school that cannot show last year's salary letter cannot
		   answer a gratuity calculation or an audit. */
		if _, err := tx.Exec(r.Context(), `
			UPDATE salary_structures
			   SET effective_to = ($2::date - 1)
			 WHERE employee_id = $1 AND effective_to IS NULL
			   AND effective_from < $2::date`, empID, in.EffectiveFrom); err != nil {
			return err
		}
		// A structure starting the same day as the current one replaces it —
		// this is a correction, not a raise, and two rows starting on one day
		// is a payroll run that cannot choose between them.
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM salary_structures
			 WHERE employee_id = $1 AND effective_from = $2::date`,
			empID, in.EffectiveFrom); err != nil {
			return err
		}

		var total int64
		for _, it := range in.Items {
			total += it.Amount
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO salary_structures
			       (institution_id, employee_id, effective_from, ctc_paise)
			VALUES ($1, $2, $3::date, $4)
			RETURNING id::text`,
			id.InstitutionID, empID, in.EffectiveFrom, total*12).Scan(&newID); err != nil {
			return err
		}
		for _, it := range in.Items {
			cid, err := uuid.Parse(it.ComponentID)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO salary_structure_items
				       (institution_id, salary_structure_id, component_id,
				        amount_paise, percent)
				VALUES ($1, $2, $3, $4, $5)`,
				id.InstitutionID, newID, cid, it.Amount, it.Percent); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"structure_id": newID})
}
