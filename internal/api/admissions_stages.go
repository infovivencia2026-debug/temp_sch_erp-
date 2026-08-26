package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Not every school tests, and not every school interviews.

   The admissions ladder was written as though all of them did: a form arrives,
   sits an entrance test, is interviewed, and is then approved. Plenty of
   schools do none of the middle — a village primary takes the form, checks the
   birth certificate and gives the seat — and for them two menu entries lead to
   a queue that will always be empty and a stage the child can never be moved
   past.

   So the two middle rungs are a school setting. Both default ON, because that
   is what every existing school has been running and a setting that changes
   behaviour on deploy is not a setting, it is a surprise.

   Held in module_settings, which already exists for exactly this and is
   already tenant-scoped, rather than in a new table for two booleans.
*/

// admissionStages is which optional rungs of the ladder this school uses.
type admissionStages struct {
	EntranceTest bool `json:"entrance_test"`
	Interview    bool `json:"interview"`
}

// stageKeys are the catalogue entries that disappear when a stage is off.
var stageKeys = map[string]bool{
	"admissions.applications.entrance_tests": true,
	"admissions.applications.interviews":     true,
}

// admissionStagesFor reads the setting, defaulting both on.
//
// A missing row, a null config and an unreadable one all mean "the school has
// not said", which is the same as "the school does both" — never fewer stages
// than the school had yesterday.
func admissionStagesFor(ctx context.Context, tx pgx.Tx) admissionStages {
	st := admissionStages{EntranceTest: true, Interview: true}
	var raw []byte
	err := tx.QueryRow(ctx,
		`SELECT config FROM module_settings WHERE module = 'admissions'`).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return st
	}
	/* Decoded into a map first, so a config that mentions only one of the two
	   leaves the other at its default rather than zeroing it — which is what
	   unmarshalling straight into the struct would do. */
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return st
	}
	if v, ok := m["entrance_test"].(bool); ok {
		st.EntranceTest = v
	}
	if v, ok := m["interview"].(bool); ok {
		st.Interview = v
	}
	return st
}

// stageAllowed reports whether a stage-gated catalogue key is in use here.
func (s *Server) stageAllowed(r *http.Request, key string) bool {
	id := httpx.IdentityFrom(r.Context())
	allowed := true
	_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		st := admissionStagesFor(r.Context(), tx)
		switch key {
		case "admissions.applications.entrance_tests":
			allowed = st.EntranceTest
		case "admissions.applications.interviews":
			allowed = st.Interview
		}
		return nil
	})
	return allowed
}

func (s *Server) getAdmissionStages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var st admissionStages
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		st = admissionStagesFor(r.Context(), tx)
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

func (s *Server) saveAdmissionStages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req admissionStages
	if !httpx.Decode(w, r, &req) {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		cfg, _ := json.Marshal(req)
		/* enabled stays true: the admissions module being on is a different
		   question from which of its optional stages this school runs, and
		   writing false here would switch the module off. */
		_, err := tx.Exec(r.Context(), `
			INSERT INTO module_settings (institution_id, module, enabled, config)
			VALUES ($1, 'admissions', true, $2::jsonb)
			ON CONFLICT (institution_id, module)
			DO UPDATE SET config = module_settings.config || EXCLUDED.config`,
			id.InstitutionID, cfg)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}
