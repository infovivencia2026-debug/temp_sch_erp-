package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Groups of people the school defines for itself.

	Classes, sections and houses ship with the product. The swimming squad, the
	bus that leaves at 3.15, the twelve children a trust pays for, the four
	teachers trained on the new lab — those are the school's own groupings, and
	every one of them is currently a list in a notebook that somebody retypes
	into the message screen.

	THE FILTER IS AS CAPABLE AS A QUERY AND IS NOT ONE. The office picks a
	field, an operator and a value; the server turns that into SQL from a
	whitelist and nothing else. Storing a fragment of a query language in a
	jsonb column and executing it later is a saved injection, and "only
	administrators can reach the screen" is not an answer — an administrator
	should not be able to read another school's roll by writing a subquery into
	a group definition either.

	CUSTOM FIELDS ARE FILTERABLE. A school's own imported column — the bus
	stop, the scholarship number, the branch somebody was hired at — is exactly
	what they want to group by, and it is the half a product with fixed fields
	can never offer. custom:<label> reads students.custom_fields, which the
	importer now fills with everything it did not recognise.
*/

// groupRule is one line of the filter. Deliberately not a tree: an office
// building "class is 6 AND gender is female" wants a list of conditions, and
// nested any/all with brackets is a query builder nobody at a counter will use
// correctly. Every rule must hold.
type groupRule struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value string `json:"value,omitempty"`
}

type personGroup struct {
	ID      string      `json:"id"`
	Kind    string      `json:"kind"`
	Name    string      `json:"name"`
	Note    *string     `json:"note,omitempty"`
	Rules   []groupRule `json:"rules"`
	Members int         `json:"members"`
	// Picked names the hand-added half, so a screen can say "9 by rule, 3
	// added by hand" rather than one number that hides where it came from.
	Picked int `json:"picked"`
}

/* THE FIELDS A RULE MAY NAME, and the SQL each one is.

   A map, not a string built from what arrived: the value is parameterised, and
   the column is looked up here or the rule is refused. Nothing a caller sends
   ever reaches the query as text.

   The expressions are written against the aliases the member query below
   establishes (st, c, sec for a child; e, d, g for a member of staff), so the
   two have to move together — hence the table names in the comments. */
var studentGroupFields = map[string]string{
	"class":         "c.name",
	"section":       "sec.name",
	"gender":        "st.gender",
	"status":        "st.status",
	"blood_group":   "st.blood_group",
	"medium":        "st.medium",
	"mother_tongue": "st.mother_tongue",
	"city":          "st.city",
	"state":         "st.state",
	"admission_no":  "st.admission_no",
	"person_code":   "st.person_code",
	"name":          "trim(concat_ws(' ', st.first_name, st.middle_name, st.last_name))",
}

var staffGroupFields = map[string]string{
	"designation":     "COALESCE(d.name,'')",
	"department":      "COALESCE(dep.name,'')",
	"employment_type": "e.employment_type",
	"status":          "e.status",
	"employee_code":   "e.employee_code",
	"person_code":     "e.person_code",
	"name":            "trim(concat_ws(' ', e.first_name, e.last_name))",
}

// The operators, each with the SQL shape it takes. Same reasoning as the
// fields: an operator that is not on this list does not exist.
var groupOps = map[string]string{
	"is":       "lower(%s) = lower($%d)",
	"is_not":   "lower(%s) <> lower($%d)",
	"contains": "%s ILIKE '%%' || $%d || '%%'",
	"starts":   "%s ILIKE $%d || '%%'",
	"is_set":   "COALESCE(%s::text,'') <> ''",
	"is_empty": "COALESCE(%s::text,'') = ''",
}

var errUnknownField = errors.New("that field cannot be filtered on")

/*
buildRules turns the office's choices into a WHERE fragment and its arguments.

	`next` is the number the caller's own parameters have reached, so this can
	be spliced into a query that already has some. Returned as ("", nil) for no
	rules, which the caller reads as "the hand-picked half only" rather than as
	"everybody".
*/
func buildRules(kind string, rules []groupRule, next int) (string, []any, error) {
	fields := studentGroupFields
	if kind == "staff" {
		fields = staffGroupFields
	}
	var (
		parts []string
		args  []any
	)
	for _, rule := range rules {
		name := strings.TrimSpace(rule.Field)
		op, ok := groupOps[strings.TrimSpace(rule.Op)]
		if !ok {
			return "", nil, fmt.Errorf("unknown filter %q", rule.Op)
		}

		var column string
		if label, isCustom := strings.CutPrefix(name, "custom:"); isCustom {
			/* The school's own imported column. The label is a value, not a
			   column name — it goes in as a parameter and Postgres looks it up
			   inside the jsonb, so a label with a quote in it is a label with a
			   quote in it and nothing more. */
			if strings.TrimSpace(label) == "" {
				return "", nil, errUnknownField
			}
			args = append(args, strings.TrimSpace(label))
			table := "st"
			if kind == "staff" {
				table = "e"
			}
			column = fmt.Sprintf("(%s.custom_fields ->> $%d)", table, next)
			next++
		} else {
			column, ok = fields[name]
			if !ok {
				return "", nil, fmt.Errorf("%w: %s", errUnknownField, name)
			}
		}

		if rule.Op == "is_set" || rule.Op == "is_empty" {
			parts = append(parts, fmt.Sprintf(op, column))
			continue
		}
		if strings.TrimSpace(rule.Value) == "" {
			return "", nil, fmt.Errorf("the %s filter needs a value", name)
		}
		args = append(args, strings.TrimSpace(rule.Value))
		parts = append(parts, fmt.Sprintf(op, column, next))
		next++
	}
	if len(parts) == 0 {
		return "", nil, nil
	}
	return "(" + strings.Join(parts, " AND ") + ")", args, nil
}

// memberQuery is the one place that knows how to find the people in a group:
// everybody the rules match, plus everybody added by hand, once each.
func memberQuery(kind, where string) string {
	if kind == "staff" {
		return `
			SELECT DISTINCT e.id::text, trim(concat_ws(' ', e.first_name, e.last_name)),
			       COALESCE(e.person_code,''), COALESCE(e.employee_code,''),
			       COALESCE(d.name,''), (m.group_id IS NOT NULL) AS picked
			  FROM employees e
			  LEFT JOIN designations d ON d.id = e.designation_id
			  LEFT JOIN departments dep ON dep.id = e.department_id
			  LEFT JOIN person_group_members m
			         ON m.employee_id = e.id AND m.group_id = $1
			 WHERE m.group_id IS NOT NULL` + where + `
			 ORDER BY 2`
	}
	return `
		SELECT DISTINCT st.id::text,
		       trim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)),
		       COALESCE(st.person_code,''), st.admission_no,
		       trim(concat_ws(' ', COALESCE(c.name,''), COALESCE(sec.name,''))),
		       (m.group_id IS NOT NULL) AS picked
		  FROM students st
		  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN classes c ON c.id = sec.class_id
		  LEFT JOIN person_group_members m
		         ON m.student_id = st.id AND m.group_id = $1
		 WHERE m.group_id IS NOT NULL` + where + `
		 ORDER BY 2`
}

type groupMember struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Code   string `json:"person_code"`
	Ref    string `json:"ref"`
	Detail string `json:"detail"`
	// Picked is true for somebody added by hand rather than found by the rule.
	Picked bool `json:"picked"`
}

func (s *Server) listPersonGroups(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind != "student" && kind != "staff" {
		httpx.BadRequest(w, r, "kind must be student or staff")
		return
	}

	out := []personGroup{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.kind, g.name, g.note, g.rules,
			       (SELECT count(*) FROM person_group_members m WHERE m.group_id = g.id)
			  FROM person_groups g
			 WHERE g.kind = $1
			 ORDER BY lower(g.name)`, kind)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var g personGroup
			var raw []byte
			if err := rows.Scan(&g.ID, &g.Kind, &g.Name, &g.Note, &raw, &g.Picked); err != nil {
				return err
			}
			g.Rules = []groupRule{}
			_ = json.Unmarshal(raw, &g.Rules)
			out = append(out, g)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type groupWriteRequest struct {
	Kind  string      `json:"kind"`
	Name  string      `json:"name"`
	Note  string      `json:"note,omitempty"`
	Rules []groupRule `json:"rules"`
}

func (s *Server) savePersonGroup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req groupWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "a group needs a name")
		return
	}
	if req.Kind != "student" && req.Kind != "staff" {
		httpx.BadRequest(w, r, "kind must be student or staff")
		return
	}
	if req.Rules == nil {
		req.Rules = []groupRule{}
	}
	// Validated at save rather than only at read: a rule that cannot be built
	// is a group that silently has no members, discovered by somebody sending
	// a message to nobody.
	if _, _, err := buildRules(req.Kind, req.Rules, 1); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	raw, _ := json.Marshal(req.Rules)

	existing := chi.URLParam(r, "id")
	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if existing != "" {
			gid, perr := uuid.Parse(existing)
			if perr != nil {
				return perr
			}
			return tx.QueryRow(r.Context(), `
				UPDATE person_groups
				   SET name = $2, note = NULLIF($3,''), rules = $4::jsonb, updated_at = now()
				 WHERE id = $1
				RETURNING id::text`, gid, req.Name, req.Note, raw).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO person_groups (institution_id, kind, name, note, rules, created_by)
			VALUES ($1,$2,$3,NULLIF($4,''),$5::jsonb,$6)
			RETURNING id::text`,
			id.InstitutionID, req.Kind, req.Name, req.Note, raw, id.UserID).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil && isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "group_exists",
			"this school already has a group with that name")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "name": req.Name})
}

func (s *Server) deletePersonGroup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid group id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The group goes; the people in it are untouched, which is the whole
		// difference between a grouping and a record.
		_, err := tx.Exec(r.Context(), `DELETE FROM person_groups WHERE id = $1`, gid)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// listGroupMembers answers who is in a group right now — rule and hand-picked
// together, because that is the list somebody is about to message.
func (s *Server) listGroupMembers(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid group id")
		return
	}

	out := []groupMember{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var kind string
		var raw []byte
		if err := tx.QueryRow(r.Context(),
			`SELECT kind, rules FROM person_groups WHERE id = $1`, gid).
			Scan(&kind, &raw); err != nil {
			return err
		}
		var rules []groupRule
		_ = json.Unmarshal(raw, &rules)

		where, args, berr := buildRules(kind, rules, 2)
		if berr != nil {
			return berr
		}
		clause := ""
		if where != "" {
			clause = " OR " + where
		}
		rows, qerr := tx.Query(r.Context(), memberQuery(kind, clause),
			append([]any{gid}, args...)...)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var m groupMember
			if err := rows.Scan(&m.ID, &m.Name, &m.Code, &m.Ref, &m.Detail, &m.Picked); err != nil {
				return err
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out, "count": len(out)})
}

type groupMemberRequest struct {
	// Student or employee ids, whichever the group is for.
	IDs []string `json:"ids"`
}

func (s *Server) addGroupMembers(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid group id")
		return
	}
	var req groupMemberRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	added := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var kind string
		if err := tx.QueryRow(r.Context(),
			`SELECT kind FROM person_groups WHERE id = $1`, gid).Scan(&kind); err != nil {
			return err
		}
		for _, raw := range req.IDs {
			pid, perr := uuid.Parse(strings.TrimSpace(raw))
			if perr != nil {
				continue
			}
			column := "student_id"
			if kind == "staff" {
				column = "employee_id"
			}
			// ON CONFLICT: adding somebody twice is a person pressing a button
			// twice, not an error worth failing the rest of the batch for.
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO person_group_members (group_id, institution_id, `+column+`, added_by)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT DO NOTHING`, gid, id.InstitutionID, pid, id.UserID)
			if err != nil {
				return err
			}
			added += int(tag.RowsAffected())
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"added": added})
}

func (s *Server) removeGroupMember(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid group id")
		return
	}
	pid, err := uuid.Parse(chi.URLParam(r, "personID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid person id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Only the hand-picked half can be removed. Somebody the rule finds is
		   in the group because they are in Class 6, and taking them out here
		   would be a hidden exception nobody could see on the rule — the
		   answer is to change the rule. */
		_, err := tx.Exec(r.Context(), `
			DELETE FROM person_group_members
			 WHERE group_id = $1 AND (student_id = $2 OR employee_id = $2)`, gid, pid)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
}

/*
getGroupFields tells the screen what may be filtered on, including this
school's own imported columns.

	The custom labels are read out of the data rather than from a registry,
	because there is no registry: the importer writes whatever the school's
	spreadsheet had. A school that imported a "Bus stop" column can group by
	bus stop the moment the import finishes, without anybody adding a field to
	this product.
*/
func (s *Server) getGroupFields(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind != "student" && kind != "staff" {
		httpx.BadRequest(w, r, "kind must be student or staff")
		return
	}

	fields := studentGroupFields
	table := "students"
	if kind == "staff" {
		fields = staffGroupFields
		table = "employees"
	}
	names := make([]string, 0, len(fields))
	for k := range fields {
		names = append(names, k)
	}

	custom := []string{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT DISTINCT k FROM `+table+`, jsonb_object_keys(custom_fields) AS k
			 ORDER BY k LIMIT 60`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			custom = append(custom, k)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	ops := make([]string, 0, len(groupOps))
	for k := range groupOps {
		ops = append(ops, k)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fields": names,
		// Sent separately so the screen can label them as the school's own.
		"custom_fields": custom,
		"ops":           ops,
	})
}

/*
mountPersonGroups sits beside the people it groups.

	Reading a group needs only the right to read the people in it; making one
	needs the right to change them, because a group is a thing the school
	publishes to itself and a bad one sends a message to the wrong families.
*/
func (s *Server) mountPersonGroups(r chi.Router) {
	studentRead := httpx.RequirePermission(rbac.StudentsRead)
	studentWrite := httpx.RequirePermission(rbac.StudentsWrite)

	r.With(studentRead).Get("/people/groups", s.listPersonGroups)
	r.With(studentRead).Get("/people/group-fields", s.getGroupFields)
	r.With(studentRead).Get("/people/groups/{id}/members", s.listGroupMembers)
	r.With(studentWrite).Post("/people/groups", s.savePersonGroup)
	r.With(studentWrite).Put("/people/groups/{id}", s.savePersonGroup)
	r.With(studentWrite).Delete("/people/groups/{id}", s.deletePersonGroup)
	r.With(studentWrite).Post("/people/groups/{id}/members", s.addGroupMembers)
	r.With(studentWrite).Delete("/people/groups/{id}/members/{personID}", s.removeGroupMember)
}
