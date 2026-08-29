package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* SUBMITTING A TEMPLATE TO META FOR APPROVAL, FROM HERE.

   Nothing this product sends over WhatsApp can leave until Meta has approved a
   template for it. That approval has always been a separate errand in Meta
   Business Manager: create the template, retype the body, work out where the
   {{1}} go, wait, then come back and map the approved name by hand. Every
   school does it once, most get the parameter order wrong the first time, and
   until it is done every WhatsApp message in the product is refused.

   The Graph API exposes template creation on the WhatsApp Business Account, and
   this product already holds the two things that call needs: the WABA id and a
   system user token, both stored when the school connected its account. So the
   errand can be done from the screen that already lists the templates.

   ---------------------------------------------------------------------------
   THE PART THAT IS EASY TO GET WRONG

   Meta positions parameters NUMERICALLY. A template body carries {{1}}, {{2}},
   and the send supplies an ordered array. This product's templates carry NAMED
   placeholders -- {{student_name}}, {{apply_url}} -- because a named one can be
   read by whoever edits the message.

   So the body is rewritten on the way out, and the order it is rewritten in IS
   the mapping that gets stored. Those two must be produced by the same pass or
   they drift, and a drifted mapping sends the fee amount where the child's name
   should be. That is why buildSubmission returns both.

   ---------------------------------------------------------------------------
   WHAT THIS DOES NOT DO

   It does not approve anything. Meta approves, usually in minutes for a
   Utility template and sometimes never for one it reads as marketing. This
   submits and records what Meta answered, and the screen shows the status Meta
   reports rather than claiming success on a 200 that only means "received".
*/

// waPlaceholder finds this product's named placeholders in a template body.
var waPlaceholder = regexp.MustCompile(`\{\{([a-z_][a-z0-9_]*)\}\}`)

/* Which Meta category a built-in belongs in, and it matters commercially.

   UTILITY is a transactional message about something the parent already has a
   relationship with -- an absence, an invoice, homework. It approves quickly
   and is billed at the lower rate. MARKETING is anything promotional; it is
   scrutinised, often rejected, and costs more.

   Every built-in here is genuinely utility. The admissions link is the only
   arguable one -- it goes to somebody who asked the school about a place, which
   is a service reply to their own enquiry rather than an unsolicited offer. */
var waCategories = map[string]string{
	"attendance.absent":       "UTILITY",
	"fees.overdue":            "UTILITY",
	"homework.set":            "UTILITY",
	"ptm.reminder":            "UTILITY",
	"reportcard.published":    "UTILITY",
	"payroll.payslip":         "UTILITY",
	"student.remark":          "UTILITY",
	"announcement.published":  "UTILITY",
	"messaging.direct":        "UTILITY",
	"messaging.test":          "UTILITY",
	"admissions.enquiry_link": "UTILITY",
}

type waSubmission struct {
	// Name is the template name at Meta: lowercase, underscores. Derived from
	// the code so a school never types it and the two can never disagree.
	Name string
	// Body carries {{1}}, {{2}} in the order Params names them.
	Body string
	// Params is the ordered placeholder mapping, stored alongside the name.
	Params []string
	// Example values, which Meta requires for any template with parameters
	// and rejects the submission without.
	Examples []string
	Category string
}

/*
buildSubmission turns one of this product's templates into Meta's shape.

	The rewrite and the mapping come out of the same pass on purpose: produced
	separately they drift, and a drifted mapping puts the fee amount where the
	child's name belongs.
*/
func buildSubmission(code, body string) waSubmission {
	seen := map[string]int{}
	order := []string{}
	out := waPlaceholder.ReplaceAllStringFunc(body, func(m string) string {
		name := waPlaceholder.FindStringSubmatch(m)[1]
		if n, ok := seen[name]; ok {
			// The same placeholder twice is one parameter used twice, not two.
			return fmt.Sprintf("{{%d}}", n)
		}
		order = append(order, name)
		seen[name] = len(order)
		return fmt.Sprintf("{{%d}}", len(order))
	})

	examples := make([]string, 0, len(order))
	for _, p := range order {
		examples = append(examples, waExample(p))
	}

	cat := waCategories[code]
	if cat == "" {
		cat = "UTILITY"
	}
	return waSubmission{
		// Meta's own shape: lowercase, digits, underscores. A dot is not legal
		// in a template name, and every code here contains one.
		Name:     strings.ReplaceAll(code, ".", "_"),
		Body:     out,
		Params:   order,
		Examples: examples,
		Category: cat,
	}
}

/* An example per placeholder, because Meta refuses a parameterised template
   without one and rejects examples that look like placeholders. A reviewer is
   reading these to judge whether the message is utility or marketing, so they
   are realistic rather than "text". */
func waExample(name string) string {
	switch name {
	case "student_name":
		return "Ananya Reddy"
	case "parent_name":
		return "Sir/Madam"
	case "school_name":
		return "Vivencia High School"
	case "on_date", "due_on":
		return "12 August 2026"
	case "amount_due":
		return "Rs 4,500"
	case "invoice_no":
		return "INV-2026-0142"
	case "apply_url":
		return "https://school.example/admissions/apply/2026"
	case "title":
		return "Holiday on Friday"
	case "body", "message":
		return "The school will remain closed."
	default:
		return "Vivencia High School"
	}
}

type waSubmitResult struct {
	Code     string `json:"code"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Category string `json:"category,omitempty"`
	Error    string `json:"error,omitempty"`
}

/*
submitWhatsAppTemplates creates templates at Meta and records the mapping.

	Submits every built-in that is not already mapped, or the one named in the
	path. Idempotent in the way that matters: a template Meta already has comes
	back as a duplicate error, and that is recorded as already-submitted rather
	than as a failure, because the school's position is the same either way.
*/
func (s *Server) submitWhatsAppTemplates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	only := strings.TrimSpace(chi.URLParam(r, "code"))

	var (
		cfg      whatsappCloudSettings
		token    string
		bodies   = map[string]string{}
		mapped   = map[string]bool{}
		notReady string
	)

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var raw []byte
		var sealed []byte
		if err := tx.QueryRow(r.Context(), `
			SELECT config, COALESCE(credentials,'')
			  FROM integrations
			 WHERE institution_id = $1 AND kind = 'messaging' AND provider = 'whatsapp'`,
			id.InstitutionID).Scan(&raw, &sealed); err != nil {
			if err == pgx.ErrNoRows {
				notReady = "connect the school's WhatsApp Business account first"
				return nil
			}
			return err
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return err
		}
		if strings.TrimSpace(cfg.WABAID) == "" {
			notReady = "this account has no WhatsApp Business Account id, which is what " +
				"a template is created against. Add it on the WhatsApp settings screen"
			return nil
		}
		if len(sealed) == 0 {
			notReady = "no access token is stored for this account"
			return nil
		}
		var oerr error
		if token, oerr = openSecret(sealed); oerr != nil {
			return oerr
		}

		// Which codes already carry an approved name: those are not resubmitted.
		rows, qerr := tx.Query(r.Context(), `
			SELECT code, COALESCE(wa_template_name,'')
			  FROM message_templates
			 WHERE institution_id = $1 AND channel = 'whatsapp'`, id.InstitutionID)
		if qerr != nil {
			return qerr
		}
		for rows.Next() {
			var code, name string
			if serr := rows.Scan(&code, &name); serr != nil {
				rows.Close()
				return serr
			}
			if strings.TrimSpace(name) != "" {
				mapped[code] = true
			}
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}

		for code, t := range builtinTemplates {
			bodies[code] = t.Body
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if notReady != "" {
		httpx.Error(w, r, http.StatusConflict, "whatsapp_not_ready", notReady)
		return
	}

	lang := strings.TrimSpace(cfg.DefaultLanguage)
	if lang == "" {
		lang = "en"
	}
	version := strings.TrimSpace(cfg.APIVersion)
	if version == "" {
		version = waDefaultAPIVersion
	}

	results := []waSubmitResult{}
	for code, body := range bodies {
		if only != "" && code != only {
			continue
		}
		if only == "" && mapped[code] {
			continue
		}
		sub := buildSubmission(code, body)
		status, metaErr := s.createMetaTemplate(r.Context(), version, cfg.WABAID, token, lang, sub)
		res := waSubmitResult{Code: code, Name: sub.Name, Status: status, Category: sub.Category}
		if metaErr != nil {
			res.Error = metaErr.Error()
			results = append(results, res)
			continue
		}
		/* Recorded immediately, before Meta has approved. The name and the
		   parameter order are decided by the submission, not by the approval,
		   and a school that closes the tab must not lose the mapping for a
		   template Meta approves ten minutes later. A send against a template
		   still in review is refused by Meta with a clear error; a send with
		   no mapping at all is refused by this product with a vaguer one. */
		if uerr := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			/* UPSERT, not UPDATE. A built-in template has no row in
			   message_templates until a school customises it -- the list
			   screen merges the built-ins with whatever rows exist -- so an
			   UPDATE matched nothing and reported success. Measured: eleven
			   templates submitted to Meta, eleven mappings silently discarded,
			   and the screen still showing none mapped.

			   The body written here is the built-in's own, so a row created by
			   this path renders exactly as it did when there was no row. */
			_, e := tx.Exec(r.Context(), `
				INSERT INTO message_templates
				       (institution_id, code, channel, subject, body,
				        wa_template_name, wa_language, wa_params, is_active)
				VALUES ($1,$2,'whatsapp',$6,$7,$3,$4,$5,true)
				ON CONFLICT (institution_id, code, channel)
				DO UPDATE SET wa_template_name = EXCLUDED.wa_template_name,
				              wa_language      = EXCLUDED.wa_language,
				              wa_params        = EXCLUDED.wa_params`,
				id.InstitutionID, code, sub.Name, lang, sub.Params,
				builtinTemplates[code].Subject, body)
			return e
		}); uerr != nil {
			res.Error = "submitted to Meta but the mapping could not be saved: " + uerr.Error()
		}
		results = append(results, res)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"items": results})
}

/*
createMetaTemplate calls the Graph API and returns the status Meta reports.

	A 200 means received, not approved. Meta answers with a status of PENDING,
	APPROVED or REJECTED, and this returns whichever it said rather than
	deciding for itself -- a screen that says "approved" because the HTTP call
	succeeded is a screen that will be contradicted by the first send.
*/
func (s *Server) createMetaTemplate(
	ctx context.Context, version, wabaID, token, lang string, sub waSubmission,
) (string, error) {
	component := map[string]any{"type": "BODY", "text": sub.Body}
	if len(sub.Examples) > 0 {
		// Meta wants example values as an array of arrays: one row of values
		// per body variation, and this product only ever submits one.
		component["example"] = map[string]any{"body_text": [][]string{sub.Examples}}
	}
	payload := map[string]any{
		"name":       sub.Name,
		"language":   lang,
		"category":   sub.Category,
		"components": []map[string]any{component},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	url := "https://graph.facebook.com/" + version + "/" + wabaID + "/message_templates"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach graph.facebook.com: %w", err)
	}
	defer res.Body.Close() //nolint:errcheck
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 8192))

	if res.StatusCode >= 300 {
		/* A template Meta already has comes back as an error, and it is not
		   one: the school's position after it is exactly what it wanted, which
		   is that the template exists. Reported as already-submitted so a
		   second press of the button does not read as a failure. */
		if bytes.Contains(answer, []byte("already exists")) ||
			bytes.Contains(answer, []byte("duplicate")) {
			return "ALREADY_SUBMITTED", nil
		}
		return "", explainMetaError(res.StatusCode, answer)
	}

	var ok struct {
		Status   string `json:"status"`
		Category string `json:"category"`
	}
	if jerr := json.Unmarshal(answer, &ok); jerr != nil || strings.TrimSpace(ok.Status) == "" {
		// Received, and Meta did not say what it thinks. PENDING is the honest
		// reading: it is in review until something says otherwise.
		return "PENDING", nil
	}
	return ok.Status, nil
}
