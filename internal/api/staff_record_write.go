package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The staff record, brought level with the child's.

   Student 360 gained a photograph, the papers a family hands in, and fields a
   school invents. The staff directory had none of the three: employees carries
   photo_file_id and nothing wrote it, employee_documents could be listed and
   not added, and there was nowhere at all for the things a school keeps about
   a teacher that we did not think of — a PF number, a UDISE code, the date a
   police verification lapses.

   The asymmetry had no reason behind it. A school holds as much paper on a
   teacher as on a child, and rather more of it is statutory.
*/

// setStaffPhoto puts a face on the record. Same shape as the child's: a file
// already uploaded, and empty removes it — which is what a school does when a
// picture is wrong rather than missing.
func (s *Server) setStaffPhoto(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var req struct {
		FileID string `json:"file_id"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	var file *uuid.UUID
	if v := strings.TrimSpace(req.FileID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		file = &parsed
	}

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE employees SET photo_file_id = $2, updated_at = now() WHERE id = $1`,
			eid, file)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

/* The papers a school holds on a teacher.

   employee_documents has been listable since it was written and never
   writable, so the degree certificate, the police verification and the
   Aadhaar copy the office takes at joining went into a drawer — and the
   expiry the list screen warns about could only ever be warned about for
   documents nobody could add.

   THE EXPIRY IS THE POINT and is why this is not the student version. A
   child's birth certificate does not lapse; a teacher's police verification,
   medical fitness and contract all do, and the directory already has a screen
   that counts what expires in the next sixty days.
*/
type staffDocumentRequest struct {
	DocType   string `json:"doc_type"`
	FileID    string `json:"file_id"`
	ExpiresOn string `json:"expires_on,omitempty"`
}

func (s *Server) addStaffDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var req staffDocumentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	kind := strings.TrimSpace(req.DocType)
	if kind == "" {
		httpx.BadRequest(w, r, "say what the document is")
		return
	}
	if len(kind) > 80 {
		httpx.BadRequest(w, r, "keep the document name under 80 characters")
		return
	}
	fileID, err := uuid.Parse(strings.TrimSpace(req.FileID))
	if err != nil {
		httpx.BadRequest(w, r, "choose a file first")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO employee_documents (institution_id, employee_id, file_id,
			                                doc_type, expires_on)
			SELECT $1, e.id, $2, $3, NULLIF($4,'')::date
			  FROM employees e WHERE e.id = $5
			RETURNING id::text`,
			id.InstitutionID, fileID, kind, req.ExpiresOn, eid).Scan(&out)
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

/* Removing a document takes the ROW, not the file.

   files is shared: the same upload can be a teacher's certificate and an
   attachment on a message, and deleting the blob because one reference went
   away would break the other.
*/
func (s *Server) deleteStaffDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	did, err := uuid.Parse(chiURLParam(r, "docID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid document id")
		return
	}
	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM employee_documents WHERE id = $1 AND employee_id = $2`,
			did, eid)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_theirs",
			"that document is not on this member of staff")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

/* Fields a school invented, on a staff record.

   MERGED, NOT ASSIGNED, for the reason the student version is: a screen that
   knows about three fields must not erase a fourth it has never heard of, and
   two screens editing different blocks of one record must not undo each other.

   A BLANK VALUE REMOVES THE KEY, which gives one way to say "this does not
   belong here after all" rather than a delete endpoint with its own
   permission and its own way of being got wrong.
*/
func (s *Server) saveStaffCustomFields(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var req struct {
		CustomFields map[string]string `json:"custom_fields"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.CustomFields) == 0 {
		httpx.BadRequest(w, r, "nothing to save")
		return
	}
	if len(req.CustomFields) > 40 {
		httpx.BadRequest(w, r, "that is more fields than one save should carry")
		return
	}
	set := map[string]string{}
	var drop []string
	for k, v := range req.CustomFields {
		k = strings.TrimSpace(k)
		if k == "" {
			httpx.BadRequest(w, r, "a field needs a name")
			return
		}
		if len(k) > 80 || len(v) > 500 {
			httpx.BadRequest(w, r,
				"keep a field's name under 80 characters and its value under 500")
			return
		}
		if strings.TrimSpace(v) == "" {
			drop = append(drop, k)
			continue
		}
		set[k] = v
	}

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		add := []byte("{}")
		if len(set) > 0 {
			b, err := json.Marshal(set)
			if err != nil {
				return err
			}
			add = b
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE employees
			   SET custom_fields = (custom_fields || $1::jsonb) - $2::text[],
			       updated_at = now()
			 WHERE id = $3`, string(add), drop, eid)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": len(set), "removed": len(drop)})
}
