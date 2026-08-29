package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The paperwork, checked off.

   application_documents has been in the schema since the first migration and
   nothing has ever written to it, so "Document Verification" was a list of
   applications with no documents on it. A clerk holding a birth certificate
   had nowhere to record that they had seen it.

   The checklist is seeded per application rather than kept as a school-wide
   template, because what a school asks for changes between sessions and an
   application checked in March should still show the list it was checked
   against.
*/

// defaultChecklist is what an Indian school asks for at admission.
//
// Required means the seat cannot be given without it; the rest are asked for
// where they apply — a caste certificate only for a reserved category, a
// transfer certificate only for a child arriving from another school.
var defaultChecklist = []struct {
	Type     string
	Required bool
}{
	{"Birth certificate", true},
	{"Aadhaar card", true},
	{"Passport photograph", true},
	{"Address proof", true},
	{"Transfer certificate", false},
	{"Previous report card", false},
	{"Caste certificate", false},
	{"Income certificate", false},
	{"Medical / immunisation record", false},
}

type applicationDocument struct {
	ID         string  `json:"id"`
	DocType    string  `json:"doc_type"`
	IsRequired bool    `json:"is_required"`
	Status     string  `json:"status"`
	Note       *string `json:"note,omitempty"`
	FileID     *string `json:"file_id,omitempty"`
	FileName   *string `json:"file_name,omitempty"`
	FileType   *string `json:"content_type,omitempty"`
	SizeBytes  *int64  `json:"size_bytes,omitempty"`
	VerifiedBy *string `json:"verified_by,omitempty"`
	VerifiedAt *string `json:"verified_at,omitempty"`
}

// listApplicationDocuments returns the checklist, seeding it on first open.
func (s *Server) listApplicationDocuments(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID := chi.URLParam(r, "id")

	var items []applicationDocument
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Seeded on first read rather than when the application is filed, so
		   applications raised before this existed get their checklist too —
		   and so a school that later adds a document type sees it appear on
		   the ones not yet checked. ON CONFLICT DO NOTHING makes the seeding
		   idempotent against the unique index. */
		for _, d := range defaultChecklist {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO application_documents
				       (institution_id, application_id, doc_type, is_required, status)
				SELECT $1, $2::uuid, $3, $4, 'pending'
				 WHERE EXISTS (SELECT 1 FROM applications WHERE id = $2::uuid)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, appID, d.Type, d.Required); err != nil {
				return err
			}
		}

		rows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.doc_type, d.is_required, d.status, d.note,
			       d.file_id::text, f.original_name, f.content_type, f.size_bytes,
			       u.full_name,
			       to_char(d.verified_at, 'YYYY-MM-DD')
			  FROM application_documents d
			  LEFT JOIN files f ON f.id = d.file_id AND f.deleted_at IS NULL
			  LEFT JOIN users u ON u.id = d.verified_by
			 WHERE d.application_id = $1::uuid
			 ORDER BY d.is_required DESC, d.doc_type`, appID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v applicationDocument
			var by *string
			if err := rows.Scan(&v.ID, &v.DocType, &v.IsRequired, &v.Status, &v.Note,
				&v.FileID, &v.FileName, &v.FileType, &v.SizeBytes, &by,
				&v.VerifiedAt); err != nil {
				return err
			}
			if by != nil && strings.TrimSpace(*by) != "" {
				v.VerifiedBy = by
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if items == nil {
		items = []applicationDocument{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type documentVerdict struct {
	Status string `json:"status"`
	Note   string `json:"note,omitempty"`
	FileID string `json:"file_id,omitempty"`
}

// decideApplicationDocument attaches a file, or records a verdict on one.
func (s *Server) decideApplicationDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	docID := chi.URLParam(r, "docID")
	var req documentVerdict
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Status = strings.TrimSpace(req.Status)
	if !oneOfStr(req.Status, "pending", "received", "verified", "rejected") {
		httpx.BadRequest(w, r, "status must be pending, received, verified or rejected")
		return
	}
	if req.Status == "rejected" && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r,
			"say what is wrong with it. The parent has to know what to bring back")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The verifier and the date are stamped only for a verdict, and
		   cleared when a document goes back to pending — otherwise a rejected
		   document keeps yesterday's "verified by" beside its rejection. */
		verdict := req.Status == "verified" || req.Status == "rejected"
		tag, err := tx.Exec(r.Context(), `
			UPDATE application_documents
			   SET status      = $2,
			       note        = nullif(btrim($3), ''),
			       file_id     = coalesce(nullif($4, '')::uuid, file_id),
			       verified_by = CASE WHEN $5 THEN $6::uuid END,
			       verified_at = CASE WHEN $5 THEN now() END,
			       updated_at  = now()
			 WHERE id = $1::uuid`,
			docID, req.Status, req.Note, req.FileID, verdict, id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.Error(w, r, http.StatusNotFound, "not_found",
			"that document is not on this application's checklist")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
