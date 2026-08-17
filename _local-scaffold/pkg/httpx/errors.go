// Package httpx holds the HTTP plumbing every module shares: one error type,
// one response envelope, and the middleware chain.
package httpx

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is the only error type that crosses a module boundary on its way to a
// client. Code is a stable machine-readable string the frontend switches on;
// Message is safe to show a user; cause is logged and never serialised.
type Error struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Status  int            `json:"-"`
	Details map[string]any `json:"details,omitempty"`
	cause   error
}

func (e *Error) Error() string {
	if e.cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.cause }

// WithCause attaches the underlying error for the logs. The client never sees it.
func (e *Error) WithCause(err error) *Error {
	clone := *e
	clone.cause = err
	return &clone
}

// WithDetails attaches structured context — a field-level validation map, the
// conflicting resource's id, the permission that was missing.
func (e *Error) WithDetails(details map[string]any) *Error {
	clone := *e
	clone.Details = details
	return &clone
}

func New(status int, code, message string) *Error {
	return &Error{Code: code, Message: message, Status: status}
}

func BadRequest(code, message string) *Error   { return New(http.StatusBadRequest, code, message) }
func Unauthorized(code, message string) *Error { return New(http.StatusUnauthorized, code, message) }
func Forbidden(code, message string) *Error    { return New(http.StatusForbidden, code, message) }
func NotFound(code, message string) *Error     { return New(http.StatusNotFound, code, message) }
func Conflict(code, message string) *Error     { return New(http.StatusConflict, code, message) }

// Internal is deliberately vague to the caller. The cause goes to the logs with
// the request id, which is what support asks the user to quote.
func Internal(err error) *Error {
	return (&Error{
		Code:    "INTERNAL_ERROR",
		Message: "Something went wrong on our side. Quote the request id if you contact support.",
		Status:  http.StatusInternalServerError,
	}).WithCause(err)
}

// Common errors used across modules, so the codes stay consistent.
var (
	ErrUnauthenticated = Unauthorized("UNAUTHENTICATED", "Sign in to continue.")
	ErrSessionExpired  = Unauthorized("SESSION_EXPIRED", "Your session has expired. Sign in again.")
	ErrForbidden       = Forbidden("FORBIDDEN", "You do not have permission to do that.")
	ErrNoTenantContext = BadRequest("NO_TENANT_CONTEXT", "No school selected for this request.")
	ErrValidation      = BadRequest("VALIDATION_FAILED", "Some fields need attention.")
)

// PermissionDenied names the permission that was missing. Telling a user which
// permission they lack is not a security leak — it is the difference between a
// support ticket and a self-service fix.
func PermissionDenied(permission string) *Error {
	return Forbidden("PERMISSION_DENIED",
		"You do not have permission to do that.").
		WithDetails(map[string]any{"required_permission": permission})
}

// OutOfScope is a distinct failure from PermissionDenied: the caller holds the
// permission but not over this object — a teacher opening another teacher's
// class. Separating them makes the audit log far more readable.
func OutOfScope(resource string) *Error {
	return Forbidden("OUT_OF_SCOPE",
		"That "+resource+" is outside what you have been given access to.")
}

// AsError converts any error into an *Error, wrapping unrecognised ones as
// internal so a handler can never leak a driver message to a client.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return Internal(err)
}
