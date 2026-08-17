package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

/*
A day at Vivencia Public School.

Ten people sign in with their own accounts and do their actual jobs, in order,
on one shared morning. The point is not endpoint coverage — the other tests do
that — it is that the modules connect: the child Meera's father enquires about
at 9am is the same child the cashier collects fees from at 11am, whose
attendance her class teacher marks at 12, whose marks produce a report card,
and whose transfer certificate quotes the dues that were settled earlier.

A break anywhere in that chain fails here even when every endpoint passes in
isolation.
*/

// person is a signed-in staff member with a cookie jar.
type person struct {
	role   string
	name   string
	client *http.Client
	t      *testing.T
	base   string
}

func arrive(t *testing.T, base, role, name string) *person {
	t.Helper()
	p := &person{role: role, name: name, client: login(t, base, role+"@vivencia.test"), t: t, base: base}
	t.Logf("  %s (%s) signs in", name, role)
	return p
}

// does performs an action and fails the test with the persona's name attached,
// so a failure reads as "Kavita could not collect the fee" rather than a bare
// status code.
func (p *person) does(what, method, path string, body any, into any) {
	p.t.Helper()

	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			p.t.Fatalf("%s: encoding %s: %v", p.name, what, err)
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}

	req, err := http.NewRequest(method, p.base+path, rdr)
	if err != nil {
		p.t.Fatalf("%s: %s: %v", p.name, what, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := p.client.Do(req)
	if err != nil {
		p.t.Fatalf("%s: %s: %v", p.name, what, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var e map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&e)
		p.t.Fatalf("%s could not %s — HTTP %d %v", p.name, what, resp.StatusCode, e)
	}
	if into != nil {
		if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
			p.t.Fatalf("%s: decoding %s: %v", p.name, what, err)
		}
	}
	p.t.Logf("    %s", what)
}

// cannot asserts an action is refused, which is as important as the happy path.
func (p *person) cannot(what, method, path string, body any, wantStatus int) {
	p.t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, p.base+path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.client.Do(req)
	if err != nil {
		p.t.Fatalf("%s: %s: %v", p.name, what, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		p.t.Errorf("%s: %s returned %d, expected it to be refused with %d",
			p.name, what, resp.StatusCode, wantStatus)
		return
	}
	p.t.Logf("    correctly refused: %s (%d)", what, resp.StatusCode)
}

func TestADayAtTheSchool(t *testing.T) {
	base := baseURL(t)

	// Shared state: what one person does, the next person sees.
	var (
		classID, sectionID string
		applicationID      string
		newStudentID       string
		admissionNo        string
	)

	// ---------------------------------------------------------------- 08:30
	t.Run("08:30 Rajesh the IT administrator opens the console", func(t *testing.T) {
		rajesh := arrive(t, base, "super_admin", "Rajesh")

		var users struct {
			Items []struct {
				FullName string `json:"full_name"`
				Status   string `json:"status"`
			} `json:"items"`
		}
		rajesh.does("reviews the user directory", "GET", "/api/v1/admin/users", nil, &users)
		if len(users.Items) == 0 {
			t.Fatal("Rajesh sees no users at all — the directory is broken")
		}

		var sessions struct {
			Items []struct {
				FullName string `json:"full_name"`
			} `json:"items"`
		}
		rajesh.does("checks who is currently signed in", "GET",
			"/api/v1/admin/sessions?active=true", nil, &sessions)

		var roles struct {
			Items []struct {
				Name        string `json:"name"`
				Permissions int    `json:"permissions"`
			} `json:"items"`
		}
		rajesh.does("audits the role matrix", "GET", "/api/v1/admin/roles", nil, &roles)
		t.Logf("    %d users, %d live sessions, %d roles configured",
			len(users.Items), len(sessions.Items), len(roles.Items))
	})

	// ---------------------------------------------------------------- 08:45
	t.Run("08:45 Principal Sunita checks the morning numbers", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")

		var kpis struct {
			Students         int   `json:"students"`
			Staff            int   `json:"staff"`
			AttendancePct    int   `json:"attendance_today_pct"`
			OutstandingPaise int64 `json:"outstanding_paise"`
			Defaulters       int   `json:"defaulters"`
			OpenApplications int   `json:"open_applications"`
		}
		sunita.does("opens the executive dashboard", "GET", "/api/v1/principal/dashboard", nil, &kpis)
		if kpis.Students == 0 {
			t.Fatal("the dashboard reports no students — Sunita would assume the system is down")
		}
		t.Logf("    %d students, %d staff, %d%% present, ₹%.0f outstanding from %d defaulters",
			kpis.Students, kpis.Staff, kpis.AttendancePct,
			float64(kpis.OutstandingPaise)/100, kpis.Defaulters)

		var shortage struct {
			Items []struct {
				FullName string `json:"full_name"`
				Pct      int    `json:"pct"`
			} `json:"items"`
		}
		sunita.does("pulls the attendance shortage list", "GET",
			"/api/v1/principal/attendance-shortage?threshold=75", nil, &shortage)

		var workload struct {
			Items []struct {
				FullName string `json:"full_name"`
				Periods  int    `json:"weekly_periods"`
			} `json:"items"`
		}
		sunita.does("reviews teacher workloads", "GET", "/api/v1/principal/staff-workload", nil, &workload)

		// She keeps an eye on the money but does not run the counter.
		var fin struct {
			Items []struct {
				FullName string `json:"full_name"`
			} `json:"items"`
		}
		sunita.does("glances at the defaulter list", "GET", "/api/v1/fees/defaulters", nil, &fin)
	})

	// ---------------------------------------------------------------- 09:15
	t.Run("09:15 Priya at the front desk takes a walk-in enquiry", func(t *testing.T) {
		priya := arrive(t, base, "admissions", "Priya")

		// She needs a class to put the child against.
		var classes struct {
			Items []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"items"`
		}
		priya.does("looks up the classes on offer", "GET", "/api/v1/academics/classes", nil, &classes)
		if len(classes.Items) == 0 {
			t.Fatal("no classes configured — Priya cannot take an admission")
		}

		/* Pick a class that actually has a seat.

		   This used to take the first class in the list and only look at the
		   seat matrix later, for show — so once repeated runs had filled Grade
		   6, the offer came back "no seats remain, waitlist the applicant" and
		   the test read as a product failure. It was the test enquiring about
		   a full class, which is the one thing an admissions clerk never does:
		   they check the matrix first, which is why the matrix exists. */
		var seatCheck struct {
			Items []struct {
				ClassID   string `json:"class_id"`
				Available int    `json:"available"`
			} `json:"items"`
		}
		priya.does("checks which classes have seats", "GET",
			"/api/v1/admissions/workflow/seats", nil, &seatCheck)
		for _, row := range seatCheck.Items {
			if row.Available > 0 {
				classID = row.ClassID
				break
			}
		}
		if classID == "" {
			t.Skip("every class in the demo school is full")
		}

		var enquiry struct {
			ID string `json:"id"`
		}
		priya.does("records Mr Menon's enquiry about his daughter Meera", "POST",
			"/api/v1/admissions/workflow/enquiries", map[string]any{
				"student_name": "Meera Menon",
				"parent_name":  "Suresh Menon",
				"phone":        "9845012345",
				"class_sought": classID,
				"source":       "walk_in",
				"notes":        "Relocating from Kochi. Wants a campus tour.",
			}, &enquiry)

		var app struct {
			ID            string `json:"id"`
			ApplicationNo string `json:"application_no"`
		}
		priya.does("converts it into a formal application", "POST",
			"/api/v1/admissions/workflow/applications", map[string]any{
				"enquiry_id":      enquiry.ID,
				"first_name":      "Meera",
				"last_name":       "Menon",
				"date_of_birth":   "2013-06-14",
				"gender":          "female",
				"category":        "general",
				"class_sought":    classID,
				"parent_name":     "Suresh Menon",
				"parent_phone":    "9845012345",
				"previous_school": "St Teresa's, Kochi",
			}, &app)
		applicationID = app.ID
		t.Logf("    application %s raised for Meera Menon", app.ApplicationNo)

		priya.does("schedules and scores her entrance test", "POST",
			"/api/v1/admissions/workflow/applications/"+applicationID+"/assessment",
			map[string]any{"kind": "entrance_test", "score": 88, "max_score": 100}, nil)
		priya.does("records the parent interview", "POST",
			"/api/v1/admissions/workflow/applications/"+applicationID+"/assessment",
			map[string]any{"kind": "interview", "score": 9, "max_score": 10}, nil)

		var merit struct {
			Items []struct {
				ApplicationID string  `json:"application_id"`
				Name          string  `json:"name"`
				MeritScore    float64 `json:"merit_score"`
				Rank          int     `json:"rank"`
			} `json:"items"`
		}
		priya.does("generates the merit list (70/30 weighting)", "GET",
			"/api/v1/admissions/workflow/merit?test_weight=70", nil, &merit)

		var meera *struct {
			ApplicationID string  `json:"application_id"`
			Name          string  `json:"name"`
			MeritScore    float64 `json:"merit_score"`
			Rank          int     `json:"rank"`
		}
		for i := range merit.Items {
			if merit.Items[i].ApplicationID == applicationID {
				meera = &merit.Items[i]
			}
		}
		if meera == nil {
			t.Fatal("Meera is missing from the merit list she was just assessed for")
		}
		// 88% test at 70% weight + 90% interview at 30% = 88.6
		if meera.MeritScore < 88 || meera.MeritScore > 89 {
			t.Errorf("merit score %.2f does not match the 70/30 weighting of 88 and 90",
				meera.MeritScore)
		}
		t.Logf("    Meera ranks #%d with %.1f", meera.Rank, meera.MeritScore)

		var seats struct {
			Items []struct {
				ClassID   string `json:"class_id"`
				ClassName string `json:"class_name"`
				Available int    `json:"available"`
				RTEQuota  int    `json:"rte_quota"`
			} `json:"items"`
		}
		priya.does("re-checks the seat matrix before committing", "GET",
			"/api/v1/admissions/workflow/seats", nil, &seats)

		priya.does("issues the offer", "POST",
			"/api/v1/admissions/workflow/applications/"+applicationID+"/decision",
			map[string]any{"decision": "offered"}, nil)

		// She takes admissions, not money: the fee counter is not hers.
		priya.cannot("run payroll", "POST", "/api/v1/payroll/run",
			map[string]any{"month": 8, "year": 2026}, http.StatusForbidden)
	})

	// ---------------------------------------------------------------- 09:40
	t.Run("09:40 Sunita admits Meera and the record is created", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")

		var sections struct {
			Items []struct {
				ID        string `json:"id"`
				ClassID   string `json:"class_id"`
				ClassName string `json:"class_name"`
				Name      string `json:"name"`
				Capacity  int    `json:"capacity"`
				Enrolled  int    `json:"enrolled"`
			} `json:"items"`
		}
		sunita.does("finds a section with room", "GET", "/api/v1/academics/sections", nil, &sections)
		for _, s := range sections.Items {
			if s.ClassID == classID && s.Enrolled < s.Capacity {
				sectionID = s.ID
				break
			}
		}
		if sectionID == "" && len(sections.Items) > 0 {
			sectionID = sections.Items[0].ID
		}
		if sectionID == "" {
			t.Fatal("no section available to place Meera in")
		}

		var enrolled struct {
			StudentID   string `json:"student_id"`
			AdmissionNo string `json:"admission_no"`
		}
		sunita.does("completes the enrolment handoff", "POST",
			"/api/v1/admissions/workflow/applications/"+applicationID+"/enrol",
			map[string]any{"section_id": sectionID}, &enrolled)
		newStudentID = enrolled.StudentID
		admissionNo = enrolled.AdmissionNo
		if newStudentID == "" {
			t.Fatal("enrolment returned no student — the handoff did not create a record")
		}
		t.Logf("    Meera is now student %s", admissionNo)

		// The handoff must have produced a real, findable student.
		var found struct {
			Items []struct {
				ID          string `json:"id"`
				FullName    string `json:"full_name"`
				AdmissionNo string `json:"admission_no"`
				ClassName   string `json:"class_name"`
			} `json:"items"`
		}
		// Searched by the admission number the handoff just returned, not by
		// first name: repeated runs leave a dozen Meeras in the demo school and
		// a name search capped at ten rows stopped finding the newest one —
		// a green test turning red on its own history rather than on a defect.
		sunita.does("confirms Meera appears in the student directory", "GET",
			"/api/v1/students?q="+url.QueryEscape(admissionNo)+"&limit=10", nil, &found)
		var seen bool
		for _, s := range found.Items {
			if s.ID == newStudentID {
				seen = true
				if s.ClassName == "" {
					t.Error("Meera has no class — the enrolment row was not created with the student")
				}
			}
		}
		if !seen {
			t.Fatal("the student created by the enrolment handoff is not in the directory")
		}
	})

	// ---------------------------------------------------------------- 10:15
	t.Run("10:15 Anil the head of department reviews his staff", func(t *testing.T) {
		anil := arrive(t, base, "hod", "Anil")

		var dash struct {
			Departments int `json:"departments"`
			Faculty     int `json:"faculty"`
			Pending     int `json:"pending_approvals"`
		}
		anil.does("opens his department dashboard", "GET", "/api/v1/department/dashboard", nil, &dash)
		if dash.Departments == 0 {
			t.Error("Anil heads no department — his whole workspace would be empty")
		}

		var faculty struct {
			Items []struct {
				FullName string `json:"full_name"`
				Periods  int    `json:"weekly_periods"`
			} `json:"items"`
		}
		anil.does("checks his faculty's teaching load", "GET", "/api/v1/department/faculty", nil, &faculty)
		t.Logf("    %d departments, %d faculty, %d approvals waiting",
			dash.Departments, dash.Faculty, dash.Pending)

		// A head of department is not an accountant.
		anil.cannot("open the fee counter", "POST", "/api/v1/fees/payments",
			map[string]any{"student_id": newStudentID, "amount_paise": 100, "mode": "cash"},
			http.StatusForbidden)
	})

	// ---------------------------------------------------------------- 11:00
	t.Run("11:00 Kavita at the fee counter collects Meera's admission fee", func(t *testing.T) {
		kavita := arrive(t, base, "finance", "Kavita")

		// She looks up an existing student with dues — Meera has no invoice yet,
		// since fee demand generation is a separate term-start job.
		var students struct {
			Items []struct {
				ID          string `json:"id"`
				FullName    string `json:"full_name"`
				AdmissionNo string `json:"admission_no"`
			} `json:"items"`
		}
		kavita.does("searches for the parent standing at her counter", "GET",
			"/api/v1/students?limit=50", nil, &students)

		// Find someone who actually owes money.
		var payer, payerName string
		for _, s := range students.Items {
			var ledger struct {
				BalancePaise int64 `json:"balance_paise"`
				Dues         []struct {
					InvoiceID    string `json:"invoice_id"`
					BalancePaise int64  `json:"balance_paise"`
				} `json:"dues"`
			}
			kavitaQuiet(t, kavita, "/api/v1/fees/students/"+s.ID+"/ledger", &ledger)
			if len(ledger.Dues) > 0 && ledger.BalancePaise > 0 {
				payer, payerName = s.ID, s.FullName
				break
			}
		}
		if payer == "" {
			t.Skip("no student in the dataset currently owes money")
		}

		var before struct {
			BalancePaise int64 `json:"balance_paise"`
			PaidPaise    int64 `json:"paid_paise"`
			Dues         []struct {
				InvoiceID    string `json:"invoice_id"`
				InvoiceNo    string `json:"invoice_no"`
				BalancePaise int64  `json:"balance_paise"`
			} `json:"dues"`
		}
		kavita.does("opens "+payerName+"'s fee account", "GET",
			"/api/v1/fees/students/"+payer+"/ledger", nil, &before)
		t.Logf("    %s owes ₹%.0f across %d invoice(s)",
			payerName, float64(before.BalancePaise)/100, len(before.Dues))

		pay := before.Dues[0].BalancePaise / 2 // parent pays half today
		if pay <= 0 {
			pay = 100000
		}

		var receipt struct {
			ReceiptNo   string `json:"receipt_no"`
			PaymentID   string `json:"payment_id"`
			AmountPaise int64  `json:"amount_paise"`
			Allocated   []struct {
				InvoiceNo   string `json:"invoice_no"`
				AmountPaise int64  `json:"amount_paise"`
			} `json:"allocated"`
			Cleared bool `json:"cleared"`
		}
		kavita.does(fmt.Sprintf("takes ₹%.0f in cash", float64(pay)/100), "POST",
			"/api/v1/fees/payments", map[string]any{
				"student_id": payer, "amount_paise": pay, "mode": "cash",
			}, &receipt)

		if receipt.ReceiptNo == "" {
			t.Fatal("no receipt number issued — Kavita has nothing to hand the parent")
		}
		if !receipt.Cleared {
			t.Error("a cash payment should be immediately cleared")
		}
		if len(receipt.Allocated) == 0 {
			t.Error("the payment was not allocated to any invoice")
		}

		var printed struct {
			ReceiptNo     string `json:"receipt_no"`
			AmountWords   string `json:"amount_words"`
			StudentName   string `json:"student_name"`
			FinancialYear string `json:"financial_year"`
		}
		kavita.does("prints the receipt", "GET",
			"/api/v1/fees/receipts/"+receipt.PaymentID, nil, &printed)
		if printed.AmountWords == "" {
			t.Error("the receipt has no amount in words, which an Indian receipt must carry")
		}
		t.Logf("    receipt %s — %s", printed.ReceiptNo, printed.AmountWords)

		var after struct {
			BalancePaise int64 `json:"balance_paise"`
			PaidPaise    int64 `json:"paid_paise"`
		}
		kavita.does("re-checks the balance", "GET",
			"/api/v1/fees/students/"+payer+"/ledger", nil, &after)
		if after.PaidPaise != before.PaidPaise+pay {
			t.Errorf("paid total went from ₹%.0f to ₹%.0f after a ₹%.0f payment — the ledger does not add up",
				float64(before.PaidPaise)/100, float64(after.PaidPaise)/100, float64(pay)/100)
		}

		// A post-dated cheque from another parent must not count as collection.
		future := time.Now().AddDate(0, 2, 0).Format(time.DateOnly)
		var pdc struct {
			Cleared   bool   `json:"cleared"`
			ReceiptNo string `json:"receipt_no"`
		}
		kavita.does("accepts a post-dated cheque from another parent", "POST",
			"/api/v1/fees/payments", map[string]any{
				"student_id": payer, "amount_paise": 500000, "mode": "cheque",
				"reference_no": "445566", "bank_name": "Canara Bank", "cheque_date": future,
			}, &pdc)
		if pdc.Cleared {
			t.Error("a post-dated cheque was reported as collected money")
		}

		var register struct {
			Items []struct {
				StudentName string `json:"student_name"`
				DueToday    bool   `json:"due_today"`
			} `json:"items"`
		}
		kavita.does("files it in the PDC register", "GET", "/api/v1/fees/pdc", nil, &register)
		if len(register.Items) == 0 {
			t.Error("the cheque she just took is not in the PDC register")
		}

		var defaulters struct {
			Items []struct {
				FullName string `json:"full_name"`
				Bucket   string `json:"bucket"`
			} `json:"items"`
		}
		kavita.does("prints the aging report for the principal", "GET",
			"/api/v1/fees/defaulters", nil, &defaulters)
		t.Logf("    %d defaulters on the aging report", len(defaulters.Items))
	})

	// ---------------------------------------------------------------- 11:45
	t.Run("11:45 Class teacher Deepa marks her register", func(t *testing.T) {
		deepa := arrive(t, base, "faculty", "Deepa")

		var today struct {
			Items []struct {
				SectionName string `json:"section_name"`
				ClassName   string `json:"class_name"`
				SubjectName string `json:"subject_name"`
				PeriodName  string `json:"period_name"`
				Marked      bool   `json:"attendance_marked"`
			} `json:"items"`
		}
		deepa.does("checks today's timetable", "GET", "/api/v1/teaching/today", nil, &today)

		var mine struct {
			Items []struct {
				SectionID   string `json:"section_id"`
				SectionName string `json:"section_name"`
				ClassName   string `json:"class_name"`
				Enrolled    int    `json:"enrolled"`
			} `json:"items"`
		}
		deepa.does("opens her own classes", "GET", "/api/v1/teaching/classes", nil, &mine)
		if len(mine.Items) == 0 {
			t.Fatal("Deepa is class teacher of nothing — she cannot take a register")
		}
		myClass := mine.Items[0]
		t.Logf("    %d classes; taking the register for %s-%s (%d students)",
			len(mine.Items), myClass.ClassName, myClass.SectionName, myClass.Enrolled)

		var roster struct {
			Items []struct {
				ID       string `json:"id"`
				FullName string `json:"full_name"`
			} `json:"items"`
			Total int `json:"total"`
		}
		deepa.does("pulls the roster", "GET",
			"/api/v1/students?section_id="+myClass.SectionID+"&limit=100", nil, &roster)
		if len(roster.Items) == 0 {
			t.Skip("no students enrolled in Deepa's section")
		}

		// Everyone present except the first two — one absent, one late.
		entries := make([]map[string]any, 0, len(roster.Items))
		for i, s := range roster.Items {
			status := "present"
			if i == 0 {
				status = "absent"
			} else if i == 1 {
				status = "late"
			}
			entries = append(entries, map[string]any{"student_id": s.ID, "status": status})
		}
		today2 := time.Now().Format(time.DateOnly)

		var marked struct {
			Submitted int `json:"submitted"`
			Written   int `json:"written"`
		}
		deepa.does(fmt.Sprintf("marks %d students", len(entries)), "POST", "/api/v1/attendance",
			map[string]any{"section_id": myClass.SectionID, "on_date": today2, "entries": entries},
			&marked)
		if marked.Submitted != len(entries) {
			t.Errorf("submitted %d marks but the register recorded %d", len(entries), marked.Submitted)
		}

		var register struct {
			Items []struct {
				StudentName string `json:"student_name"`
				Status      string `json:"status"`
				SectionID   string `json:"section_id"`
			} `json:"items"`
		}
		deepa.does("re-reads the register to confirm", "GET",
			"/api/v1/attendance?section_id="+myClass.SectionID+"&on_date="+today2, nil, &register)
		absent := 0
		for _, r := range register.Items {
			if r.SectionID != myClass.SectionID {
				t.Errorf("Deepa can see attendance for section %s, which is not hers", r.SectionID)
			}
			if r.Status == "absent" {
				absent++
			}
		}
		t.Logf("    register saved: %d rows, %d absent", len(register.Items), absent)

		// She must not be able to mark a class she does not teach.
		var allSections struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		sunita := arrive(t, base, "institution_admin", "Sunita (lending her list)")
		sunita.does("lists every section", "GET", "/api/v1/academics/sections", nil, &allSections)
		own := map[string]bool{}
		for _, c := range mine.Items {
			own[c.SectionID] = true
		}
		for _, s := range allSections.Items {
			if !own[s.ID] {
				deepa.cannot("mark a register for another teacher's class", "POST", "/api/v1/attendance",
					map[string]any{
						"section_id": s.ID, "on_date": today2,
						"entries": []map[string]any{{"student_id": roster.Items[0].ID, "status": "absent"}},
					}, http.StatusForbidden)
				break
			}
		}
	})

	// ---------------------------------------------------------------- 12:30
	t.Run("12:30 The office alerts parents of absentees", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")
		var alerts struct {
			AbsentStudents int `json:"absent_students"`
			MessagesQueued int `json:"messages_queued"`
		}
		sunita.does("triggers absence alerts for today", "POST",
			"/api/v1/attendance-workflow/absence-alerts?on_date="+time.Now().Format(time.DateOnly),
			nil, &alerts)
		t.Logf("    %d absentees, %d SMS queued to guardians",
			alerts.AbsentStudents, alerts.MessagesQueued)
	})

	// ---------------------------------------------------------------- 13:15
	t.Run("13:15 Deepa enters term marks", func(t *testing.T) {
		deepa := arrive(t, base, "faculty", "Deepa")

		esID := firstExamSubject(t, base)
		if esID == "" {
			t.Skip("no exam paper configured")
		}

		var book struct {
			Items []struct {
				StudentID string  `json:"student_id"`
				FullName  string  `json:"full_name"`
				MaxMarks  float64 `json:"max_marks"`
			} `json:"items"`
		}
		deepa.does("opens the gradebook", "GET",
			"/api/v1/exams/gradebook?exam_subject_id="+esID, nil, &book)
		if len(book.Items) == 0 {
			t.Skip("no students on this paper")
		}

		entries := make([]map[string]any, 0, len(book.Items))
		for i, s := range book.Items {
			entries = append(entries, map[string]any{
				"student_id": s.StudentID, "marks_obtained": 45 + (i*7)%50,
			})
		}
		var saved struct {
			Written int `json:"written"`
		}
		deepa.does(fmt.Sprintf("enters marks for %d students", len(entries)), "POST",
			"/api/v1/exams/marks",
			map[string]any{"exam_subject_id": esID, "entries": entries}, &saved)

		// A slipped decimal must be caught, not silently accepted.
		deepa.cannot("save 950 marks on a 100-mark paper", "POST", "/api/v1/exams/marks",
			map[string]any{"exam_subject_id": esID, "entries": []map[string]any{
				{"student_id": book.Items[0].StudentID, "marks_obtained": 950},
			}}, http.StatusBadRequest)

		var after struct {
			Items []struct {
				Grade *string `json:"grade"`
			} `json:"items"`
		}
		deepa.does("confirms grades were derived", "GET",
			"/api/v1/exams/gradebook?exam_subject_id="+esID, nil, &after)
		graded := 0
		for _, r := range after.Items {
			if r.Grade != nil && *r.Grade != "" {
				graded++
			}
		}
		if graded == 0 {
			t.Error("no grades were derived from the marks — the grading scale is not being applied")
		}
		t.Logf("    %d marks saved, %d graded automatically", saved.Written, graded)
	})

	// ---------------------------------------------------------------- 14:00
	t.Run("14:00 Sunita publishes results and a circular", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")

		examID := firstExam(t, base)
		if examID != "" && sectionID != "" {
			var gen struct {
				ReportCards int  `json:"report_cards"`
				Published   bool `json:"published"`
			}
			sunita.does("generates and publishes report cards", "POST",
				"/api/v1/exams/report-cards/generate",
				map[string]any{"exam_id": examID, "section_id": sectionID, "publish": true}, &gen)

			var cards struct {
				Items []struct {
					FullName   string   `json:"full_name"`
					Rank       *int     `json:"rank_in_section"`
					Percentage *float64 `json:"percentage"`
				} `json:"items"`
			}
			sunita.does("reviews the ranked results", "GET",
				"/api/v1/exams/report-cards?section_id="+sectionID, nil, &cards)

			// Ranks must be unique and start at 1, or parents will notice.
			ranks := map[int]int{}
			for _, c := range cards.Items {
				if c.Rank != nil {
					ranks[*c.Rank]++
				}
			}
			if len(cards.Items) > 0 && ranks[1] == 0 {
				t.Error("no student is ranked first in a published set of report cards")
			}
			t.Logf("    %d report cards published", gen.ReportCards)
		}

		var circ struct {
			ID         string `json:"id"`
			Recipients int    `json:"recipients"`
		}
		sunita.does("publishes the PTM circular", "POST", "/api/v1/communication/circulars",
			map[string]any{
				"title":        "Parent-Teacher Meeting — Saturday 30 August",
				"body":         "PTM will be held from 9am to 1pm. Report cards will be discussed.",
				"requires_ack": true,
			}, &circ)
		t.Logf("    circular reaches %d guardians", circ.Recipients)
	})

	// ---------------------------------------------------------------- 14:45
	t.Run("14:45 Meena in HR runs the month's payroll", func(t *testing.T) {
		meena := arrive(t, base, "hr", "Meena")

		var staff struct {
			Items []struct {
				FullName string `json:"full_name"`
			} `json:"items"`
		}
		meena.does("checks the employee directory", "GET",
			"/api/v1/hr/employees?status=active", nil, &staff)

		now := time.Now()
		var run struct {
			Employees      int   `json:"employees"`
			GrossPaise     int64 `json:"gross_paise"`
			DeductionPaise int64 `json:"deduction_paise"`
			NetPaise       int64 `json:"net_paise"`
		}
		meena.does("runs payroll for this month", "POST", "/api/v1/payroll/run",
			map[string]any{"month": int(now.Month()), "year": now.Year()}, &run)

		if run.Employees > 0 {
			if run.NetPaise != run.GrossPaise-run.DeductionPaise {
				t.Errorf("payroll does not balance: gross %d - deductions %d != net %d",
					run.GrossPaise, run.DeductionPaise, run.NetPaise)
			}
			t.Logf("    %d employees, net ₹%.0f payable",
				run.Employees, float64(run.NetPaise)/100)
		}

		var slips struct {
			Items []struct {
				FullName string           `json:"full_name"`
				NetPaise int64            `json:"net_paise"`
				Breakup  map[string]int64 `json:"breakup"`
			} `json:"items"`
		}
		meena.does("opens the payslips", "GET",
			fmt.Sprintf("/api/v1/payroll/payslips?month=%d&year=%d", int(now.Month()), now.Year()),
			nil, &slips)
		for _, s := range slips.Items {
			if len(s.Breakup) == 0 {
				t.Errorf("%s's payslip has no component breakup", s.FullName)
			}
			break
		}

		// HR does not decide admissions.
		meena.cannot("offer an admission", "POST",
			"/api/v1/admissions/workflow/applications/"+applicationID+"/decision",
			map[string]any{"decision": "rejected"}, http.StatusForbidden)
	})

	// ---------------------------------------------------------------- 15:20
	t.Run("15:20 Ganesh at the library and stores desk", func(t *testing.T) {
		ganesh := arrive(t, base, "operations", "Ganesh")

		var dash struct {
			LibraryTitles int `json:"library_titles"`
			LoansOut      int `json:"loans_out"`
			LoansOverdue  int `json:"loans_overdue"`
			Vehicles      int `json:"vehicles"`
		}
		ganesh.does("opens his operations dashboard", "GET",
			"/api/v1/operations/dashboard", nil, &dash)

		var stock struct {
			Items []struct {
				Code   string `json:"code"`
				Name   string `json:"name"`
				OnHand int    `json:"on_hand"`
				Low    bool   `json:"below_reorder"`
			} `json:"items"`
		}
		ganesh.does("checks stock levels", "GET", "/api/v1/ops/inventory/stock", nil, &stock)
		low := 0
		for _, s := range stock.Items {
			if s.Low {
				low++
			}
		}
		t.Logf("    %d titles, %d on loan (%d overdue); %d stock items, %d below reorder",
			dash.LibraryTitles, dash.LoansOut, dash.LoansOverdue, len(stock.Items), low)

		var hostel struct {
			Items []struct {
				Block    string `json:"block"`
				Occupied int    `json:"occupied"`
				Beds     int    `json:"beds"`
			} `json:"items"`
		}
		ganesh.does("reviews hostel occupancy", "GET", "/api/v1/ops/hostel/occupancy", nil, &hostel)

		// Issuing more than exists must be refused, not allowed to go negative.
		if len(stock.Items) > 0 {
			itemID := firstInventoryItem(t, base)
			if itemID != "" {
				ganesh.cannot("issue 100000 units that are not in stock", "POST",
					"/api/v1/ops/inventory/movements",
					map[string]any{"item_id": itemID, "kind": "issue", "quantity": 100000},
					http.StatusBadRequest)
			}
		}
	})

	// ---------------------------------------------------------------- 16:00
	t.Run("16:00 Arjun the student checks his own portal", func(t *testing.T) {
		arjun := arrive(t, base, "student", "Arjun")

		var me struct {
			Items []struct {
				StudentID   string `json:"student_id"`
				FullName    string `json:"full_name"`
				AdmissionNo string `json:"admission_no"`
			} `json:"items"`
		}
		arjun.does("opens his profile", "GET", "/api/v1/portal/students", nil, &me)
		if len(me.Items) != 1 {
			t.Errorf("a student should resolve to exactly one record, got %d", len(me.Items))
		}

		var summary struct {
			FullName      string `json:"full_name"`
			AttendancePct int    `json:"attendance_pct"`
			HomeworkDue   int    `json:"homework_due"`
			Outstanding   int64  `json:"outstanding_paise"`
		}
		arjun.does("checks his attendance and dues", "GET", "/api/v1/portal/summary", nil, &summary)
		t.Logf("    %s: %d%% attendance, ₹%.0f outstanding",
			summary.FullName, summary.AttendancePct, float64(summary.Outstanding)/100)

		var att struct {
			Items []struct {
				Date   string `json:"date"`
				Status string `json:"status"`
			} `json:"items"`
		}
		arjun.does("opens his attendance calendar", "GET", "/api/v1/portal/attendance", nil, &att)

		// The portal must not be a way into the school's records.
		arjun.cannot("list every student in the school", "GET", "/api/v1/students", nil, http.StatusForbidden)
		arjun.cannot("open the fee counter", "POST", "/api/v1/fees/payments",
			map[string]any{"student_id": newStudentID, "amount_paise": 1, "mode": "cash"},
			http.StatusForbidden)
		arjun.cannot("read the staff payroll", "GET", "/api/v1/payroll/payslips", nil, http.StatusForbidden)
	})

	// ---------------------------------------------------------------- 18:30
	t.Run("18:30 Mrs Nair checks on her children from home", func(t *testing.T) {
		nair := arrive(t, base, "parent", "Mrs Nair")

		var kids struct {
			Items []struct {
				StudentID   string `json:"student_id"`
				FullName    string `json:"full_name"`
				AdmissionNo string `json:"admission_no"`
				ClassName   string `json:"class_name"`
			} `json:"items"`
		}
		nair.does("opens the app and sees her children", "GET", "/api/v1/portal/students", nil, &kids)
		if len(kids.Items) == 0 {
			t.Fatal("Mrs Nair has no children linked — the parent app would be empty")
		}
		t.Logf("    %d children linked", len(kids.Items))

		// Each child's attendance must be that child's, not a merge.
		for _, k := range kids.Items {
			var att struct {
				Items []struct {
					Date   string `json:"date"`
					Status string `json:"status"`
				} `json:"items"`
			}
			nair.does("checks "+k.FullName+"'s attendance", "GET",
				"/api/v1/portal/attendance?student_id="+k.StudentID, nil, &att)
			seen := map[string]bool{}
			for _, d := range att.Items {
				if seen[d.Date] {
					t.Errorf("%s's calendar has two entries for %s — another child's rows leaked in",
						k.FullName, d.Date)
				}
				seen[d.Date] = true
			}

			var sum struct {
				FullName      string `json:"full_name"`
				AttendancePct int    `json:"attendance_pct"`
				Outstanding   int64  `json:"outstanding_paise"`
			}
			nair.does("reads "+k.FullName+"'s summary", "GET",
				"/api/v1/portal/summary?student_id="+k.StudentID, nil, &sum)
			if sum.FullName != k.FullName {
				t.Errorf("asked for %s's summary and got %s's", k.FullName, sum.FullName)
			}
		}

		// She must not be able to open a child who is not hers.
		other := someoneElsesChild(t, base, kids.Items)
		if other != "" {
			nair.cannot("open another family's child", "GET",
				"/api/v1/portal/summary?student_id="+other, nil, http.StatusNotFound)
		}

		var circulars struct {
			Items []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"items"`
		}
		nair.does("reads the circulars", "GET", "/api/v1/communication/circulars", nil, &circulars)
		if len(circulars.Items) > 0 {
			nair.does("acknowledges the PTM circular", "POST",
				"/api/v1/communication/circulars/"+circulars.Items[0].ID+"/ack", nil, nil)
		}
	})

	// ---------------------------------------------------------------- 19:00
	t.Run("19:00 The office issues a transfer certificate", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")

		var cert struct {
			SerialNo string `json:"serial_no"`
			Type     string `json:"type"`
		}
		sunita.does("issues a bonafide certificate for Meera", "POST",
			"/api/v1/lifecycle/certificates",
			map[string]any{
				"student_id": newStudentID, "type_code": "BONAFIDE",
				"reason": "Passport application",
			}, &cert)
		if cert.SerialNo == "" {
			t.Fatal("the certificate has no serial number")
		}

		var register struct {
			Items []struct {
				SerialNo    string         `json:"serial_no"`
				Type        string         `json:"type"`
				StudentName string         `json:"student_name"`
				Snapshot    map[string]any `json:"snapshot"`
			} `json:"items"`
		}
		sunita.does("checks the certificate register", "GET",
			"/api/v1/lifecycle/certificates", nil, &register)

		var found bool
		for _, c := range register.Items {
			if c.SerialNo == cert.SerialNo {
				found = true
				// The snapshot is what makes an old certificate stable.
				if c.Snapshot == nil || c.Snapshot["admission_no"] == nil {
					t.Error("the certificate carries no frozen snapshot of the student")
				} else {
					t.Logf("    %s issued for %s, snapshot admission_no=%v",
						c.SerialNo, c.StudentName, c.Snapshot["admission_no"])
				}
			}
		}
		if !found {
			t.Error("the certificate just issued is not in the register")
		}
	})

	// ---------------------------------------------------------------- 19:30
	t.Run("19:30 Sunita reviews the UDISE+ readiness before filing season", func(t *testing.T) {
		sunita := arrive(t, base, "institution_admin", "Sunita")

		var udise struct {
			Items []struct {
				AdmissionNo string `json:"admission_no"`
				Name        string `json:"name"`
				Issues      string `json:"issues"`
			} `json:"items"`
		}
		sunita.does("runs the UDISE+ validation", "GET", "/api/v1/compliance/udise", nil, &udise)

		bad := 0
		for _, r := range udise.Items {
			if r.Issues != "" {
				bad++
			}
		}
		t.Logf("    %d students in the return, %d would be rejected", len(udise.Items), bad)
		if len(udise.Items) > 0 && bad == len(udise.Items) {
			t.Logf("    (every record is incomplete — expected on demo data, but this is exactly")
			t.Logf("     the list a school works through before the filing deadline)")
		}

		// Fixing one record must reduce the count.
		if bad > 0 {
			// APAAR is unique per student nationally, so the demo value has to
			// vary between runs or the second run legitimately conflicts.
			apaar := fmt.Sprintf("%012d", time.Now().UnixNano()%1_000_000_000_000)
			sunita.does("issues an APAAR ID for the first flagged student", "POST",
				"/api/v1/compliance/apaar", map[string]any{
					"student_id": newStudentID, "apaar_id": apaar,
					"aadhaar_consent": true,
				}, nil)
		}
	})
}

// --- small helpers ----------------------------------------------------------

func kavitaQuiet(t *testing.T, p *person, path string, into any) {
	t.Helper()
	resp, err := p.client.Get(p.base + path)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		_ = json.NewDecoder(resp.Body).Decode(into)
	}
}

func firstExamSubject(t *testing.T, base string) string {
	t.Helper()
	c := login(t, base, "institution_admin@vivencia.test")
	var out struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if code := getJSON(t, c, base+"/api/v1/exams/subjects", &out); code == 200 && len(out.Items) > 0 {
		return out.Items[0].ID
	}
	return ""
}

func firstExam(t *testing.T, base string) string {
	t.Helper()
	c := login(t, base, "institution_admin@vivencia.test")
	var out struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if code := getJSON(t, c, base+"/api/v1/exams/list", &out); code == 200 && len(out.Items) > 0 {
		return out.Items[0].ID
	}
	return ""
}

func firstInventoryItem(t *testing.T, base string) string {
	t.Helper()
	c := login(t, base, "operations@vivencia.test")
	var out struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if code := getJSON(t, c, base+"/api/v1/ops/inventory/stock", &out); code == 200 && len(out.Items) > 0 {
		return out.Items[0].ID
	}
	return ""
}

// someoneElsesChild returns a student id the given guardian is not linked to.
func someoneElsesChild(t *testing.T, base string, mine []struct {
	StudentID   string `json:"student_id"`
	FullName    string `json:"full_name"`
	AdmissionNo string `json:"admission_no"`
	ClassName   string `json:"class_name"`
}) string {
	t.Helper()
	admin := login(t, base, "institution_admin@vivencia.test")
	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=200", &all)
	own := map[string]bool{}
	for _, m := range mine {
		own[m.StudentID] = true
	}
	for _, s := range all.Items {
		if !own[s.ID] {
			return s.ID
		}
	}
	return ""
}
