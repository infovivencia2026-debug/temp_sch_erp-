package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What one school was promised, against what its tier includes.

   The entitlement matrix answers "may this school use the hostel module" — a
   yes or a no per module. It cannot answer "this school negotiated 50GB and the
   Basic tier includes 10", because that is a number, not a switch, and there
   was nowhere to put it.

   Two levels, and the screen shows both: the plan's figure is what the tier
   includes, the subscription's is what this school was actually promised. An
   override that equals the plan is still worth storing — it says somebody
   looked, and it survives the tier being re-priced underneath them.

   Students already worked this way (subscriptions.licensed_students), which is
   why this reads as a pair rather than an invention: storage is being given the
   shape students already had. */

type tenantLimits struct {
	InstitutionID string `json:"institution_id"`
	School        string `json:"school"`
	PlanCode      string `json:"plan_code,omitempty"`
	PlanName      string `json:"plan_name,omitempty"`

	// What the tier includes. NULL — sent as nil — means unlimited.
	PlanStudents *int `json:"plan_students,omitempty"`
	PlanStorage  *int `json:"plan_storage_gb,omitempty"`

	// What this school was promised instead, if anything.
	OverrideStudents *int `json:"override_students,omitempty"`
	OverrideStorage  *int `json:"override_storage_gb,omitempty"`

	// What is actually being used, so a limit can be judged rather than guessed.
	Students    int   `json:"students"`
	StoredBytes int64 `json:"stored_bytes"`
}

// listTenantLimits is the per-school limits table behind the entitlement matrix.
func (s *Server) listTenantLimits(w http.ResponseWriter, r *http.Request) {
	items := []tenantLimits{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name,
			       COALESCE(sub.plan_code, ''), COALESCE(p.name, ''),
			       p.max_students, p.max_storage_gb,
			       sub.licensed_students, sub.storage_gb,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int,
			       COALESCE((SELECT sum(f.size_bytes) FROM files f
			         WHERE f.institution_id = i.id AND f.deleted_at IS NULL), 0)
			  FROM institutions i
			  LEFT JOIN subscriptions sub ON sub.institution_id = i.id
			  LEFT JOIN plans p ON p.code = sub.plan_code
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tenantLimits
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.PlanCode, &v.PlanName,
				&v.PlanStudents, &v.PlanStorage, &v.OverrideStudents, &v.OverrideStorage,
				&v.Students, &v.StoredBytes); err != nil {
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

type limitsRequest struct {
	InstitutionID string `json:"institution_id"`
	// Absent leaves the limit alone; null clears it back to the plan's.
	Students *int `json:"licensed_students"`
	Storage  *int `json:"storage_gb"`
}

// setTenantLimits records what one school was promised.
func (s *Server) setTenantLimits(w http.ResponseWriter, r *http.Request) {
	var req limitsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	iid, err := uuid.Parse(strings.TrimSpace(req.InstitutionID))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id must be a uuid")
		return
	}
	for _, v := range []*int{req.Students, req.Storage} {
		if v != nil && *v < 0 {
			httpx.BadRequest(w, r, "a limit cannot be negative — leave it blank for the plan's own")
			return
		}
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* Only a school that has a subscription can be promised something
		   different from its plan. One with none has no plan to differ from,
		   and writing a row here would invent a subscription by the back door
		   — which is how a school ends up billed for a tier nobody sold it. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE subscriptions
			   SET licensed_students = $2, storage_gb = $3, updated_at = now()
			 WHERE institution_id = $1`, iid, req.Students, req.Storage)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.Error(w, r, http.StatusConflict, "no_subscription",
			"that school is not on a plan yet, so there is nothing to vary. Put it on a plan first.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}
