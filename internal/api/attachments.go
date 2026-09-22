package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A file on a message.

   The chat screens upload through POST /api/v1/files first and then send
   the message naming the file ids. The server does not trust the names and
   sizes the client sends back: it looks the ids up in files, within the
   school, and stores what the files table says. A message may be a file
   with no words. Ten per message, which is a stack of photos, not a dump. */

type attachment struct {
	ID          string `json:"file_id"`
	Name        string `json:"name"`
	Size        int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
	URL         string `json:"url"`
}

const maxAttachmentsPerMessage = 10

var errBadAttachment = errors.New("attachment")

// resolveAttachments checks the ids belong to files this school holds and
// returns the list as stored, with names and sizes from the files table.
func resolveAttachments(ctx context.Context, tx pgx.Tx, inst uuid.UUID, in []attachment) ([]attachment, error) {
	if len(in) == 0 {
		return []attachment{}, nil
	}
	if len(in) > maxAttachmentsPerMessage {
		return nil, errBadAttachment
	}
	ids := make([]uuid.UUID, 0, len(in))
	for _, a := range in {
		id, err := uuid.Parse(strings.TrimSpace(a.ID))
		if err != nil {
			return nil, errBadAttachment
		}
		ids = append(ids, id)
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, original_name, size_bytes, content_type
		  FROM files
		 WHERE id = ANY($1) AND institution_id = $2 AND deleted_at IS NULL`, ids, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]attachment{}
	for rows.Next() {
		var a attachment
		if err := rows.Scan(&a.ID, &a.Name, &a.Size, &a.ContentType); err != nil {
			return nil, err
		}
		a.URL = "/api/v1/files/" + a.ID
		byID[a.ID] = a
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]attachment, 0, len(ids))
	for _, id := range ids {
		a, ok := byID[id.String()]
		if !ok {
			return nil, errBadAttachment
		}
		out = append(out, a)
	}
	return out, nil
}

// attachmentsJSON is what goes in the jsonb column.
func attachmentsJSON(list []attachment) []byte {
	if list == nil {
		list = []attachment{}
	}
	b, _ := json.Marshal(list)
	return b
}

// scanAttachments turns the jsonb column back into the list; a null or
// broken column reads as none rather than failing the whole thread.
func scanAttachments(raw []byte) []attachment {
	var out []attachment
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return []attachment{}
	}
	return out
}

// attachmentsFor resolves a request's attachments inside the caller's
// scope and answers the request itself when they are not acceptable, so a
// handler needs one call and no new error branches.
func (s *Server) attachmentsFor(w http.ResponseWriter, r *http.Request, in []attachment) ([]attachment, bool) {
	id := httpx.IdentityFrom(r.Context())
	var out []attachment
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var e error
		out, e = resolveAttachments(r.Context(), tx, id.InstitutionID, in)
		return e
	})
	if errors.Is(err, errBadAttachment) {
		httpx.BadRequest(w, r, "one of the attached files is missing or is not this school's; upload it again")
		return nil, false
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return nil, false
	}
	return out, true
}
