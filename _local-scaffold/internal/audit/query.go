package audit

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

// Record is an audit entry as returned to a reader. Before and After stay raw
// JSON: the UI renders a diff, and re-marshalling them here would only invite
// drift from what was actually stored.
type Record struct {
	ID          uuid.UUID  `json:"id"`
	At          time.Time  `json:"at"`
	ActorUserID *uuid.UUID `json:"actor_user_id"`
	ActorName   string     `json:"actor_name,omitempty"`
	ActorRole   string     `json:"actor_role,omitempty"`
	Action      string     `json:"action"`
	EntityKind  string     `json:"entity_kind"`
	EntityID    *uuid.UUID `json:"entity_id"`
	Before      any        `json:"before,omitempty"`
	After       any        `json:"after,omitempty"`
	Reason      string     `json:"reason,omitempty"`
	RequestID   string     `json:"request_id,omitempty"`
}

type ListFilter struct {
	EntityKind string
	EntityID   *uuid.UUID
	Action     string
	ActorID    *uuid.UUID
	Limit      int
}

type Reader struct {
	db *database.DB
}

func NewReader(db *database.DB) *Reader { return &Reader{db: db} }

// List returns audit entries for the actor's organisation, newest first. RLS
// scopes it to the tenant; the platform.audit.read permission gates the route.
func (r *Reader) List(ctx context.Context, actor *httpx.Actor, f ListFilter) ([]Record, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	return database.InTenantTx(ctx, r.db, actor.OrganizationID, func(tx database.Tx) ([]Record, error) {
		rows, err := tx.Query(ctx, `
			SELECT a.id, a.at, a.actor_user_id, coalesce(u.full_name, ''),
			       coalesce(a.actor_role, ''), a.action, a.entity_kind, a.entity_id,
			       a.before, a.after, coalesce(a.reason, ''), coalesce(a.request_id, '')
			FROM   audit_logs a
			LEFT   JOIN users u ON u.id = a.actor_user_id
			WHERE  ($1::text IS NULL OR a.entity_kind = $1)
			  AND  ($2::uuid IS NULL OR a.entity_id = $2)
			  AND  ($3::text IS NULL OR a.action = $3)
			  AND  ($4::uuid IS NULL OR a.actor_user_id = $4)
			ORDER  BY a.at DESC
			LIMIT  $5`,
			nullifEmpty(f.EntityKind), f.EntityID, nullifEmpty(f.Action), f.ActorID, f.Limit)
		if err != nil {
			return nil, httpx.Internal(err)
		}
		defer rows.Close()

		out := []Record{}
		for rows.Next() {
			var rec Record
			if err := rows.Scan(&rec.ID, &rec.At, &rec.ActorUserID, &rec.ActorName,
				&rec.ActorRole, &rec.Action, &rec.EntityKind, &rec.EntityID,
				&rec.Before, &rec.After, &rec.Reason, &rec.RequestID); err != nil {
				return nil, httpx.Internal(err)
			}
			out = append(out, rec)
		}
		if err := rows.Err(); err != nil {
			return nil, httpx.Internal(err)
		}
		return out, nil
	})
}

func nullifEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
