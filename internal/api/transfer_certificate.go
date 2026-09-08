package api

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/*
What a transfer certificate has to say.

	The snapshot carried nine keys. A CBSE or state-board TC carries about
	twenty, and an inspector reads them against the admission register: the
	date of birth in words as well as figures, nationality, category, whether
	the child was in the NCC or scouts, games played, general conduct, the
	reason for leaving, the date the family applied and the date the paper
	was issued, the class at the time in words, whether the child qualified
	for promotion, the month up to which fees were paid and any concession
	enjoyed. Half of those are already on the student record and were simply
	not copied; the rest are asked for on the issue form, because no table
	holds "played kabaddi".

	The dues gate is the other half of this file. The snapshot only ever
	recorded the dues; nothing stopped the issue.
*/

type tcDetails struct {
	Nationality        string `json:"nationality,omitempty"`
	Category           string `json:"category,omitempty"`
	NCCScout           string `json:"ncc_scout,omitempty"`
	Games              string `json:"games,omitempty"`
	Conduct            string `json:"conduct,omitempty"`
	DateOfApplication  string `json:"date_of_application,omitempty"`
	DateOfIssue        string `json:"date_of_issue,omitempty"`
	QualifiedPromotion *bool  `json:"qualified_for_promotion,omitempty"`
	DuesPaidUpTo       string `json:"dues_paid_up_to,omitempty"`
	FeeConcession      string `json:"fee_concession,omitempty"`
	LastExamPassed     string `json:"last_exam_passed,omitempty"`
	// Issue although fees are owed. Refused without a reason, and the
	// person overriding is written on the certificate row.
	OverrideDues       bool   `json:"override_dues,omitempty"`
	OverrideDuesReason string `json:"override_dues_reason,omitempty"`
}

var errDuesUnpaid = errors.New("dues unpaid")

// tcDues is what the child still owes, counted the way the fee screens
// count it: unpaid, partial and overdue invoices, net less paid.
func tcDues(ctx context.Context, tx pgx.Tx, sid uuid.UUID) (paise int64, invoices int, err error) {
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(sum(i.net_paise - i.paid_paise), 0)::bigint, count(*)::int
		  FROM invoices i
		 WHERE i.student_id = $1
		   AND i.status IN ('unpaid','partial','overdue')
		   AND i.net_paise > i.paid_paise`, sid).Scan(&paise, &invoices)
	return
}

// tcExtras reads what the record already knows and lays the form's answers
// over it, in the shape the snapshot stores.
func tcExtras(ctx context.Context, tx pgx.Tx, sid uuid.UUID, d tcDetails,
	reason string) (map[string]any, error) {

	var dob *time.Time
	var nationality, category, classLevelName string
	var classLevel *int
	var duesPaidUpTo *time.Time
	var concession *string
	var daysTotal, daysPresent int
	var subjects []string
	var lastExam *string
	var lastExamPassed *bool
	if err := tx.QueryRow(ctx, `
		SELECT st.date_of_birth, COALESCE(st.nationality,''), COALESCE(st.category,''),
		       COALESCE(c.name,''), c.level,
		       -- The month up to which the family is paid: the latest due date
		       -- among the bills fully settled.
		       (SELECT max(i.due_on) FROM invoices i
		         WHERE i.student_id = st.id AND i.status = 'paid'),
		       (SELECT string_agg(concat_ws(' ', initcap(fc.kind),
		                          CASE WHEN fc.percent IS NOT NULL THEN fc.percent::text || '%'
		                               WHEN fc.amount_paise IS NOT NULL
		                                    THEN '₹' || (fc.amount_paise/100)::text END), '; ')
		          FROM fee_concessions fc
		         WHERE fc.student_id = st.id AND fc.academic_year_id = en.academic_year_id),
		       -- This year's register, not the child's whole life.
		       (SELECT count(DISTINCT sa.on_date) FROM student_attendance sa
		         WHERE sa.student_id = st.id AND sa.on_date >= ay.starts_on
		           AND sa.on_date <= ay.ends_on)::int,
		       (SELECT count(DISTINCT sa.on_date) FROM student_attendance sa
		         WHERE sa.student_id = st.id AND sa.on_date >= ay.starts_on
		           AND sa.on_date <= ay.ends_on
		           AND sa.status IN ('present','late'))::int,
		       COALESCE((SELECT array_agg(sub.name ORDER BY sub.name)
		          FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
		         WHERE cs.class_id = en.class_id), '{}'),
		       -- The last examination the school stood behind: the latest
		       -- published card, and whether it cleared the pass line.
		       (SELECT COALESCE(ex.name, t.name, ay2.name)
		          FROM report_cards rc
		          LEFT JOIN exams ex ON ex.id = rc.exam_id
		          LEFT JOIN terms t ON t.id = rc.term_id
		          LEFT JOIN academic_years ay2 ON ay2.id = rc.academic_year_id
		         WHERE rc.student_id = st.id AND rc.is_published
		         ORDER BY rc.published_at DESC NULLS LAST LIMIT 1),
		       (SELECT rc.percentage >= COALESCE(
		                 (SELECT min(100.0 * es.pass_marks / NULLIF(es.max_marks,0))
		                    FROM exam_subjects es WHERE es.exam_id = rc.exam_id), 33)
		          FROM report_cards rc
		         WHERE rc.student_id = st.id AND rc.is_published AND rc.percentage IS NOT NULL
		         ORDER BY rc.published_at DESC NULLS LAST LIMIT 1)
		  FROM students st
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.academic_year_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		  LEFT JOIN academic_years ay ON ay.id = en.academic_year_id
		 WHERE st.id = $1`, sid).
		Scan(&dob, &nationality, &category, &classLevelName, &classLevel, &duesPaidUpTo,
			&concession, &daysTotal, &daysPresent, &subjects, &lastExam, &lastExamPassed); err != nil {
		return nil, err
	}

	pick := func(given, onRecord string) string {
		if v := strings.TrimSpace(given); v != "" {
			return v
		}
		return onRecord
	}
	out := map[string]any{
		"nationality":         pick(d.Nationality, firstNonEmpty(nationality, "Indian")),
		"category":            pick(d.Category, category),
		"ncc_scout":           strings.TrimSpace(d.NCCScout),
		"games":               strings.TrimSpace(d.Games),
		"conduct":             pick(d.Conduct, "Good"),
		"reason_for_leaving":  strings.TrimSpace(reason),
		"date_of_application": strings.TrimSpace(d.DateOfApplication),
		"date_of_leaving":     nowInIndia().Format("2006-01-02"),
		"working_days":        daysTotal,
		"days_present":        daysPresent,
		"subjects_studied":    subjects,
		"last_exam_passed":    pick(d.LastExamPassed, deref(lastExam)),
	}
	if dob != nil {
		out["date_of_birth_in_words"] = dateInWords(*dob)
	}
	if classLevel != nil {
		out["class_in_words"] = fmt.Sprintf("%s (%s)", ordinalWords(*classLevel), classLevelName)
	} else {
		out["class_in_words"] = classLevelName
	}
	switch {
	case d.QualifiedPromotion != nil:
		out["qualified_for_promotion"] = *d.QualifiedPromotion
	case lastExamPassed != nil:
		out["qualified_for_promotion"] = *lastExamPassed
	}
	if v := strings.TrimSpace(d.DuesPaidUpTo); v != "" {
		out["dues_paid_up_to"] = v
	} else if duesPaidUpTo != nil {
		out["dues_paid_up_to"] = duesPaidUpTo.Format("2006-01-02")
	}
	if v := strings.TrimSpace(d.FeeConcession); v != "" {
		out["fee_concession"] = v
	} else if concession != nil && *concession != "" {
		out["fee_concession"] = *concession
	} else {
		out["fee_concession"] = "Nil"
	}
	if d.DateOfIssue != "" {
		out["date_of_issue"] = strings.TrimSpace(d.DateOfIssue)
	}
	return out, nil
}

// dateInWords writes 14 March 2014 as "Fourteenth March Two Thousand
// Fourteen", which is how the date of birth goes on a TC beside the digits.
func dateInWords(t time.Time) string {
	return fmt.Sprintf("%s %s %s", ordinalWords(t.Day()), t.Month().String(),
		fees.NumberInWords(int64(t.Year())))
}

var ordinalSmall = map[int]string{
	1: "First", 2: "Second", 3: "Third", 4: "Fourth", 5: "Fifth", 6: "Sixth",
	7: "Seventh", 8: "Eighth", 9: "Ninth", 10: "Tenth", 11: "Eleventh",
	12: "Twelfth", 13: "Thirteenth", 14: "Fourteenth", 15: "Fifteenth",
	16: "Sixteenth", 17: "Seventeenth", 18: "Eighteenth", 19: "Nineteenth",
	20: "Twentieth", 30: "Thirtieth",
}

func ordinalWords(n int) string {
	if s, ok := ordinalSmall[n]; ok {
		return s
	}
	if n > 20 && n < 40 {
		tens := "Twenty"
		if n >= 30 {
			tens = "Thirty"
		}
		return tens + "-" + ordinalSmall[n%10]
	}
	return fmt.Sprintf("%dth", n)
}

/*
renderIssuedCertificate prints the certificate from its frozen snapshot.

	The template preview fills the school's design from the live record, which
	is right for a preview and wrong for a document already issued: a TC
	printed again a year later must say what it said the first time. Every
	snapshot key is a token — {{date_of_birth_in_words}}, {{conduct}} — and
	a school with no template of its own gets the prescribed fields laid out
	plainly, which is what the receiving school reads.
*/
func (s *Server) renderIssuedCertificate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	certID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid certificate id")
		return
	}
	var typeName, code, body, serial, issuedOn, signatory, signatoryRole, school string
	var snapshot map[string]any
	var overrideBy *string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT ct.name, ct.code, COALESCE(ct.template_html,''), ic.serial_no,
			       to_char(ic.issued_on,'DD-MM-YYYY'), COALESCE(ct.signatory,''),
			       COALESCE(ct.signatory_role,''), ic.snapshot,
			       (SELECT i.name FROM institutions i WHERE i.id = ic.institution_id),
			       (SELECT u.full_name FROM users u WHERE u.id = ic.dues_override_by)
			  FROM issued_certificates ic
			  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
			 WHERE ic.id = $1`, certID).
			Scan(&typeName, &code, &body, &serial, &issuedOn, &signatory, &signatoryRole,
				&snapshot, &school, &overrideBy)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	fields := map[string]string{
		"serial_no": serial, "issued_on": issuedOn, "signatory": signatory,
		"signatory_role": signatoryRole, "school_name": school,
		"student_name": snapshotString(snapshot["name"]),
	}
	for k, v := range snapshot {
		fields[k] = snapshotString(v)
	}
	if fields["date_of_issue"] == "" {
		fields["date_of_issue"] = issuedOn
	}
	if overrideBy != nil {
		fields["dues_override_by"] = *overrideBy
	}

	var rendered string
	if strings.TrimSpace(body) != "" {
		rendered = body
		for k, v := range fields {
			rendered = strings.ReplaceAll(rendered, "{{"+k+"}}", html.EscapeString(v))
		}
	} else {
		rendered = plainCertificate(typeName, code, fields)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"html": rendered, "name": typeName + " " + serial, "template": strings.TrimSpace(body) != "",
	})
}

func snapshotString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "Yes"
		}
		return "No"
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%.2f", t)
	case []any:
		parts := make([]string, 0, len(t))
		for _, p := range t {
			parts = append(parts, snapshotString(p))
		}
		return strings.Join(parts, ", ")
	default:
		return fmt.Sprint(t)
	}
}

// The prescribed order of a transfer certificate, as the register form has
// it. Other certificate kinds get their snapshot in key order.
var tcLines = []struct{ key, label string }{
	{"serial_no", "TC No."},
	{"admission_no", "Admission No."},
	{"name", "Name of the pupil"},
	{"guardian_name", "Father's / Guardian's name"},
	{"nationality", "Nationality"},
	{"category", "Category"},
	{"date_of_birth", "Date of birth (in figures)"},
	{"date_of_birth_in_words", "Date of birth (in words)"},
	{"admission_date", "Date of admission"},
	{"class_in_words", "Class in which the pupil last studied (in words)"},
	{"subjects_studied", "Subjects studied"},
	{"last_exam_passed", "School / Board examination last taken"},
	{"qualified_for_promotion", "Whether qualified for promotion to the higher class"},
	{"dues_paid_up_to", "School dues paid up to"},
	{"fee_concession", "Any fee concession availed"},
	{"working_days", "Total number of working days"},
	{"days_present", "Total number of working days present"},
	{"ncc_scout", "Whether NCC cadet / Scout / Guide"},
	{"games", "Games played / extra-curricular activities"},
	{"conduct", "General conduct"},
	{"date_of_application", "Date of application for certificate"},
	{"date_of_leaving", "Date on which the pupil left the school"},
	{"reason_for_leaving", "Reason for leaving"},
	{"apaar_id", "APAAR ID"},
	{"date_of_issue", "Date of issue"},
	{"dues_override_by", "Dues outstanding at issue, allowed by"},
}

func plainCertificate(typeName, code string, f map[string]string) string {
	var b strings.Builder
	b.WriteString(`<div style="font-family:Georgia,serif;max-width:190mm;margin:0 auto;padding:16mm;line-height:1.5">`)
	fmt.Fprintf(&b, `<h2 style="text-align:center;margin:0">%s</h2>`, html.EscapeString(f["school_name"]))
	fmt.Fprintf(&b, `<h3 style="text-align:center;margin:4px 0 16px;letter-spacing:.08em;text-transform:uppercase">%s</h3>`,
		html.EscapeString(typeName))
	b.WriteString(`<table style="width:100%;border-collapse:collapse;font-size:14px">`)
	var lines []struct{ key, label string }
	if code == "TC" {
		lines = tcLines
	} else {
		keys := make([]string, 0, len(f))
		for k := range f {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			lines = append(lines, struct{ key, label string }{k, strings.ReplaceAll(k, "_", " ")})
		}
	}
	n := 0
	for _, l := range lines {
		v, ok := f[l.key]
		if !ok || (v == "" && l.key == "dues_override_by") {
			continue
		}
		n++
		if v == "" {
			v = "—"
		}
		fmt.Fprintf(&b, `<tr><td style="padding:4px 8px 4px 0;width:2em;vertical-align:top">%d.</td>`+
			`<td style="padding:4px 8px;vertical-align:top">%s</td>`+
			`<td style="padding:4px 0;font-weight:600;vertical-align:top">%s</td></tr>`,
			n, html.EscapeString(l.label), html.EscapeString(v))
	}
	b.WriteString(`</table>`)
	fmt.Fprintf(&b, `<p style="margin-top:32px;font-size:13px">Date: %s</p>`, html.EscapeString(f["date_of_issue"]))
	fmt.Fprintf(&b, `<p style="text-align:right;margin-top:40px">%s<br><span style="font-size:12px">%s</span></p>`,
		html.EscapeString(firstNonEmpty(f["signatory"], "Principal")),
		html.EscapeString(firstNonEmpty(f["signatory_role"], "Signature with seal")))
	b.WriteString(`</div>`)
	return b.String()
}
