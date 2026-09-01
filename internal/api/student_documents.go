package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The papers a family hands in.

   student_documents has been in the baseline since the beginning — file, type,
   who checked it and when — and nothing has ever written to it or read it. So
   the birth certificate and the Aadhaar scan the office takes at admission
   went into a filing cabinet, and the one question the Documents tab is
   actually opened for, "have we got their birth certificate", could not be
   answered from the child's record.

   THE TYPE IS FREE TEXT, deliberately. Schools ask for different papers — a
   caste certificate here, a migration certificate there, a guardian's employer
   letter somewhere else — and a fixed list of six is one somebody works around
   by filing the seventh thing under the nearest wrong heading. That is worse
   than free text, because it looks tidy and is untrue. The screen offers the
   common ones as suggestions and lets anything be typed.

   CHECKED IS A PERSON, NOT A FLAG. verified_by and verified_at are both set
   together, so "checked" always answers "by whom" — a green tick nobody is
   accountable for is what makes an inspection go badly.
*/

type studentDocumentRequest struct {
	DocType string `json:"doc_type"`
	// Already uploaded through /api/v1/files. The picker does that first, so
	// this endpoint never handles bytes.
	FileID string `json:"file_id"`
	Notes  string `json:"notes,omitempty"`
}

func (s *Server) addStudentDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req studentDocumentRequest
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
	if len(req.Notes) > 500 {
		httpx.BadRequest(w, r, "keep the note under 500 characters")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 4)

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The child is checked inside the INSERT rather than before it.

		   A separate SELECT then INSERT is two statements a teacher's scope
		   could change between, and more to the point it is a check somebody
		   can forget to write next time. The row cannot be created for a child
		   outside the caller's scope because the SELECT that feeds it returns
		   nothing. */
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_documents
			    (institution_id, student_id, file_id, doc_type, notes)
			SELECT $1, st.id, $2, $3, $4
			  FROM students st
			 WHERE st.id = $5 AND `+pred+`
			RETURNING id::text`,
			append([]any{id.InstitutionID, fileID, kind, nullString(req.Notes), sid},
				args...)...).Scan(&out)
	})
	if err == pgx.ErrNoRows {
		httpx.Forbidden(w, r, "this child is not one you can edit")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

// verifyStudentDocument records that somebody looked at the paper, and who.
func (s *Server) verifyStudentDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	did, err := uuid.Parse(chiURLParam(r, "docID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid document id")
		return
	}
	var req struct {
		// False un-checks it, for the copy that turns out to be the wrong
		// child's or too blurred to read.
		Verified bool `json:"verified"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 4)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Both columns move together in both directions. Clearing one and
		// leaving the other would produce a document checked at a time by
		// nobody, or by somebody at no time.
		var by any
		var at string
		if req.Verified {
			by, at = id.UserID, "now()"
		} else {
			by, at = nil, "NULL"
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_documents sd
			   SET verified_by = $1, verified_at = `+at+`
			 WHERE sd.id = $2
			   AND sd.student_id = $3
			   AND EXISTS (SELECT 1 FROM students st
			                WHERE st.id = sd.student_id AND `+pred+`)`,
			append([]any{by, did, sid}, args...)...)
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
		httpx.Forbidden(w, r, "that document is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"verified": req.Verified})
}

/* Removing a document takes the ROW, not the file.

   files is shared: the same upload can be a child's document and an
   attachment on a message, and deleting the blob because one reference went
   away would break the other. The row is the school saying "we no longer hold
   this as part of this child's record", which is what removing it means.
*/
func (s *Server) deleteStudentDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	did, err := uuid.Parse(chiURLParam(r, "docID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid document id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 3)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM student_documents sd
			 WHERE sd.id = $1 AND sd.student_id = $2
			   AND EXISTS (SELECT 1 FROM students st
			                WHERE st.id = sd.student_id AND `+pred+`)`,
			append([]any{did, sid}, args...)...)
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
		httpx.Forbidden(w, r, "that document is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

/* Fields a school invented, saved one block at a time.

   The record shows Details, Contact and Emergency, and every school has
   something none of them thought of — a bus stop, a second emergency number, a
   sibling's admission number. Sending the whole custom_fields map from each
   block would mean the block that knows only its own fields wipes the others,
   so this MERGES: keys present are set, keys absent are left alone.

   A BLANK VALUE REMOVES THE KEY. That gives one way to say "this field does
   not belong here after all", rather than a delete endpoint that would need
   its own permission, its own route and its own way of being got wrong.
*/
func (s *Server) saveStudentCustomFields(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
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

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 4)

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
			UPDATE students st
			   SET custom_fields = (st.custom_fields || $1::jsonb) - $2::text[],
			       updated_at = now()
			 WHERE st.id = $3 AND `+pred,
			append([]any{string(add), drop, sid}, args...)...)
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
		httpx.Forbidden(w, r, "this child is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": len(set), "removed": len(drop)})
}
