package api

import (
	"html/template"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

/* The front door.

   The commercial cycle already ran seller → tenant → principal → tour, and had
   no beginning: a school that wanted to buy had to already know somebody at
   the vendor. This is the page that starts it — the plans, what each includes,
   and a form that puts a named school in front of the sales desk.

   Server-rendered like the sign-in page, and for the same reason: it has to
   work before any tenant exists, before anyone has an account, and without the
   SPA bundle. It is also the one page a search engine should be able to read.

   It deliberately does not provision anything. A self-service trial that mints
   a live tenant from an unverified form is how a database fills with
   "asdf School"; the seller reads the enquiry, telephones the school, and
   provisions from the console with one click. */

// BuyPage renders the public pricing page and takes enquiries.
type BuyPage struct {
	DB  *database.DB
	Tpl *template.Template
}

type buyPlan struct {
	Code        string
	Name        string
	Rupees      string
	MaxStudents string
	Modules     []string
	Featured    bool
}

type buyView struct {
	// AssetVersion busts nginx's seven-day cache on /static; see
	// internal/static.Version.
	AssetVersion string
	Plans        []buyPlan
	Sent         bool
	Error        string
	School       string
	Contact      string
	Email        string
	Phone        string
	District     string
	Students     string
	Plan         string
	Message      string
}

// modulesFor turns a plan's module keys into something a head teacher can read.
var moduleLabels = map[string]string{
	"students":      "Student records",
	"academics":     "Classes, sections and timetable",
	"attendance":    "Attendance",
	"fees":          "Fee collection and receipts",
	"communication": "SMS, email and circulars",
	"exams":         "Examinations and report cards",
	"hr":            "Staff records and payroll",
	"transport":     "Transport and routes",
	"library":       "Library",
	"hostel":        "Hostel",
	"inventory":     "Stores and inventory",
}

func (b *BuyPage) plans(r *http.Request) ([]buyPlan, error) {
	var out []buyPlan
	err := b.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT code, name, price_paise, max_students, modules
			  FROM plans ORDER BY sequence, price_paise`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				p       buyPlan
				paise   int64
				maxStud *int
				mods    []string
			)
			if err := rows.Scan(&p.Code, &p.Name, &paise, &maxStud, &mods); err != nil {
				return err
			}
			p.Rupees = indianRupees(paise / 100)
			if maxStud == nil {
				p.MaxStudents = "Unlimited students"
			} else {
				p.MaxStudents = "Up to " + indianRupees(int64(*maxStud)) + " students"
			}
			if len(mods) == 0 {
				p.Modules = []string{"Every module, including hostel, stores and health"}
			} else {
				for _, m := range mods {
					if label, ok := moduleLabels[m]; ok {
						p.Modules = append(p.Modules, label)
					} else {
						p.Modules = append(p.Modules, m)
					}
				}
			}
			out = append(out, p)
		}
		return rows.Err()
	})
	// The middle plan is the one most schools want; saying so is more useful
	// than three identical columns.
	if len(out) == 3 {
		out[1].Featured = true
	}
	return out, err
}

// indianRupees groups by the Indian convention — 1,80,000 rather than 180,000.
// A price written the wrong way reads as a foreign product.
func indianRupees(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) <= 3 {
		return s
	}
	head, tail := s[:len(s)-3], s[len(s)-3:]
	var parts []string
	for len(head) > 2 {
		parts = append([]string{head[len(head)-2:]}, parts...)
		head = head[:len(head)-2]
	}
	if head != "" {
		parts = append([]string{head}, parts...)
	}
	return strings.Join(parts, ",") + "," + tail
}

func (b *BuyPage) Show(w http.ResponseWriter, r *http.Request) {
	plans, err := b.plans(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	b.render(w, r, http.StatusOK, buyView{Plans: plans, Plan: r.URL.Query().Get("plan")})
}

func (b *BuyPage) Submit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	v := buyView{
		School:   strings.TrimSpace(r.PostFormValue("school_name")),
		Contact:  strings.TrimSpace(r.PostFormValue("contact_name")),
		Email:    strings.TrimSpace(r.PostFormValue("email")),
		Phone:    strings.TrimSpace(r.PostFormValue("phone")),
		District: strings.TrimSpace(r.PostFormValue("district")),
		Students: strings.TrimSpace(r.PostFormValue("students")),
		Plan:     strings.TrimSpace(r.PostFormValue("plan_code")),
		Message:  strings.TrimSpace(r.PostFormValue("message")),
	}
	v.Plans, _ = b.plans(r)

	switch {
	case v.School == "":
		v.Error = "Please tell us the name of your school."
	case v.Contact == "":
		v.Error = "Please tell us who we should speak to."
	case v.Email == "" && v.Phone == "":
		v.Error = "Please leave an email address or a phone number so we can reply."
	}
	if v.Error != "" {
		b.render(w, r, http.StatusBadRequest, v)
		return
	}

	var students *int
	if n, err := strconv.Atoi(v.Students); err == nil && n > 0 {
		students = &n
	}

	err := b.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO purchase_enquiries (school_name, contact_name, email, phone,
			                                district, students, plan_code, message,
			                                source)
			VALUES ($1,$2,NULLIF($3,'')::citext,NULLIF($4,''),NULLIF($5,''),$6,
			        NULLIF($7,''),NULLIF($8,''),'website')`,
			v.School, v.Contact, v.Email, v.Phone, v.District, students,
			v.Plan, v.Message)
		return err
	})
	if err != nil {
		// The school is not interested in why. Log it, apologise, keep the form
		// filled in so they can try again rather than retyping everything.
		httpx.LogError(r, err)
		v.Error = "Something went wrong at our end. Please try again, or email us directly."
		b.render(w, r, http.StatusInternalServerError, v)
		return
	}

	b.render(w, r, http.StatusOK, buyView{Plans: v.Plans, Sent: true, School: v.School})
}

func (b *BuyPage) render(w http.ResponseWriter, r *http.Request, status int, v buyView) {
	v.AssetVersion = static.Version()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := b.Tpl.ExecuteTemplate(w, "buy.gohtml", v); err != nil {
		httpx.Internal(w, r, err)
	}
}

// --- the seller's side of the same table ---------------------------------------

type salesEnquiryRow struct {
	ID          string  `json:"id"`
	School      string  `json:"school_name"`
	Contact     string  `json:"contact_name"`
	Email       *string `json:"email,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	District    *string `json:"district,omitempty"`
	Students    *int    `json:"students,omitempty"`
	Plan        *string `json:"plan_code,omitempty"`
	Message     *string `json:"message,omitempty"`
	Status      string  `json:"status"`
	Source      string  `json:"source"`
	CreatedAt   string  `json:"created_at"`
	Provisioned bool    `json:"provisioned"`
}

// listSalesEnquiries is the sales desk: who has asked to buy, and which of
// them became customers. Distinct from listEnquiries, which is a *school's*
// own admissions enquiries — parents asking about a place, not schools asking
// about the software.
func (s *Server) listSalesEnquiries(w http.ResponseWriter, r *http.Request) {
	items := []salesEnquiryRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, school_name, contact_name, email::text, phone, district,
			       students, plan_code, message, status, source,
			       to_char(created_at, 'YYYY-MM-DD'),
			       provisioned_institution_id IS NOT NULL
			  FROM purchase_enquiries
			 ORDER BY created_at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v salesEnquiryRow
			if err := rows.Scan(&v.ID, &v.School, &v.Contact, &v.Email, &v.Phone,
				&v.District, &v.Students, &v.Plan, &v.Message, &v.Status,
				&v.Source, &v.CreatedAt, &v.Provisioned); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
