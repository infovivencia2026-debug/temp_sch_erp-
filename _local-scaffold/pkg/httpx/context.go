package httpx

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Keys under which the middleware chain stores the resolved request context.
const (
	ctxRequestID = "erp.request_id"
	ctxActor     = "erp.actor"
)

// Actor is who is making the request and what they may do — resolved once, by
// the middleware chain, and never re-derived from a request parameter.
//
// Permissions is the union of the permissions of every active membership the
// user holds in the current organisation. Scope narrowing (which sections, which
// children) is decided per object by the policy layer, not here.
type Actor struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	FullName       string
	Email          string

	// SchoolID is the school selected for this request, if any. Nil for
	// organisation-level calls such as listing schools.
	SchoolID *uuid.UUID

	// Roles are the role keys held in this organisation, most privileged first.
	// Used for the audit log's actor_role and for scope resolution.
	Roles []string

	// SchoolAccess lists the schools this actor is scoped to. Empty means
	// organisation-wide access (an org_admin has no per-school membership rows).
	SchoolAccess []uuid.UUID

	permissions map[string]struct{}
}

// Can reports whether the actor holds a permission. This is the grant gate only
// — the scope gate is a separate, per-object check in the policy layer.
func (a *Actor) Can(permission string) bool {
	if a == nil {
		return false
	}
	_, ok := a.permissions[permission]
	return ok
}

// Permissions returns the permission keys as a slice, for the session response
// that drives permission-aware UI.
func (a *Actor) Permissions() []string {
	out := make([]string, 0, len(a.permissions))
	for k := range a.permissions {
		out = append(out, k)
	}
	return out
}

// OrgWide reports whether the actor's access spans the whole organisation rather
// than a named set of schools.
func (a *Actor) OrgWide() bool { return a != nil && len(a.SchoolAccess) == 0 }

// CanAccessSchool is the tenant/scope gate for a school-bound object. An
// organisation-wide actor passes; anyone else must hold a membership in it.
func (a *Actor) CanAccessSchool(schoolID uuid.UUID) bool {
	if a == nil {
		return false
	}
	if a.OrgWide() {
		return true
	}
	for _, id := range a.SchoolAccess {
		if id == schoolID {
			return true
		}
	}
	return false
}

// PrimaryRole is the role recorded against audit entries.
func (a *Actor) PrimaryRole() string {
	if a == nil || len(a.Roles) == 0 {
		return ""
	}
	return a.Roles[0]
}

func NewActor(userID, orgID uuid.UUID, name, email string, roles []string,
	schools []uuid.UUID, permissions []string) *Actor {
	set := make(map[string]struct{}, len(permissions))
	for _, p := range permissions {
		set[p] = struct{}{}
	}
	return &Actor{
		UserID:         userID,
		OrganizationID: orgID,
		FullName:       name,
		Email:          email,
		Roles:          roles,
		SchoolAccess:   schools,
		permissions:    set,
	}
}

func SetActor(c *gin.Context, a *Actor) { c.Set(ctxActor, a) }

// CurrentActor returns the authenticated actor, or nil. Handlers behind
// RequireAuth can rely on it being non-nil.
func CurrentActor(c *gin.Context) *Actor {
	if v, ok := c.Get(ctxActor); ok {
		if a, ok := v.(*Actor); ok {
			return a
		}
	}
	return nil
}

func RequestID(c *gin.Context) string {
	if v, ok := c.Get(ctxRequestID); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func UserIDOrEmpty(c *gin.Context) string {
	if a := CurrentActor(c); a != nil {
		return a.UserID.String()
	}
	return ""
}
