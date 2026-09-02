// Package httpx holds the HTTP plumbing shared by the API and the
// server-rendered pages: JSON encoding, a stable error envelope, request
// context accessors, and the middleware stack.
package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

type ctxKey int

const (
	ctxRequestID ctxKey = iota
	ctxIdentity
)

// Identity is the authenticated caller, resolved once per request by the
// session middleware and read everywhere downstream.
type Identity struct {
	UserID        uuid.UUID
	InstitutionID uuid.UUID
	SessionID     uuid.UUID
	FullName      string
	// PlatformAdmin means the account belongs to no institution — platform
	// staff rather than school staff. It governs *reach* across tenants; it no
	// longer governs *capability*, which is the distinction below.
	PlatformAdmin bool
	// Restricted marks platform staff who hold only the permissions granted to
	// them. A vendor's billing administrator is platform-wide and must never
	// read a child's medical record; before this they inherited everything by
	// virtue of having no institution, which is exactly the over-collection
	// the DPDP Act makes expensive.
	Restricted bool
	// MustChangePassword is true while the account still carries the password
	// the office issued in bulk -- which is the person's own mobile number,
	// and therefore known to anybody holding the class list. Everything except
	// reading the session and setting a new one is refused until it is false.
	MustChangePassword bool
	Permissions        map[string]struct{}
}

func (i *Identity) Can(perm string) bool {
	if i == nil {
		return false
	}
	if i.PlatformAdmin && !i.Restricted {
		return true
	}
	_, ok := i.Permissions[perm]
	return ok
}

func WithIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, ctxIdentity, id)
}

func IdentityFrom(ctx context.Context) *Identity {
	id, _ := ctx.Value(ctxIdentity).(*Identity)
	return id
}

func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxRequestID, id)
}

func RequestIDFrom(ctx context.Context) string {
	s, _ := ctx.Value(ctxRequestID).(string)
	return s
}

// --- responses -------------------------------------------------------------

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// ErrorBody is the single error shape the SPA parses. Keeping one envelope
// means the client never has to guess whether it got {error}, {message}, or a
// bare string.
type ErrorBody struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id,omitempty"`
	} `json:"error"`
}

func Error(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	var b ErrorBody
	b.Error.Code = code
	b.Error.Message = msg
	b.Error.RequestID = RequestIDFrom(r.Context())
	JSON(w, status, b)
}

func Unauthorized(w http.ResponseWriter, r *http.Request) {
	Error(w, r, http.StatusUnauthorized, "unauthenticated", "sign in to continue")
}

func Forbidden(w http.ResponseWriter, r *http.Request, perm string) {
	Error(w, r, http.StatusForbidden, "forbidden", "missing permission: "+perm)
}

// Denied is Forbidden for a rule rather than a missing permission — a caller
// who holds users.write but still may not grant a platform role. The message
// is a whole sentence, so it must not be prefixed with "missing permission".
func Denied(w http.ResponseWriter, r *http.Request, msg string) {
	Error(w, r, http.StatusForbidden, "forbidden", msg)
}

func BadRequest(w http.ResponseWriter, r *http.Request, msg string) {
	Error(w, r, http.StatusBadRequest, "bad_request", msg)
}

func NotFound(w http.ResponseWriter, r *http.Request) {
	Error(w, r, http.StatusNotFound, "not_found", "resource not found")
}

// Internal logs the real cause and returns a generic message. The request_id
// in the response is the join key between what the user reports and the logs.
// LogError records a failure without answering the request, for handlers that
// render their own page rather than a JSON envelope.
func LogError(r *http.Request, err error) {
	slog.ErrorContext(r.Context(), "request failed",
		"error", err, "path", r.URL.Path, "request_id", RequestIDFrom(r.Context()))
}

func Internal(w http.ResponseWriter, r *http.Request, err error) {
	slog.ErrorContext(r.Context(), "request failed",
		"error", err,
		"path", r.URL.Path,
		"request_id", RequestIDFrom(r.Context()))
	Error(w, r, http.StatusInternalServerError, "internal", "something went wrong")
}

func Decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		BadRequest(w, r, "malformed JSON body")
		return false
	}
	return true
}
