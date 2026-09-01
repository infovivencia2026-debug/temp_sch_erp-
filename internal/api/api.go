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
	// FileStoreDir backs uploads from the server's own disk when there is no
	// object store. Empty means neither exists and uploads answer 503.
	FileStoreDir string
	// BaseURL is what goes into a message a person clicks from outside the
	// app -- an application link texted to a parent, most of it. A relative
	// path is fine on a page the browser is already on and useless in an SMS,
	// so anything that leaves the building has to carry this.
	BaseURL string
}

// Routes returns the /api/v1 subtree.
//
// Only /session is reachable unauthenticated: the SPA calls it on boot to
// decide between rendering the app and redirecting to /login, and it must
// answer 200 with {authenticated:false} rather than 401 for that to work.
func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	r.Get("/session", s.getSession)
	s.mountAdmissionsPublic(r)
	s.mountSMSGatewayDevice(r)
	// The driver's phone, for the same reason: it holds a device token and no
	// session, and the claim has no credential at all until it succeeds.
	s.mountBusTrackerDevice(r)
	/* The message test link. No session, by design: somebody checking whether
	   SMS works wants to open it on the phone they are testing against. What
	   stands in for one is a key in the URL plus the recipient allowlist, and
	   the endpoint refuses to exist at all on a school whose guard has been
	   opened. See message_test_link.go. */
	r.Post("/public/message-test", s.sendPublicTestMessage)

	r.Group(func(r chi.Router) {
		r.Use(httpx.RequireAuth)
		// A platform operator may name the school they are working on. Must sit
		// after RequireAuth (there is no identity to amend before it) and
		// before every handler that reads one.
		r.Use(ActingInstitution(s.DB))
		// What the school has *bought*, as distinct from what the user may
		// do. Sits after ActingInstitution so a platform operator working
		// inside a tenant is judged by that tenant's subscription, not by
		// their own absence of one.
		r.Use(s.RequireSubscription)

		r.Get("/ref-data", s.getRefData)
		// The period presets every metric picker offers. Published so the
		// client does not keep a second copy that drifts from the resolver.
		r.Get("/date-ranges", s.listRangePresets)
		// The SPA's whole navigation comes from here; see internal/catalog.
		r.Get("/catalog", s.getCatalog)

		/* The assistant's fast path, in front of the RAG service.

		   Authenticated, which the RAG service is not: it answers anybody who
		   can reach the origin. That is what makes the role scoping real --
		   the roles come from the session cookie, so a parent cannot be
		   answered with the staff screen by editing a request body. */
		r.Post("/assistant/ask", s.assistantAsk)

		/* And the slow path behind it, which the fast path's own comment
		   promised and nothing implemented. Same gate, same roles; see
		   assistant_chat.go for why it lives here and not beside the app. */
		r.Post("/assistant/chat", s.assistantChat)

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
			/* What a class costs, at the desk where a family asks it.

			   Admitting raises no invoice on purpose, which left the clerk with
			   nothing to say when a parent asked the one question every
			   admission conversation contains. Read-only, and from the same
			   structure the demand raise reads — two sources for one figure is
			   two figures. */
			r.Get("/fee-preview", s.admissionFeePreview)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/", s.createStudent)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Put("/{id}", s.updateStudent)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/import", s.importStudents)
			/* The photograph. Nothing has ever written students.photo_file_id,
			   so the ID card, the statutory return and the report card all read
			   a column no screen could fill. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Put("/{id}/photo", s.setStudentPhoto)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/photos/import", s.importStudentPhotos)
			// The parents' photographs, optional and reached through the child
			// so the same scope rule applies to a family as to the child.
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Put("/{id}/guardians/{gid}/photo", s.setGuardianPhoto)
			/* Adding and correcting a child's parents. A guardian could be
			   created exactly once — one of them, in the admission form, on
			   the day the child was admitted — and never again. Every alert
			   this product sends goes to guardians, so a parent not on the
			   record is a parent the school cannot reach. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/guardians", s.saveStudentGuardian)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Delete("/{id}/guardians/{gid}", s.unlinkStudentGuardian)
			/* Leaving, and coming back. A transfer certificate already ends a
			   child's time here; this is the other ways a child leaves, none
			   of which produce a document the family ever asks for. Nothing is
			   deleted either way — see student_exit.go. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/{id}/exit", s.recordStudentExit)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/{id}/readmit", s.readmitStudent)
			// Suspension is not leaving: it leaves the enrolment open, because
			// the child is expected back.
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).Post("/{id}/suspend", s.suspendStudent)
			// The roll in four numbers, counted server-side across everything
			// the caller may see rather than from the page of rows on screen.
			r.Get("/counts", s.studentCounts)
			// The depth behind the tabs — marks by subject, the ledger by fee
			// head, receipts, documents on file, leave, and every year the
			// child has been here. Split from /profile, which has to be
			// instant because somebody is on the telephone.
			r.Get("/{id}/detail", s.getStudentDetail)
			// Graded by whoever marks: a class teacher signs off Discipline,
			// the PE teacher signs off games.
			r.With(httpx.RequirePermission(rbac.MarksWrite)).
				Post("/{id}/co-scholastic", s.saveCoScholasticGrade)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/activities", s.enrolInActivity)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/activities/{enrolID}/leave", s.leaveActivity)
			/* The papers a family hands in. student_documents has been in the
			   baseline since the beginning with nothing writing to it or
			   reading it, so the birth certificate the office took at
			   admission was on no screen anywhere. */
			// Fields a school invented, merged rather than assigned so one
			// block of the record cannot wipe another's.
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/custom-fields", s.saveStudentCustomFields)
			/* A few fields at a time. PUT /students/{id} runs the same upsert
			   the importer uses and writes the whole record, so sending three
			   fields through it blanks the other twenty. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Patch("/{id}/fields", s.patchStudentFields)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/documents", s.addStudentDocument)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/{id}/documents/{docID}/verify", s.verifyStudentDocument)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Delete("/{id}/documents/{docID}", s.deleteStudentDocument)
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

		s.mountAdminRollups(r)
		s.mountReportBuilder(r)
		s.mountAdminOps(r)
		s.mountMDM(r)
		s.mountTimetableOps(r)
		s.mountMasterTimetable(r)
		s.mountHRGrowth(r)
		s.mountClassroom(r)
		s.mountComms(r)
		s.mountDirectSend(r)
		s.mountSMSGateway(r)
		s.mountBusTrackerAdmin(r)
		/* The office's side of tracking: the live map, the stop-arrival
		   ledger and the safety events. Written, tested, and until now
		   reachable only from their own tests -- every one of these routes
		   404'd in production while the catalogue counted them shipped. */
		s.mountBusTracking(r)
		s.mountBusTrackerManage(r)
		s.mountTransportLiveMap(r)

		r.Route("/academics", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AcademicsRead))
			s.mountAdminAcademics(r)
			r.Get("/years", s.listAcademicYears)
			r.Get("/classes", s.listClasses)
			r.Get("/sections", s.listSections)
			r.Get("/subjects", s.listSubjects)
			/* Houses. The table and students.house_id have been in the
			   baseline since the beginning with no screen touching either. */
			/* The half of a report card with no marks in it. Not a subject:
			   an area has a grade, a term and a sentence, and putting it in
			   class_subjects would put Discipline in the timetable and in
			   every percentage the report card computes. */
			// terms has been in the schema from the beginning with nothing
			// reading it. A co-scholastic grade belongs to one.
			r.Get("/terms", s.listTerms)
			r.Get("/co-scholastic-areas", s.listCoScholasticAreas)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).
				Post("/co-scholastic-areas", s.saveCoScholasticArea)
			r.Get("/houses", s.listHouses)
			/* Clubs, coaching and electives. Enrolling in a paid one raises a
			   real invoice through the same numbering finance uses, so the
			   family pays it beside the tuition and the office collects it. */
			r.Get("/activities", s.listActivities)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/activities", s.saveActivity)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/houses", s.saveHouse)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Delete("/houses/{id}", s.deleteHouse)
		})

		r.Route("/timetable", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.TimetableRead))
			r.Get("/entries", s.listTimetableEntries)
			r.Get("/periods", s.listPeriods)
			r.Get("/teachers", s.listTeachers)
		})

		r.Route("/attendance", func(r chi.Router) {
			/* Chasing the people who can mark it.

			   The principal's dashboard named a real problem — six registers
			   unmarked — and offered a button that landed on a read-only
			   report, because a principal cannot mark a register and should
			   not. What they actually do at that moment is chase somebody. */
			r.With(httpx.RequirePermission(rbac.AttendanceReadAll)).
				Post("/nudge", s.nudgeRegister)
			r.With(httpx.RequirePermission(rbac.AttendanceRead)).Get("/", s.listAttendance)
			r.With(httpx.RequirePermission(rbac.AttendanceWrite)).Post("/", s.markAttendance)
		})

		r.Route("/me", func(r chi.Router) {
			r.With(httpx.RequirePermission(rbac.SelfAttendanceRead)).Get("/student", s.getMyStudent)
			// Ungated on purpose. Every other route asks "may this role read
			// payroll", and the answer for a teacher is no — which is right for
			// the payroll office's list of everybody and wrong for their own
			// payslip. There is no id in the path: the handler looks up the
			// employee row whose user_id is the caller, so it cannot be aimed
			// at somebody else's salary.
			r.Get("/pay", s.getMyPay)
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
			// Gated in the handler: HR decides staff leave, and a class
			// teacher decides their own students' leave. Requiring
			// hr.leave.approve on the route meant the person who marks the
			// register could see a parent's note and not answer it.
			r.Post("/leave/{id}/decide", s.decideLeave)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/concessions/{id}/decide", s.decideConcession)
			r.With(httpx.RequirePermission(rbac.StaffAttend)).Get("/staff-register", s.getStaffRegister)
			r.With(httpx.RequirePermission(rbac.StaffAttend)).Post("/staff-attendance", s.markStaffAttendance)
		})

		r.Route("/homework", func(r chi.Router) {
			r.Get("/", s.listHomework)
			r.With(httpx.RequirePermission(rbac.HomeworkWrite)).Post("/", s.publishHomework)
			r.Post("/{id}/submit", s.submitHomework)
			// Not gated on HomeworkWrite: a subject teacher who did not set
			// this task still covers the lesson it is due in, and the handler
			// narrows to sections the caller actually teaches anyway.
			r.Get("/{id}/submissions", s.listHomeworkSubmissions)
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
			/* What a board implies, said BEFORE it is chosen, and applied only
			   when somebody presses the button. The field was a label: nothing
			   in the product branched on it, so CBSE and Kerala SSLC produced
			   the same empty grading scale. */
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/boards", s.listBoardPresets)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).Post("/boards/apply", s.applyBoardPreset)
			// The lists a school may extend. Reading is gated on reading the
			// institution, because every form in the product needs them;
			// writing on settings.write, because adding a board changes what
			// the whole school records and is not a clerk's decision.
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/option-kinds", s.listCustomisableKinds)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/options", s.listOptions)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).Post("/options", s.addOption)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).Delete("/options/{id}", s.retireOption)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Put("/institution", s.updateInstitution)
			r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/campuses", s.listCampuses)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Post("/campuses", s.createCampus)
			r.With(httpx.RequirePermission(rbac.InstitutionWrite)).Put("/campuses/{id}", s.updateCampus)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/academic-years", s.createAcademicYear)
			// The dates here decide the year plan's ruler and the working-day
			// count, and a school that opened late enters the wrong Monday first.
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Patch("/academic-years/{id}", s.updateAcademicYear)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/classes", s.createClass)
			// Nothing joins on a name, so a rename is a label change the
			// timetable, register and ledger follow without moving.
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Patch("/classes/{id}", s.updateClass)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Delete("/classes/{id}", s.deleteClass)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/sections", s.createSection)
			// The name is the thing most likely to be wrong on the first pass, and
			// nothing joins on it — everything points at the section by id.
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Patch("/sections/{id}", s.updateSection)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Delete("/sections/{id}", s.deleteSection)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/subjects", s.createSubject)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Patch("/subjects/{id}", s.updateSubject)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Delete("/subjects/{id}", s.deleteSubject)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Put("/periods", s.setPeriods)
			r.With(httpx.RequirePermission(rbac.AcademicsRead)).Get("/class-subjects", s.listClassSubjects)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Put("/class-subjects", s.setClassSubjects)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/class-teacher", s.setClassTeacher)
			r.With(httpx.RequirePermission(rbac.AcademicsWrite)).Post("/assign-teacher", s.assignTeacher)
			r.With(httpx.RequirePermission(rbac.ExamsRead)).Get("/grading-scales", s.listGradingScales)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/grading-scales", s.createGradingScale)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Delete("/grading-scales/{id}", s.deleteGradingScale)
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).Post("/exams", s.createExam)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/fee-heads", s.listFeeHeads)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/fee-heads", s.createFeeHead)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Patch("/fee-heads/{id}", s.updateFeeHead)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Delete("/fee-heads/{id}", s.deleteFeeHead)
			// Pricing a class means naming one. Accounts holds fees.write and
			// not academics.read, so without this the class dropdown on the
			// fee-structure form was empty for exactly the people who use it.
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/fee-classes", s.listClasses)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/fee-structures", s.createFeeStructure)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/fee-structures", s.listFeeStructures)
			// Fees are re-set every year; a price list you cannot remove is
			// one the office works around with a second, similar name.
			r.With(httpx.RequirePermission(rbac.FeesWrite)).
				Delete("/fee-structures/{id}", s.deleteFeeStructure)
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/employees", s.createEmployee)
			// A phone changes, a name changes, somebody is promoted, a salary
			// account is keyed wrong once. No delete: leaving is a status.
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Patch("/employees/{id}", s.updateEmployee)
			// Completing an appointment: whoever may appoint somebody may let
			// them in. Deliberately not access.users.write — that right would
			// also let HR reset the principal's password.
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/employees/{id}/login", s.issueStaffLogin)
			// The handset credential, beside the browser one. Same permission
			// on purpose: the office that appointed a driver hands them their
			// PIN, and access.users.write would also let HR reset the
			// principal's password.
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/employees/{id}/pin", s.issueStaffPIN)
			// Assigning a class from the teacher's own record, writing the same
			// row the allocation grid writes — a staff record with its own idea
			// of who teaches what is one that disagrees with the timetable.
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).
				Post("/employees/{id}/subjects", s.assignStaffSubject)
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).
				Delete("/employees/{id}/subjects/{allocID}", s.removeStaffSubject)
			// Reading a downloaded password list back in. Same right as
			// issuing one by hand, because it is the same act done in bulk.
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/logins/import", s.importStaffLogins)

			// The fingerprint reader. Registering it is inside the session;
			// the device's own protocol is not, and cannot be — see iclock.go.
			r.With(httpx.RequirePermission(rbac.EmployeesRead)).Get("/biometric-devices", s.listBiometricDevices)
			r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/biometric-devices", s.saveBiometricDevice)
			// Punches from an id no employee claims: somebody enrolled a
			// finger without telling the office.
			r.With(httpx.RequirePermission(rbac.EmployeesRead)).Get("/biometric-devices/unclaimed", s.listUnresolvedPunches)

			/* The family's way in.

			   Nothing outside the demo seeder had ever written
			   students.user_id or guardians.user_id, so the parent workspace
			   (40 features) and the student workspace (30) were unreachable in
			   every real school on the installation. Gated on students.write,
			   because the office that admits a child is the office that hands
			   their family the login. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/students/{id}/login", s.issueStudentLogin)
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/guardians/{id}/login", s.issueGuardianLogin)

			/* Logins for everybody who has just been imported.

			   Not gated on the route: one handler serves students, guardians
			   and staff, and the loosest of the three rights would otherwise
			   become the price of admission to all of them. It checks the
			   matching permission per kind instead. */
			r.Post("/logins/bulk", s.issueLoginsInBulk)

			/* Setting a school up from the spreadsheets it already has.
			   Classes, sections and staff all existed as forms that took one
			   row at a time, which is eighty separate typings for a school of
			   ten classes — every one of those lists is already a spreadsheet
			   in the office. Gated on the permission the equivalent single
			   form needs, so importing grants nothing extra. */
			// The real gate is per entity, inside the handler: one route
			// serves classes, sections and staff, and staff must cost
			// employees.write rather than academics.write.
			// What has been uploaded before, by whom. Every importer used to
			// report a count and forget it on the next refresh.
			r.Get("/import/history", s.listImportRuns)
			// Taking one upload back out. Gated inside the handler on the same
			// permission the import itself needed, because one route serves
			// every entity.
			r.Post("/import/history/{id}/undo", s.undoImport)
			// The file itself, so an upload can be opened and read back.
			r.Get("/import/history/{id}/content", s.getImportContent)
			r.Get("/import/{entity}/template", s.getBulkTemplate)
			r.Post("/import/{entity}", s.bulkImport)
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
			// The head of department's own first screen — see hod_dashboard.go.
			r.Get("/hod-dashboard", s.getHODDashboard)
			// The teacher's half of the parent conversation — see
			// teacher_parent_inbox.go. The reply leg already existed; being
			// told there was something to reply to did not.
			r.Get("/parent-messages", s.listTeacherParentThreads)
			r.Get("/parent-messages/thread", s.listTeacherParentMessages)
			s.mountFacultyComms(r)
			s.mountTeaching(r)
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
			// What the school has written about your child. The staff screen
			// reads the same table under a different narrowing; this one adds
			// visible_to_family, which is the condition that makes a private
			// note private.
			r.Get("/remarks", s.listChildRemarks)
			r.Get("/fees", s.getFamilyFees)
			// The same conduct file, narrowed by the handler to the notes the
			// school chose to share. Without this the visible_to_student flag
			// would be a promise the product never keeps.
			r.Get("/notes", s.listDisciplineNotes)
			r.Get("/results", s.getFamilyResults)
			// The card itself, on the school's own design. Published cards
			// only, and only for a child this caller is attached to.
			r.Get("/results/card", s.renderFamilyReportCard)
			/* Paying from the app, with no money moving — a simulation, and
			   marked as one on every row it writes. It exists so the receipt,
			   the ledger and the balance are exercised before a gateway is
			   wired in, which is the worst day to find a fault in them. */
			r.Post("/fees/pay", s.portalSimulatedPay)
			// Where is my admission. Mounted here rather than under
			// /admissions because the caller is a family, not the office, and
			// the permission it must ride is the portal's own self/children
			// scope -- the admissions group requires staff read.
			s.mountPortalAdmission(r)
			s.mountParentPortal(r)
			s.mountParentSchoolLife(r)
			s.mountParentForum(r)
			s.mountStudentLearning(r)
			s.mountStudentLife(r)
		})

		// --- Accounts & Finance -------------------------------------------
		r.Route("/finance", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.InvoicesRead))
			s.mountLedgers(r)
			s.mountFeeEngine(r)
			s.mountTally(r)
			s.mountBanking(r)
			s.mountConcessions(r)
			s.mountCollections(r)
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
			/* A penalty somebody decided on, rather than one a rule worked out.
			   Same right as taking money: whoever may put a payment on a
			   family's ledger may put a charge on it. */
			r.With(httpx.RequirePermission(rbac.PaymentsWrite)).Post("/invoices/{id}/penalty", s.addInvoicePenalty)
			/* Chasing a fee today, rather than by rule. Same right as sending
			   any other message from the school: it goes to families over
			   channels the school pays for. */
			/* Gated on running the fee ledger, not on messaging.

			   comms.messages.send is the right to write to the school at
			   large; an accountant holds neither it nor any reason to. Chasing
			   a family for their own overdue bill is a fee action — it reaches
			   only families who owe money, about what they owe — so the
			   permission that says "you run the fees" is the one that governs
			   it. Gated the other way, the whole feature was a red line under
			   the button for the only role that would ever press it. */
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/reminders/send", s.sendFeeReminders)
			/* The standing arrangement, in one sentence: remind the family N
			   days before the fee is due, on this channel. Same plan row the
			   rules engine runs — change it here or there, both show it. */
			/* What a bounced cheque costs, decided once rather than typed at
			   the counter each time — see cheque_bounce_fine.go. */
			r.Get("/cheque-bounce-fine", s.getChequeBounceFine)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Put("/cheque-bounce-fine", s.setChequeBounceFine)
			r.Get("/reminders/schedule", s.getFeeReminderSchedule)
			r.With(httpx.RequirePermission(rbac.FeesWrite)).Put("/reminders/schedule", s.saveFeeReminderSchedule)
			r.With(httpx.RequirePermission(rbac.PaymentsWrite)).Post("/payments/{id}/bounce", s.bounceCheque)
			r.With(httpx.RequirePermission(rbac.PaymentsRead)).Get("/pdc", s.listPDC)
			r.With(httpx.RequirePermission(rbac.InvoicesRead)).Get("/defaulters", s.listDefaulters)
			/* RAISING ONE CHILD'S BILL IS AN ADMISSIONS ACT; a whole class is
			   an accounts one.

			   The gate was invoices.write alone, so the desk that admits a
			   child — and that already causes an invoice when it accepts an
			   application — was offered "Raise this child's fee" and refused
			   by name for pressing it. The handler enforces the split: without
			   invoices.write, a student_id is required. */
			r.With(httpx.RequireAnyPermission(rbac.InvoicesWrite, rbac.AdmissionsWrite)).
				Post("/invoices/generate", s.generateInvoices)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/concessions", s.listConcessions)
			// The writer the discount book never had. Raise on fees.write,
			// approve on refunds.write — the split concessions.go already
			// asserts for its own module.
			s.mountConcessionGrant(r)
			r.With(httpx.RequirePermission(rbac.FeesRead)).Get("/refunds", s.listRefunds)
		})

		// --- Admissions & Front Office ------------------------------------
		r.Route("/admissions", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AdmissionsRead))
			s.mountAdmissionsGrowth(r)
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
			/* THE KINDS OF LEAVE A SCHOOL GIVES ARE NOT AN HR SECRET.

			   Everything else under /hr is the staff FILE -- salaries,
			   documents, exits -- and hr.employees.read is the right gate for
			   it. This one is a dropdown on the form a teacher fills in to ask
			   for a day off, and it sat behind that same gate: a teacher's own
			   leave screen 403'd, showed "Type: Not recorded" on all thirteen
			   of their own rows, and offered nothing to pick when applying.

			   So it is registered before the guard rather than inside it, and
			   the guard moved into a group around everything else. Reading the
			   list of leave types tells you nothing about any person; writing
			   one is still hr.employees.write, below. */
			r.Get("/leave-types", s.listLeaveTypes)

			r.Group(func(r chi.Router) {
				r.Use(httpx.RequirePermission(rbac.EmployeesRead))
				r.Get("/dashboard", s.getHRDashboard)
				r.Get("/employees", s.listEmployees)
				/* One member of staff, and what they actually do here.

				   section_subject_teachers has been written from one direction
				   only — the allocation grid, which asks "who teaches 7-A
				   Maths". Nothing ever asked "what does Anand teach", although
				   that is where a clash, a substitution and a workload
				   conversation all start. */
				r.Get("/employees/{id}/detail", s.getStaffDetail)
				r.Get("/documents", s.listEmployeeDocuments)
				// The school's own ID card artwork, front and back. Reading it is
				// open to anybody who reads staff, because printing a card is the
				// point; changing it is a write against the school's branding.
				/* Letters over a career, not only at the end of one.

				   Writing one needs the right to change staff records; reading who
				   printed what is open to anybody who reads staff, because a
				   register nobody can see is not a check on anything. */
				r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Post("/letters", s.issueStaffLetter)
				r.Post("/letters/printed", s.logLetterPrinted)
				r.Get("/letters/prints", s.listLetterPrints)

				r.Get("/id-card-template", s.getIDCardTemplate)
				r.With(httpx.RequirePermission(rbac.EmployeesWrite)).
					Put("/id-card-template", s.saveIDCardTemplate)
				s.mountHRLifecycle(r)
			})
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
			// The host list on the visitor and appointment forms. Not
			// /hr/employees, which needs the permission that also opens
			// payroll — see front_desk_directory.go.
			r.Get("/staff", s.listDeskStaff)
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
			/* Which rungs of the ladder this school actually uses. Readable by
			   anyone who can see admissions, because the screens have to draw
			   themselves accordingly; writable only with admissions.write. */
			/* Telling a family where their application stands.

			   On admissions.write rather than comms.messages.send. The general
			   sending right also opens absence alerts, which are about enrolled
			   children and are not the admissions desk's business — and the
			   desk that cannot tell a family their offer is out is the reason
			   this all happens on somebody personal WhatsApp instead.

			   Narrow enough to be safe on the smaller right: it writes only to
			   the families behind applications, only in one of four fixed
			   admission templates, and never to a free-typed audience. */
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).
				Post("/applicant-messages", s.sendApplicantMessages)
			r.Get("/applications/{id}/fees", s.getAdmissionFees)
			r.Get("/applications/{id}/documents", s.listApplicationDocuments)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).
				Post("/applications/{id}/documents/{docID}", s.decideApplicationDocument)
			r.Get("/stages", s.getAdmissionStages)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Put("/stages", s.saveAdmissionStages)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications", s.createApplication)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications/{id}/assessment", s.recordAssessment)
			r.With(httpx.RequirePermission(rbac.AdmissionsWrite)).Post("/applications/{id}/decision", s.decideApplication)
			/* Offering a place is the desk's; the child actually JOINING takes
			   a seat, raises a bill and issues a family a login. A school that
			   wants its head to see those details first switches this on. */
			r.With(httpx.RequirePermission(rbac.AdmissionsRead)).
				Get("/pending-admissions", s.listPendingAdmissions)
			r.With(httpx.RequirePermission(rbac.AdmissionsApprove)).
				Post("/pending-admissions/{id}/decide", s.decideAdmission)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).
				Get("/admission-approval", s.getAdmissionApproval)
			r.With(httpx.RequirePermission(rbac.SettingsWrite)).
				Put("/admission-approval", s.setAdmissionApproval)
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
			s.mountBoardExams(r)
			r.Get("/list", s.listExams)
			// Papers, on an exam that already exists. Without this an exam
			// scheduled without them could never be given any, and five
			// screens downstream stay empty forever.
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).
				Post("/{id}/papers", s.addExamPapers)
			r.Get("/subjects", s.listExamSubjects)
			/* What a paper is out of, and which scale grades it — set before
			   marks are entered, which is the only safe moment. Both used to
			   be decided invisibly when the exam was created and could never
			   be changed. */
			r.With(httpx.RequirePermission(rbac.ExamsWrite)).
				Put("/subjects/{id}/setup", s.setPaperSetup)
			r.Get("/gradebook", s.getGradebook)
			r.Get("/report-cards", s.listReportCards)
			// Whether every subject teacher has finished. A card generated
			// before they have totals the marks that exist over the marks
			// that were expected, so a missing paper reads as a failed one.
			r.Get("/report-cards/readiness", s.getReportCardReadiness)
			r.With(httpx.RequirePermission(rbac.MarksWrite)).Post("/marks", s.enterMarks)

			// Question papers. Listing and submitting are open to anybody who
			// reads exams, because the handler narrows to the classes the
			// caller actually teaches — gating submission on a write
			// permission would mean the person who sets the paper needs the
			// right to schedule the exam.
			r.Get("/question-papers", s.listQuestionPapers)
			r.Get("/question-papers/slots", s.listPaperSlots)
			r.Post("/question-papers", s.submitQuestionPaper)
			r.With(httpx.RequirePermission(rbac.ExamsApprove)).
				Post("/question-papers/{id}/decide", s.decideQuestionPaper)

			// Mark moderation. Both sides need the approval permission: this
			// is not a screen a teacher reads about their own paper, it is the
			// department's judgement about all of them.
			r.With(httpx.RequirePermission(rbac.ExamsApprove)).Get("/moderation", s.listMarkModeration)
			r.With(httpx.RequirePermission(rbac.ExamsApprove)).Post("/moderation", s.moderateMarks)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/generate", s.generateReportCards)
			/* Up, then out. The class teacher who generated the set sends it
			   up; releasing it to families is a separate right, held by the
			   head, so nobody signs off their own results. */
			/* The design the school prints on.

			   Readable by anybody who may see a report card, because the
			   preview is part of reading one. Written by the class teacher as
			   well as the head: the person who discovers the subject column is
			   in the wrong order is the one printing thirty of them. */
			r.Get("/report-cards/template", s.getReportCardTemplate)
			r.Get("/report-cards/render", s.renderReportCard)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/template", s.saveReportCardTemplate)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/template/reset", s.resetReportCardTemplate)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/font", s.setReportCardFont)
			r.With(httpx.RequirePermission(rbac.ReportCardsGenerate)).Post("/report-cards/submit", s.submitReportCards)
			r.With(httpx.RequirePermission(rbac.ReportCardsPublish)).Get("/report-cards/pending", s.listPendingReportCards)
			r.With(httpx.RequirePermission(rbac.ReportCardsPublish)).Post("/report-cards/publish", s.publishReportCards)
			r.With(httpx.RequirePermission(rbac.ReportCardsPublish)).Post("/report-cards/return", s.returnReportCards)
			/* Anybody's own signature, on the exams routes because that is
			   where the documents it signs are. No user id in the request:
			   a signature somebody else can attach is not a signature. */
			r.Get("/my-signature", s.getMySignature)
			r.Put("/my-signature", s.setMySignature)

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
		/* A member of staff's own month. SelfProfileRead, not a teaching
		   permission: every one of these rows is already about the person
		   signed in -- their duties, their leave, the work they set -- so the
		   handler's WHERE clause is the scope, and a wider permission would
		   only stop office staff seeing a calendar of their own. */
		r.With(httpx.RequirePermission(rbac.SelfProfileRead)).
			Get("/me/calendar", s.getStaffCalendar)

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
			/* Answering a request a family actually made. The office's own
			   button INSERTS, so acting on a parent's request used to create a
			   second row with a second serial and leave the first sitting in
			   the family's list for ever. */
			r.With(httpx.RequirePermission(rbac.StudentsWrite)).
				Post("/certificates/{id}/decide", s.decideCertificate)
		})

		// --- Communication (module 6) --------------------------------------
		r.Route("/communication", func(r chi.Router) {
			r.Get("/circulars", s.listCirculars)
			// "Did it reach them?" had no answer anywhere in the product.
			r.Get("/circulars/{id}/delivery", s.getCircularDelivery)
			r.Post("/circulars/{id}/ack", s.ackCircular)
			r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).Post("/circulars", s.publishCircular)
		})

		// --- Timetable generation (module 7) -------------------------------
		r.Route("/timetable-admin", func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.TimetableWrite))
			r.Post("/substitutions", s.createSubstitution)
		})

		// --- Compliance exports (module 8) ---------------------------------
		s.mountStatutory(r)

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
			/* What a person is paid, which nothing could set.

			   Payroll only ever ran for staff who had a salary structure, and
			   no endpoint wrote one — so "Run payroll" found nobody, in every
			   school, for as long as the feature has existed. */
			/* Moving the month forward: lock it so attendance cannot change
			   an agreed figure, mark it paid when the transfer has gone, and
			   publish it so staff are told. Each is somebody's decision, and
			   the order is enforced — publishing before paying is how twelve
			   people ask where their money is. */
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/state", s.setPayrollState)

			r.Get("/components", s.listSalaryComponents)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/components", s.saveSalaryComponent)
			r.Get("/structures", s.listSalaryStructures)
			r.With(httpx.RequirePermission(rbac.PayrollWrite)).Post("/structures", s.saveSalaryStructure)

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
			s.mountDigitalLibrary(r)
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
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/assignable-staff", s.listAssignableStaff)
			/* The tracking policy, which nothing could reach.

			   Both handlers existed and no route pointed at either, so
			   parents_may_watch could never be turned on: every parent screen
			   correctly reported that the school had not published the buses,
			   and there was no way for the school to publish them. The
			   geofence, the speed limit and the trip timeout were unreachable
			   for the same reason. */
			r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/policy", s.getTrackingPolicy)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Put("/transport/policy", s.saveTrackingPolicy)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/routes", s.saveRoute)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Put("/transport/routes/{id}", s.saveRoute)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Delete("/transport/routes/{id}", s.deleteRoute)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/vehicles", s.createVehicle)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Put("/transport/vehicles/{id}", s.updateVehicle)
			r.With(httpx.RequirePermission(rbac.TransportWrite)).Put("/transport/vehicles/{id}/route", s.setVehicleRoute)
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
			// The price list is the one screen in this workspace that exists
			// to be changed — see plans_write.go. A school's agreed price is
			// fixed at signing, so an edit reaches the next purchase only.
			r.Post("/plans", s.createPlan)
			r.Put("/plans/{code}", s.updatePlan)
			r.Delete("/plans/{code}", s.retirePlan)
			// What one school was promised, against what its tier includes —
			// see tenant_limits.go. A number, not a switch, which is why the
			// entitlement matrix could not hold it.
			r.Get("/limits", s.listTenantLimits)
			r.Put("/limits", s.setTenantLimits)
			r.Get("/tickets", s.listTickets)
			r.Get("/enquiries", s.listSalesEnquiries)
			/* The write half. Leads have had a five-stage status since 00013
			   and nothing could ever move one, so every enquiry this product
			   received was permanently 'new'. See seller_crm.go. */
			s.mountSellerCRM(r)
			// One notice to every school at once — see platform_broadcast.go.
			// What each school uses, and what the installation costs to
			// provide it — see platform_usage.go.
			// The provisioning and error log — see platform_log.go.
			r.Get("/events", s.listPlatformEvents)
			r.Get("/usage", s.getPlatformUsage)
			r.Put("/costs", s.setPlatformCosts)
			r.Get("/broadcasts", s.listPlatformBroadcasts)
			r.Post("/broadcasts", s.raisePlatformBroadcast)
			r.Delete("/broadcasts/{id}", s.retirePlatformBroadcast)
		})

		/* What the vendor is telling every school, read by everyone.

		   Outside /seller and gated on nothing beyond being signed in: a
		   maintenance notice only the vendor may read is not a notice, and a
		   permission in front of it would keep it from the person at the
		   counter who most needs to know the site goes down on Sunday. */
		r.Get("/platform-notices", s.listLiveBroadcasts)

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
			s.mountPlatformConfig(r)
			s.mountMessaging(r)
			s.mountMessageRules(r)
			s.mountWhatsApp(r)
			s.mountTallyConnector(r)
			s.mountConnectors(r)
			s.mountIntegrationsIndex(r)
			r.With(httpx.RequirePermission(rbac.UsersRead)).Get("/users", s.listUsers)
			r.With(httpx.RequirePermission(rbac.UsersRead)).Get("/users/{id}", s.getUser)
			r.With(httpx.RequirePermission(rbac.UsersWrite)).Post("/users", s.createUser)
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Put("/users/{id}/roles", s.setRoles)
			// Handing a job over: grant and revoke in one transaction, so the
			// school is never left with two bursars or none.
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Post("/users/roles/transfer", s.transferRoles)
			// An account with a role of its own, created empty and dialled up on
			// the grid, for the job the built-in roles do not describe.
			r.With(httpx.RequirePermission(rbac.RolesWrite)).Post("/users/generic", s.createGenericAccount)
			// The built-ins as starting points. They cannot be edited in place —
			// the seeder restores them — so copying is the move, and this names
			// what each copy would give.
			r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/roles/templates", s.listRoleTemplates)
			// Gated in the handler, not here: appointing somebody requires
			// choosing their role, so hr.employees.write has to be able to
			// read the list. Requiring roles.read meant an HR manager with
			// every right to appoint staff was shown an empty dropdown.
			r.Get("/assignable-roles", s.listAssignableRoles)
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

		/* Remarks about staff, as distinct from remarks about children.
		   Gated on nothing beyond a session: who may write about whom is a
		   question about the relationship between two people, not a
		   capability, and the handler works it out. */
		/* One member of staff writing to another.

		   Behind a session and nothing more: who may write to whom is a
		   question about two people at the same school, which the handler
		   answers, and not a capability anybody is granted. */
		r.Route("/staff-messages", func(r chi.Router) {
			r.Get("/", s.listStaffMessages)
			r.Get("/threads", s.listStaffThreads)
			r.Post("/", s.sendStaffMessage)
		})

		r.Route("/staff-remarks", func(r chi.Router) {
			r.Get("/", s.listStaffRemarks)
			r.Post("/", s.createStaffRemark)
			r.Get("/teachers", s.listRemarkableTeachers)
		})

		r.Route("/files", func(r chi.Router) {
			r.Post("/presign", s.presignUpload)
			// The two that work without an object store. Any signed-in member
			// of the school may upload and read; which screens offer it is a
			// catalogue decision, and narrowing per purpose here would mean
			// this handler had to know what every future caller is for.
			r.Post("/", s.uploadFile)
			r.Get("/{id}", s.downloadFile)
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
