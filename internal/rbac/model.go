package rbac

import "sort"

/*
The product-facing permission model.

A school administrator does not think in permission keys. They think "the
accountant manages fees, the class teacher marks attendance for her own
section". This file is the translation layer: it projects the 70 capability
keys onto a grid of feature groups, each carrying a level and a data scope,
and projects a grid back onto keys.

Two deliberate departures from a naive five-rung ladder:

Approve is not a rung above Manage. A head of department approves leave without
editing employee records; a class teacher generates report cards without
scheduling exams. Modelling approval as a superset of editing would have forced
those roles into "custom" the moment anyone opened the screen. It is an
independent toggle, offered only where the group has an approval key.

Export is the same, for the same reason: an accountant exports the fee ledger
without being able to refund against it.

Everything else is a strict ladder — None, View, Manage — because "can edit but
cannot see" is not a thing a school ever means.
*/

// Level is the rung a role sits on for one feature group.
type Level int8

const (
	LevelNone Level = iota
	LevelView
	LevelManage
)

var levelNames = [...]string{"none", "view", "manage"}

func (l Level) String() string {
	if l < 0 || int(l) >= len(levelNames) {
		return "none"
	}
	return levelNames[l]
}

// ParseLevel reads a level back off the wire. Unknown input is rejected rather
// than defaulting, because defaulting a bad level to "manage" grants access and
// defaulting it to "none" silently removes it.
func ParseLevel(s string) (Level, bool) {
	for i, n := range levelNames {
		if n == s {
			return Level(i), true
		}
	}
	return LevelNone, false
}

// Band sorts groups into the three shelves the configuration screen shows:
// what every school uses, what only some schools buy, and what the product
// itself needs.
type Band string

const (
	BandCore     Band = "core"
	BandOptional Band = "optional"
	BandSystem   Band = "system"
)

// ScopeRule is one rung of a group's data-scope ladder.
//
// WriteKeys are granted only when the level reaches Manage: widening a
// teacher's attendance to the whole school should let them read every register
// without also letting them mark a class they do not teach, unless they were
// given the ability to mark at all.
type ScopeRule struct {
	Scope     string
	Keys      []string
	WriteKeys []string
}

// Group is one row of the grid — a feature group a school would recognise.
type Group struct {
	Key   string
	Name  string
	Blurb string
	Band  Band

	// View and Manage are the keys each rung adds; Approve and Export are the
	// independent toggles. A nil slice means the group does not offer that rung.
	View    []string
	Manage  []string
	Approve []string
	Export  []string

	// Scopes is the selectable ladder, narrowest first. A group with fewer than
	// two entries has a scope that follows the person's posting rather than the
	// role definition, and the screen shows it read-only with ScopeNote.
	Scopes    []ScopeRule
	ScopeNote string
}

// fixed builds the single-entry ladder used by groups whose reach is decided
// by the assignment rather than by the role.
func fixed(scope string) []ScopeRule { return []ScopeRule{{Scope: scope}} }

// Groups is the whole grid, in the order the screen renders it.
//
// Every one of the 70 capability keys appears in exactly one group, which
// TestGroupsCoverEveryPermission enforces. A key that fell out of the grid
// would be invisible to whoever configures a role and impossible to grant
// without a shell.
var Groups = []Group{
	// --- the school day ---------------------------------------------------
	{
		Key: "students", Name: "Students", Band: BandCore,
		Blurb:   "Student records, profiles and the register of who is enrolled.",
		View:    []string{StudentsRead},
		Manage:  []string{StudentsWrite},
		Approve: []string{StudentsDelete},
		Export:  []string{StudentsExport},
		Scopes: []ScopeRule{
			{Scope: "assigned_classes"},
			{Scope: "institution", Keys: []string{StudentsReadAll}},
		},
		ScopeNote: "Assigned classes means the sections this person teaches or is class teacher of.",
	},
	{
		Key: "admissions", Name: "Admissions", Band: BandCore,
		Blurb:     "Enquiries, applications, documents and the admission decision.",
		View:      []string{AdmissionsRead},
		Manage:    []string{AdmissionsWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "The admission pipeline is school-wide; a lead has no class yet.",
	},
	{
		Key: "attendance", Name: "Attendance", Band: BandCore,
		Blurb:  "Daily and period attendance for students.",
		View:   []string{AttendanceRead},
		Manage: []string{AttendanceWrite},
		Scopes: []ScopeRule{
			{Scope: "assigned_classes"},
			{Scope: "institution", Keys: []string{AttendanceReadAll}, WriteKeys: []string{AttendanceWriteAny}},
		},
		ScopeNote: "Widening to the whole school lets this person mark any section, not only their own.",
	},
	{
		Key: "academics", Name: "Classes & subjects", Band: BandCore,
		Blurb:     "The academic structure: classes, sections, subjects and allocations.",
		View:      []string{AcademicsRead},
		Manage:    []string{AcademicsWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "The structure itself is school-wide; what it contains is scoped elsewhere.",
	},
	{
		Key: "timetable", Name: "Timetable", Band: BandCore,
		Blurb:     "The period grid, teacher allocation and substitutions.",
		View:      []string{TimetableRead},
		Manage:    []string{TimetableWrite},
		Scopes:    fixed("assigned_classes"),
		ScopeNote: "Reading is filtered to this person's own periods; office and leadership roles see the whole grid.",
	},
	{
		Key: "homework", Name: "Homework & classwork", Band: BandCore,
		Blurb:     "Setting work and reviewing what comes back.",
		Manage:    []string{HomeworkWrite},
		Scopes:    fixed("assigned_classes"),
		ScopeNote: "Always the person's own classes.",
	},
	{
		Key: "exams", Name: "Exams & schedules", Band: BandCore,
		Blurb:  "Exam types, terms, papers and the exam calendar.",
		View:   []string{ExamsRead},
		Manage: []string{ExamsWrite},
		// Vouching for the paper before it is printed and for the marks after
		// it is sat. Separate from Manage because scheduling an exam and
		// standing behind what is on it are different jobs, held by different
		// people in most schools.
		Approve:   []string{ExamsApprove},
		Scopes:    fixed("institution"),
		ScopeNote: "An exam schedule belongs to the school, not to a section.",
	},
	{
		Key: "marks", Name: "Marks & report cards", Band: BandCore,
		Blurb:     "Entering marks and issuing the report card.",
		Manage:    []string{MarksWrite},
		Approve:   []string{ReportCardsGenerate},
		Scopes:    fixed("assigned_classes"),
		ScopeNote: "Marks entry follows the subjects allocated to this person.",
	},
	{
		Key: "fees", Name: "Fees & payments", Band: BandCore,
		Blurb:     "Fee structure, invoices, collection, concessions and refunds.",
		View:      []string{FeesRead, InvoicesRead, PaymentsRead},
		Manage:    []string{FeesWrite, InvoicesWrite, PaymentsWrite},
		Approve:   []string{RefundsWrite},
		Export:    []string{FinanceExport},
		Scopes:    fixed("institution"),
		ScopeNote: "The fee ledger is school-wide. Parents see only their own through the portal.",
	},
	{
		Key: "staff", Name: "Staff & leave", Band: BandCore,
		Blurb:     "Employee records, staff attendance and leave.",
		View:      []string{EmployeesRead},
		Manage:    []string{EmployeesWrite, StaffAttend},
		Approve:   []string{LeaveApprove},
		Scopes:    fixed("institution"),
		ScopeNote: "A head of department is narrowed to their own department by their posting.",
	},
	{
		Key: "announcements", Name: "Announcements", Band: BandCore,
		Blurb:     "Circulars and notices to classes, parents or the whole school.",
		Manage:    []string{AnnouncementsWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Who receives a notice is chosen when it is published.",
	},
	{
		Key: "reports", Name: "Reports & analytics", Band: BandCore,
		Blurb:     "Collection, strength, attendance and performance reporting.",
		View:      []string{ReportsRead},
		Scopes:    fixed("institution"),
		ScopeNote: "Every report is bounded by the reader's other scopes.",
	},
	{
		Key: "institution", Name: "Institution & campuses", Band: BandCore,
		Blurb:     "The school profile, its campuses and its branding.",
		Manage:    []string{InstitutionWrite, CampusesWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Whole-school configuration.",
	},
	{
		Key: "settings", Name: "Settings & integrations", Band: BandCore,
		Blurb:     "Module settings, numbering, payment gateway, SMS and WhatsApp.",
		View:      []string{InstitutionRead},
		Manage:    []string{SettingsWrite, IntegrationsWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Whole-school configuration.",
	},
	{
		Key: "access", Name: "Users & roles", Band: BandCore,
		Blurb:     "Accounts, role assignment and signing people out.",
		View:      []string{UsersRead, RolesRead},
		Manage:    []string{UsersWrite, RolesWrite, SessionsRevoke},
		Scopes:    fixed("institution"),
		ScopeNote: "Granting this lets a person widen their own access. Give it sparingly.",
	},
	{
		// Kept apart from Users & roles so a support engineer can be given the
		// audit trail and the job queue — everything needed to explain what
		// happened — without also being able to create accounts.
		Key: "audit", Name: "Audit trail & jobs", Band: BandCore,
		Blurb:     "The change history, background jobs and the ability to re-run them.",
		View:      []string{AuditRead, JobsRead},
		Manage:    []string{JobsEnqueue},
		Scopes:    fixed("institution"),
		ScopeNote: "Reading the audit trail shows who changed what, including on records this person cannot open.",
	},

	// --- bought or switched on separately ---------------------------------
	{
		Key: "payroll", Name: "Payroll", Band: BandOptional,
		Blurb:     "Salary structure, deductions, payslips and the monthly run.",
		View:      []string{PayrollRead},
		Manage:    []string{PayrollWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Separate from staff records so an HR clerk can keep files without seeing salaries.",
	},
	{
		Key: "discipline", Name: "Discipline & conduct", Band: BandOptional,
		Blurb:     "Conduct notes and disciplinary action on a student's record.",
		Manage:    []string{DisciplineWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Written against the student, readable wherever that student is readable.",
	},
	{
		Key: "health", Name: "Infirmary", Band: BandOptional,
		Blurb:     "Medical incidents, allergies, medication and visit history.",
		View:      []string{HealthRead},
		Manage:    []string{HealthWrite},
		Scopes:    fixed("institution"),
		ScopeNote: "Health data is sensitive. Grant it to clinic staff only.",
	},
	{
		Key: "counselling", Name: "Counselling", Band: BandOptional,
		Blurb:     "Counselling notes, kept apart from the infirmary record.",
		View:      []string{CounselingRead},
		Scopes:    fixed("institution"),
		ScopeNote: "Read-only in the product; notes are written in the counsellor's own workspace.",
	},
	{
		Key: "messaging", Name: "SMS, email & WhatsApp", Band: BandOptional,
		Blurb:     "Sending on the paid channels, as opposed to posting a notice.",
		Manage:    []string{MessagesSend},
		Scopes:    fixed("institution"),
		ScopeNote: "Every send is metered and logged against the school.",
	},
	{
		Key: "results_release", Name: "Releasing results", Band: BandCore,
		Blurb: "Signing report cards off and letting families read them.",
		/* A group of its own rather than another rung on "Marks & report
		   cards".

		   The levels inside a group are a ladder: anybody standing on Approve
		   holds every key at that level. Put release beside generate and the
		   class teacher who produced the cards is handed the power to publish
		   them — which is exactly the state the approval workflow replaces. */
		/* Manage, not Approve.

		   Approve in this model is an independent toggle sitting on top of a
		   level, and a group has to offer a level of its own — which is right:
		   "can approve but has no level" describes nothing. Releasing results
		   is the managing of them, so that is the rung it sits on. */
		Manage:    []string{ReportCardsPublish},
		Scopes:    fixed("institution"),
		ScopeNote: "A head signs off for the school. Class teachers submit; they do not release.",
	},
	{
		Key: "message_oversight", Name: "Reading staff–family messages", Band: BandOptional,
		Blurb:  "What teachers and families said to each other, read by somebody who was not party to it.",
		View:   []string{MessagesReadAll},
		Scopes: fixed("institution"),
		ScopeNote: "A head of department is narrowed to their own department's teachers; " +
			"a principal sees the school. Kept apart from students.read.all, which the " +
			"librarian and the transport manager hold and which is no reason to read a " +
			"family's correspondence.",
	},
	{
		Key: "transport", Name: "Transport", Band: BandOptional,
		Blurb:     "Vehicles, routes, stops, allocation and GPS.",
		View:      []string{TransportRead},
		Manage:    []string{TransportWrite},
		Scopes:    fixed("campus"),
		ScopeNote: "Bounded by the campuses this person is posted to.",
	},
	{
		Key: "front_desk", Name: "Front desk", Band: BandOptional,
		Blurb:     "Visitor passes, the block list, appointments, calls and post.",
		View:      []string{FrontDeskRead},
		Manage:    []string{FrontDeskWrite},
		Scopes:    fixed("campus"),
		ScopeNote: "Each campus keeps its own gate register.",
	},
	{
		Key: "library", Name: "Library", Band: BandOptional,
		Blurb:     "Catalogue, accession register, issue, return and fines.",
		View:      []string{LibraryRead},
		Manage:    []string{LibraryWrite},
		Scopes:    fixed("campus"),
		ScopeNote: "Bounded by the campuses this person is posted to.",
	},
	{
		Key: "hostel", Name: "Hostel", Band: BandOptional,
		Blurb:     "Rooms, beds, allocation, gate pass and hostel attendance.",
		View:      []string{HostelRead},
		Manage:    []string{HostelWrite},
		Scopes:    fixed("campus"),
		ScopeNote: "Residential schools only.",
	},
	{
		Key: "inventory", Name: "Inventory & assets", Band: BandOptional,
		Blurb:     "Stores, uniforms, stationery, lab items and fixed assets.",
		View:      []string{InventoryRead},
		Manage:    []string{InventoryWrite, AssetsWrite},
		Scopes:    fixed("campus"),
		ScopeNote: "Bounded by the campuses this person is posted to.",
	},

	// --- the product itself -----------------------------------------------
	{
		Key: "platform", Name: "Platform operations", Band: BandSystem,
		Blurb:     "Tenants and subscription plans. The vendor's own back office.",
		Manage:    []string{PlatformTenantsRW, PlatformPlansRW},
		Scopes:    fixed("platform"),
		ScopeNote: "Spans every school on the installation. Never grant this to a school.",
	},
	{
		Key: "account", Name: "Own account", Band: BandSystem,
		Blurb:     "The signed-in person's own profile and password.",
		View:      []string{SelfProfileRead},
		Manage:    []string{SelfProfileWrite},
		Scopes:    fixed("own"),
		ScopeNote: "Every role holds this.",
	},
	{
		Key: "portal", Name: "Own attendance & fees", Band: BandSystem,
		Blurb:     "The student portal: my attendance, my fees, my receipts.",
		View:      []string{SelfAttendanceRead, SelfFeesRead},
		Scopes:    fixed("own"),
		ScopeNote: "Arrives with the student record, not from this screen.",
	},
	{
		Key: "children", Name: "Linked children", Band: BandSystem,
		Blurb:     "The guardian's view of the students they are linked to.",
		View:      []string{SelfChildrenRead},
		Scopes:    fixed("linked_children"),
		ScopeNote: "Arrives with the guardian link, not from this screen.",
	},
}

// GroupByKey looks a group up by key.
func GroupByKey(key string) (Group, bool) {
	for _, g := range Groups {
		if g.Key == key {
			return g, true
		}
	}
	return Group{}, false
}

// keysAt returns the keys a level implies, cumulatively.
func (g Group) keysAt(l Level) []string {
	var out []string
	if l >= LevelView {
		out = append(out, g.View...)
	}
	if l >= LevelManage {
		out = append(out, g.Manage...)
	}
	return out
}

// Levels lists the rungs this group actually offers. A group with no read key
// — homework, announcements — goes straight from None to Manage, and offering
// a View rung that grants nothing would be a control that does nothing.
func (g Group) Levels() []Level {
	out := []Level{LevelNone}
	if len(g.View) > 0 {
		out = append(out, LevelView)
	}
	if len(g.Manage) > 0 {
		out = append(out, LevelManage)
	}
	return out
}

// owns reports whether a key belongs to this group, scope keys included.
func (g Group) owns(key string) bool {
	for _, list := range [][]string{g.View, g.Manage, g.Approve, g.Export} {
		for _, k := range list {
			if k == key {
				return true
			}
		}
	}
	for _, s := range g.Scopes {
		for _, list := range [][]string{s.Keys, s.WriteKeys} {
			for _, k := range list {
				if k == key {
					return true
				}
			}
		}
	}
	return false
}

// GroupState is one row of a role's grid.
type GroupState struct {
	Group string `json:"group"`
	Level string `json:"level"`
	Scope string `json:"scope"`

	Approve bool `json:"approve"`
	Export  bool `json:"export"`

	// Extra holds keys the role carries that its level does not imply — a
	// hand-tuned combination. They are shown rather than hidden, and Apply
	// preserves them, because silently dropping a grant on save is how a role
	// loses an ability nobody meant to remove.
	Extra []string `json:"extra,omitempty"`
}

// Read projects a permission set onto the grid.
func Read(keys []string) []GroupState {
	held := make(map[string]bool, len(keys))
	for _, k := range keys {
		held[k] = true
	}

	out := make([]GroupState, 0, len(Groups))
	for _, g := range Groups {
		st := GroupState{Group: g.Key, Level: LevelNone.String()}

		// The level is the highest rung whose keys are all held. Stopping at the
		// first gap rather than counting a majority means a role that holds two
		// of three fee-read keys reads as View plus an extra, not as full View.
		level := LevelNone
		for _, l := range []Level{LevelView, LevelManage} {
			complete := true
			for _, k := range g.keysAt(l) {
				if !held[k] {
					complete = false
					break
				}
			}
			if !complete {
				break
			}
			level = l
		}
		st.Level = level.String()

		st.Approve = len(g.Approve) > 0 && allHeld(held, g.Approve)
		st.Export = len(g.Export) > 0 && allHeld(held, g.Export)

		// Widest satisfied scope wins. WriteKeys are ignored when reading: a
		// role given institution-wide attendance reads at that scope whether or
		// not it can also mark, and the write half is restored on save from the
		// level rather than from the scope.
		st.Scope = ""
		for _, s := range g.Scopes {
			if allHeld(held, s.Keys) {
				st.Scope = s.Scope
			}
		}
		if st.Scope == "" && len(g.Scopes) > 0 {
			st.Scope = g.Scopes[0].Scope
		}

		accounted := map[string]bool{}
		for _, k := range g.keysAt(level) {
			accounted[k] = true
		}
		if st.Approve {
			for _, k := range g.Approve {
				accounted[k] = true
			}
		}
		if st.Export {
			for _, k := range g.Export {
				accounted[k] = true
			}
		}
		// Scope keys count as accounted for only while the group is open at
		// all, mirroring Apply. A widener held with no underlying access — the
		// shape that let a role carry attendance.read.all while every
		// attendance endpoint refused it — must surface as an extra, not be
		// quietly absorbed here and then dropped on the next save.
		if level > LevelNone {
			for _, s := range g.Scopes {
				if s.Scope != st.Scope {
					continue
				}
				for _, k := range s.Keys {
					accounted[k] = true
				}
				if level >= LevelManage {
					for _, k := range s.WriteKeys {
						accounted[k] = true
					}
				}
			}
		}
		for _, k := range keys {
			if g.owns(k) && !accounted[k] {
				st.Extra = append(st.Extra, k)
			}
		}
		sort.Strings(st.Extra)
		out = append(out, st)
	}
	return out
}

// Apply projects a grid back onto a permission set.
//
// It returns only capability keys. A role's catalog feature grants live in the
// same table and are not this function's business; the caller diffs against
// All so the navigation grants survive a save untouched.
func Apply(states []GroupState) []string {
	byKey := make(map[string]GroupState, len(states))
	for _, s := range states {
		byKey[s.Group] = s
	}

	set := map[string]bool{}
	for _, g := range Groups {
		st, ok := byKey[g.Key]
		if !ok {
			continue
		}
		level, ok := ParseLevel(st.Level)
		if !ok {
			continue
		}
		for _, k := range g.keysAt(level) {
			set[k] = true
		}
		// An approval or an export with no underlying access is a control that
		// cannot be exercised: you cannot refund against a ledger you cannot
		// read. Both toggles are ignored below View, which keeps the saved role
		// consistent with what the screen showed.
		if level > LevelNone {
			if st.Approve {
				for _, k := range g.Approve {
					set[k] = true
				}
			}
			if st.Export {
				for _, k := range g.Export {
					set[k] = true
				}
			}
		}
		for _, s := range g.Scopes {
			if s.Scope != st.Scope || level == LevelNone {
				continue
			}
			for _, k := range s.Keys {
				set[k] = true
			}
			if level >= LevelManage {
				for _, k := range s.WriteKeys {
					set[k] = true
				}
			}
		}
		for _, k := range st.Extra {
			if g.owns(k) {
				set[k] = true
			}
		}
	}

	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func allHeld(held map[string]bool, keys []string) bool {
	if len(keys) == 0 {
		return false
	}
	for _, k := range keys {
		if !held[k] {
			return false
		}
	}
	return true
}
