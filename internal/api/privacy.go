package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
The school's privacy switches, and the one SQL fragment every alert shares.

	Who hears about a child is a policy decision a school makes once, not a
	choice each feature makes for it. The 2026-09-23 audit found marks and fee
	balances going to every linked guardian, relation 'other' included, from
	three different queries that each joined student_guardians their own way.
	guardianAlertFilter is the single answer, spliced into each of them:

	  - a link the school has blocked or ended never hears anything;
	  - with alerts_primary_only on (the default), only the primary guardian
	    hears -- unless the child has no primary on record, in which case
	    everyone linked does, because silence is the worse failure.

	The fragment assumes the guardian link is aliased `sg`.
*/
const guardianAlertFilter = `
	   AND NOT sg.portal_blocked
	   AND (sg.access_until IS NULL OR sg.access_until >= current_date)
	   AND (sg.is_primary
	        OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
	        OR NOT EXISTS (SELECT 1 FROM student_guardians p
	                        WHERE p.student_id = sg.student_id AND p.is_primary
	                          AND NOT p.portal_blocked
	                          AND (p.access_until IS NULL OR p.access_until >= current_date)))`

type privacySettings struct {
	AlertsPrimaryOnly      bool `json:"alerts_primary_only"`
	CredentialsByEmailOnly bool `json:"credentials_by_email_only"`
}

// getPrivacy powers the Privacy screen under Staff.
func (s *Server) getPrivacy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var out privacySettings
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT alerts_primary_only, credentials_by_email_only
			  FROM institutions WHERE id = $1`, id.InstitutionID).
			Scan(&out.AlertsPrimaryOnly, &out.CredentialsByEmailOnly)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) setPrivacy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req privacySettings
	if !httpx.Decode(w, r, &req) {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE institutions
			   SET alerts_primary_only = $2, credentials_by_email_only = $3, updated_at = now()
			 WHERE id = $1`, id.InstitutionID, req.AlertsPrimaryOnly, req.CredentialsByEmailOnly)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}

// credentialsByEmailOnly reads the school's switch inside a transaction that
// is about to send a login.
func credentialsByEmailOnly(ctx context.Context, tx pgx.Tx, inst any) bool {
	var v bool
	if err := tx.QueryRow(ctx, `SELECT credentials_by_email_only FROM institutions WHERE id = $1`, inst).Scan(&v); err != nil {
		return true
	}
	return v
}
