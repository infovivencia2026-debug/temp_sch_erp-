// Package audit records who did what, in the same transaction as the change
// itself.
//
// That last part is the whole design. If the audit row were written after the
// commit, a crash between the two would leave a change nobody made. If it were
// written to a queue, a Redis outage would do the same. Writing it inside the
// caller's transaction means the change and its record commit together or not
// at all.
//
// The table has UPDATE and DELETE revoked from the application role, so this
// package can only ever append.
package audit

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

type Entry struct {
	OrganizationID uuid.UUID
	SchoolID       *uuid.UUID
	ActorUserID    *uuid.UUID
	ActorRole      string
	Action         string // e.g. "school.update"
	EntityKind     string // e.g. "school"
	EntityID       *uuid.UUID
	Before         any    // serialised to jsonb; nil for creates
	After          any    // serialised to jsonb; nil for deletes
	Reason         string // required by the caller for corrections and overrides
	IP             string
	UserAgent      string
	RequestID      string
}

type Writer struct{}

func NewWriter() *Writer { return &Writer{} }

// Write appends an entry using the caller's transaction. It never opens one of
// its own — that is what keeps it atomic with the business change.
func (w *Writer) Write(ctx context.Context, tx database.Tx, e Entry) error {
	if e.OrganizationID == uuid.Nil {
		return fmt.Errorf("audit: entry for %q has no organisation", e.Action)
	}
	if e.Action == "" || e.EntityKind == "" {
		return fmt.Errorf("audit: entry needs an action and an entity kind")
	}

	before, err := toJSON(e.Before)
	if err != nil {
		return fmt.Errorf("audit: encode before state: %w", err)
	}
	after, err := toJSON(e.After)
	if err != nil {
		return fmt.Errorf("audit: encode after state: %w", err)
	}

	var ip any
	if e.IP != "" {
		ip = e.IP
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO audit_logs (organization_id, school_id, actor_user_id, actor_role,
		                        action, entity_kind, entity_id, before, after,
		                        reason, ip, user_agent, request_id)
		VALUES ($1, $2, $3, nullif($4, ''), $5, $6, $7, $8, $9,
		        nullif($10, ''), $11, nullif($12, ''), nullif($13, ''))`,
		e.OrganizationID, e.SchoolID, e.ActorUserID, e.ActorRole,
		e.Action, e.EntityKind, e.EntityID, before, after,
		e.Reason, ip, e.UserAgent, e.RequestID)
	if err != nil {
		return fmt.Errorf("audit: write %q: %w", e.Action, err)
	}
	return nil
}

// FromActor pre-fills the who and the where from the request context, leaving
// the caller to describe only the what.
func FromActor(actor *httpx.Actor, requestID, ip, userAgent string) Entry {
	e := Entry{RequestID: requestID, IP: ip, UserAgent: userAgent}
	if actor != nil {
		e.OrganizationID = actor.OrganizationID
		e.ActorUserID = &actor.UserID
		e.ActorRole = actor.PrimaryRole()
		e.SchoolID = actor.SchoolID
	}
	return e
}

func toJSON(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return raw, nil
}
