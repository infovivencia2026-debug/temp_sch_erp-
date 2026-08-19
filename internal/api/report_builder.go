package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* institution_admin.analysis.custom_report_builder

   A principal defines a report without waiting for a developer: pick a
   subject, tick columns, add filters, group it, sort it, save it, run it,
   export it, share it with a role.

   The single hard requirement is that this must not become an arbitrary SQL
   surface. Nothing the client sends is ever interpolated into a statement.
   The client sends KEYS; reportSubjects below is the only place in the process
   that knows a table or a column name, every one of them a Go string literal,
   and a key that is not in it is refused. Values are always parameters.

   Three properties follow from that and are worth stating because each one is
   a thing a report builder normally gets wrong:

     - A saved report is a definition, never a result set. Running one for a
       different user re-resolves THAT user's scope. Sharing a report with a
       head of department therefore shares the question, not the principal's
       answer to it. Storing rows, or storing the author's scope alongside the
       definition, would turn "share" into privilege escalation.

     - Scope goes in as a parameter, not as a conditional fragment. Every
       generated query carries a scope predicate in the unconditional form the
       comment above rollupBoundary.deptPredicate recommends —
       ($n::uuid[] IS NULL OR col = ANY($n)) — because these queries build
       their placeholders dynamically and a predicate that sometimes consumes
       its argument and sometimes does not cannot survive that. NULL means
       unrestricted; an empty array means the caller's boundary is genuinely
       empty and the report is correctly empty.

     - A report over the whole institution can be slow and can be large. Every
       run is capped by the saved row_limit, paginated, and counted; export is
       a separate deliberate act (?format=csv) and is recorded in report_runs,
       because a list of every child's address on a screen and the same list in
       somebody's downloads folder are not the same event.

   RBAC: everything here sits behind admin.reports.read, which is the existing
   permission for "view reports and analytics" and is exactly what these are.
   There is no reports.write in rbac; rather than invent one, editing and
   deleting a definition is restricted to its author or to a holder of
   settings.write, decided in the handler. That is a narrower rule than a
   permission could express anyway: it is about which row, not which capability.
*/

// --- the whitelist -----------------------------------------------------------

/*
reportDimension is a column you can show and group by.

	Expr is a SQL fragment written in this file and never derived from a
	request. It is safe to interpolate for exactly that reason, and for no
	other.
*/
type reportDimension struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"` // text | number | date | money
	Expr  string `json:"-"`
}

/*
reportMeasure is a column that only exists once the report is grouped.

	Kept apart from dimensions rather than flagged on them because the two are
	legal in different reports: a measure in an ungrouped report is a bare
	aggregate beside raw columns, which Postgres rejects and a user cannot be
	expected to predict. Splitting the vocabulary lets the server refuse it at
	save time with a sentence instead of a syntax error.
*/
type reportMeasure struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
	Expr  string `json:"-"`
}

// reportField is something you can filter on, and the operators it admits.
type reportField struct {
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Kind  string   `json:"kind"` // text | number | date | uuid | enum
	Ops   []string `json:"ops"`
	// Options is the closed vocabulary for an enum, so the UI offers a select
	// rather than a free-text box the server will only reject.
	Options []string `json:"options,omitempty"`
	Expr    string   `json:"-"`
}

/*
reportSubject is one thing a school can report on.

	From is the FROM clause and its joins, fixed per subject. A "joinable
	dimensions" model where the client picks joins was considered and dropped:
	the joins that matter here are the ones that give a row its class, its
	section and its department, every subject needs all of them, and making
	them optional buys nothing but a way to write a cross join.

	ScopeExpr is the column the caller's boundary applies to, and Scope reads
	the resolved boundary for it. Both are mandatory. A subject with no scope
	is a subject that leaks across a department, so there is no way to declare
	one.
*/
type reportSubject struct {
	Key        string            `json:"key"`
	Name       string            `json:"name"`
	Summary    string            `json:"summary"`
	Dimensions []reportDimension `json:"dimensions"`
	Measures   []reportMeasure   `json:"measures"`
	Fields     []reportField     `json:"fields"`

	From      string                              `json:"-"`
	Where     string                              `json:"-"` // always-on predicate, may be empty
	ScopeExpr string                              `json:"-"`
	Scope     func(b *rollupBoundary) []uuid.UUID `json:"-"`
}

func (s reportSubject) dimension(key string) (reportDimension, bool) {
	for _, d := range s.Dimensions {
		if d.Key == key {
			return d, true
		}
	}
	return reportDimension{}, false
}

func (s reportSubject) measure(key string) (reportMeasure, bool) {
	for _, m := range s.Measures {
		if m.Key == key {
			return m, true
		}
	}
	return reportMeasure{}, false
}

func (s reportSubject) field(key string) (reportField, bool) {
	for _, f := range s.Fields {
		if f.Key == key {
			return f, true
		}
	}
	return reportField{}, false
}

// Operator sets, named so a field declares an intent rather than a list.
var (
	opsText   = []string{"eq", "ne", "contains", "in", "is_null", "is_not_null"}
	opsEnum   = []string{"eq", "ne", "in", "is_null", "is_not_null"}
	opsNumber = []string{"eq", "ne", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"}
	opsDate   = []string{"eq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"}
	opsUUID   = []string{"eq", "in"}
)

/*
sectionScope is the boundary for anything keyed on a class.

	nil means unrestricted, which is not the same as an empty slice: a teacher
	timetabled for nothing must see nothing, and returning nil for them would
	hand them the school. scope.Resolved documents the same distinction and it
	is preserved all the way to the placeholder.
*/
func sectionScope(b *rollupBoundary) []uuid.UUID {
	if b.All {
		return nil
	}
	if b.Res.SectionIDs == nil {
		return []uuid.UUID{}
	}
	return b.Res.SectionIDs
}

func departmentScope(b *rollupBoundary) []uuid.UUID {
	if b.All {
		return nil
	}
	if b.Depts == nil {
		return []uuid.UUID{}
	}
	return b.Depts
}

/*
reportSubjects is the entire surface a saved report can reach.

	Four subjects rather than forty. Each one is a question a school already
	asks on paper — who is enrolled, who turned up, who has paid, who is on the
	staff — and each carries the joins that give a row its class and its
	department so scope can be applied. Adding a fifth is a Go change and a
	review, which is the point: the alternative is a form that reaches every
	table in the schema including the one holding password hashes.

	Deliberately NOT reachable: anything the roll-ups in admin_rollups.go
	already answer as a finished screen, and anything confidential — medical
	records, discipline, counselling, bank details, Aadhaar. A column absent
	here cannot be selected by any means the API offers.
*/
var reportSubjects = []reportSubject{
	{
		Key:     "students",
		Name:    "Students",
		Summary: "One row per enrolled student, with their class and section.",
		From: `students st
		         JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		         JOIN sections sec ON sec.id = en.section_id
		         JOIN classes cl ON cl.id = en.class_id`,
		ScopeExpr: "en.section_id",
		Scope:     sectionScope,
		Dimensions: []reportDimension{
			{Key: "admission_no", Label: "Admission no", Kind: "text", Expr: "st.admission_no"},
			{Key: "full_name", Label: "Name", Kind: "text",
				Expr: `concat_ws(' ', st.first_name, nullif(st.middle_name,''), st.last_name)`},
			{Key: "class", Label: "Class", Kind: "text", Expr: "cl.name"},
			{Key: "section", Label: "Section", Kind: "text", Expr: "sec.name"},
			{Key: "roll_no", Label: "Roll no", Kind: "number", Expr: "en.roll_no"},
			{Key: "gender", Label: "Gender", Kind: "text", Expr: "st.gender"},
			{Key: "category", Label: "Category", Kind: "text", Expr: "st.category"},
			{Key: "status", Label: "Status", Kind: "text", Expr: "st.status"},
			{Key: "date_of_birth", Label: "Date of birth", Kind: "date", Expr: "st.date_of_birth"},
			{Key: "admission_date", Label: "Admitted on", Kind: "date", Expr: "st.admission_date"},
			{Key: "mother_tongue", Label: "Mother tongue", Kind: "text", Expr: "st.mother_tongue"},
			{Key: "medium", Label: "Medium", Kind: "text", Expr: "st.medium"},
			{Key: "city", Label: "City", Kind: "text", Expr: "st.city"},
		},
		Measures: []reportMeasure{
			{Key: "student_count", Label: "Students", Kind: "number", Expr: "count(DISTINCT st.id)"},
			{Key: "rte_count", Label: "RTE students", Kind: "number",
				Expr: "count(DISTINCT st.id) FILTER (WHERE st.is_rte)"},
			{Key: "cwsn_count", Label: "CWSN students", Kind: "number",
				Expr: "count(DISTINCT st.id) FILTER (WHERE st.is_cwsn)"},
		},
		Fields: []reportField{
			{Key: "class_id", Label: "Class", Kind: "uuid", Ops: opsUUID, Expr: "en.class_id"},
			{Key: "section_id", Label: "Section", Kind: "uuid", Ops: opsUUID, Expr: "en.section_id"},
			{Key: "status", Label: "Status", Kind: "enum", Ops: opsEnum, Expr: "st.status",
				Options: []string{"active", "inactive", "withdrawn", "transferred", "graduated", "alumni"}},
			{Key: "gender", Label: "Gender", Kind: "enum", Ops: opsEnum, Expr: "st.gender",
				Options: []string{"male", "female", "other"}},
			{Key: "category", Label: "Category", Kind: "enum", Ops: opsEnum, Expr: "st.category",
				Options: []string{"general", "obc", "sc", "st", "ews", "other"}},
			{Key: "admission_date", Label: "Admitted on", Kind: "date", Ops: opsDate, Expr: "st.admission_date"},
			{Key: "full_name", Label: "Name", Kind: "text", Ops: opsText,
				Expr: `concat_ws(' ', st.first_name, st.last_name)`},
			{Key: "is_rte", Label: "RTE", Kind: "enum", Ops: opsEnum, Expr: "st.is_rte::text",
				Options: []string{"true", "false"}},
		},
	},
	{
		Key:     "attendance",
		Name:    "Attendance",
		Summary: "One row per student per day marked, with the class it was marked in.",
		From: `student_attendance at
		         JOIN students st ON st.id = at.student_id
		         JOIN sections sec ON sec.id = at.section_id
		         JOIN classes cl ON cl.id = sec.class_id`,
		ScopeExpr: "at.section_id",
		Scope:     sectionScope,
		Dimensions: []reportDimension{
			{Key: "on_date", Label: "Date", Kind: "date", Expr: "at.on_date"},
			{Key: "admission_no", Label: "Admission no", Kind: "text", Expr: "st.admission_no"},
			{Key: "full_name", Label: "Name", Kind: "text",
				Expr: `concat_ws(' ', st.first_name, st.last_name)`},
			{Key: "class", Label: "Class", Kind: "text", Expr: "cl.name"},
			{Key: "section", Label: "Section", Kind: "text", Expr: "sec.name"},
			{Key: "status", Label: "Status", Kind: "text", Expr: "at.status"},
			{Key: "minutes_late", Label: "Minutes late", Kind: "number", Expr: "at.minutes_late"},
			{Key: "month", Label: "Month", Kind: "text", Expr: `to_char(at.on_date,'YYYY-MM')`},
		},
		Measures: []reportMeasure{
			{Key: "marked_count", Label: "Days marked", Kind: "number", Expr: "count(*)"},
			{Key: "present_count", Label: "Present", Kind: "number",
				Expr: "count(*) FILTER (WHERE at.status = 'present')"},
			{Key: "absent_count", Label: "Absent", Kind: "number",
				Expr: "count(*) FILTER (WHERE at.status = 'absent')"},
			// Rounded here rather than in the browser so the CSV and the screen
			// carry the same figure to the same precision.
			{Key: "present_pct", Label: "Present %", Kind: "number",
				Expr: `round(100.0 * count(*) FILTER (WHERE at.status = 'present')
				       / nullif(count(*),0), 1)`},
		},
		Fields: []reportField{
			{Key: "on_date", Label: "Date", Kind: "date", Ops: opsDate, Expr: "at.on_date"},
			{Key: "section_id", Label: "Section", Kind: "uuid", Ops: opsUUID, Expr: "at.section_id"},
			{Key: "class_id", Label: "Class", Kind: "uuid", Ops: opsUUID, Expr: "sec.class_id"},
			{Key: "status", Label: "Status", Kind: "enum", Ops: opsEnum, Expr: "at.status",
				Options: []string{"present", "absent", "late", "half_day", "leave", "holiday"}},
			{Key: "minutes_late", Label: "Minutes late", Kind: "number", Ops: opsNumber, Expr: "at.minutes_late"},
		},
	},
	{
		Key:     "fees",
		Name:    "Fees",
		Summary: "One row per invoice, with what it was for and what is still owed.",
		From: `invoices inv
		         JOIN students st ON st.id = inv.student_id
		         LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		         LEFT JOIN sections sec ON sec.id = en.section_id
		         LEFT JOIN classes cl ON cl.id = en.class_id`,
		ScopeExpr: "en.section_id",
		Scope:     sectionScope,
		Dimensions: []reportDimension{
			{Key: "invoice_no", Label: "Invoice no", Kind: "text", Expr: "inv.invoice_no"},
			{Key: "admission_no", Label: "Admission no", Kind: "text", Expr: "st.admission_no"},
			{Key: "full_name", Label: "Name", Kind: "text",
				Expr: `concat_ws(' ', st.first_name, st.last_name)`},
			{Key: "class", Label: "Class", Kind: "text", Expr: "cl.name"},
			{Key: "section", Label: "Section", Kind: "text", Expr: "sec.name"},
			{Key: "status", Label: "Status", Kind: "text", Expr: "inv.status"},
			{Key: "issued_on", Label: "Issued on", Kind: "date", Expr: "inv.issued_on"},
			{Key: "due_on", Label: "Due on", Kind: "date", Expr: "inv.due_on"},
			// Money is paise everywhere in this codebase; the UI groups it and
			// the CSV writes rupees. Never a float.
			{Key: "net_paise", Label: "Billed", Kind: "money", Expr: "inv.net_paise"},
			{Key: "paid_paise", Label: "Paid", Kind: "money", Expr: "inv.paid_paise"},
			{Key: "balance_paise", Label: "Balance", Kind: "money",
				Expr: "inv.net_paise - inv.paid_paise"},
			{Key: "days_overdue", Label: "Days overdue", Kind: "number",
				Expr: `GREATEST(0, current_date - inv.due_on)`},
		},
		Measures: []reportMeasure{
			{Key: "invoice_count", Label: "Invoices", Kind: "number", Expr: "count(*)"},
			{Key: "student_count", Label: "Students", Kind: "number", Expr: "count(DISTINCT st.id)"},
			{Key: "billed_paise", Label: "Billed", Kind: "money", Expr: "sum(inv.net_paise)"},
			{Key: "collected_paise", Label: "Collected", Kind: "money", Expr: "sum(inv.paid_paise)"},
			{Key: "outstanding_paise", Label: "Outstanding", Kind: "money",
				Expr: "sum(inv.net_paise - inv.paid_paise)"},
		},
		Fields: []reportField{
			{Key: "status", Label: "Status", Kind: "enum", Ops: opsEnum, Expr: "inv.status",
				Options: []string{"unpaid", "part_paid", "paid", "cancelled"}},
			{Key: "issued_on", Label: "Issued on", Kind: "date", Ops: opsDate, Expr: "inv.issued_on"},
			{Key: "due_on", Label: "Due on", Kind: "date", Ops: opsDate, Expr: "inv.due_on"},
			{Key: "class_id", Label: "Class", Kind: "uuid", Ops: opsUUID, Expr: "en.class_id"},
			{Key: "section_id", Label: "Section", Kind: "uuid", Ops: opsUUID, Expr: "en.section_id"},
			{Key: "balance_paise", Label: "Balance (paise)", Kind: "number", Ops: opsNumber,
				Expr: "(inv.net_paise - inv.paid_paise)"},
			{Key: "academic_year_id", Label: "Academic year", Kind: "uuid", Ops: opsUUID,
				Expr: "inv.academic_year_id"},
		},
	},
	{
		Key:     "staff",
		Name:    "Staff",
		Summary: "One row per employee, with their department and designation.",
		From: `employees emp
		         LEFT JOIN departments dep ON dep.id = emp.department_id
		         LEFT JOIN designations des ON des.id = emp.designation_id`,
		ScopeExpr: "emp.department_id",
		Scope:     departmentScope,
		Dimensions: []reportDimension{
			{Key: "employee_code", Label: "Staff code", Kind: "text", Expr: "emp.employee_code"},
			{Key: "full_name", Label: "Name", Kind: "text",
				Expr: `concat_ws(' ', emp.first_name, emp.last_name)`},
			{Key: "department", Label: "Department", Kind: "text", Expr: "dep.name"},
			{Key: "designation", Label: "Designation", Kind: "text", Expr: "des.name"},
			{Key: "employment_type", Label: "Employment type", Kind: "text", Expr: "emp.employment_type"},
			{Key: "status", Label: "Status", Kind: "text", Expr: "emp.status"},
			{Key: "gender", Label: "Gender", Kind: "text", Expr: "emp.gender"},
			{Key: "joined_on", Label: "Joined on", Kind: "date", Expr: "emp.joined_on"},
			{Key: "qualification", Label: "Qualification", Kind: "text", Expr: "emp.qualification"},
			{Key: "experience_years", Label: "Experience (years)", Kind: "number",
				Expr: "emp.experience_years"},
			{Key: "years_of_service", Label: "Years here", Kind: "number",
				Expr: `round(extract(epoch FROM age(current_date, emp.joined_on)) / 31557600.0, 1)`},
		},
		Measures: []reportMeasure{
			{Key: "staff_count", Label: "Staff", Kind: "number", Expr: "count(*)"},
			{Key: "avg_experience", Label: "Average experience", Kind: "number",
				Expr: "round(avg(emp.experience_years), 1)"},
		},
		Fields: []reportField{
			{Key: "department_id", Label: "Department", Kind: "uuid", Ops: opsUUID, Expr: "emp.department_id"},
			{Key: "status", Label: "Status", Kind: "enum", Ops: opsEnum, Expr: "emp.status",
				Options: []string{"active", "on_leave", "suspended", "relieved"}},
			{Key: "employment_type", Label: "Employment type", Kind: "text", Ops: opsText,
				Expr: "emp.employment_type"},
			{Key: "joined_on", Label: "Joined on", Kind: "date", Ops: opsDate, Expr: "emp.joined_on"},
			{Key: "gender", Label: "Gender", Kind: "enum", Ops: opsEnum, Expr: "emp.gender",
				Options: []string{"male", "female", "other"}},
			{Key: "full_name", Label: "Name", Kind: "text", Ops: opsText,
				Expr: `concat_ws(' ', emp.first_name, emp.last_name)`},
		},
	},
}

func lookupReportSubject(key string) (reportSubject, bool) {
	for _, s := range reportSubjects {
		if s.Key == key {
			return s, true
		}
	}
	return reportSubject{}, false
}

// --- the saved definition ----------------------------------------------------

type reportFilterClause struct {
	Field  string   `json:"field"`
	Op     string   `json:"op"`
	Value  string   `json:"value,omitempty"`
	Value2 string   `json:"value2,omitempty"` // the far end of a between
	Values []string `json:"values,omitempty"` // an in-list
}

type reportDefinition struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	Description *string              `json:"description,omitempty"`
	Subject     string               `json:"subject"`
	SubjectName string               `json:"subject_name"`
	Columns     []string             `json:"columns"`
	Filters     []reportFilterClause `json:"filters"`
	GroupBy     []string             `json:"group_by"`
	SortColumn  *string              `json:"sort_column,omitempty"`
	SortDir     string               `json:"sort_dir"`
	RowLimit    int                  `json:"row_limit"`
	CreatedBy   *string              `json:"created_by,omitempty"`
	CreatedByMe bool                 `json:"created_by_me"`
	CanEdit     bool                 `json:"can_edit"`
	SharedWith  []string             `json:"shared_with"`
	UpdatedAt   string               `json:"updated_at"`
}

type reportDefinitionRequest struct {
	ID          string               `json:"id,omitempty"`
	Name        string               `json:"name"`
	Description string               `json:"description,omitempty"`
	Subject     string               `json:"subject"`
	Columns     []string             `json:"columns"`
	Filters     []reportFilterClause `json:"filters,omitempty"`
	GroupBy     []string             `json:"group_by,omitempty"`
	SortColumn  string               `json:"sort_column,omitempty"`
	SortDir     string               `json:"sort_dir,omitempty"`
	// A missing row_limit is the default, not zero. A definition saved with 0
	// would return nothing and look broken; the request type is a string-free
	// struct so this arrives as 0 either way and is normalised below.
	RowLimit int `json:"row_limit,omitempty"`
}

const (
	reportDefaultLimit = 500
	reportMaxLimit     = 5000
	reportPageSize     = 100
)

/*
validateReportDefinition is the gate everything else depends on.

	Called on save AND before every run. Twice on purpose: a definition legal
	when it was saved can become illegal when a column is withdrawn from the
	whitelist, and the run is the moment that matters. Re-validating turns that
	into a clear refusal instead of a query built from a key with no expression
	behind it.
*/
func validateReportDefinition(req *reportDefinitionRequest) (reportSubject, error) {
	req.Name = strings.TrimSpace(req.Name)
	req.Description = strings.TrimSpace(req.Description)
	if req.Name == "" {
		return reportSubject{}, errors.New("give the report a name")
	}
	if len(req.Name) > 120 {
		return reportSubject{}, errors.New("that name is too long")
	}
	subj, ok := lookupReportSubject(req.Subject)
	if !ok {
		return reportSubject{}, fmt.Errorf("%q is not a subject you can report on", req.Subject)
	}
	if len(req.Columns) == 0 {
		return subj, errors.New("pick at least one column")
	}
	if len(req.Columns) > 20 {
		return subj, errors.New("a report with more than twenty columns is a spreadsheet export, not a report")
	}

	grouped := len(req.GroupBy) > 0
	inGroup := map[string]bool{}
	for _, g := range req.GroupBy {
		if _, ok := subj.dimension(g); !ok {
			return subj, fmt.Errorf("cannot group by %q", g)
		}
		if inGroup[g] {
			return subj, fmt.Errorf("%q is grouped twice", g)
		}
		inGroup[g] = true
	}

	seen := map[string]bool{}
	for _, c := range req.Columns {
		if seen[c] {
			return subj, fmt.Errorf("%q is selected twice", c)
		}
		seen[c] = true
		_, isDim := subj.dimension(c)
		_, isMeasure := subj.measure(c)
		switch {
		case !isDim && !isMeasure:
			return subj, fmt.Errorf("%q is not a column of %s", c, subj.Name)
		case !grouped && isMeasure:
			return subj, fmt.Errorf(
				"%q is a total — group the report by something before you can show it", c)
		case grouped && isDim && !inGroup[c]:
			// The alternative is silently wrapping it in min(), which answers
			// a question nobody asked.
			return subj, fmt.Errorf(
				"%q is not grouped, so there is no single value for it — group by it or drop it", c)
		}
	}
	// Every grouped column has to be shown, or the rows are indistinguishable.
	for _, g := range req.GroupBy {
		if !seen[g] {
			return subj, fmt.Errorf("%q is grouped but not shown — the rows would be unreadable", g)
		}
	}

	for i := range req.Filters {
		if err := validateReportFilter(subj, &req.Filters[i]); err != nil {
			return subj, err
		}
	}

	if req.SortColumn != "" && !seen[req.SortColumn] {
		return subj, fmt.Errorf("cannot sort by %q — it is not one of the shown columns", req.SortColumn)
	}
	switch req.SortDir {
	case "":
		req.SortDir = "asc"
	case "asc", "desc":
	default:
		return subj, errors.New("sort direction must be asc or desc")
	}

	if req.RowLimit == 0 {
		req.RowLimit = reportDefaultLimit
	}
	if req.RowLimit < 1 || req.RowLimit > reportMaxLimit {
		return subj, fmt.Errorf("the row cap must be between 1 and %d", reportMaxLimit)
	}
	if req.Filters == nil {
		req.Filters = []reportFilterClause{}
	}
	if req.GroupBy == nil {
		req.GroupBy = []string{}
	}
	return subj, nil
}

func validateReportFilter(subj reportSubject, f *reportFilterClause) error {
	fld, ok := subj.field(f.Field)
	if !ok {
		return fmt.Errorf("cannot filter on %q", f.Field)
	}
	if !oneOfStr(f.Op, fld.Ops...) {
		return fmt.Errorf("%q cannot be compared with %q", fld.Label, f.Op)
	}
	f.Value = strings.TrimSpace(f.Value)
	f.Value2 = strings.TrimSpace(f.Value2)

	switch f.Op {
	case "is_null", "is_not_null":
		f.Value, f.Value2, f.Values = "", "", nil
		return nil
	case "in":
		clean := []string{}
		for _, v := range f.Values {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if err := checkReportValue(fld, v); err != nil {
				return err
			}
			clean = append(clean, v)
		}
		if len(clean) == 0 {
			return fmt.Errorf("%s: give at least one value to match", fld.Label)
		}
		if len(clean) > 200 {
			return fmt.Errorf("%s: too many values in one filter", fld.Label)
		}
		f.Values, f.Value, f.Value2 = clean, "", ""
		return nil
	case "between":
		if f.Value == "" || f.Value2 == "" {
			return fmt.Errorf("%s: a range needs both ends", fld.Label)
		}
		if err := checkReportValue(fld, f.Value); err != nil {
			return err
		}
		if err := checkReportValue(fld, f.Value2); err != nil {
			return err
		}
		f.Values = nil
		return nil
	default:
		if f.Value == "" {
			return fmt.Errorf("%s: give a value to compare against", fld.Label)
		}
		if err := checkReportValue(fld, f.Value); err != nil {
			return err
		}
		f.Values = nil
		return nil
	}
}

/*
checkReportValue refuses a value that cannot be what the field is.

	Not a security control — every value is bound as a parameter regardless —
	but the difference between "that is not a date" at the moment of typing and
	an opaque 500 three screens later.
*/
func checkReportValue(fld reportField, v string) error {
	switch fld.Kind {
	case "number":
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			return fmt.Errorf("%s: %q is not a number", fld.Label, v)
		}
	case "date":
		if _, err := time.Parse(time.DateOnly, v); err != nil {
			return fmt.Errorf("%s: %q is not a date (YYYY-MM-DD)", fld.Label, v)
		}
	case "uuid":
		if _, err := uuid.Parse(v); err != nil {
			return fmt.Errorf("%s: pick a value from the list", fld.Label)
		}
	case "enum":
		if len(fld.Options) > 0 && !oneOfStr(v, fld.Options...) {
			return fmt.Errorf("%s: %q is not one of the permitted values", fld.Label, v)
		}
	case "text":
		if len(v) > 200 {
			return fmt.Errorf("%s: that is too long to search for", fld.Label)
		}
	}
	return nil
}

// --- translating a definition into SQL ---------------------------------------

// argList accumulates bind parameters and hands back their placeholders, so no
// part of the builder has to count $n by hand. Every value a request supplied
// arrives here and nowhere else.
type argList struct{ args []any }

func (a *argList) add(v any) string {
	a.args = append(a.args, v)
	return "$" + strconv.Itoa(len(a.args))
}

/*
buildReportSQL turns a validated definition into one parameterised statement.

	Only three kinds of string reach the SQL text: literals written here,
	Expr fields from reportSubjects (also written here), and $n placeholders.
	The definition contributes keys that select among them and nothing else.
*/
func buildReportSQL(subj reportSubject, def *reportDefinitionRequest,
	scopeIDs []uuid.UUID, limit, offset int) (string, string, []any, []string, error) {

	a := &argList{}
	selects := make([]string, 0, len(def.Columns))
	labels := make([]string, 0, len(def.Columns))
	grouped := len(def.GroupBy) > 0

	for _, key := range def.Columns {
		if d, ok := subj.dimension(key); ok {
			selects = append(selects, d.Expr)
			labels = append(labels, d.Label)
			continue
		}
		m, ok := subj.measure(key)
		if !ok {
			return "", "", nil, nil, fmt.Errorf("%q is no longer available on this subject", key)
		}
		selects = append(selects, m.Expr)
		labels = append(labels, m.Label)
	}

	where := []string{}
	if subj.Where != "" {
		where = append(where, subj.Where)
	}

	/* Scope, always, in the unconditional form.

	   A NULL array means "no boundary"; an empty array means the caller's
	   boundary is empty and the report is correctly empty. Written this way
	   rather than as a conditional fragment because these placeholders are
	   numbered dynamically and a predicate that sometimes consumes its
	   argument cannot be placed safely in that sequence — the trap documented
	   above rollupBoundary.deptPredicate. */
	var scopeArg any
	if scopeIDs != nil {
		scopeArg = scopeIDs
	}
	p := a.add(scopeArg)
	where = append(where, fmt.Sprintf("(%s::uuid[] IS NULL OR %s = ANY(%s))", p, subj.ScopeExpr, p))

	for _, f := range def.Filters {
		clause, err := filterSQL(subj, f, a)
		if err != nil {
			return "", "", nil, nil, err
		}
		where = append(where, clause)
	}

	var b strings.Builder
	b.WriteString("SELECT ")
	b.WriteString(strings.Join(selects, ", "))
	b.WriteString("\n  FROM ")
	b.WriteString(subj.From)
	b.WriteString("\n WHERE ")
	b.WriteString(strings.Join(where, "\n   AND "))

	// COUNT over the same FROM and WHERE, built before GROUP BY is appended so
	// the two can never disagree about which rows the report covers.
	count := "SELECT count(*) FROM (SELECT 1 FROM " + subj.From +
		" WHERE " + strings.Join(where, " AND ")
	if grouped {
		groupExprs := make([]string, 0, len(def.GroupBy))
		for _, g := range def.GroupBy {
			d, ok := subj.dimension(g)
			if !ok {
				return "", "", nil, nil, fmt.Errorf("%q is no longer groupable", g)
			}
			groupExprs = append(groupExprs, d.Expr)
		}
		b.WriteString("\n GROUP BY ")
		b.WriteString(strings.Join(groupExprs, ", "))
		count += " GROUP BY " + strings.Join(groupExprs, ", ")
	}
	count += ") q"

	if def.SortColumn != "" {
		// Ordinal rather than the expression: an aggregate repeated in ORDER BY
		// is evaluated twice, and Postgres accepts the position for both cases.
		for i, key := range def.Columns {
			if key == def.SortColumn {
				dir := "ASC"
				if def.SortDir == "desc" {
					dir = "DESC"
				}
				b.WriteString(fmt.Sprintf("\n ORDER BY %d %s NULLS LAST", i+1, dir))
				break
			}
		}
	}

	// The saved cap is the ceiling; the page is what the screen asked for. A
	// page that would reach past the cap is trimmed rather than refused.
	if limit > def.RowLimit {
		limit = def.RowLimit
	}
	if offset >= def.RowLimit {
		limit = 0
	} else if offset+limit > def.RowLimit {
		limit = def.RowLimit - offset
	}
	b.WriteString(fmt.Sprintf("\n LIMIT %s OFFSET %s", a.add(limit), a.add(offset)))

	return b.String(), count, a.args, labels, nil
}

// filterSQL renders one clause. fld.Expr and the operator template are
// literals; f.Value never appears in the string.
func filterSQL(subj reportSubject, f reportFilterClause, a *argList) (string, error) {
	fld, ok := subj.field(f.Field)
	if !ok {
		return "", fmt.Errorf("%q is no longer a filter on this subject", f.Field)
	}
	if !oneOfStr(f.Op, fld.Ops...) {
		return "", fmt.Errorf("%q cannot be compared with %q", fld.Label, f.Op)
	}

	switch f.Op {
	case "is_null":
		return fmt.Sprintf("(%s) IS NULL", fld.Expr), nil
	case "is_not_null":
		return fmt.Sprintf("(%s) IS NOT NULL", fld.Expr), nil
	case "contains":
		// The wildcards are added here so a value of '%' matches a literal
		// percent sign rather than everything.
		return fmt.Sprintf("(%s) ILIKE '%%' || %s || '%%'", fld.Expr, a.add(f.Value)), nil
	case "in":
		vals, err := reportValues(fld, f.Values)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("(%s) = ANY(%s)", fld.Expr, a.add(vals)), nil
	case "between":
		lo, err := reportValue(fld, f.Value)
		if err != nil {
			return "", err
		}
		hi, err := reportValue(fld, f.Value2)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("(%s) BETWEEN %s AND %s", fld.Expr, a.add(lo), a.add(hi)), nil
	}

	op := map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.Op]
	if op == "" {
		return "", fmt.Errorf("unsupported comparison %q", f.Op)
	}
	v, err := reportValue(fld, f.Value)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("(%s) %s %s", fld.Expr, op, a.add(v)), nil
}

// reportValue converts a filter value to the Go type the column expects, so
// pgx binds a date as a date rather than as text Postgres has to coerce.
func reportValue(fld reportField, raw string) (any, error) {
	switch fld.Kind {
	case "number":
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, fmt.Errorf("%s: %q is not a number", fld.Label, raw)
		}
		return f, nil
	case "date":
		t, err := time.Parse(time.DateOnly, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %q is not a date", fld.Label, raw)
		}
		return t, nil
	case "uuid":
		u, err := uuid.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: pick a value from the list", fld.Label)
		}
		return u, nil
	default:
		return raw, nil
	}
}

func reportValues(fld reportField, raws []string) (any, error) {
	switch fld.Kind {
	case "uuid":
		out := make([]uuid.UUID, 0, len(raws))
		for _, v := range raws {
			u, err := uuid.Parse(v)
			if err != nil {
				return nil, fmt.Errorf("%s: pick values from the list", fld.Label)
			}
			out = append(out, u)
		}
		return out, nil
	case "number":
		out := make([]float64, 0, len(raws))
		for _, v := range raws {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return nil, fmt.Errorf("%s: %q is not a number", fld.Label, v)
			}
			out = append(out, f)
		}
		return out, nil
	default:
		return raws, nil
	}
}

// --- mount -------------------------------------------------------------------

/*
mountReportBuilder registers the builder.

	Splice into internal/api/api.go beside the other roll-up mounts:

	    s.mountAdminRollups(r)
	    s.mountReportBuilder(r)     // <- here

	Mounted at the authenticated router rather than inside an existing group so
	the permission is stated here, once, where the reader of this file can see
	it. Everything is behind admin.reports.read; the mutations narrow further to
	the author, in the handler, because "may this person edit THIS report" is
	about a row and not about a capability.
*/
func (s *Server) mountReportBuilder(r chi.Router) {
	r.Route("/report-builder", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.ReportsRead))
		r.Get("/schema", s.getReportSchema)
		r.Get("/definitions", s.listReportDefinitions)
		r.Post("/definitions", s.saveReportDefinition)
		r.Get("/definitions/{id}", s.getReportDefinition)
		r.Delete("/definitions/{id}", s.deleteReportDefinition)
		r.Get("/definitions/{id}/run", s.runReportDefinition)
		r.Post("/definitions/{id}/shares", s.shareReportDefinition)
		r.Delete("/definitions/{id}/shares/{role}", s.unshareReportDefinition)
		r.Get("/definitions/{id}/runs", s.listReportRuns)
		// A definition can be tried before it is saved. Same validator, same
		// builder, same scope — otherwise "preview" and "run" would be two
		// code paths and only one of them would stay correct.
		r.Post("/preview", s.previewReport)
	})
}

// --- schema ------------------------------------------------------------------

type reportSchemaResponse struct {
	Subjects []reportSubject `json:"subjects"`
	// What the caller may share with. Roles are per institution and
	// renameable, so the key travels with the name.
	Roles []reportRoleOption `json:"roles"`
	// The boundary the caller's own runs will carry, so the screen can say
	// "your department" rather than implying the whole school.
	Scope       string `json:"scope"`
	MaxRowLimit int    `json:"max_row_limit"`
	PageSize    int    `json:"page_size"`
}

type reportRoleOption struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

func (s *Server) getReportSchema(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	roles, err := collect(s, r, `
		SELECT key, name FROM roles
		 WHERE institution_id = app_current_institution() OR institution_id IS NULL
		 ORDER BY name`, nil,
		func(rows pgx.Rows) (reportRoleOption, error) {
			var v reportRoleOption
			return v, rows.Scan(&v.Key, &v.Name)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, reportSchemaResponse{
		Subjects:    reportSubjects,
		Roles:       roles,
		Scope:       b.label(),
		MaxRowLimit: reportMaxLimit,
		PageSize:    reportPageSize,
	})
}

// --- definitions -------------------------------------------------------------

/*
reportVisibility is the SQL that decides which saved reports a caller lists.

	Note what this is NOT: it is not a data boundary. The rows a report returns
	are bounded by the reader's own scope at run time, so a definition reaching
	the wrong person exposes a question, not an answer. This exists to keep the
	list meaningful — your own reports, plus the ones someone shared with a role
	you hold — and the institution-wide reach of a principal is what lets them
	administer the lot.
*/
const reportVisibility = `(
	    d.created_by = $1
	 OR $2::boolean
	 OR EXISTS (SELECT 1 FROM report_shares sh
	             JOIN roles ro ON ro.key = sh.role_key
	             JOIN user_roles ur ON ur.role_id = ro.id AND ur.user_id = $1
	            WHERE sh.report_id = d.id))`

func (s *Server) listReportDefinitions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT d.id::text, d.name, d.description, d.subject, d.columns,
		       d.filters::text, d.group_by, d.sort_column, d.sort_dir, d.row_limit,
		       d.created_by::text, d.created_by = $1,
		       to_char(d.updated_at,'YYYY-MM-DD"T"HH24:MI'),
		       COALESCE((SELECT array_agg(sh.role_key ORDER BY sh.role_key)
		                   FROM report_shares sh WHERE sh.report_id = d.id), '{}')
		  FROM report_definitions d
		 WHERE `+reportVisibility+`
		 ORDER BY d.name`, []any{id.UserID, b.All},
		scanReportDefinition)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	for i := range items {
		items[i].CanEdit = items[i].CreatedByMe || id.Can(rbac.SettingsWrite)
	}
	respond(w, r, items, nil)
}

func scanReportDefinition(rows pgx.Rows) (reportDefinition, error) {
	var (
		v          reportDefinition
		filtersRaw string
	)
	err := rows.Scan(&v.ID, &v.Name, &v.Description, &v.Subject, &v.Columns,
		&filtersRaw, &v.GroupBy, &v.SortColumn, &v.SortDir, &v.RowLimit,
		&v.CreatedBy, &v.CreatedByMe, &v.UpdatedAt, &v.SharedWith)
	if err != nil {
		return v, err
	}
	v.Filters = []reportFilterClause{}
	if filtersRaw != "" {
		// A definition whose filters no longer parse is shown with none rather
		// than failing the whole list; validation at run time will catch it.
		_ = json.Unmarshal([]byte(filtersRaw), &v.Filters)
	}
	if subj, ok := lookupReportSubject(v.Subject); ok {
		v.SubjectName = subj.Name
	}
	return v, nil
}

/*
loadReportDefinition fetches one report the caller is allowed to see.

	404 rather than 403 for a report outside the caller's visibility, following
	hr_growth.go: telling somebody a report exists that they may not open is
	itself a disclosure, and "no such report" is the honest answer to a request
	that names one they cannot reach.
*/
func (s *Server) loadReportDefinition(r *http.Request, reportID uuid.UUID) (reportDefinition, error) {
	id := httpx.IdentityFrom(r.Context())
	b, err := s.resolveRollupScope(r)
	if err != nil {
		return reportDefinition{}, err
	}
	items, err := collect(s, r, `
		SELECT d.id::text, d.name, d.description, d.subject, d.columns,
		       d.filters::text, d.group_by, d.sort_column, d.sort_dir, d.row_limit,
		       d.created_by::text, d.created_by = $1,
		       to_char(d.updated_at,'YYYY-MM-DD"T"HH24:MI'),
		       COALESCE((SELECT array_agg(sh.role_key ORDER BY sh.role_key)
		                   FROM report_shares sh WHERE sh.report_id = d.id), '{}')
		  FROM report_definitions d
		 WHERE d.id = $3 AND `+reportVisibility,
		[]any{id.UserID, b.All, reportID}, scanReportDefinition)
	if err != nil {
		return reportDefinition{}, err
	}
	if len(items) == 0 {
		return reportDefinition{}, pgx.ErrNoRows
	}
	items[0].CanEdit = items[0].CreatedByMe || id.Can(rbac.SettingsWrite)
	return items[0], nil
}

func (s *Server) getReportDefinition(w http.ResponseWriter, r *http.Request) {
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	def, err := s.loadReportDefinition(r, reportID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, def)
	}
}

func (s *Server) saveReportDefinition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req reportDefinitionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if _, err := validateReportDefinition(&req); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	filters, err := json.Marshal(req.Filters)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) == "" {
			return tx.QueryRow(r.Context(), `
				INSERT INTO report_definitions
				    (institution_id, name, description, subject, columns, filters,
				     group_by, sort_column, sort_dir, row_limit, created_by)
				VALUES ($1,$2,NULLIF($3,''),$4,$5,$6::jsonb,$7,NULLIF($8,''),$9,$10,$11)
				RETURNING id::text`,
				id.InstitutionID, req.Name, req.Description, req.Subject, req.Columns,
				string(filters), req.GroupBy, req.SortColumn, req.SortDir, req.RowLimit,
				nullUUIDArg(id.UserID)).Scan(&out)
		}
		existing, err := uuid.Parse(req.ID)
		if err != nil {
			return errors.New("id must be a uuid")
		}
		/* Only the author, or a settings administrator, may rewrite a saved
		   report. Enforced in the UPDATE's WHERE rather than in a prior read
		   so two people editing at once cannot race between the check and the
		   write. A row that does not match is reported as not found. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE report_definitions
			   SET name = $2, description = NULLIF($3,''), subject = $4, columns = $5,
			       filters = $6::jsonb, group_by = $7, sort_column = NULLIF($8,''),
			       sort_dir = $9, row_limit = $10, updated_at = now()
			 WHERE id = $1 AND (created_by = $11 OR $12::boolean)`,
			existing, req.Name, req.Description, req.Subject, req.Columns,
			string(filters), req.GroupBy, req.SortColumn, req.SortDir, req.RowLimit,
			nullUUIDArg(id.UserID), id.Can(rbac.SettingsWrite))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		out = existing.String()
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate_name",
			"a report of that name already exists — two reports with one name is how a school stops trusting both")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

func (s *Server) deleteReportDefinition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM report_definitions
			 WHERE id = $1 AND (created_by = $2 OR $3::boolean)`,
			reportID, nullUUIDArg(id.UserID), id.Can(rbac.SettingsWrite))
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
	}
}

// --- sharing -----------------------------------------------------------------

type reportShareRequest struct {
	RoleKey string `json:"role_key"`
}

/*
shareReportDefinition lets a role open somebody else's saved report.

	What is shared is the definition. The reader's own scope is resolved when
	they run it, so a head of department opening a report the principal built
	sees their department — never the principal's rows. That is the whole
	safety argument for this endpoint existing at all, and it lives in
	runReportDefinition, not here.
*/
func (s *Server) shareReportDefinition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req reportShareRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.RoleKey = strings.TrimSpace(req.RoleKey)
	if req.RoleKey == "" {
		httpx.BadRequest(w, r, "pick a role to share with")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var owned bool
		err := tx.QueryRow(r.Context(), `
			SELECT (created_by = $2 OR $3::boolean) FROM report_definitions WHERE id = $1`,
			reportID, nullUUIDArg(id.UserID), id.Can(rbac.SettingsWrite)).Scan(&owned)
		if err != nil {
			return err
		}
		if !owned {
			return pgx.ErrNoRows
		}
		var exists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM roles
			                WHERE key = $1
			                  AND (institution_id = app_current_institution()
			                       OR institution_id IS NULL))`, req.RoleKey).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("no such role")
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO report_shares (report_id, role_key, shared_by)
			VALUES ($1,$2,$3)
			ON CONFLICT (report_id, role_key) DO NOTHING`,
			reportID, req.RoleKey, nullUUIDArg(id.UserID))
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"shared": true})
	}
}

func (s *Server) unshareReportDefinition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	role := strings.TrimSpace(chi.URLParam(r, "role"))
	if role == "" {
		httpx.BadRequest(w, r, "which role?")
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM report_shares sh
			 USING report_definitions d
			 WHERE sh.report_id = $1 AND sh.role_key = $2 AND d.id = sh.report_id
			   AND (d.created_by = $3 OR $4::boolean)`,
			reportID, role, nullUUIDArg(id.UserID), id.Can(rbac.SettingsWrite))
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"unshared": true})
	}
}

// --- running -----------------------------------------------------------------

type reportResult struct {
	Columns []reportResultColumn `json:"columns"`
	Rows    [][]*string          `json:"rows"`
	Total   int                  `json:"total"`
	Limit   int                  `json:"limit"`
	Offset  int                  `json:"offset"`
	HasMore bool                 `json:"has_more"`
	// The saved cap. When total exceeds it the screen has to say so, or a
	// principal reads a truncated list as the whole answer.
	RowLimit  int    `json:"row_limit"`
	Truncated bool   `json:"truncated"`
	Scope     string `json:"scope"`
	Grouped   bool   `json:"grouped"`
	TookMS    int    `json:"took_ms"`
}

type reportResultColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

/*
runReportDefinition executes a saved report for whoever is asking.

	The author's identity is not consulted anywhere in here. resolveRollupScope
	reads the CALLER's boundary and it is that boundary the query carries, so a
	shared report is a shared question. Any change that caches rows, or stores
	the scope beside the definition, breaks the one property that makes sharing
	safe.
*/
func (s *Server) runReportDefinition(w http.ResponseWriter, r *http.Request) {
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	def, err := s.loadReportDefinition(r, reportID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	req := reportDefinitionRequest{
		Name: def.Name, Subject: def.Subject, Columns: def.Columns,
		Filters: def.Filters, GroupBy: def.GroupBy, SortDir: def.SortDir,
		RowLimit: def.RowLimit,
	}
	if def.SortColumn != nil {
		req.SortColumn = *def.SortColumn
	}
	s.executeReport(w, r, &req, &reportID)
}

// previewReport runs an unsaved definition. Same validator, same builder, same
// scope; nothing is recorded because nothing was saved.
func (s *Server) previewReport(w http.ResponseWriter, r *http.Request) {
	var req reportDefinitionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	// A preview has no name yet and does not need one.
	if strings.TrimSpace(req.Name) == "" {
		req.Name = "Preview"
	}
	s.executeReport(w, r, &req, nil)
}

func (s *Server) executeReport(w http.ResponseWriter, r *http.Request,
	req *reportDefinitionRequest, saved *uuid.UUID) {

	id := httpx.IdentityFrom(r.Context())
	subj, err := validateReportDefinition(req)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	csv := strings.EqualFold(r.URL.Query().Get("format"), "csv")
	limit, offset := reportPageSize, 0
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v > 0 {
		offset = v
	}
	if limit > reportPageSize {
		limit = reportPageSize
	}
	if csv {
		// An export is the whole report up to its cap: paginating a download
		// gives the school a folder of fragments to staple together by hand.
		limit, offset = req.RowLimit, 0
	}

	sqlText, countText, args, labels, err := buildReportSQL(subj, req, subj.Scope(b), limit, offset)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	started := time.Now()
	var (
		rows  [][]*string
		total int
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The count uses the same args, minus the LIMIT/OFFSET pair the builder
		// appended last — hence the slice rather than a second arg list.
		if err := tx.QueryRow(r.Context(), countText, args[:len(args)-2]...).Scan(&total); err != nil {
			return err
		}
		res, err := tx.Query(r.Context(), sqlText, args...)
		if err != nil {
			return err
		}
		defer res.Close()
		for res.Next() {
			vals, err := res.Values()
			if err != nil {
				return err
			}
			rows = append(rows, reportRowStrings(vals))
		}
		return res.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if rows == nil {
		rows = [][]*string{}
	}

	cols := make([]reportResultColumn, 0, len(req.Columns))
	for i, key := range req.Columns {
		kind := "text"
		if d, ok := subj.dimension(key); ok {
			kind = d.Kind
		} else if m, ok := subj.measure(key); ok {
			kind = m.Kind
		}
		cols = append(cols, reportResultColumn{Key: key, Label: labels[i], Kind: kind})
	}

	// Recorded after the rows are in hand, so the count is what was actually
	// produced and an export is distinguishable from a look.
	if saved != nil {
		s.recordReportRun(r, *saved, len(rows), csv, b.label(), int(time.Since(started).Milliseconds()))
	}

	if csv {
		header := make([]string, len(cols))
		for i, c := range cols {
			header[i] = c.Label
		}
		writeRollupCSV(w, reportSlug(req.Name), header, rows, func(row []*string) []string {
			out := make([]string, len(header))
			for i := range header {
				if i < len(row) && row[i] != nil {
					out[i] = *row[i]
				}
			}
			return out
		})
		return
	}

	httpx.JSON(w, http.StatusOK, reportResult{
		Columns:   cols,
		Rows:      rows,
		Total:     total,
		Limit:     limit,
		Offset:    offset,
		HasMore:   offset+len(rows) < total && offset+len(rows) < req.RowLimit,
		RowLimit:  req.RowLimit,
		Truncated: total > req.RowLimit,
		Scope:     b.label(),
		Grouped:   len(req.GroupBy) > 0,
		TookMS:    int(time.Since(started).Milliseconds()),
	})
}

/*
reportRowStrings renders a row for transport.

	Everything becomes a string or a null. The column set is decided at run
	time, so a typed row struct is not available; strings keep the JSON honest
	about which cells were NULL (null, not "" and not 0) and let the CSV writer
	take the same rows without a second conversion. Money stays in paise as an
	integer string — the UI groups it Indian-style and the CSV shows rupees,
	both from the same figure.
*/
func reportRowStrings(vals []any) []*string {
	out := make([]*string, len(vals))
	for i, v := range vals {
		if v == nil {
			continue
		}
		var s string
		switch t := v.(type) {
		case string:
			s = t
		case time.Time:
			s = t.Format(time.DateOnly)
		case bool:
			s = strconv.FormatBool(t)
		case int64:
			s = strconv.FormatInt(t, 10)
		case int32:
			s = strconv.FormatInt(int64(t), 10)
		case float64:
			s = strconv.FormatFloat(t, 'f', -1, 64)
		default:
			s = fmt.Sprint(t)
		}
		out[i] = &s
	}
	return out
}

// reportSlug makes a filename out of a report's name.
func reportSlug(name string) string {
	var b strings.Builder
	for _, c := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteRune(c)
		case b.Len() > 0:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "report"
	}
	return out
}

/*
recordReportRun logs the run and swallows its own failure.

	Deliberately not inside the transaction that produced the rows: the log is
	worth having and is never worth failing a report the school is waiting for.
	A dropped audit row is visible in the runs list as a gap; a 500 on a report
	that actually ran is a support call.
*/
func (s *Server) recordReportRun(r *http.Request, reportID uuid.UUID,
	count int, exported bool, scopeLabel string, ms int) {
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO report_runs
			    (institution_id, report_id, ran_by, row_count, exported, scope_label, duration_ms)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			id.InstitutionID, reportID, nullUUIDArg(id.UserID), count, exported, scopeLabel, ms)
		return err
	})
	if err != nil {
		httpx.LogError(r, err)
	}
}

type reportRunRow struct {
	ID       string  `json:"id"`
	RanAt    string  `json:"ran_at"`
	RanBy    *string `json:"ran_by,omitempty"`
	RowCount int     `json:"row_count"`
	Exported bool    `json:"exported"`
	Scope    string  `json:"scope"`
	TookMS   *int    `json:"took_ms,omitempty"`
}

func (s *Server) listReportRuns(w http.ResponseWriter, r *http.Request) {
	reportID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	// Visibility of the runs follows visibility of the report itself.
	if _, err := s.loadReportDefinition(r, reportID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT run.id::text, to_char(run.ran_at,'YYYY-MM-DD"T"HH24:MI'),
		       u.full_name, run.row_count, run.exported, run.scope_label, run.duration_ms
		  FROM report_runs run
		  LEFT JOIN users u ON u.id = run.ran_by
		 WHERE run.report_id = $1
		 ORDER BY run.ran_at DESC
		 LIMIT 100`, []any{reportID},
		func(rows pgx.Rows) (reportRunRow, error) {
			var v reportRunRow
			return v, rows.Scan(&v.ID, &v.RanAt, &v.RanBy, &v.RowCount,
				&v.Exported, &v.Scope, &v.TookMS)
		})
	respond(w, r, items, err)
}
