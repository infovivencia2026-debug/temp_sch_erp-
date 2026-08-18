// Package api serves the JSON API the React SPA consumes, under /api/v1.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
	"github.com/school-erp/erp/internal/storage"
)

type Server struct {
	DB        *database.DB
	Sessions  *auth.Store
	Hasher    *auth.Hasher
	Queue     *queue.Client
	Inspector *queue.Inspector
	Storage   *storage.Store // nil when R2 is unconfigured
}

// Routes returns the /api/v1 subtree.
//
// Only /session is reachable unauthenticated: the SPA calls it on boot to
// decide between rendering the app and redirecting to /login, and it must
// answer 200 with {authenticated:false} rather than 401 for that to work.
func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	r.Get("/session", s.getSession)

	r.Group(func(r chi.Router) {
		r.Use(httpx.RequireAuth)
		// A platform operator may name the school they are working on. Must sit
		// after RequireAuth (there is no identity to amend before it) and
		// before every handler that reads one.
		r.Use(ActingInstitution(s.DB))

		r.Get("/ref-data", s.getRefData)
		// The period presets every metric picker offers. Published so the
		// client does not keep a second copy that drifts from the resolver.
		r.Get("/date-ranges", s.listRangePresets)
		// The SPA's whole navigation comes from here; see internal/catalog.
		r.Get("/catalog", s.getCatalog)

		r.Route("/profile", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.SelfProfileRead)).Get("/", s.getProfile)
			r.With(httpx.RequirePermission(rbac.SelfProfileWrite)).Put("/", s.updateProfile)
			r.With(httpx.RequirePermission(rbac.SelfProfileWrite)).Post("/password", s.changePassword)
		})

		r.Route("/students", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.StudentsRead))
			/* The conduct file and the accommodations agreed for a child who
			   needs them. Reading needs only students.read, so a form teacher
			   covering someone else's class can see what they are walking
			   into; writing about a child needs students.write, and the
			   handler additionally checks the child is one the caller
			   actually teaches. */
			r.Get("/notes", s.listDisciplineNotes)
			r.With(httpx.RequirePermission(rbac.DisciplineWrite)).Post("/notes", s.recordDisciplineNote)
			r.Get("/support-plans", s.listSupportPlans)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Put("/support-plans", s.saveSupportPlan)
			r.Get("/", s.listStudents)
			r.Get("/import/template", s.getImportTemplate)
			r.Get("/{id}", s.getStudent)
			r.Get("/{id}/profile", s.getStudentProfile)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/", s.createStudent)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Put("/{id}", s.updateStudent)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/import", s.importStudents)
		})

		/* --- Syllabus, lesson plans and coverage --------------------------

		   Reads are open to any signed-in member of staff; the handlers narrow
		   by who is asking. A teacher sees their own plans, a head of
		   department sees the queue, and the coverage view is the same numbers
		   either way — one table, one truth. */
		r.Route("/syllabus", func(r chi.Router) {
			r.Get("/units", s.listSyllabusUnits)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Put("/units", s.setSyllabusUnits)
			r.Get("/coverage", s.getSyllabusCoverage)
			r.Get("/lesson-plans", s.listLessonPlans)
			r.Post("/lesson-plans", s.saveLessonPlan)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).
				Post("/lesson-plans/{id}/decide", s.decideLessonPlan)
		})

		r.Route("/academics", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AcademicsRead))
			s.mountAdminAcademics(r)
			r.Get("/years", s.listAcademicYears)
			r.Get("/classes", s.listClasses)
			r.Get("/sections", s.listSections)
			r.Get("/subjects", s.listSubjects)
		})

		r.Route("/timetable", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.TimetableRead))
			r.Get("/entries", s.listTimetableEntries)
			r.Get("/periods", s.listPeriods)
			r.Get("/teachers", s.listTeachers)
		})

		r.Route("/attendance", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.AttendanceRead)).Get("/", s.listAttendance)
			r.With(httpx.RequirePermission(rbac.AttendanceWrite)).Post("/", s.markAttendance)
		})

		r.Route("/me", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.SelfAttendanceRead)).Get("/student", s.getMyStudent)
		})

		// Heavy work is never done inline; these hand off to the queue and
		// return 202 with a job id the client polls.
		r.Route("/jobs", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.JobsEnqueue)).Post("/", s.enqueueJob)
			r.With(httpx.RequirePermission(rbac.JobsRead)).Get("/queues", s.queueStats)
			r.With(httpx.RequirePermission(rbac.JobsRead)).Get("/{id}", s.jobStatus)
		})

		// --- Approvals, leave, staff attendance, homework --------------------
		r.Route("/workflow", func(r chi.Router) {
			r.Get("/approvals", s.getApprovals)
			r.Post("/leave", s.applyForLeave)
			r.With(httpx.RequirePermission(rbac.LeaveApprove)).Post("/leave/{id}/decide", s.decideLeave)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/concessions/{id}/decide", s.decideConcession)
			r.With(httpx.RequirePermission(rbac.StaffAttend)).Get("/staff-register", s.getStaffRegister)
			r.With(httpx.RequirePermission(rbac.StaffAttend)).Post("/staff-attendance", s.markStaffAttendance)
		})

		r.Route("/homework", func(r chi.Router) {
			r.Get("/", s.listHomework)
			r.With(httpx.RequirePermission(rbac.HomeworkWrite)).Post("/", s.publishHomework)
			r.Post("/{id}/submit", s.submitHomework)
		})

		// --- CSV export ------------------------------------------------------
		r.Get("/export", s.listExports)
		r.Get("/export/{name}", s.exportCSV)

		// --- School setup ---------------------------------------------------
		// Until these existed a school could be operated but not created: every
		// class, subject and fee head had to be inserted in SQL.
		r.Route("/setup", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/status", s.getSetupStatus)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/institution", s.getInstitution)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/institution/options", s.getInstitutionOptions)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Put("/institution", s.updateInstitution)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/campuses", s.listCampuses)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Post("/campuses", s.createCampus)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Put("/campuses/{id}", s.updateCampus)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/academic-years", s.createAcademicYear)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/classes", s.createClass)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/sections", s.createSection)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/subjects", s.createSubject)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Put("/periods", s.setPeriods)
			r.With(httpx.RequirePermission(rbac.AcademicsRead)).Get("/class-subjects", s.listClassSubjects)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Put("/class-subjects", s.setClassSubjects)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/class-teacher", s.setClassTeacher)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/assign-teacher", s.assignTeacher)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/grading-scales", s.createGradingScale)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/exams", s.createExam)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/fee-heads", s.listFeeHeads)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/fee-heads", s.createFeeHead)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/fee-structures", s.createFeeStructure)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/fee-structures", s.listFeeStructures)
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/employees", s.createEmployee)
		})

		// --- Institution Admin / Principal --------------------------------
		r.Route("/principal", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.ReportsRead))
			r.Get("/dashboard", s.getPrincipalDashboard)
			r.Get("/attendance-trend", s.getAttendanceTrend)
			r.Get("/attendance-shortage", s.getAttendanceShortage)
			r.Get("/staff-workload", s.getStaffWorkload)
		})

		// --- HOD / Department Head (department-scoped) --------------------
		r.Route("/department", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.EmployeesRead))
			r.Get("/dashboard", s.getDeptDashboard)
			r.Get("/faculty", s.listDeptFaculty)
		})

		// --- Faculty / Teacher (assigned-classes scope) -------------------
		r.Route("/teaching", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.TimetableRead))
			r.Get("/today", s.listTodaysClasses)
			r.Get("/my-work", s.getMyWork)
			r.Get("/classes", s.listMyClasses)
			s.mountFacultyComms(r)
			/* What a class teacher knows about each child: the roll-up, the
			   conduct file, and the accommodations agreed for those who need
			   them. Reads are open to anyone who can see a student — a family
			   reading their own child's notes gets only the shared ones — and
			   writing needs students.write. */
			r.Get("/progress", s.listStudentProgress)
		})

		// --- Student & Parent portals (self / children scope) -------------
		r.Route("/portal", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.SelfProfileRead))
			r.Get("/students", s.listMyStudents)
			r.Get("/summary", s.getPortalSummary)
			r.Get("/attendance", s.listPortalAttendance)
			r.Get("/fees", s.getFamilyFees)
			// The same conduct file, narrowed by the handler to the notes the
			// school chose to share. Without this the visible_to_student flag
			// would be a promise the product never keeps.
			r.Get("/notes", s.listDisciplineNotes)
			r.Get("/results", s.getFamilyResults)
			s.mountParentPortal(r)
			s.mountParentSchoolLife(r)
		})

		// --- Accounts & Finance -------------------------------------------
		r.Route("/finance", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.InvoicesRead))
			s.mountLedgers(r)
			r.Get("/dashboard", s.getFinanceDashboard)
			r.Get("/invoices", s.listInvoices)
			r.Get("/payments", s.listPayments)
		})

		// --- Fee counter ---------------------------------------------------
		// The ledger is deliberately outside the finance permission: a parent
		// reads their own child's account through the same endpoint, narrowed
		// by scope rather than by a separate read-only copy of the query.
		r.Route("/fees", func(r chi.Router) {
			r.Get("/students/{id}/ledger", s.getStudentLedger)
			r.With(httpx.RequirePermission(rbac.PaymentsWrite)).Post("/payments", s.collectFee)
			r.With(httpx.RequirePermission(rbac.PaymentsRead)).Get("/receipts/{id}", s.getReceipt)
			r.With(httpx.RequirePermission(rbac.PaymentsWrite)).Post("/payments/{id}/clear", s.clearCheque)
			r.With(httpx.RequirePermission(rbac.PaymentsWrite)).Post("/payments/{id}/bounce", s.bounceCheque)
			r.With(httpx.RequirePermission(rbac.PaymentsRead)).Get("/pdc", s.listPDC)
			r.With(httpx.RequirePermission(rbac.InvoicesRead)).Get("/defaulters", s.listDefaulters)
			r.With(httpx.RequirePermission(rbac.InvoicesWrite)).Post("/invoices/generate", s.generateInvoices)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/concessions", s.listConcessions)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/refunds", s.listRefunds)
		})

		// --- Admissions & Front Office ------------------------------------
		r.Route("/admissions", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AdmissionsRead))
			r.Get("/dashboard", s.getAdmissionsDashboard)
			r.Get("/enquiries", s.listEnquiries)
			r.Get("/applications", s.listApplications)

			/* The funnel: where leads came from, who is chasing them, the
			   quota register an inspection reads, and the waiting list. */
			r.Get("/sources", s.getLeadSources)
			r.Get("/leads", s.listLeads)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/leads/assign", s.assignLeads)
			r.Get("/register", s.getAdmissionRegister)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications/patch", s.patchApplication)
			r.Get("/siblings", s.findSiblings)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/waitlist/promote", s.promoteWaitlist)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/rte/import", s.importRTELottery)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/message", s.messageApplicants)
			r.Get("/open-days", s.listOpenDays)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/open-days", s.createOpenDay)
			r.Get("/open-days/{id}/slots", s.listOpenDaySlots)
			r.Get("/open-days/{id}/bookings", s.listOpenDayBookings)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/open-days/book", s.bookOpenDay)
			r.Get("/prospectus", s.listProspectusSales)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/prospectus", s.sellProspectus)
		})

		/* Leave is registered outside the /hr group on purpose.

		   That group carries RequirePermission(EmployeesRead), and a nested
		   Group inherits it rather than escaping it — so a teacher opening
		   their own "Leave & self service" got a 403 on their own record. The
		   handler narrows to the caller's own rows when they lack the HR
		   grant, which is what makes it safe to leave open. */
		r.Get("/hr/leave", s.listLeaveRequests)

		// --- HR & Payroll ---------------------------------------------------
		r.Route("/hr", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.EmployeesRead))
			r.Get("/dashboard", s.getHRDashboard)
			r.Get("/employees", s.listEmployees)
			r.Get("/documents", s.listEmployeeDocuments)
			s.mountHRLifecycle(r)
		})

		/* --- The front desk -------------------------------------------------

		   Who came in, who rang, what arrived in the post, and who is booked
		   to see the principal. Gated on its own permission rather than on
		   admissions: a receptionist signs visitors in all day and has no
		   business deciding who gets a seat. */
		r.Route("/office", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.FrontDeskRead))
			r.Get("/visitors", s.listVisitors)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/visitors", s.signVisitorIn)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/visitors/{id}/out", s.signVisitorOut)
			r.Get("/blocklist", s.listBlocklist)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/blocklist", s.addToBlocklist)
			r.Get("/appointments", s.listAppointments)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/appointments", s.saveAppointment)
			r.Get("/calls", s.listCalls)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/calls", s.saveCall)
			r.Get("/courier", s.listCourier)
			r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Post("/courier", s.saveCourier)
		})

		// --- Operations Staff -----------------------------------------------
		r.Route("/operations", func(r chi.Router) {
			r.With(httpx.RequireAnyPermission(rbac.LibraryRead, rbac.TransportRead,
				rbac.HostelRead, rbac.InventoryRead)).Get("/dashboard", s.getOperationsDashboard)
		})

		// --- Admissions workflow (module 2) --------------------------------
		r.Route("/admissions/workflow", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AdmissionsRead))
			r.Get("/merit", s.getMeritList)
			r.Get("/seats", s.getSeatMatrix)
			r.Get("/funnel", s.getAdmissionsFunnel)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/enquiries", s.createEnquiry)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Put("/enquiries/{id}", s.updateEnquiry)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications", s.createApplication)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications/{id}/assessment", s.recordAssessment)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications/{id}/decision", s.decideApplication)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/applications/{id}/enrol", s.enrolApplicant)
		})

		// --- Attendance corrections & alerts (module 3) --------------------
		r.Route("/attendance-workflow", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.AttendanceWrite)).Post("/corrections", s.requestCorrection)
			r.With(httpx.RequirePermission(rbac.AttendanceRead)).Get("/corrections", s.listCorrections)
			// Approving an amendment rewrites a register, so the capability it
			// needs is "mark any section" -- not hr.leave.approve, which is the
			// staff leave queue and has nothing to do with attendance. The
			// mis-gate meant a vice principal, whose whole job is monitoring
			// attendance, could see the queue and not decide anything in it.
			r.With(httpx.RequirePermission(rbac.AttendanceWriteAny)).Post("/corrections/{id}/decide", s.decideCorrection)
			r.With(httpx.RequirePermission(rbac.MessagesSend)).Post("/absence-alerts", s.sendAbsenceAlerts)
		})

		// --- Examinations & report cards (module 4) ------------------------
		r.Route("/exams", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.ExamsRead))
			r.Get("/list", s.listExams)
			r.Get("/subjects", s.listExamSubjects)
			r.Get("/gradebook", s.getGradebook)
			r.Get("/report-cards", s.listReportCards)
			r.With(httpx.RequirePermission(rbac.MarksWrite)).Post("/marks", s.enterMarks)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/generate", s.generateReportCards)

			/* Exam day: halls, seating and the ticket.

			   Seating is gated on ExamsWrite rather than a read permission —
			   re-running an allocation moves every candidate, which is not
			   something an invigilator should be able to do from a phone. */
			r.Get("/halls", s.listExamHalls)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/halls", s.createExamHall)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/seats/allocate", s.allocateSeats)
			r.Get("/hall-plan", s.getHallPlan)

		})

		/* --- The NEP holistic progress card -------------------------------

		   Outside /exams on purpose. That group requires academics.exams.read,
		   which a student and a parent rightly do not hold — and the HPC is
		   theirs as much as the school's: the framework requires the child's
		   own assessment and the guardian's, so gating the whole thing behind
		   a staff permission would make the 360 loop impossible to close.

		   Authorisation is per row instead: hpcStudent refuses anyone else's
		   child, and recordObservation checks the observer role against who is
		   signed in, so a parent cannot file the teacher's view. */
		r.Route("/hpc", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.SelfProfileRead))
			r.Get("/card", s.getHolisticCard)
			// A hall ticket is the candidate's own document. Same scope rule as
			// the card: your child, a child you teach, or anyone if you are the
			// office — never a stranger's.
			r.Get("/hall-ticket", s.getHallTicket)
			r.Get("/competencies", s.listCompetencies)
			r.Post("/observations", s.recordObservation)
		})

		// --- Student lifecycle (module 5) ----------------------------------
		r.Route("/lifecycle", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.StudentsRead))
			r.Get("/certificates", s.listCertificates)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/promote", s.promoteStudents)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/certificates", s.issueCertificate)
		})

		// --- Communication (module 6) --------------------------------------
		r.Route("/communication", func(r chi.Router) {
			r.Get("/circulars", s.listCirculars)
			r.Post("/circulars/{id}/ack", s.ackCircular)
			r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).Post("/circulars", s.publishCircular)
		})

		// --- Timetable generation (module 7) -------------------------------
		r.Route("/timetable-admin", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.TimetableWrite))
			r.Post("/generate", s.generateTimetable)
			r.Post("/substitutions", s.createSubstitution)
		})

		// --- Compliance exports (module 8) ---------------------------------
		r.Route("/compliance", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.ReportsRead))
			r.Get("/udise", s.getUDISEExport)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/apaar", s.setAPAARID)
		})

		// --- Payroll (module 9) --------------------------------------------
		r.Route("/payroll", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.PayrollRead))
			r.Get("/payslips", s.listPayslips)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/run", s.runPayroll)

			/* Statutory payroll: the rates, the returns they generate, and the
			   three things a payroll office does around the payslip — withhold
			   tax, lend money against salary, and check the security agency
			   billed for guards who turned up. */
			r.Get("/settings", s.getPayrollSettings)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Put("/settings", s.savePayrollSettings)
			r.Get("/statutory", s.getStatutoryRegister)
			r.Get("/ecr", s.getECRFile)
			r.Get("/bank-file", s.getBankFile)
			r.Get("/ctc", s.getCTCBreakup)
			r.Get("/gratuity", s.getGratuityLiability)
			r.Get("/tax", s.getTaxComputation)
			r.Get("/declarations", s.listDeclarations)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/declarations", s.saveDeclaration)
			r.Get("/loans", s.listStaffLoans)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/loans", s.saveStaffLoan)
			r.Get("/contractor-bills", s.listContractorBills)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/contractor-bills", s.saveContractorBill)
		})

		// --- Operations desks (module 10) ----------------------------------
		r.Route("/ops", func(r chi.Router) {
			s.mountInfirmary(r)
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/titles", s.listLibraryTitles)
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/titles/{id}/copies", s.listTitleCopies)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/issue", s.issueBook)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/loans/{id}/return", s.returnBook)
			/* Reads for the same two resources sat under /operations while
			   their writes were here, so the library screen could return a
			   book it could not list and the fleet screen 404'd on load. One
			   resource, one prefix. */
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/loans", s.listLibraryLoans)

			/* The rest of a librarian's year: the hold queue, the annual
			   stock audit, and the textbook indent. */
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/reservations", s.listReservations)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/reservations", s.placeReservation)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/reservations/{id}/decide", s.decideReservation)
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/audits", s.listStockAudits)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/audits", s.saveStockAudit)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/audits/{id}/scan", s.recordAuditScan)
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/audits/{id}/missing", s.listAuditMissing)
			r.With(httpx.RequirePermission(rbac.LibraryRead)).Get("/library/indents", s.listTextbookIndents)
			r.With(httpx.RequirePermission(rbac.LibraryWrite)).Post("/library/indents", s.saveTextbookIndent)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/vehicles", s.listVehicles)
			r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/occupancy", s.listHostelOccupancy)
			r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/rooms/{id}/boarders", s.listRoomBoarders)
			r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/allocate", s.allocateHostelBed)
			/* A warden's day beyond the bed list.

			   Outpass reads and consent are open to families on purpose: a
			   guardian has to be able to see and agree to a trip, and the
			   handlers narrow to their own children. Permitting and recording
			   movement stays with the hostel. */
			r.Get("/hostel/outpasses", s.listOutpasses)
			r.Post("/hostel/outpasses", s.createOutpass)
			r.Post("/hostel/outpasses/{id}/decide", s.decideOutpass)
			r.With(httpx.RequirePermission(rbac.HostelRead)).Get("/hostel/complaints", s.listHostelComplaints)
			r.Post("/hostel/complaints", s.raiseHostelComplaint)
			r.With(httpx.RequirePermission(rbac.HostelWrite)).Post("/hostel/complaints/{id}/resolve", s.resolveHostelComplaint)
			r.Get("/hostel/mess", s.listMessMenu)
			r.With(httpx.RequirePermission(rbac.HostelWrite)).Put("/hostel/mess", s.setMessMenu)
			r.With(httpx.RequirePermission(rbac.HealthRead)).Get("/health/students", s.listHealthRecords)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/routes", s.listRoutes)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/routes/{id}/stops", s.listRouteStops)

			/* The transport office. Live GPS tracking, geofenced alerts,
			   speeding detection, fuel telematics, in-bus CCTV and AIS-140
			   registration are absent on purpose: each needs a certified
			   device in the vehicle and a vendor feed, and drawing a bus on a
			   map from no position data would be a lie. */
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/staff", s.listTransportStaff)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/staff", s.saveTransportStaff)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/allocations", s.listTransportAllocations)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/allocations", s.allocateTransport)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/attendance", s.listBusAttendance)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/attendance", s.markBusAttendance)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/logs", s.listVehicleLogs)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/logs", s.recordVehicleLog)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/checks", s.listTripChecks)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/checks", s.recordTripCheck)
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/incidents", s.listTransportIncidents)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/incidents", s.saveTransportIncident)
			r.With(httpx.RequirePermission(rbac.InventoryRead)).Get("/inventory/stock", s.listStock)
			r.With(httpx.RequirePermission(rbac.InventoryWrite)).Post("/inventory/movements", s.moveStock)
		})

		/* --- Seller: the vendor's own back office -------------------------

		   Guarded as a group. Everything under /seller is commercial, no
		   school role holds platform.tenants.write, and a route added here
		   later inherits the boundary rather than having to remember it. */
		r.Route("/seller", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.PlatformTenantsRW))
			r.Get("/tenants", s.listTenants)
			r.Post("/tenants", s.provisionTenant)
			r.Put("/tenants/{id}/subscription", s.setSubscription)
			r.Post("/tenants/{id}/reset-admin", s.resetTenantAdmin)
			r.Get("/plans", s.listPlans)
			r.Get("/tickets", s.listTickets)
			r.Get("/enquiries", s.listSalesEnquiries)
		})

		/* What needs me, for whoever is asking.

		   Outside every module group on purpose: it is not a feature of
		   attendance or of fees, it is the question those modules answer
		   together. One endpoint, gated per probe by the caller's own
		   permissions rather than by a wrapper here. */
		r.Get("/attention", s.getAttention)

		// The first-run tour is every user's own, so it sits outside /seller.
		r.Get("/tour", s.getTour)
		r.Post("/tour", s.setTour)

		// --- Super Admin: access, platform configuration ------------------
		r.Route("/admin", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.UsersRead)).Get("/users", s.listUsers)
			r.With(httpx.RequirePermission(rbac.UsersRead)).Get("/users/{id}", s.getUser)
			r.With(httpx.RequirePermission(rbac.UsersWrite)).Post("/users", s.createUser)
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Put("/users/{id}/roles", s.setRoles)
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/assignable-roles", s.listAssignableRoles)
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/role-presets", s.listRolePresets)
			r.With(httpx.RequirePermission(rbac.AuditRead)).Get("/audit", s.listAudit)
			r.With(httpx.RequirePermission(rbac.AuditRead)).Get("/audit/summary", s.getAuditSummary)
			r.With(httpx.RequirePermission(rbac.UsersWrite)).Put("/users/{id}/status", s.setUserStatus)
			r.With(httpx.RequirePermission(rbac.UsersWrite)).Post("/users/{id}/reset-password", s.resetUserPassword)
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/roles", s.listRoles)
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/roles/{id}/permissions", s.getRolePermissions)
			// The grid is the same data as /permissions, grouped the way a
			// school reads it. Both stay: one configures, one audits.
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/roles/{id}/grid", s.getRoleGrid)
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Put("/roles/{id}/grid", s.setRoleGrid)
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Post("/roles", s.createRole)
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/installable-roles", s.listInstallableRoles)
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Post("/roles/install", s.installRole)
			r.Get("/institutions", s.listInstitutions)
			// The cockpit: every campus on the installation, side by side.
			r.Get("/platform-dashboard", s.getPlatformDashboard)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/modules", s.listModules)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).Put("/modules", s.setModule)
			r.With(httpx.RequirePermission(rbac.AuditRead)).Get("/sessions", s.listSessions)
			r.With(httpx.RequirePermission(rbac.SessionsRevoke)).Delete("/sessions/{id}", s.revokeSession)
		})

		r.Route("/files", func(r chi.Router) {
			r.Post("/presign", s.presignUpload)
		})
	})

	return r
}

// tenantScope builds the RLS scope for the caller. Named to avoid colliding
// with internal/scope, which resolves the narrower per-user boundaries.
func tenantScope(id *httpx.Identity) database.Scope {
	return database.Scope{InstitutionID: id.InstitutionID, PlatformAdmin: id.PlatformAdmin}
}

// resolveScope loads the caller's narrow data boundary (campuses, departments,
// taught sections, linked students).
//
// Handlers for department-, class-, self- and child-scoped features must call
// this and apply the returned filter. RLS will not save them: a HOD reading
// another department's students is reading rows from their own tenant, which
// every tenant_isolation policy happily allows.
func (s *Server) resolveScope(r *http.Request) (*scope.Resolved, error) {
	return scope.Resolve(r.Context(), s.DB, httpx.IdentityFrom(r.Context()))
}
