package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/scope"
)

/* THE DIGITAL LIBRARY: WHO A THING IS FOR, AND WHO HAS OPENED IT.

   study_materials always had two widths of audience, a section and a
   subject's class, and a third by accident: a row with neither was the
   whole school's. Migration 00334 makes the third deliberate and adds a
   fourth, a list of named children, for the worksheet that is five
   families' business and not the class's. This file holds what that needs
   beyond teaching.go's create and list: the reach check for a list of
   children, the expiry a teacher may put on a post, the "seen by" list a
   teacher reads, and the mark a reader leaves when they open something.

   Access control is the same three tests everywhere: a section is shareable
   when the caller teaches it, a child when the caller's student predicate
   reaches them, the whole school only by somebody whose scope already is
   the whole school. The feed (student_learning.go) reads the same columns
   back, so a child sees exactly the union of what was addressed to their
   section, their class's subjects, the school and themselves. */

// materialAudiences are the values study_materials.audience may hold.
var materialAudiences = map[string]bool{"class": true, "school": true, "students": true}

// materialExpiry turns "show for N days" into a timestamp, or nothing.
func materialExpiry(days *int) *time.Time {
	if days == nil || *days <= 0 {
		return nil
	}
	t := time.Now().Add(time.Duration(*days) * 24 * time.Hour)
	return &t
}

// parseStudentIDs parses the target list, refusing an empty or malformed one.
func parseStudentIDs(raw []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(raw))
	seen := map[uuid.UUID]bool{}
	for _, s := range raw {
		v, err := uuid.Parse(s)
		if err != nil {
			return nil, errors.New("student_ids must be uuids")
		}
		if !seen[v] {
			seen[v] = true
			ids = append(ids, v)
		}
	}
	if len(ids) == 0 {
		return nil, errors.New("name at least one student")
	}
	return ids, nil
}

// studentsInReach is true when every id names a child the caller may
// address: the same predicate that decides which children they can list.
func studentsInReach(ctx context.Context, tx pgx.Tx, res *scope.Resolved, ids []uuid.UUID) (bool, error) {
	if res.AllStudents {
		return true, nil
	}
	pred, args := res.StudentPredicate("st", 2)
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM students st
		 WHERE st.id = ANY($1) AND `+pred, append([]any{ids}, args...)...).Scan(&n)
	if err != nil {
		return false, err
	}
	return n == len(ids), nil
}

// insertMaterialTargets records who a 'students' post is for.
func insertMaterialTargets(ctx context.Context, tx pgx.Tx, institutionID, materialID uuid.UUID, ids []uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO study_material_targets (institution_id, material_id, student_id)
		SELECT $1, $2, unnest($3::uuid[])
		ON CONFLICT (material_id, student_id) DO NOTHING`,
		institutionID, materialID, ids)
	return err
}

// materialOwnedOrInReach is materialInReach plus the one case it did not
// know: a post addressed to named children has no section and no subject,
// and belongs to whoever posted it.
func materialOwnedOrInReach(ctx context.Context, tx pgx.Tx, res *scope.Resolved, id uuid.UUID) error {
	var csID, secID, by *uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT class_subject_id, section_id, uploaded_by FROM study_materials WHERE id = $1`,
		id).Scan(&csID, &secID, &by); err != nil {
		return err
	}
	if by != nil && *by == res.UserID {
		return nil
	}
	return materialInReach(ctx, tx, res, csID, secID)
}

type materialView struct {
	Name     string  `json:"name"`
	Student  *string `json:"student,omitempty"`
	ViewedAt string  `json:"viewed_at"`
}

// listMaterialViews is the teacher's "seen by": every reader who has opened
// the material, newest first, with the child a guardian was reading as.
func (s *Server) listMaterialViews(w http.ResponseWriter, r *http.Request) {
	mID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid material id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var items []materialView
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := materialOwnedOrInReach(r.Context(), tx, res, mID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT u.full_name,
			       CASE WHEN st.id IS NULL THEN NULL
			            ELSE concat_ws(' ', st.first_name, st.middle_name, st.last_name) END,
			       to_char(v.viewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM study_material_views v
			  JOIN users u ON u.id = v.user_id
			  LEFT JOIN students st ON st.id = v.student_id
			 WHERE v.material_id = $1
			 ORDER BY v.viewed_at DESC
			 LIMIT 500`, mID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v materialView
			if err := rows.Scan(&v.Name, &v.Student, &v.ViewedAt); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	if items == nil {
		items = []materialView{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// markResourceSeen is the reader's side: the first opening is kept, later
// ones change nothing. A guardian's mark names the child they were reading
// as, so the teacher's list says which family has seen it.
func (s *Server) markResourceSeen(w http.ResponseWriter, r *http.Request) {
	mID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid material id")
		return
	}
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO study_material_views (institution_id, material_id, user_id, student_id)
			SELECT $1, sm.id, $3, $4
			  FROM study_materials sm
			 WHERE sm.id = $2 AND sm.is_published
			ON CONFLICT (material_id, user_id) DO NOTHING`,
			id.InstitutionID, mID, id.UserID, student)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
