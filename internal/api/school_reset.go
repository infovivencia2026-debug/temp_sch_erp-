package api

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Emptying a school so real data can go in.

	A school evaluates this with invented children, invented staff and invented
	fees, decides to use it, and then cannot get rid of any of it. Every guard
	that protects live data works exactly as well against test data: a class
	will not delete because it has sections, a section will not delete because
	it has a register, a teacher will not delete because they are assigned to a
	class. Undoing an upload of twenty-two staff removed three and kept
	nineteen, all for good reasons.

	So the choice was to hand-unpick a school in the right order -- assignments,
	then timetable, then enrolments, then sections, then classes -- or to start
	the evaluation again on a new school and lose the settings they had spent a
	week getting right. Most people pick the second, and some pick neither and
	go elsewhere.

	This deletes the school's operational data in one action, and deliberately
	keeps three things:

	  the school itself, its campuses and its academic years -- what somebody
	  spent the week getting right, and the reason they do not want to start
	  over somewhere new;

	  the logins that can still get back in: anybody holding an admin role, so
	  the person pressing this is not locked out of the school they just
	  emptied;

	  nothing else. Children, staff, classes, marks, money and messages all go.

	Scoped to one institution by every statement, and it is not a superuser
	route: it needs the settings-write permission, which is the head's.
*/

// keptTables are never emptied. The school, the people who can still sign in,
// and the calendar everything else will be rebuilt against.
var keptTables = map[string]bool{
	"institutions": true, "campuses": true,
	"academic_years": true, "terms": true,
	// Logins and what they may do. Deleting these would lock out the person
	// who pressed the button, and take the school's own configured roles with
	// it -- neither of which is test data.
	"users": true, "roles": true, "user_roles": true, "role_permissions": true,
	// How the school is set up rather than what it has recorded.
	"module_settings": true, "institution_settings": true, "branding_profiles": true,
	"bell_schedules": true, "periods": true,
	// The record of imports is how somebody sees what this action removed, so
	// it outlives the rows it describes.
	"import_runs": true, "import_run_rows": true,
	// goose's own bookkeeping, which is not tenant data at all.
	"goose_db_version": true,
}

type resetResult struct {
	Table string `json:"table"`
	Rows  int64  `json:"rows"`
}

/*
resetSchool empties one school's records.

	The delete order is discovered rather than declared. There are over four
	hundred tenant tables and a hand-written order would be wrong within a
	week of somebody adding a foreign key -- so this simply tries every table,
	skips the ones a foreign key still protects, and goes round again. A pass
	that deletes nothing means what remains is genuinely unreachable, and it is
	reported rather than forced.

	One transaction: a half-emptied school is worse than a full one, because
	nobody can tell which half.
*/
func (s *Server) resetSchool(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req struct {
		// The school's own name, typed. Not a checkbox: this is the one
		// action in the product that cannot be undone at all, and the cost of
		// getting it wrong is a school's week of work. Typing the name is the
		// difference between deciding and clicking.
		Confirm string `json:"confirm"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}

	var name string
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, id.InstitutionID).Scan(&name)
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !strings.EqualFold(strings.TrimSpace(req.Confirm), strings.TrimSpace(name)) {
		httpx.BadRequest(w, r,
			"type the school's name exactly to confirm. Nothing has been deleted.")
		return
	}

	var out []resetResult
	var stuck []string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT c.table_name
			  FROM information_schema.columns c
			  JOIN information_schema.tables t
			    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			 WHERE c.column_name = 'institution_id'
			   AND c.table_schema = 'public'
			   AND t.table_type = 'BASE TABLE'`)
		if err != nil {
			return err
		}
		var tables []string
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err != nil {
				rows.Close()
				return err
			}
			if !keptTables[t] {
				tables = append(tables, t)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		sort.Strings(tables)

		total := map[string]int64{}
		remaining := tables
		for pass := 0; pass < 12 && len(remaining) > 0; pass++ {
			var blocked []string
			progress := false
			for _, t := range remaining {
				/* A savepoint per table, because one foreign key refusal must
				   not abort the whole transaction -- in Postgres any error
				   poisons the transaction until it is rolled back to a point
				   before it, and without this the first protected table would
				   end the entire reset. */
				if _, err := tx.Exec(r.Context(), "SAVEPOINT tbl"); err != nil {
					return err
				}
				tag, derr := tx.Exec(r.Context(),
					fmt.Sprintf(`DELETE FROM %q WHERE institution_id = $1`, t),
					id.InstitutionID)
				if derr != nil {
					if _, err := tx.Exec(r.Context(), "ROLLBACK TO SAVEPOINT tbl"); err != nil {
						return err
					}
					blocked = append(blocked, t)
					continue
				}
				if _, err := tx.Exec(r.Context(), "RELEASE SAVEPOINT tbl"); err != nil {
					return err
				}
				if n := tag.RowsAffected(); n > 0 {
					total[t] += n
					progress = true
				}
			}
			remaining = blocked
			// Nothing moved and something is still blocked: the rest is
			// genuinely unreachable, and going round again would only take
			// longer to say so.
			if !progress {
				break
			}
		}
		stuck = remaining

		for t, n := range total {
			out = append(out, resetResult{Table: t, Rows: n})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Rows > out[j].Rows })
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var deleted int64
	for _, x := range out {
		deleted += x.Rows
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"school": name, "deleted": deleted, "tables": out,
		// Named rather than hidden: a school that still has rows somewhere
		// should be told which, not left to find out when a list is not empty.
		"could_not_clear": stuck,
	})
}
