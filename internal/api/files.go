package api

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/storage"
)

type presignRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	Purpose     string `json:"purpose"`
}

// maxUploadBytes matches nginx's client_max_body_size so the two limits cannot
// drift. The browser uploads straight to R2, but keeping parity means a file
// that would be rejected by the proxy is also rejected here.
const maxUploadBytes = 16 << 20

var allowedUploadTypes = map[string]bool{
	"application/pdf": true,
	"image/jpeg":      true,
	"image/png":       true,
	"image/webp":      true,
	"text/csv":        true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
}

// presignUpload hands the client a short-lived R2 URL and records the intended
// file row up front, so an abandoned upload leaves a row we can garbage-collect
// rather than an orphaned object nobody knows about.
func (s *Server) presignUpload(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	if s.Storage == nil {
		// Production is running with R2_ACCOUNT_ID=REPLACE_ME, so this is the
		// live behaviour today. Say so plainly instead of failing at the PUT.
		httpx.Error(w, r, http.StatusServiceUnavailable, "storage_unconfigured",
			"file storage is not configured on this deployment")
		return
	}

	var req presignRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Filename = strings.TrimSpace(req.Filename)
	if req.Filename == "" {
		httpx.BadRequest(w, r, "filename is required")
		return
	}
	if req.SizeBytes <= 0 || req.SizeBytes > maxUploadBytes {
		httpx.BadRequest(w, r, "size_bytes must be between 1 and 16777216")
		return
	}
	if !allowedUploadTypes[req.ContentType] {
		httpx.BadRequest(w, r, "unsupported content_type: "+req.ContentType)
		return
	}
	if req.Purpose == "" {
		req.Purpose = "attachment"
	}

	key := storage.Key(id.InstitutionID, req.Purpose, req.Filename)
	up, err := s.Storage.PresignPut(r.Context(), key, req.ContentType, req.SizeBytes)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var fileID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO files (institution_id, object_key, original_name, content_type,
			                   size_bytes, purpose, uploaded_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, key, req.Filename, req.ContentType,
			req.SizeBytes, req.Purpose, id.UserID).Scan(&fileID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"file_id": fileID,
		"upload":  up,
	})
}
