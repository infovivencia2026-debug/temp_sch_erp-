// Package rbac holds the permission catalogue as typed constants and a registry
// the route-coverage test reads.
//
// Permissions are strings in the database and constants here. The registry
// exists so that a typo in a route declaration fails a test rather than silently
// creating a permission nobody holds — which would deny everyone, or worse, a
// permission nobody checks.
package rbac

import (
	"slices"
	"sort"
)

// Permission keys. Format: <domain>.<resource>.<action>.
const (
	// platform
	UserRead       = "platform.user.read"
	UserCreate     = "platform.user.create"
	UserUpdate     = "platform.user.update"
	RoleRead       = "platform.role.read"
	RoleAssign     = "platform.role.assign"
	AuditRead      = "platform.audit.read"
	SettingsRead   = "platform.settings.read"
	SettingsUpdate = "platform.settings.update"

	// tenancy
	SchoolRead    = "tenancy.school.read"
	SchoolCreate  = "tenancy.school.create"
	SchoolUpdate  = "tenancy.school.update"
	SchoolArchive = "tenancy.school.archive"
	CampusRead    = "tenancy.campus.read"
	CampusManage  = "tenancy.campus.manage"
	YearRead      = "tenancy.year.read"
	YearManage    = "tenancy.year.manage"

	// student information system
	StudentRead           = "sis.student.read"
	StudentReadRestricted = "sis.student.read_restricted"
	StudentCreate         = "sis.student.create"
	StudentUpdate         = "sis.student.update"
	StudentArchive        = "sis.student.archive"
	StudentExport         = "sis.student.export"
	GuardianRead          = "sis.guardian.read"
	GuardianManage        = "sis.guardian.manage"
	GuardianLink          = "sis.guardian.link"
	EnrollmentRead        = "sis.enrollment.read"
	EnrollmentManage      = "sis.enrollment.manage"
	LifecycleManage       = "sis.lifecycle.manage"

	// academic structure
	GradeRead        = "academics.grade.read"
	GradeManage      = "academics.grade.manage"
	SectionRead      = "academics.section.read"
	SectionManage    = "academics.section.manage"
	SubjectRead      = "academics.subject.read"
	SubjectManage    = "academics.subject.manage"
	AllocationRead   = "academics.allocation.read"
	AllocationManage = "academics.allocation.manage"
)

// All is every permission the code knows about. It must match the rows migration
// 0004 inserts — a test asserts exactly that, so the catalogue and the code
// cannot drift apart.
var All = []string{
	UserRead, UserCreate, UserUpdate,
	RoleRead, RoleAssign, AuditRead,
	SettingsRead, SettingsUpdate,
	SchoolRead, SchoolCreate, SchoolUpdate, SchoolArchive,
	CampusRead, CampusManage,
	YearRead, YearManage,
	StudentRead, StudentReadRestricted, StudentCreate, StudentUpdate,
	StudentArchive, StudentExport,
	GuardianRead, GuardianManage, GuardianLink,
	EnrollmentRead, EnrollmentManage, LifecycleManage,
	GradeRead, GradeManage, SectionRead, SectionManage,
	SubjectRead, SubjectManage, AllocationRead, AllocationManage,
}

// Restricted permissions gate data whose mere reading is worth recording:
// health, discipline, government identifiers, and the audit log itself.
var Restricted = map[string]bool{
	AuditRead:             true,
	StudentReadRestricted: true,
	StudentExport:         true,
}

func IsKnown(permission string) bool {
	return slices.Contains(All, permission)
}

// Sorted returns the catalogue in a stable order, for diffing against the
// database and for display in the admin UI.
func Sorted() []string {
	out := append([]string(nil), All...)
	sort.Strings(out)
	return out
}
