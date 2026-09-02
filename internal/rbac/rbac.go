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
	AttendanceWriteAny = "academics.attendance.write.any"
	ExamsRead          = "academics.exams.read"
	ExamsWrite         = "academics.exams.write"
	MarksWrite         = "academics.marks.write"
	// Reading the paper before the exam and the marks after it. Separate from
	// exams.write, which is scheduling: the person who puts the exam in the
	// calendar and the person who vouches for what is on the paper are not the
	// same job, and in most schools not the same person.
	ExamsApprove        = "academics.exams.approve"
	ReportCardsGenerate = "academics.reportcards.generate"
	/* Releasing results to families, as distinct from producing them.

	   A class teacher generates and sends up; a head signs off. Kept apart
	   because the whole point of the workflow is that the two are different
	   people — folding release into generate would let the person who typed
	   the marks publish them, which is the state this replaces. */
	ReportCardsPublish = "academics.reportcards.publish"
	HomeworkWrite      = "academics.homework.write"

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
	/* Letting a child actually JOIN, as distinct from offering them a place.

	   Offering is a conversation and reversible; joining takes a seat another
	   child cannot have, raises a bill and issues a family a login. Schools
	   that want a head to see those details first switch the requirement on,
	   and this is the permission that answers it — deliberately NOT
	   admissions.write, which the desk holds and which would make the
	   approval a formality it grants itself. */
	AdmissionsApprove = "admissions.approve"

	// The front desk: the visitor register, the telephone book, the post, and
	// the appointment diary. Separate from admissions because a receptionist
	// signs visitors in all day and has no business deciding who gets a seat.
	FrontDeskRead  = "office.front_desk.read"
	FrontDeskWrite = "office.front_desk.write"

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
	/* Reading correspondence somebody else is party to.

	   Deliberately its own right rather than folded into students.read.all,
	   which the librarian, the transport manager and the nurse all hold — they
	   have every reason to look up a child and none at all to read what that
	   child's mother wrote to their class teacher. A head who has to answer for
	   what the school said to a family does. */
	MessagesReadAll = "comms.messages.read.all"

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
	{ExamsApprove, "academics", "Approve question papers and moderate marks"},
	{MarksWrite, "academics", "Enter and amend marks"},
	{ReportCardsGenerate, "academics", "Generate report cards"},
	{ReportCardsPublish, "academics", "Approve and release report cards to families"},
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
	{AdmissionsApprove, "admissions", "Approve a new joining"},
	{FrontDeskRead, "office", "View the visitor, call and courier registers"},
	{FrontDeskWrite, "office", "Run the front desk"},

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
	{MessagesReadAll, "comms", "Read messages between staff and families"},

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
	// The seller's own mail server and SMS channel, through which every
	// school's password-reset links are sent. A platform account reaches
	// only the platform's rows through the integrations handlers -- its
	// institution is NULL -- so this is not a key into any school's setup.
	IntegrationsWrite,
	SelfProfileRead, SelfProfileWrite,
}

/*
SupportAdminPermissions is the vendor's support desk, one shelf below
SellerAdmin.

	A support engineer reproduces a fault: they need to see that a school
	exists, that its jobs are running and what its audit trail says happened.
	They do not need the enquiry list or the fee ledger to do that, and
	seller_admin's tenant and plan rights are a commercial function, not a
	support one.

	Like every other platform role it is Restricted, so it is held to exactly
	the keys below rather than inheriting a school's records by belonging to
	no school.
*/
var SupportAdminPermissions = []string{
	InstitutionRead, ReportsRead, JobsRead, AuditRead,
	SelfProfileRead, SelfProfileWrite,
}

/*
optionalRoles are seeded on request rather than into every new school.

	Most Indian K-12 schools do not have a discipline officer, an examination
	controller and a hostel warden as distinct people — one senior teacher does
	all three. Seeding twenty-two roles into a forty-child school gives the
	person setting it up twenty-two decisions to make and no way to tell which
	ones matter.

	These stay available as one-click presets; they are simply not part of a
	fresh school's opening position. Schools already running keep every role
	they have: SeedInstitution re-seeds any role that already exists, so this
	list changes what a new tenant starts with and nothing else.
*/
// A head of department is not optional any more. Timetable assignment,
// cover, faculty allocation and leave approval were all moved to that desk,
// and a role a school has to create before any of them work is a feature
// nobody finds. Eight of the nine schools on this installation had no hod
// row at all.
var optionalRoles = map[string]bool{
	"support_admin": true, "vice_principal": true, "it_admin": true,
	"exam_controller": true, "front_office": true, "operations": true,
	"librarian": true, "transport_manager": true, "hostel_warden": true,
	"driver": true, "counsellor": true, "nurse": true,
	"discipline_officer": true, "activity_coord": true,
}

// IsDefault reports whether a role is seeded into a newly provisioned school.
func IsDefault(roleKey string) bool { return !optionalRoles[roleKey] }

// SystemRoles mirrors the role set production seeds per institution.
var SystemRoles = []Role{
	{"seller_admin", "Seller Admin", SellerAdminPermissions},
	{"support_admin", "Support Admin", SupportAdminPermissions},
	{"institution_admin", "Institution Admin / Principal", keysExcept(PlatformTenantsRW, PlatformPlansRW)},
	// A vice principal or academic coordinator runs teaching and learning
	// without running the school: they own the timetable, the exam cycle and
	// academic monitoring, and hold no finance, HR or access rights at all.
	// Larger schools were previously forced to hand out institution_admin for
	// this, which is every fee record and every salary as a side effect.
	{"vice_principal", "Vice Principal / Academic Coordinator", []string{
		// A joining is an academic and pastoral decision as much as a
		// financial one, and a vice principal already carries the timetable
		// and the roll it lands in.
		// The approver has to be able to read what they are approving: the
		// grid drops an approve toggle on a group the role cannot view.
		AdmissionsRead,
		AdmissionsApprove,
		StudentsRead, StudentsReadAll, AcademicsRead, AcademicsWrite,
		TimetableRead, TimetableWrite,
		// Reads every register and may amend any of them: approving a
		// correction is a write against a section they do not teach.
		AttendanceRead, AttendanceReadAll, AttendanceWrite, AttendanceWriteAny,
		ExamsRead, ExamsWrite, ExamsApprove, MarksWrite, ReportCardsGenerate, HomeworkWrite,
		DisciplineWrite, EmployeesRead, ReportsRead, AnnouncementsWrite,
		SelfProfileRead, SelfProfileWrite}},
	{"it_admin", "IT Administrator", []string{
		UsersRead, UsersWrite, RolesRead, RolesWrite, SessionsRevoke,
		AuditRead, JobsRead, JobsEnqueue, IntegrationsWrite, SettingsWrite,
		InstitutionRead, SelfProfileRead, SelfProfileWrite}},
	// A department head reads across their department and approves within it,
	// but does not administer the institution. The department *boundary* is not
	// expressed here — these are capabilities; internal/scope narrows the rows.
	/* A head of department teaches.

	   The role held every capability for running a department and none for
	   doing the job inside it, so a HOD who takes Maths for 6-B reached the
	   Homework screen — the catalogue grants it — and got the STUDENT's
	   version, because the screen decides what to show from
	   academics.homework.write and the role did not have it. A Turn-in button,
	   on a teacher's screen, which the endpoint then refused with "only a
	   student or their guardian can submit homework".

	   HomeworkWrite and AttendanceWrite are what the classroom half of the job
	   needs. Every HOD in an Indian school still has a timetable; a role that
	   assumes otherwise describes an administrator, not a head of department. */
	{"hod", "HOD / Department Head", []string{
		StudentsRead, AcademicsRead, AcademicsWrite, TimetableRead, TimetableWrite,
		AttendanceRead, AttendanceWrite, HomeworkWrite,
		ExamsRead, ExamsApprove, MarksWrite, ReportsRead,
		EmployeesRead, LeaveApprove, AnnouncementsWrite,
		/* What their own teachers said to families, and what families said
		   back. A head answering for a subject has to be able to see the
		   conversation that led to a complaint; the scope resolver narrows it
		   to their department, so this is not the school's whole postbag. */
		MessagesReadAll,
		SelfProfileRead, SelfProfileWrite}},
	// Operations covers every specialism; the sub-role a user actually performs
	// is decided by which of these they are granted, not by a separate role.
	{"operations", "Operations Staff", []string{
		AcademicsRead, StudentsRead, StudentsReadAll,
		LibraryRead, LibraryWrite, TransportRead, TransportWrite,
		HostelRead, HostelWrite, InventoryRead, InventoryWrite, AssetsWrite,
		HealthRead, SelfProfileRead, SelfProfileWrite}},
	// DisciplineWrite, but not StudentsWrite. A subject teacher records "did
	// not bring the notebook, third time" and "helped a classmate who had been
	// ill" as a matter of course; editing the child's record, or agreeing the
	// accommodations for one who needs them, is the class teacher's job.
	{"faculty", "Faculty / Teacher", []string{
		StudentsRead, AcademicsRead, TimetableRead, AttendanceRead, AttendanceWrite,
		ExamsRead, MarksWrite, HomeworkWrite, AnnouncementsWrite, DisciplineWrite,
		/* Being a section's class teacher is a fact about the section, not a
		   role somebody is given. A teacher who is class teacher of 6-B held
		   the plain "teacher" role and met "missing permission" on the report
		   card screen for their own section — the workflow that has them send
		   results up to the head was unreachable by the people it is for.

		   Safe to grant here because the handler checks
		   res.IsClassTeacherOf(sectionID) regardless of the permission: a
		   teacher who is class teacher of nothing can generate nothing. */
		ReportCardsGenerate,
		SelfProfileRead, SelfProfileWrite}},
	{"class_teacher", "Class Teacher", []string{
		StudentsRead, StudentsWrite, AcademicsRead, TimetableRead,
		AttendanceRead, AttendanceWrite, ExamsRead, MarksWrite,
		ReportCardsGenerate, HomeworkWrite, DisciplineWrite,
		SelfProfileRead, SelfProfileWrite}},
	// AttendanceRead is what the endpoints gate on; AttendanceReadAll only
	// widens the rows they return. This role held the widener without the
	// opener, so its institution-wide attendance access resolved to a 403 on
	// every attendance endpoint and the .all grant did nothing at all.
	{"exam_controller", "Examination Controller", []string{
		StudentsRead, StudentsReadAll, AttendanceRead, AttendanceReadAll,
		AcademicsRead, ExamsRead, ExamsWrite, MarksWrite,
		ReportCardsGenerate, ReportsRead, SelfProfileRead, SelfProfileWrite}},
	{"finance", "Accounts & Finance", []string{
		AcademicsRead, StudentsRead, StudentsReadAll, FeesRead, FeesWrite, InvoicesRead, InvoicesWrite,
		PaymentsRead, PaymentsWrite, RefundsWrite, FinanceExport, ReportsRead,
		SelfProfileRead, SelfProfileWrite}},
	/* TransportRead, because the desk is where the bus is asked for.

	   A parent says which stop they live at while filling in the admission
	   form, and enrolment can now put the child on a route there and then. The
	   route and stop pickers read the transport lists, which sit behind
	   TransportRead -- a permission this role did not hold, so the dropdowns
	   would have rendered empty with no error and the clerk would have enrolled
	   the child with no bus, exactly as before.

	   Read only. The desk still cannot add a bus, price a stop or change a
	   route; it can see which routes exist and put a child on one, which is
	   the job it is being asked to do. */
	{"admissions", "Admissions & Front Office", []string{
		FrontDeskRead, FrontDeskWrite,
		AcademicsRead, AdmissionsRead, AdmissionsWrite, StudentsRead, StudentsWrite,
		/* The whole roll, because the office admits into all of it.

		   StudentsRead without the widener resolves to the caller's OWN
		   children — the narrowing that makes a parent see one child — and an
		   admissions clerk has none on the roll. So Student 360 answered "No
		   student matches" for every search, and the office that hands a family
		   their login could not reach a single family to hand it to.

		   Read, not write-any: they already held StudentsWrite, which is what
		   admitting a child needs. This only lets them find the child they have
		   just admitted. */
		StudentsReadAll,
		TransportRead,
		SelfProfileRead, SelfProfileWrite}},
	// The receptionist could read the school and write nothing, which made the
	// role unable to do the one job it has: sign a visitor in.
	{"front_office", "Receptionist / Front Office", []string{
		AcademicsRead, AdmissionsRead, StudentsRead, FrontDeskRead, FrontDeskWrite,
		SelfProfileRead, SelfProfileWrite}},
	/* HR keeps the record; the school decides the leave.

	   LeaveApprove was here, so a leave request went to HR as well as to the
	   head of department and the principal, and HR was told about every one of
	   them. Whether a teacher can be spared on Thursday is a timetable
	   question — who covers the class — and that is the department's to answer
	   and the principal's to overrule. HR still holds every consequence of the
	   decision: the balance, the loss of pay, the payslip that follows. */
	{"hr", "HR & Payroll", []string{
		AcademicsRead, EmployeesRead, EmployeesWrite, PayrollRead, PayrollWrite,
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
