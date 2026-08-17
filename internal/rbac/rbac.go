// Package rbac defines the permission vocabulary.
//
// Permission keys are rows in the permissions table, granted to roles through
// role_permissions and to users through user_roles. Production carries 74 keys
// across 13 modules and 490 grants. The constants here are the compile-time
// half of that contract: a handler naming a key that is not seeded will refuse
// every caller, so Seed and All exist to keep the two in step.
package rbac

const (
	// students
	StudentsRead = "students.read"
	// StudentsReadAll is institution-wide student access. StudentsRead alone
	// means "the students I can reach through my own scope" — a teacher's
	// sections, a guardian's children. Back-office roles hold both.
	StudentsReadAll = "students.read.all"
	StudentsWrite   = "students.write"
	StudentsDelete  = "students.delete"
	StudentsExport  = "students.export"

	// academics
	AcademicsRead     = "academics.read"
	AcademicsWrite    = "academics.write"
	TimetableRead     = "academics.timetable.read"
	TimetableWrite    = "academics.timetable.write"
	AttendanceRead    = "academics.attendance.read"
	AttendanceReadAll = "academics.attendance.read.all"
	AttendanceWrite   = "academics.attendance.write"
	// AttendanceWriteAny permits marking any section. Plain AttendanceWrite is
	// limited to sections the caller teaches or is class teacher of.
	AttendanceWriteAny  = "academics.attendance.write.any"
	ExamsRead           = "academics.exams.read"
	ExamsWrite          = "academics.exams.write"
	MarksWrite          = "academics.marks.write"
	ReportCardsGenerate = "academics.reportcards.generate"
	HomeworkWrite       = "academics.homework.write"

	// finance
	FeesRead      = "finance.fees.read"
	FeesWrite     = "finance.fees.write"
	InvoicesRead  = "finance.invoices.read"
	InvoicesWrite = "finance.invoices.write"
	PaymentsRead  = "finance.payments.read"
	PaymentsWrite = "finance.payments.write"
	RefundsWrite  = "finance.refunds.write"
	FinanceExport = "finance.export"

	// admissions
	AdmissionsRead  = "admissions.read"
	AdmissionsWrite = "admissions.write"

	// hr
	EmployeesRead  = "hr.employees.read"
	EmployeesWrite = "hr.employees.write"
	LeaveApprove   = "hr.leave.approve"
	PayrollRead    = "hr.payroll.read"
	PayrollWrite   = "hr.payroll.write"
	StaffAttend    = "hr.attendance.write"

	// operations
	LibraryRead    = "operations.library.read"
	LibraryWrite   = "operations.library.write"
	TransportRead  = "operations.transport.read"
	TransportWrite = "operations.transport.write"
	HostelRead     = "operations.hostel.read"
	HostelWrite    = "operations.hostel.write"
	InventoryRead  = "operations.inventory.read"
	InventoryWrite = "operations.inventory.write"
	AssetsWrite    = "operations.assets.write"

	// welfare
	HealthRead      = "welfare.health.read"
	HealthWrite     = "welfare.health.write"
	DisciplineWrite = "welfare.discipline.write"
	CounselingRead  = "welfare.counseling.read"

	// comms
	AnnouncementsWrite = "comms.announcements.write"
	MessagesSend       = "comms.messages.send"

	// institution / admin / access / platform / self
	InstitutionRead    = "institution.read"
	InstitutionWrite   = "institution.write"
	CampusesWrite      = "institution.campuses.write"
	SettingsWrite      = "institution.settings.write"
	IntegrationsWrite  = "institution.integrations.write"
	UsersRead          = "access.users.read"
	UsersWrite         = "access.users.write"
	RolesRead          = "access.roles.read"
	RolesWrite         = "access.roles.write"
	SessionsRevoke     = "access.sessions.revoke"
	AuditRead          = "admin.audit.read"
	JobsRead           = "admin.jobs.read"
	JobsEnqueue        = "admin.jobs.enqueue"
	PlatformTenantsRW  = "platform.tenants.write"
	PlatformPlansRW    = "platform.plans.write"
	ReportsRead        = "admin.reports.read"
	SelfProfileRead    = "self.profile.read"
	SelfProfileWrite   = "self.profile.write"
	SelfChildrenRead   = "self.children.read"
	SelfAttendanceRead = "self.attendance.read"
	SelfFeesRead       = "self.fees.read"
)

// Permission is a seedable row.
type Permission struct {
	Key         string
	Module      string
	Description string
}

// All is the authoritative list, seeded by cmd/migrate --seed.
var All = []Permission{
	{StudentsRead, "students", "View students within your own scope"},
	{StudentsReadAll, "students", "View every student in the institution"},
	{StudentsWrite, "students", "Create and edit student records"},
	{StudentsDelete, "students", "Archive or delete student records"},
	{StudentsExport, "students", "Export student data"},

	{AcademicsRead, "academics", "View classes, sections and subjects"},
	{AcademicsWrite, "academics", "Manage classes, sections and subjects"},
	{TimetableRead, "academics", "View the timetable"},
	{TimetableWrite, "academics", "Edit the timetable"},
	{AttendanceRead, "academics", "View attendance within your own scope"},
	{AttendanceReadAll, "academics", "View attendance for the whole institution"},
	{AttendanceWrite, "academics", "Mark attendance for your own sections"},
	{AttendanceWriteAny, "academics", "Mark attendance for any section"},
	{ExamsRead, "academics", "View exams and schedules"},
	{ExamsWrite, "academics", "Manage exams and schedules"},
	{MarksWrite, "academics", "Enter and amend marks"},
	{ReportCardsGenerate, "academics", "Generate report cards"},
	{HomeworkWrite, "academics", "Set homework and review submissions"},

	{FeesRead, "finance", "View fee heads and structures"},
	{FeesWrite, "finance", "Manage fee heads, structures and concessions"},
	{InvoicesRead, "finance", "View invoices"},
	{InvoicesWrite, "finance", "Raise and amend invoices"},
	{PaymentsRead, "finance", "View payments"},
	{PaymentsWrite, "finance", "Record payments and allocations"},
	{RefundsWrite, "finance", "Issue refunds"},
	{FinanceExport, "finance", "Export financial data"},

	{AdmissionsRead, "admissions", "View enquiries and applications"},
	{AdmissionsWrite, "admissions", "Manage the admissions pipeline"},

	{EmployeesRead, "hr", "View employee records"},
	{EmployeesWrite, "hr", "Manage employee records"},
	{LeaveApprove, "hr", "Approve or reject leave requests"},
	{PayrollRead, "hr", "View payroll"},
	{PayrollWrite, "hr", "Run payroll"},
	{StaffAttend, "hr", "Mark staff attendance"},

	{LibraryRead, "operations", "View the library catalogue"},
	{LibraryWrite, "operations", "Manage titles, copies and loans"},
	{TransportRead, "operations", "View routes and allocations"},
	{TransportWrite, "operations", "Manage routes, stops and vehicles"},
	{HostelRead, "operations", "View hostel occupancy"},
	{HostelWrite, "operations", "Manage hostel allocations"},
	{InventoryRead, "operations", "View stores and inventory"},
	{InventoryWrite, "operations", "Manage stores and inventory"},
	{AssetsWrite, "operations", "Manage fixed assets"},

	{HealthRead, "welfare", "View health records"},
	{HealthWrite, "welfare", "Maintain health records"},
	{DisciplineWrite, "welfare", "Record disciplinary actions"},
	{CounselingRead, "welfare", "View counseling notes"},

	{AnnouncementsWrite, "comms", "Publish announcements"},
	{MessagesSend, "comms", "Send SMS, email and push messages"},

	{InstitutionRead, "institution", "View institution profile"},
	{InstitutionWrite, "institution", "Edit institution profile"},
	{CampusesWrite, "institution", "Manage campuses"},
	{SettingsWrite, "institution", "Change module settings"},
	{IntegrationsWrite, "institution", "Configure integrations"},

	{UsersRead, "access", "View users"},
	{UsersWrite, "access", "Invite, edit and suspend users"},
	{RolesRead, "access", "View roles and permissions"},
	{RolesWrite, "access", "Create roles and change grants"},
	{SessionsRevoke, "access", "Revoke active sessions"},

	{AuditRead, "admin", "Read the audit log"},
	{JobsRead, "admin", "Inspect background jobs and queues"},
	{JobsEnqueue, "admin", "Trigger background jobs"},
	{ReportsRead, "admin", "View reports and analytics"},

	{PlatformTenantsRW, "platform", "Manage tenant institutions"},
	{PlatformPlansRW, "platform", "Manage subscription plans"},

	{SelfProfileRead, "self", "View own profile"},
	{SelfProfileWrite, "self", "Edit own profile and password"},
	{SelfChildrenRead, "self", "View own children (guardian)"},
	{SelfAttendanceRead, "self", "View own attendance"},
	{SelfFeesRead, "self", "View own fees and invoices"},
}

// Role is a seeded system role and the keys it grants.
type Role struct {
	Key         string
	Name        string
	Permissions []string
}

/*
SellerAdmin is the software vendor's own back office.

	It is platform-wide like super_admin, and deliberately far narrower. The
	vendor provisions tenants, prices plans, watches adoption and reproduces
	faults; none of that requires reading a child's marks, medical notes or
	guardian's phone number, and holding those rights "just in case" is what the
	DPDP Act prices at up to ₹250 crore.

	Reaching a school's actual records is possible but never implicit: it takes
	a deliberate, time-boxed impersonation that the school can see in its own
	audit trail.
*/
var SellerAdminPermissions = []string{
	PlatformTenantsRW, PlatformPlansRW,
	// Enough of a school's shape to support and bill it — its name, plan and
	// headcount — and nothing about the people inside it.
	InstitutionRead, ReportsRead,
	SelfProfileRead, SelfProfileWrite,
}

// SystemRoles mirrors the role set production seeds per institution.
var SystemRoles = []Role{
	{"seller_admin", "Seller Admin", SellerAdminPermissions},
	{"institution_admin", "Institution Admin / Principal", keysExcept(PlatformTenantsRW, PlatformPlansRW)},
	{"it_admin", "IT Administrator", []string{
		UsersRead, UsersWrite, RolesRead, RolesWrite, SessionsRevoke,
		AuditRead, JobsRead, JobsEnqueue, IntegrationsWrite, SettingsWrite,
		InstitutionRead, SelfProfileRead, SelfProfileWrite}},
	// A department head reads across their department and approves within it,
	// but does not administer the institution. The department *boundary* is not
	// expressed here — these are capabilities; internal/scope narrows the rows.
	{"hod", "HOD / Department Head", []string{
		StudentsRead, AcademicsRead, AcademicsWrite, TimetableRead, TimetableWrite,
		AttendanceRead, ExamsRead, MarksWrite, ReportsRead,
		EmployeesRead, LeaveApprove, AnnouncementsWrite,
		SelfProfileRead, SelfProfileWrite}},
	// Operations covers every specialism; the sub-role a user actually performs
	// is decided by which of these they are granted, not by a separate role.
	{"operations", "Operations Staff", []string{
		AcademicsRead, StudentsRead, StudentsReadAll,
		LibraryRead, LibraryWrite, TransportRead, TransportWrite,
		HostelRead, HostelWrite, InventoryRead, InventoryWrite, AssetsWrite,
		HealthRead, SelfProfileRead, SelfProfileWrite}},
	{"faculty", "Faculty / Teacher", []string{
		StudentsRead, AcademicsRead, TimetableRead, AttendanceRead, AttendanceWrite,
		ExamsRead, MarksWrite, HomeworkWrite, AnnouncementsWrite,
		SelfProfileRead, SelfProfileWrite}},
	{"class_teacher", "Class Teacher", []string{
		StudentsRead, StudentsWrite, AcademicsRead, TimetableRead,
		AttendanceRead, AttendanceWrite, ExamsRead, MarksWrite,
		ReportCardsGenerate, HomeworkWrite, DisciplineWrite,
		SelfProfileRead, SelfProfileWrite}},
	{"exam_controller", "Examination Controller", []string{
		StudentsRead, StudentsReadAll, AttendanceReadAll, AcademicsRead, ExamsRead, ExamsWrite, MarksWrite,
		ReportCardsGenerate, ReportsRead, SelfProfileRead, SelfProfileWrite}},
	{"finance", "Accounts & Finance", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, FeesRead, FeesWrite, InvoicesRead, InvoicesWrite,
		PaymentsRead, PaymentsWrite, RefundsWrite, FinanceExport, ReportsRead,
		SelfProfileRead, SelfProfileWrite}},
	{"admissions", "Admissions & Front Office", []string{
		AcademicsRead, AdmissionsRead, AdmissionsWrite, StudentsRead, StudentsWrite,
		SelfProfileRead, SelfProfileWrite}},
	{"front_office", "Receptionist / Front Office", []string{
		AcademicsRead, AdmissionsRead, StudentsRead, SelfProfileRead, SelfProfileWrite}},
	{"hr", "HR & Payroll", []string{
		AcademicsRead, EmployeesRead, EmployeesWrite, LeaveApprove, PayrollRead, PayrollWrite,
		StaffAttend, ReportsRead, SelfProfileRead, SelfProfileWrite}},
	{"librarian", "Librarian", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, LibraryRead, LibraryWrite, SelfProfileRead, SelfProfileWrite}},
	{"hostel_warden", "Hostel Warden", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, HostelRead, HostelWrite, DisciplineWrite,
		SelfProfileRead, SelfProfileWrite}},
	{"transport_manager", "Transport Manager", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, TransportRead, TransportWrite, SelfProfileRead, SelfProfileWrite}},
	{"driver", "Driver / Bus Attendant", []string{
		TransportRead, SelfProfileRead, SelfProfileWrite}},
	{"counsellor", "Counsellor", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, CounselingRead, HealthRead, SelfProfileRead, SelfProfileWrite}},
	{"nurse", "Nurse / Clinic", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, HealthRead, HealthWrite, SelfProfileRead, SelfProfileWrite}},
	{"discipline_officer", "Discipline Officer", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, DisciplineWrite, SelfProfileRead, SelfProfileWrite}},
	{"activity_coord", "Activity / Sports Coordinator", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, AnnouncementsWrite, SelfProfileRead, SelfProfileWrite}},
	{"student", "Student", []string{
		SelfProfileRead, SelfProfileWrite, SelfAttendanceRead, SelfFeesRead, TimetableRead}},
	{"parent", "Parent / Guardian", []string{
		SelfProfileRead, SelfProfileWrite, SelfChildrenRead, SelfAttendanceRead, SelfFeesRead}},
}

func keysExcept(excluded ...string) []string {
	skip := make(map[string]struct{}, len(excluded))
	for _, e := range excluded {
		skip[e] = struct{}{}
	}
	out := make([]string, 0, len(All))
	for _, p := range All {
		if _, ok := skip[p.Key]; !ok {
			out = append(out, p.Key)
		}
	}
	return out
}
