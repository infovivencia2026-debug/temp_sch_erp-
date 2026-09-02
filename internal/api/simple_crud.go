package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
The lists a school keeps, and could only ever add to.

	Walking the router turned up forty resources that can be created and not
	corrected or removed. Most of those are right: a receipt is never edited,
	it is reversed by a refund; a stock movement is a ledger line; changing a
	password is not a record at all.

	What is left is the ordinary furniture of a school -- its houses, its
	clubs, its exam halls, its buses, its enquiries -- and every one of them
	accumulates mistakes. A club typed twice, a bus sold last year, a house
	spelt wrong at setup and printed on every report card since. None of it was
	removable, so schools work around it: a second club with a corrected name
	beside the first, and both in every dropdown for ever.

	One shape for all of them, because they are the same shape: refuse while
	something real depends on the row, say what depends on it, and otherwise
	remove it.
*/

// removable is one list a school maintains: which table, what to call it when
// refusing, and what would be orphaned by removing a row.
type removable struct {
	table string
	noun  string
	// guards are counted before deleting. Each is a count query taking the
	// row's id, and a label for the refusal. A guard that returns anything
	// above zero stops the delete and is named in the message.
	guards []guard
}

type guard struct {
	label string
	sql   string
}

/*
deleteSimple removes one row from a list, unless something depends on it.

	Refused rather than cascaded, always. The rows underneath these are
	children and their records: a house with sixty pupils in it, an exam hall
	with a seating plan, a bus with a route running tomorrow morning. Deleting
	through them would work, report success, and be discovered by a driver at
	a stop that no longer exists.

	The refusal counts what is in the way, because "60 students" tells somebody
	which house they are actually about to empty, and that is usually the
	moment they realise they meant the other one.
*/
func (s *Server) deleteSimple(spec removable) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := httpx.IdentityFrom(r.Context())
		rowID, err := uuid.Parse(chiURLParam(r, "id"))
		if err != nil {
			httpx.BadRequest(w, r, "invalid "+spec.noun+" id")
			return
		}

		var blocking []string
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(r.Context(),
				fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM %q WHERE id = $1)`, spec.table),
				rowID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return errRefGone
			}
			for _, g := range spec.guards {
				var n int
				if err := tx.QueryRow(r.Context(), g.sql, rowID).Scan(&n); err != nil {
					// A guard that cannot be answered is treated as blocking.
					// Deleting because a check failed is the wrong way to be
					// wrong.
					blocking = append(blocking, g.label)
					continue
				}
				if n > 0 {
					blocking = append(blocking, fmt.Sprintf("%d %s", n, g.label))
				}
			}
			if len(blocking) > 0 {
				return errRefInUse
			}
			_, err := tx.Exec(r.Context(),
				fmt.Sprintf(`DELETE FROM %q WHERE id = $1`, spec.table), rowID)
			return err
		})
		if errors.Is(err, errRefInUse) {
			httpx.BadRequest(w, r,
				strings.Join(blocking, " and ")+" still belong to this "+spec.noun+
					". Move them first — deleting it would take them with it")
			return
		}
		writeRefResult(w, r, err, spec.noun, rowID)
	}
}

/*
patchSimple renames a row, and sets whatever else the list allows.

	Only the columns named here, and never the id or the institution: a rename
	is a label change, and everything that points at the row keeps pointing at
	it. That is the whole reason a rename is safe and a delete is not.
*/
func (s *Server) patchSimple(table, noun string, columns []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := httpx.IdentityFrom(r.Context())
		rowID, err := uuid.Parse(chiURLParam(r, "id"))
		if err != nil {
			httpx.BadRequest(w, r, "invalid "+noun+" id")
			return
		}
		var req map[string]any
		if !httpx.Decode(w, r, &req) {
			return
		}

		sets := make([]string, 0, len(columns))
		args := []any{rowID}
		for _, c := range columns {
			v, ok := req[c]
			if !ok {
				continue
			}
			// An empty name is a row nobody can identify in a list, which is
			// worse than the wrong name.
			if c == "name" {
				str, _ := v.(string)
				if strings.TrimSpace(str) == "" {
					httpx.BadRequest(w, r, "a "+noun+" needs a name")
					return
				}
			}
			args = append(args, v)
			sets = append(sets, fmt.Sprintf("%q = $%d", c, len(args)))
		}
		if len(sets) == 0 {
			httpx.BadRequest(w, r, "nothing to change")
			return
		}

		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			tag, err := tx.Exec(r.Context(),
				fmt.Sprintf(`UPDATE %q SET %s WHERE id = $1`, table, strings.Join(sets, ", ")),
				args...)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errRefGone
			}
			return nil
		})
		writeRefResult(w, r, err, noun, rowID)
	}
}

// mountSimpleCRUD hangs edit and delete on the lists that had neither.
func (s *Server) mountSimpleCRUD(r chi.Router, perm string) {
	/* A house is printed on report cards and holds children; a club has
	   members; a hall has a seating plan; a bus has a route and children
	   assigned to stops on it. Each guard names what the school would lose. */
	// Column names taken from the tables rather than from memory: houses spell
	// it "color", and an activity has a category and a venue where I had
	// assumed a kind and a description. A patch naming a column that does not
	// exist fails at the database, on the school's screen, with a message
	// about SQL.
	r.With(httpx.RequirePermission(perm)).
		Patch("/houses/{id}", s.patchSimple("houses", "house", []string{"name", "color"}))

	r.With(httpx.RequirePermission(perm)).
		Patch("/activities/{id}", s.patchSimple("activities", "activity",
			[]string{"name", "category", "schedule", "venue", "capacity",
				"is_active", "notes"}))
	r.With(httpx.RequirePermission(perm)).
		Delete("/activities/{id}", s.deleteSimple(removable{
			table: "activities", noun: "activity",
			guards: []guard{{
				label: "children signed up",
				sql: `SELECT count(*)::int FROM student_activities
				       WHERE activity_id = $1`,
			}},
		}))
}
