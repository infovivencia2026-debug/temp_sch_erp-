package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Admissions growth: the form the school designs, the nurture it sends, and
   the reason a family walked away.

   Three features that look unrelated and share one spine — the enquiry. A
   family arrives as a lead, is nurtured, fills in a form the school wrote, and
   either becomes a student or becomes a number in the lost-reason report. The
   admissions funnel in admissions_funnel.go already owns the middle of that
   journey; this file owns the two ends and the reason for the ending.

   Three decisions are load-bearing and are stated here because no single
   handler shows them:

     1. A published form is immutable. Not "discouraged from being edited" —
        the handlers refuse. A school edits by taking a draft, which becomes
        version n+1, and applications keep the version they were answered
        under. Without this, adding a required field on Tuesday silently
        invalidates Monday's four hundred submissions and re-renders them with
        a blank box nobody was ever shown.

     2. Validation is the server's. The public form endpoint re-derives every
        rule from the stored definition and never trusts a field id, a
        required flag, or a visibility decision that arrived in the request
        body. A field id that does not belong to the version being submitted is
        rejected outright rather than merely ignored — ignoring it would let a
        submission write an answer against another school's form.

     3. Nothing here sends a message. Campaign touches go through QueueMessage
        in messaging.go, which owns the provider set, the template fallback and
        the one-per-occurrence index. A second sender was exactly what
        migration 00044 was written to prevent.

   One honest constraint, stated rather than hidden: nothing in this deployment
   flushes the message queue on a schedule yet. runCampaigns is written to be
   called by whatever does — it is idempotent, it may be called twice, and it
   is also reachable from the screen so a school can see it work today. It is
   not a cron and does not start one. */

// --- the vocabulary a school may extend --------------------------------------

/*
Why a lead was lost.

	Registered from here rather than added to the literal in custom_options.go,
	so this worker's branch does not collide with anyone editing that map. The
	built-in five are the reasons an Indian school actually hears at the gate;
	the point of registering the kind at all is that the sixth reason — the one
	nobody thought of — is a row the school adds, not a migration.
*/
func init() {
	customisableKinds["lost_reason"] = lostReasons
	kindLabels["lost_reason"] = "Reasons a lead was lost"
}

var lostReasons = []option{
	{"fees", "Fees too high"},
	{"distance", "Distance from home"},
	{"seat_unavailable", "No seat available"},
	{"chose_another_school", "Chose another school"},
	{"no_response", "No response from parent"},
}

// --- mount --------------------------------------------------------------------

/*
mountAdmissionsGrowth registers the staff-facing half of all three features.

	Mounted inside the existing /admissions group in api.go, which already
	carries RequirePermission(admissions.read). Everything that changes a form,
	a campaign or a lead's fate additionally carries admissions.write, matching
	the rest of that group — a counsellor who may read the funnel does not
	thereby get to publish the application form the whole city fills in.

	No new permission is invented. admissions.read and admissions.write already
	describe exactly this authority.
*/
func (s *Server) mountAdmissionsGrowth(r chi.Router) {
	write := httpx.RequirePermission(rbac.AdmissionsWrite)

	// --- the form builder ---------------------------------------------
	r.Get("/forms", s.listAdmissionForms)
	r.With(write).Post("/forms", s.createAdmissionForm)
	r.With(write).Post("/forms/{id}", s.updateAdmissionForm)
	r.Get("/forms/{id}/versions", s.listAdmissionFormVersions)
	// Taking a draft from the published version is how a school edits a live
	// form. It is a write because it creates a version.
	r.With(write).Post("/forms/{id}/draft", s.draftAdmissionForm)

	r.Get("/form-versions/{id}", s.getAdmissionFormVersion)
	r.With(write).Post("/form-versions/{id}/publish", s.publishAdmissionFormVersion)
	r.With(write).Post("/form-versions/{id}/sections", s.saveAdmissionFormSection)
	r.With(write).Delete("/form-sections/{id}", s.deleteAdmissionFormSection)
	r.With(write).Post("/form-versions/{id}/fields", s.saveAdmissionFormField)
	r.With(write).Delete("/form-fields/{id}", s.deleteAdmissionFormField)

	// What one applicant answered, laid out with the definition they saw.
	r.Get("/applications/{id}/answers", s.getApplicationAnswers)

	// --- multi-touch campaign sequences -------------------------------
	r.Get("/campaigns", s.listAdmissionCampaigns)
	r.With(write).Post("/campaigns", s.saveAdmissionCampaign)
	r.Get("/campaigns/{id}/steps", s.listCampaignSteps)
	r.With(write).Post("/campaigns/{id}/steps", s.saveCampaignStep)
	r.With(write).Delete("/campaign-steps/{id}", s.deleteCampaignStep)
	r.Get("/campaigns/{id}/enrolments", s.listCampaignEnrolments)
	r.With(write).Post("/campaigns/{id}/enrol", s.enrolLeadsOnCampaign)
	r.With(write).Post("/campaign-enrolments/{id}/stop", s.stopCampaignEnrolment)
	r.Get("/campaigns/outbox", s.listCampaignOutbox)
	// The runner. Idempotent, safe to call twice, and the thing a scheduler
	// will call once one exists.
	r.With(write).Post("/campaigns/run", s.runCampaignsHandler)

	// --- lost lead reason analysis ------------------------------------
	r.With(write).Post("/leads/{id}/lost", s.markLeadLost)
	r.With(write).Post("/leads/{id}/reopen", s.reopenLead)
	r.With(write).Post("/leads/{id}/opt-out", s.optLeadOut)
	r.Get("/lost-leads", s.listLostLeads)
	r.Get("/lost-leads/analysis", s.getLostLeadAnalysis)
	r.Get("/lost-leads/reasons", s.listLostReasonOptions)
}

/*
mountAdmissionsPublic registers the applicant-facing surface.

	Separate from mountAdmissionsGrowth because it must be spliced OUTSIDE the
	RequireAuth group in api.go — beside r.Get("/session", …). A family filling
	in an admission form has no account, and requiring one is the difference
	between an online application form and a data-entry screen for the office.

	Everything about these two handlers assumes hostility:

	  - The school is identified by the form's slug, so a submission can only
	    ever reach the institution that published that slug. The transaction
	    runs InTenant against that institution, so RLS is doing its usual work
	    rather than being stepped around.
	  - Submission is rate-limited per address, in process. Not a distributed
	    limiter — there is no shared limiter in this codebase and inventing one
	    here would be a second thing to operate. It stops the obvious flood; it
	    is not claimed to stop a determined one, and applications carry
	    submitted_from so the office can see a burst.
	  - Nothing is ever read back. There is no GET for a submitted application
	    on this surface, so the slug being guessable leaks nothing.
*/
func (s *Server) mountAdmissionsPublic(r chi.Router) {
	r.Get("/public/admissions/forms/{slug}", s.getPublicAdmissionForm)
	r.Post("/public/admissions/forms/{slug}", s.submitPublicAdmissionForm)
}

// ==============================================================================
// 1. The online application form builder
// ==============================================================================

type admissionFormRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	Slug        string  `json:"slug"`
	IsOpen      bool    `json:"is_open"`
	OpensOn     *string `json:"opens_on,omitempty"`
	ClosesOn    *string `json:"closes_on,omitempty"`
	// The two questions a list of forms is asked: is there a live definition,
	// and is somebody mid-edit.
	LiveVersion  *int `json:"live_version,omitempty"`
	DraftVersion *int `json:"draft_version,omitempty"`
	Submissions  int  `json:"submissions"`
}

func (s *Server) listAdmissionForms(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT f.id::text, f.name, f.description, f.slug, f.is_open,
		       to_char(f.opens_on,'YYYY-MM-DD'), to_char(f.closes_on,'YYYY-MM-DD'),
		       (SELECT v.version FROM admission_form_versions v
		         WHERE v.form_id = f.id AND v.status = 'published'),
		       (SELECT v.version FROM admission_form_versions v
		         WHERE v.form_id = f.id AND v.status = 'draft'),
		       (SELECT count(*)::int FROM applications a
		          JOIN admission_form_versions v ON v.id = a.form_version_id
		         WHERE v.form_id = f.id)
		  FROM admission_forms f
		 ORDER BY f.is_open DESC, lower(f.name)`, nil,
		func(rows pgx.Rows) (admissionFormRow, error) {
			var v admissionFormRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Description, &v.Slug, &v.IsOpen,
				&v.OpensOn, &v.ClosesOn, &v.LiveVersion, &v.DraftVersion, &v.Submissions)
		})
	respond(w, r, items, err)
}

type admissionFormRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Slug        string `json:"slug,omitempty"`
	CampusID    string `json:"campus_id,omitempty"`
	SessionID   string `json:"admission_session_id,omitempty"`
	IsOpen      bool   `json:"is_open"`
	OpensOn     string `json:"opens_on,omitempty"`
	ClosesOn    string `json:"closes_on,omitempty"`
}

/*
createAdmissionForm starts a form and its first draft in one transaction.

	A form with no version is a row that renders as nothing and reads as a bug,
	so the draft is created here rather than left for a second call the client
	might not make.
*/
func (s *Server) createAdmissionForm(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req admissionFormRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the form needs a name")
		return
	}
	slug := strings.TrimSpace(strings.ToLower(req.Slug))
	if slug == "" {
		slug = formSlug(req.Name)
	}
	if !validFormSlug(slug) {
		httpx.BadRequest(w, r,
			"the web address must be 3-64 characters of lowercase letters, digits and hyphens")
		return
	}
	campus, err := optionalUUID(req.CampusID)
	if err != nil {
		httpx.BadRequest(w, r, "campus_id must be a uuid")
		return
	}
	session, err := optionalUUID(req.SessionID)
	if err != nil {
		httpx.BadRequest(w, r, "admission_session_id must be a uuid")
		return
	}
	opens, err := optionalDate(req.OpensOn)
	if err != nil {
		httpx.BadRequest(w, r, "opens_on must be YYYY-MM-DD")
		return
	}
	closes, err := optionalDate(req.ClosesOn)
	if err != nil {
		httpx.BadRequest(w, r, "closes_on must be YYYY-MM-DD")
		return
	}

	var formID, versionID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO admission_forms (institution_id, campus_id, admission_session_id,
			                             name, description, slug, is_open,
			                             opens_on, closes_on, created_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8::date,$9::date,$10)
			RETURNING id::text`,
			id.InstitutionID, campus, session, req.Name, req.Description, slug,
			req.IsOpen, opens, closes, nullUUIDArg(id.UserID)).Scan(&formID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_form_versions (institution_id, form_id, version, status)
			VALUES ($1,$2,1,'draft') RETURNING id::text`,
			id.InstitutionID, formID).Scan(&versionID)
	})
	switch {
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate",
			"a form with that name or that web address already exists")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": formID, "slug": slug, "draft_version_id": versionID,
		})
	}
}

// updateAdmissionForm changes the wrapper, never the definition. Opening and
// closing a form is a property of the form, not of a version, so it stays
// editable while the definition beneath it is frozen.
func (s *Server) updateAdmissionForm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	formID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req admissionFormRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the form needs a name")
		return
	}
	opens, err := optionalDate(req.OpensOn)
	if err != nil {
		httpx.BadRequest(w, r, "opens_on must be YYYY-MM-DD")
		return
	}
	closes, err := optionalDate(req.ClosesOn)
	if err != nil {
		httpx.BadRequest(w, r, "closes_on must be YYYY-MM-DD")
		return
	}

	// Opening a form with no published definition would put a 404 on a poster.
	var live int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM admission_form_versions
			 WHERE form_id = $1 AND status = 'published'`, formID).Scan(&live); err != nil {
			return err
		}
		if req.IsOpen && live == 0 {
			return errFormNotPublished
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE admission_forms
			   SET name = $2, description = NULLIF($3,''), is_open = $4,
			       opens_on = $5::date, closes_on = $6::date
			 WHERE id = $1`,
			formID, req.Name, req.Description, req.IsOpen, opens, closes)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	switch {
	case errors.Is(err, errFormNotPublished):
		httpx.Error(w, r, http.StatusConflict, "not_published",
			"publish a version before opening the form. An open form with no definition is a broken link on a poster")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate", "another form already has that name")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": formID.String()})
	}
}

var (
	errFormNotPublished = errors.New("form has no published version")
	errVersionFrozen    = errors.New("a published version cannot be edited")
	errNoDraft          = errors.New("no draft to publish")
)

type formVersionRow struct {
	ID          string  `json:"id"`
	Version     int     `json:"version"`
	Status      string  `json:"status"`
	Notes       *string `json:"notes,omitempty"`
	PublishedAt *string `json:"published_at,omitempty"`
	Fields      int     `json:"fields"`
	// How many applications were answered under this version. The number that
	// makes the immutability rule concrete on screen.
	Applications int `json:"applications"`
}

func (s *Server) listAdmissionFormVersions(w http.ResponseWriter, r *http.Request) {
	formID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT v.id::text, v.version, v.status, v.notes,
		       to_char(v.published_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI'),
		       (SELECT count(*)::int FROM admission_form_fields f WHERE f.version_id = v.id),
		       (SELECT count(*)::int FROM applications a WHERE a.form_version_id = v.id)
		  FROM admission_form_versions v
		 WHERE v.form_id = $1
		 ORDER BY v.version DESC`, []any{formID},
		func(rows pgx.Rows) (formVersionRow, error) {
			var v formVersionRow
			return v, rows.Scan(&v.ID, &v.Version, &v.Status, &v.Notes, &v.PublishedAt,
				&v.Fields, &v.Applications)
		})
	respond(w, r, items, err)
}

type formFieldRow struct {
	ID          string          `json:"id"`
	SectionID   string          `json:"section_id"`
	Code        string          `json:"code"`
	Label       string          `json:"label"`
	FieldType   string          `json:"field_type"`
	HelpText    *string         `json:"help_text,omitempty"`
	Placeholder *string         `json:"placeholder,omitempty"`
	IsRequired  bool            `json:"is_required"`
	Sequence    int             `json:"sequence"`
	Options     []option        `json:"options"`
	OptionKind  *string         `json:"option_kind,omitempty"`
	MinLength   *int            `json:"min_length,omitempty"`
	MaxLength   *int            `json:"max_length,omitempty"`
	MinNumber   *float64        `json:"min_number,omitempty"`
	MaxNumber   *float64        `json:"max_number,omitempty"`
	Pattern     *string         `json:"pattern,omitempty"`
	VisibleWhen *visibilityRule `json:"visible_when,omitempty"`
	// True where the code writes through to a column on the application row
	// itself. The builder shows it so a school understands why deleting
	// 'parent_phone' is not the same as deleting 'mother_occupation'.
	Reserved bool `json:"reserved"`
}

type formSectionRow struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Description *string        `json:"description,omitempty"`
	Sequence    int            `json:"sequence"`
	Fields      []formFieldRow `json:"fields"`
}

type formDefinition struct {
	VersionID string           `json:"version_id"`
	FormID    string           `json:"form_id"`
	FormName  string           `json:"form_name"`
	Slug      string           `json:"slug"`
	Version   int              `json:"version"`
	Status    string           `json:"status"`
	Editable  bool             `json:"editable"`
	Sections  []formSectionRow `json:"sections"`
	// The classes a form may be applied for, so the applicant's dropdown is
	// real ids rather than free text that never matches a class.
	Classes []option `json:"classes"`
}

// visibilityRule is "show this only when that answer says so". One condition,
// not an expression tree: a school building a conditional form wants "if
// sibling, ask which one", and a rule language would be a second thing to
// validate on an unauthenticated surface.
type visibilityRule struct {
	Field  string `json:"field"`
	Equals string `json:"equals"`
}

func (s *Server) getAdmissionFormVersion(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var def formDefinition
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		def, err = loadFormDefinition(r.Context(), tx, versionID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, def)
	}
}

// loadFormDefinition reads one whole version: the wrapper, its sections, its
// fields and the class list. One function because the public renderer, the
// builder and the submission validator must never disagree about what a
// version says — three readers of the same rows is how a browser and a server
// end up enforcing different forms.
func loadFormDefinition(ctx context.Context, tx pgx.Tx, versionID uuid.UUID) (formDefinition, error) {
	var def formDefinition
	if err := tx.QueryRow(ctx, `
		SELECT v.id::text, v.form_id::text, f.name, f.slug, v.version, v.status
		  FROM admission_form_versions v
		  JOIN admission_forms f ON f.id = v.form_id
		 WHERE v.id = $1`, versionID).
		Scan(&def.VersionID, &def.FormID, &def.FormName, &def.Slug, &def.Version, &def.Status); err != nil {
		return def, err
	}
	def.Editable = def.Status == "draft"

	sections := map[string]int{}
	rows, err := tx.Query(ctx, `
		SELECT id::text, title, description, sequence
		  FROM admission_form_sections
		 WHERE version_id = $1
		 ORDER BY sequence, lower(title)`, versionID)
	if err != nil {
		return def, err
	}
	for rows.Next() {
		var sec formSectionRow
		if err := rows.Scan(&sec.ID, &sec.Title, &sec.Description, &sec.Sequence); err != nil {
			rows.Close()
			return def, err
		}
		sec.Fields = []formFieldRow{}
		sections[sec.ID] = len(def.Sections)
		def.Sections = append(def.Sections, sec)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return def, err
	}
	if def.Sections == nil {
		def.Sections = []formSectionRow{}
	}

	frows, err := tx.Query(ctx, `
		SELECT id::text, section_id::text, code, label, field_type, help_text,
		       placeholder, is_required, sequence, options, option_kind,
		       min_length, max_length, min_number, max_number, pattern, visible_when
		  FROM admission_form_fields
		 WHERE version_id = $1
		 ORDER BY sequence, lower(label)`, versionID)
	if err != nil {
		return def, err
	}
	defer frows.Close()
	for frows.Next() {
		var f formFieldRow
		var optsRaw, visRaw []byte
		if err := frows.Scan(&f.ID, &f.SectionID, &f.Code, &f.Label, &f.FieldType,
			&f.HelpText, &f.Placeholder, &f.IsRequired, &f.Sequence, &optsRaw,
			&f.OptionKind, &f.MinLength, &f.MaxLength, &f.MinNumber, &f.MaxNumber,
			&f.Pattern, &visRaw); err != nil {
			return def, err
		}
		f.Options = []option{}
		if len(optsRaw) > 0 {
			_ = json.Unmarshal(optsRaw, &f.Options)
		}
		var vis visibilityRule
		if len(visRaw) > 0 {
			_ = json.Unmarshal(visRaw, &vis)
		}
		if vis.Field != "" {
			f.VisibleWhen = &vis
		}
		_, f.Reserved = reservedFields[f.Code]
		if i, ok := sections[f.SectionID]; ok {
			def.Sections[i].Fields = append(def.Sections[i].Fields, f)
		}
	}
	if err := frows.Err(); err != nil {
		return def, err
	}

	def.Classes, err = classOptions(ctx, tx)
	return def, err
}

func classOptions(ctx context.Context, tx pgx.Tx) ([]option, error) {
	out := []option{}
	rows, err := tx.Query(ctx, `SELECT id::text, name FROM classes ORDER BY level, name`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var o option
		if err := rows.Scan(&o.Value, &o.Label); err != nil {
			return out, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

/*
reservedFields are the codes that write through to the applications row.

	A form the school designs has to produce a real application, not a bag of
	key-value pairs sitting beside an empty one. So a handful of codes are
	spoken for: answer them and the column is filled, and the answer is also
	kept so the rendered form still shows what the family typed.

	The value is the column. class_sought is special-cased in the writer
	because it is a uuid the applicant picks from a list, and gender and
	category are special-cased because the applications table constrains them.
*/
var reservedFields = map[string]string{
	"first_name":      "first_name",
	"middle_name":     "middle_name",
	"last_name":       "last_name",
	"date_of_birth":   "date_of_birth",
	"gender":          "gender",
	"category":        "category",
	"class_sought":    "class_sought",
	"parent_name":     "parent_name",
	"parent_phone":    "parent_phone",
	"parent_email":    "parent_email",
	"address":         "address",
	"previous_school": "previous_school",
}

// requiredReserved are the four the applications table will not accept a row
// without. A version missing any of them cannot be published: it would build a
// form that collects answers and then fails at the last step, in front of the
// applicant.
var requiredReserved = []string{"first_name", "parent_name", "parent_phone", "class_sought"}

// --- editing a draft ----------------------------------------------------------

/*
draftAdmissionForm opens the next version for editing.

	Copies the published definition rather than starting blank. A school
	changing one help text should not have to retype forty fields, and a
	"start from scratch" that is the only option is how a live form gets
	edited in place instead — which is the thing this whole design refuses.
*/
func (s *Server) draftAdmissionForm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	formID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var draftID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Already mid-edit: hand back the same draft rather than refusing.
		if err := tx.QueryRow(r.Context(), `
			SELECT id::text FROM admission_form_versions
			 WHERE form_id = $1 AND status = 'draft'`, formID).Scan(&draftID); err == nil {
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		var sourceID *uuid.UUID
		var next int
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT id FROM admission_form_versions
			         WHERE form_id = $1 AND status = 'published'),
			       COALESCE(max(version), 0) + 1
			  FROM admission_form_versions WHERE form_id = $1`, formID).
			Scan(&sourceID, &next); err != nil {
			return err
		}
		var inst uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM admission_forms WHERE id = $1`, formID).Scan(&inst); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO admission_form_versions (institution_id, form_id, version, status)
			VALUES ($1,$2,$3,'draft') RETURNING id::text`, inst, formID, next).Scan(&draftID); err != nil {
			return err
		}
		if sourceID == nil {
			return nil
		}
		// Sections first, then fields keyed through the section they came
		// from. A join on the old section id is what keeps a field under the
		// same heading in the copy.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO admission_form_sections
			    (institution_id, version_id, title, description, sequence)
			SELECT institution_id, $2, title, description, sequence
			  FROM admission_form_sections WHERE version_id = $1`, *sourceID, draftID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO admission_form_fields
			    (institution_id, version_id, section_id, code, label, field_type,
			     help_text, placeholder, is_required, sequence, options, option_kind,
			     min_length, max_length, min_number, max_number, pattern, visible_when)
			SELECT f.institution_id, $2, ns.id, f.code, f.label, f.field_type,
			       f.help_text, f.placeholder, f.is_required, f.sequence, f.options,
			       f.option_kind, f.min_length, f.max_length, f.min_number, f.max_number,
			       f.pattern, f.visible_when
			  FROM admission_form_fields f
			  JOIN admission_form_sections os ON os.id = f.section_id
			  JOIN admission_form_sections ns
			    ON ns.version_id = $2 AND lower(ns.title) = lower(os.title)
			 WHERE f.version_id = $1`, *sourceID, draftID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"draft_version_id": draftID})
	}
}

// requireDraft is the immutability rule, in one place. Every edit goes through
// it, so there is no handler that can be written to forget it.
func requireDraft(ctx context.Context, tx pgx.Tx, versionID uuid.UUID) error {
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM admission_form_versions WHERE id = $1`, versionID).Scan(&status); err != nil {
		return err
	}
	if status != "draft" {
		return errVersionFrozen
	}
	return nil
}

func respondVersionEdit(w http.ResponseWriter, r *http.Request, err error, body map[string]any) {
	switch {
	case errors.Is(err, errVersionFrozen):
		httpx.Error(w, r, http.StatusConflict, "version_published",
			"this version is live and cannot be edited. Take a draft from it. Applications already submitted must keep rendering as they were answered.")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate",
			"that name or code is already used on this version")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, body)
	}
}

type formSectionRequest struct {
	ID          string `json:"id,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Sequence    int    `json:"sequence"`
}

func (s *Server) saveAdmissionFormSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req formSectionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "the section needs a heading")
		return
	}
	secID, err := optionalUUID(req.ID)
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := requireDraft(r.Context(), tx, versionID); err != nil {
			return err
		}
		if secID != nil {
			// version_id in the predicate, not only the id: a section id from
			// another version must not be steerable into this one.
			return tx.QueryRow(r.Context(), `
				UPDATE admission_form_sections
				   SET title = $3, description = NULLIF($4,''), sequence = $5
				 WHERE id = $1 AND version_id = $2
				 RETURNING id::text`,
				*secID, versionID, req.Title, req.Description, req.Sequence).Scan(&out)
		}
		var inst uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM admission_form_versions WHERE id = $1`, versionID).
			Scan(&inst); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_form_sections
			    (institution_id, version_id, title, description, sequence)
			VALUES ($1,$2,$3,NULLIF($4,''),$5) RETURNING id::text`,
			inst, versionID, req.Title, req.Description, req.Sequence).Scan(&out)
	})
	respondVersionEdit(w, r, err, map[string]any{"id": out})
}

func (s *Server) deleteAdmissionFormSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	secID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var versionID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT version_id FROM admission_form_sections WHERE id = $1`, secID).
			Scan(&versionID); err != nil {
			return err
		}
		if err := requireDraft(r.Context(), tx, versionID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM admission_form_sections WHERE id = $1`, secID)
		return err
	})
	respondVersionEdit(w, r, err, map[string]any{"id": secID.String(), "deleted": true})
}

type formFieldRequest struct {
	ID          string          `json:"id,omitempty"`
	SectionID   string          `json:"section_id"`
	Code        string          `json:"code"`
	Label       string          `json:"label"`
	FieldType   string          `json:"field_type"`
	HelpText    string          `json:"help_text,omitempty"`
	Placeholder string          `json:"placeholder,omitempty"`
	IsRequired  bool            `json:"is_required"`
	Sequence    int             `json:"sequence"`
	Options     []option        `json:"options,omitempty"`
	OptionKind  string          `json:"option_kind,omitempty"`
	MinLength   *int            `json:"min_length,omitempty"`
	MaxLength   *int            `json:"max_length,omitempty"`
	MinNumber   *float64        `json:"min_number,omitempty"`
	MaxNumber   *float64        `json:"max_number,omitempty"`
	Pattern     string          `json:"pattern,omitempty"`
	VisibleWhen *visibilityRule `json:"visible_when,omitempty"`
}

var fieldTypes = []string{"text", "textarea", "number", "date", "select", "checkbox", "file", "email", "phone"}

func (s *Server) saveAdmissionFormField(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req formFieldRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(strings.ToLower(req.Code))
	req.Label = strings.TrimSpace(req.Label)
	req.FieldType = strings.TrimSpace(req.FieldType)
	if req.Code == "" {
		req.Code = optionValue(req.Label)
	}
	if req.Label == "" {
		httpx.BadRequest(w, r, "the field needs a label")
		return
	}
	if !validFieldCode(req.Code) {
		httpx.BadRequest(w, r,
			"the field code must start with a letter and hold only lowercase letters, digits and underscores")
		return
	}
	if !oneOfStr(req.FieldType, fieldTypes...) {
		httpx.BadRequest(w, r, "field_type must be one of "+strings.Join(fieldTypes, ", "))
		return
	}
	// A select with nothing to select from is a field that cannot be answered
	// and, if required, a form that cannot be submitted.
	if req.FieldType == "select" && len(req.Options) == 0 && req.OptionKind == "" &&
		req.Code != "class_sought" {
		httpx.BadRequest(w, r,
			"a dropdown needs either its own options or the name of a school list to draw them from")
		return
	}
	if req.OptionKind != "" {
		if _, known := customisableKinds[req.OptionKind]; !known {
			httpx.BadRequest(w, r, "unknown school list: "+req.OptionKind)
			return
		}
	}
	if req.VisibleWhen != nil && req.VisibleWhen.Field == req.Code {
		httpx.BadRequest(w, r, "a field cannot be conditional on its own answer")
		return
	}
	sectionID, err := uuid.Parse(strings.TrimSpace(req.SectionID))
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	fieldID, err := optionalUUID(req.ID)
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	opts, _ := json.Marshal(req.Options)
	if req.Options == nil {
		opts = []byte("[]")
	}
	vis := []byte("{}")
	if req.VisibleWhen != nil && strings.TrimSpace(req.VisibleWhen.Field) != "" {
		vis, _ = json.Marshal(req.VisibleWhen)
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := requireDraft(r.Context(), tx, versionID); err != nil {
			return err
		}
		// The section must belong to this version. Without the check a field
		// could be parked under another form's heading and would then be
		// invisible to the renderer that walks sections.
		var n int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM admission_form_sections
			 WHERE id = $1 AND version_id = $2`, sectionID, versionID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return errors.New("that section does not belong to this version of the form")
		}
		if req.VisibleWhen != nil {
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int FROM admission_form_fields
				 WHERE version_id = $1 AND code = $2`, versionID, req.VisibleWhen.Field).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return errors.New("visible_when names a field this version does not have: " + req.VisibleWhen.Field)
			}
		}
		if fieldID != nil {
			return tx.QueryRow(r.Context(), `
				UPDATE admission_form_fields
				   SET section_id = $3, code = $4, label = $5, field_type = $6,
				       help_text = NULLIF($7,''), placeholder = NULLIF($8,''),
				       is_required = $9, sequence = $10, options = $11::jsonb,
				       option_kind = NULLIF($12,''), min_length = $13, max_length = $14,
				       min_number = $15, max_number = $16, pattern = NULLIF($17,''),
				       visible_when = $18::jsonb
				 WHERE id = $1 AND version_id = $2
				 RETURNING id::text`,
				*fieldID, versionID, sectionID, req.Code, req.Label, req.FieldType,
				req.HelpText, req.Placeholder, req.IsRequired, req.Sequence, string(opts),
				req.OptionKind, req.MinLength, req.MaxLength, req.MinNumber, req.MaxNumber,
				req.Pattern, string(vis)).Scan(&out)
		}
		var inst uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM admission_form_versions WHERE id = $1`, versionID).
			Scan(&inst); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_form_fields
			    (institution_id, version_id, section_id, code, label, field_type,
			     help_text, placeholder, is_required, sequence, options, option_kind,
			     min_length, max_length, min_number, max_number, pattern, visible_when)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),$9,$10,$11::jsonb,
			        NULLIF($12,''),$13,$14,$15,$16,NULLIF($17,''),$18::jsonb)
			RETURNING id::text`,
			inst, versionID, sectionID, req.Code, req.Label, req.FieldType,
			req.HelpText, req.Placeholder, req.IsRequired, req.Sequence, string(opts),
			req.OptionKind, req.MinLength, req.MaxLength, req.MinNumber, req.MaxNumber,
			req.Pattern, string(vis)).Scan(&out)
	})
	respondVersionEdit(w, r, err, map[string]any{"id": out})
}

func (s *Server) deleteAdmissionFormField(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fieldID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var versionID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT version_id FROM admission_form_fields WHERE id = $1`, fieldID).
			Scan(&versionID); err != nil {
			return err
		}
		if err := requireDraft(r.Context(), tx, versionID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM admission_form_fields WHERE id = $1`, fieldID)
		return err
	})
	respondVersionEdit(w, r, err, map[string]any{"id": fieldID.String(), "deleted": true})
}

/*
publishAdmissionFormVersion freezes a draft and retires the version it replaces.

	Checked before, not after. A form published without class_sought collects
	four hundred answers and then fails on the insert, in front of an applicant
	who has just spent ten minutes on it — so the four columns the applications
	table will not do without are required to be present here, where the person
	who can fix it is the one reading the message.
*/
func (s *Server) publishAdmissionFormVersion(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var version int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var formID uuid.UUID
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT form_id, status, version FROM admission_form_versions WHERE id = $1`, versionID).
			Scan(&formID, &status, &version); err != nil {
			return err
		}
		if status != "draft" {
			return errNoDraft
		}
		def, err := loadFormDefinition(r.Context(), tx, versionID)
		if err != nil {
			return err
		}
		present := map[string]bool{}
		total := 0
		for _, sec := range def.Sections {
			for _, f := range sec.Fields {
				present[f.Code] = true
				total++
			}
		}
		if total == 0 {
			return errors.New("this version has no fields. Publishing it would put an empty form on a poster")
		}
		var missing []string
		for _, code := range requiredReserved {
			if !present[code] {
				missing = append(missing, code)
			}
		}
		if len(missing) > 0 {
			return fmt.Errorf(
				"an application cannot be created without %s. Add %s as field codes before publishing",
				strings.Join(missing, ", "), strings.Join(missing, " and "))
		}
		// Retire first: the one-live partial unique index would otherwise
		// refuse the publish, and the refusal would read as a bug.
		if _, err := tx.Exec(r.Context(), `
			UPDATE admission_form_versions SET status = 'retired'
			 WHERE form_id = $1 AND status = 'published'`, formID); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE admission_form_versions
			   SET status = 'published', published_at = now(), published_by = $2
			 WHERE id = $1`, versionID, nullUUIDArg(id.UserID))
		return err
	})
	switch {
	case errors.Is(err, errNoDraft):
		httpx.Error(w, r, http.StatusConflict, "not_a_draft",
			"only a draft can be published")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"id": versionID.String(), "version": version, "status": "published",
		})
	}
}

// --- what one applicant answered ---------------------------------------------

type answerRow struct {
	Section string  `json:"section"`
	Code    string  `json:"code"`
	Label   string  `json:"label"`
	Type    string  `json:"field_type"`
	Value   string  `json:"value"`
	FileID  *string `json:"file_id,omitempty"`
	URL     *string `json:"external_url,omitempty"`
}

// getApplicationAnswers renders a submission against the definition it was
// answered under — the point of versioning, made visible.
func (s *Server) getApplicationAnswers(w http.ResponseWriter, r *http.Request) {
	appID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	/* The CASE on value_bool is guarded by IS NOT NULL rather than left to
	   COALESCE. `CASE WHEN NULL THEN 'Yes' ELSE 'No' END` is 'No', not NULL,
	   so an unguarded branch makes every unanswered file and text field render
	   as the word "No".

	   class_sought is looked up rather than printed: the stored value is a
	   class id, which is right in the data and useless on a screen. The
	   subquery compares id::text to the answer so a non-uuid value cannot
	   raise a cast error on a row nobody was asking about. */
	items, err := collect(s, r, `
		SELECT sec.title, f.code, f.label, f.field_type,
		       COALESCE(
		           CASE WHEN f.code = 'class_sought'
		                THEN (SELECT c.name FROM classes c WHERE c.id::text = ans.value_text)
		           END,
		           ans.value_text,
		           ans.value_number::text,
		           to_char(ans.value_date,'YYYY-MM-DD'),
		           CASE WHEN ans.value_bool IS NOT NULL
		                THEN CASE WHEN ans.value_bool THEN 'Yes' ELSE 'No' END
		           END,
		           ''),
		       ans.file_id::text, ans.external_url
		  FROM application_form_answers ans
		  JOIN admission_form_fields f ON f.id = ans.field_id
		  JOIN admission_form_sections sec ON sec.id = f.section_id
		 WHERE ans.application_id = $1
		 ORDER BY sec.sequence, sec.title, f.sequence, f.label`, []any{appID},
		func(rows pgx.Rows) (answerRow, error) {
			var v answerRow
			return v, rows.Scan(&v.Section, &v.Code, &v.Label, &v.Type, &v.Value, &v.FileID, &v.URL)
		})
	respond(w, r, items, err)
}

// ==============================================================================
// The applicant-facing surface
// ==============================================================================

/*
formLimiter is a per-address submission limit, in process.

	Deliberately small and deliberately declared as what it is. There is no
	shared rate limiter in this codebase, and introducing a Redis-backed one
	here would be a second piece of infrastructure to operate for one endpoint.
	This stops the accidental flood and the casual script; behind more than one
	process it limits per process, and applications carry submitted_from so a
	burst is visible to the office rather than merely absorbed.
*/
type formLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var publicFormLimiter = &formLimiter{hits: map[string][]time.Time{}}

/*
The budget, and why it is this size.

	Every attempt counts, valid or not — limiting only successful submissions
	would make a flood of malformed bodies free, and those still cost a form
	definition read each. Twelve in ten minutes is therefore set well above
	what a real family needs: a parent who mistypes a date of birth four times
	and a phone number twice must not be locked out of applying to a school,
	and that failure would be far more expensive than the one being defended
	against.
*/
const (
	formSubmitWindow = 10 * time.Minute
	formSubmitBurst  = 12
)

// allow reports whether this address may submit again, and prunes as it goes so
// the map does not grow without bound over a long-running process.
func (l *formLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-formSubmitWindow)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= formSubmitBurst {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	// Opportunistic sweep: one expired bucket per call is enough to keep a map
	// of transient addresses bounded without ever walking it under load.
	for k, v := range l.hits {
		if len(v) == 0 || v[len(v)-1].Before(cutoff) {
			delete(l.hits, k)
			break
		}
	}
	return true
}

func callerAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// resolvePublicForm finds the live version behind a slug, and the school it
// belongs to. Everything downstream runs InTenant against that institution, so
// a public submission is inside RLS exactly as a staff write is.
func (s *Server) resolvePublicForm(ctx context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	var inst, versionID uuid.UUID
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT f.institution_id, v.id
			  FROM admission_forms f
			  JOIN admission_form_versions v
			    ON v.form_id = f.id AND v.status = 'published'
			 WHERE f.slug = $1
			   AND f.is_open
			   AND (f.opens_on  IS NULL OR f.opens_on  <= current_date)
			   AND (f.closes_on IS NULL OR f.closes_on >= current_date)`, slug).
			Scan(&inst, &versionID)
	})
	return inst, versionID, err
}

func (s *Server) getPublicAdmissionForm(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "slug")))
	if !validFormSlug(slug) {
		httpx.NotFound(w, r)
		return
	}
	inst, versionID, err := s.resolvePublicForm(r.Context(), slug)
	if errors.Is(err, pgx.ErrNoRows) {
		// One answer for "no such form", "not open yet" and "closed on
		// Friday": a 404 that distinguishes them is a way to enumerate a
		// platform's schools.
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var def formDefinition
	var schoolName string
	err = s.DB.InTenant(r.Context(), tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		var err error
		if def, err = loadFormDefinition(r.Context(), tx, versionID); err != nil {
			return err
		}
		if err = resolveFieldOptions(r.Context(), tx, &def); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, inst).Scan(&schoolName)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"school": schoolName, "form": def,
	})
}

// resolveFieldOptions fills a select's list from the school's own vocabulary,
// so the applicant's dropdown and the server's validator are built from the
// same rows in the same transaction.
func resolveFieldOptions(ctx context.Context, tx pgx.Tx, def *formDefinition) error {
	for si := range def.Sections {
		for fi := range def.Sections[si].Fields {
			f := &def.Sections[si].Fields[fi]
			if f.Code == "class_sought" {
				f.Options = def.Classes
				continue
			}
			if f.OptionKind == nil || *f.OptionKind == "" {
				continue
			}
			opts, err := optionsForKind(ctx, tx, *f.OptionKind)
			if err != nil {
				return err
			}
			f.Options = opts
		}
	}
	return nil
}

// optionsForKind is customOptionsFor without an http.Request: the built-in
// list plus the school's additions, read inside a transaction the caller
// already holds. The request-shaped version cannot serve the public endpoint,
// which has no identity at all.
func optionsForKind(ctx context.Context, tx pgx.Tx, kind string) ([]option, error) {
	out := []option{}
	out = append(out, customisableKinds[kind]...)
	rows, err := tx.Query(ctx, `
		SELECT value, label FROM custom_options
		 WHERE kind = $1 AND active ORDER BY sequence, label`, kind)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var o option
		if err := rows.Scan(&o.Value, &o.Label); err != nil {
			return out, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

type publicSubmission struct {
	// Keyed by field CODE, never by field id. The client has no business
	// naming a row: a code is meaningful only within the version being
	// submitted, and cannot address another school's field the way a uuid can.
	Answers map[string]string `json:"answers"`
	// A file field carries an id from POST /api/v1/files/presign, or a URL.
	Files map[string]string `json:"files,omitempty"`
	URLs  map[string]string `json:"urls,omitempty"`
}

/*
submitPublicAdmissionForm validates a submission against the stored definition
and creates the application.

	Every rule is re-derived here from the version's own rows. Nothing about
	what is required, what is visible, what a dropdown may contain or how long
	a value may be is taken from the request — the browser enforced those for
	the applicant's benefit and an attacker simply did not run the browser.

	Conditional visibility is resolved server-side and in order: a field whose
	condition is not met is not required, and any answer given to it is
	discarded. Trusting the client's view of what was on screen would let a
	submission skip a required field by claiming it was hidden.
*/
func (s *Server) submitPublicAdmissionForm(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "slug")))
	if !validFormSlug(slug) {
		httpx.NotFound(w, r)
		return
	}
	if !publicFormLimiter.allow(callerAddress(r), time.Now()) {
		httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited",
			"too many applications from this connection. Please wait a few minutes and try again.")
		return
	}
	var req publicSubmission
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Answers == nil {
		req.Answers = map[string]string{}
	}

	inst, versionID, err := s.resolvePublicForm(r.Context(), slug)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var appNo string
	var problems []string
	err = s.DB.InTenant(r.Context(), tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		def, err := loadFormDefinition(r.Context(), tx, versionID)
		if err != nil {
			return err
		}
		if err := resolveFieldOptions(r.Context(), tx, &def); err != nil {
			return err
		}
		checked, errs := validateSubmission(def, req)
		if len(errs) > 0 {
			problems = errs
			return errFormInvalid
		}
		appNo, err = insertPublicApplication(r.Context(), tx, inst, versionID, def, checked,
			callerAddress(r))
		return err
	})
	switch {
	case errors.Is(err, errFormInvalid):
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{
				"code":    "validation_failed",
				"message": "Some answers need attention.",
				"details": problems,
			},
		})
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"application_no": appNo,
			"message":        "Your application has been received. Please keep this number for reference.",
		})
	}
}

var errFormInvalid = errors.New("submission failed validation")

// checkedAnswer is one validated answer, already typed. Built only by
// validateSubmission, so a value can only reach the insert having been through
// the rules.
type checkedAnswer struct {
	Field  formFieldRow
	Text   *string
	Number *float64
	Date   *string
	Bool   *bool
	FileID *uuid.UUID
	URL    *string
}

/*
validateSubmission is the whole server-side rule set.

	Returns the answers that survived and the messages an applicant should see.
	Messages are written for the family, not for a developer: "Date of birth
	must be a date, like 2019-04-15" is something a parent can act on, and
	"invalid date" is not.
*/
func validateSubmission(def formDefinition, req publicSubmission) ([]checkedAnswer, []string) {
	var out []checkedAnswer
	var errs []string

	// Answers by code, so a visibility condition can be resolved against what
	// was actually submitted rather than against what the client claims was
	// shown.
	given := map[string]string{}
	for k, v := range req.Answers {
		given[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
	}

	allowed := map[string]bool{}
	for _, sec := range def.Sections {
		for _, f := range sec.Fields {
			allowed[f.Code] = true
		}
	}
	// A code nobody asked for is refused rather than dropped. Silently
	// ignoring it means a mis-keyed integration looks like it is working.
	for code := range given {
		if !allowed[code] {
			errs = append(errs, "this form has no question called "+code)
		}
	}

	for _, sec := range def.Sections {
		for _, f := range sec.Fields {
			// Visibility, decided here. A hidden field is neither required nor
			// answerable.
			if f.VisibleWhen != nil {
				if given[strings.ToLower(f.VisibleWhen.Field)] != f.VisibleWhen.Equals {
					continue
				}
			}

			if f.FieldType == "file" {
				fileRaw := strings.TrimSpace(req.Files[f.Code])
				urlRaw := strings.TrimSpace(req.URLs[f.Code])
				if fileRaw == "" && urlRaw == "" {
					if f.IsRequired {
						errs = append(errs, f.Label+" is required. Attach a file or give a link to it")
					}
					continue
				}
				if fileRaw != "" && urlRaw != "" {
					errs = append(errs, f.Label+": give either an uploaded file or a link, not both")
					continue
				}
				a := checkedAnswer{Field: f}
				if fileRaw != "" {
					fid, err := uuid.Parse(fileRaw)
					if err != nil {
						errs = append(errs, f.Label+": that upload reference is not valid")
						continue
					}
					a.FileID = &fid
				} else {
					if !strings.HasPrefix(urlRaw, "https://") && !strings.HasPrefix(urlRaw, "http://") {
						errs = append(errs, f.Label+": a link must start with https://")
						continue
					}
					u := urlRaw
					a.URL = &u
				}
				out = append(out, a)
				continue
			}

			raw := given[f.Code]
			if raw == "" {
				if f.IsRequired && f.FieldType != "checkbox" {
					errs = append(errs, f.Label+" is required")
				}
				if f.FieldType == "checkbox" {
					no := false
					if f.IsRequired {
						errs = append(errs, f.Label+" must be ticked")
						continue
					}
					out = append(out, checkedAnswer{Field: f, Bool: &no})
				}
				continue
			}

			a, msg := checkOneAnswer(f, raw)
			if msg != "" {
				errs = append(errs, msg)
				continue
			}
			out = append(out, a)
		}
	}
	return out, errs
}

func checkOneAnswer(f formFieldRow, raw string) (checkedAnswer, string) {
	a := checkedAnswer{Field: f}

	// Length applies to everything typed. A 40 KB "middle name" is not a
	// validation edge case, it is the first thing anybody tries.
	if f.MinLength != nil && len([]rune(raw)) < *f.MinLength {
		return a, fmt.Sprintf("%s must be at least %d characters", f.Label, *f.MinLength)
	}
	limit := 2000
	if f.MaxLength != nil && *f.MaxLength < limit {
		limit = *f.MaxLength
	}
	if len([]rune(raw)) > limit {
		return a, fmt.Sprintf("%s must be at most %d characters", f.Label, limit)
	}
	if f.Pattern != nil && *f.Pattern != "" {
		ok, err := matchStoredPattern(*f.Pattern, raw)
		if err != nil {
			// A school typed a broken regular expression. Refusing the
			// applicant for it would be blaming the wrong person, so the rule
			// is skipped and the answer accepted.
			ok = true
		}
		if !ok {
			return a, f.Label + " is not in the expected format"
		}
	}

	switch f.FieldType {
	case "number":
		n, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return a, f.Label + " must be a number"
		}
		if f.MinNumber != nil && n < *f.MinNumber {
			return a, fmt.Sprintf("%s must be at least %g", f.Label, *f.MinNumber)
		}
		if f.MaxNumber != nil && n > *f.MaxNumber {
			return a, fmt.Sprintf("%s must be at most %g", f.Label, *f.MaxNumber)
		}
		a.Number = &n
	case "date":
		if _, err := time.Parse("2006-01-02", raw); err != nil {
			return a, f.Label + " must be a date, like 2019-04-15"
		}
		d := raw
		a.Date = &d
	case "checkbox":
		b := raw == "true" || raw == "yes" || raw == "1" || raw == "on"
		if f.IsRequired && !b {
			return a, f.Label + " must be ticked"
		}
		a.Bool = &b
	case "select":
		found := false
		for _, o := range f.Options {
			if o.Value == raw {
				found = true
				break
			}
		}
		if !found {
			return a, f.Label + ": choose one of the options offered"
		}
		v := raw
		a.Text = &v
	case "email":
		if !strings.Contains(raw, "@") || strings.HasPrefix(raw, "@") || strings.HasSuffix(raw, "@") {
			return a, f.Label + " must be an email address"
		}
		v := raw
		a.Text = &v
	case "phone":
		digits := strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, raw)
		// Ten digits is an Indian mobile; the longer forms carry a country
		// code. Anything shorter is a typo, not a number.
		if len(digits) < 10 || len(digits) > 15 {
			return a, f.Label + " must be a phone number of at least 10 digits"
		}
		v := raw
		a.Text = &v
	default:
		v := raw
		a.Text = &v
	}
	return a, ""
}

/*
insertPublicApplication writes the application and every answer.

	Reserved codes fill the columns on applications; every answer, reserved or
	not, is also stored against the version, so the rendered form shows exactly
	what the family typed rather than a reconstruction from columns.
*/
func insertPublicApplication(ctx context.Context, tx pgx.Tx, inst, versionID uuid.UUID,
	def formDefinition, answers []checkedAnswer, from string) (string, error) {

	core := map[string]string{}
	var classID *uuid.UUID
	for _, a := range answers {
		col, reserved := reservedFields[a.Field.Code]
		if !reserved {
			continue
		}
		switch {
		case a.Text != nil:
			core[col] = *a.Text
		case a.Date != nil:
			core[col] = *a.Date
		case a.Number != nil:
			core[col] = strconv.FormatFloat(*a.Number, 'f', -1, 64)
		}
		if a.Field.Code == "class_sought" && a.Text != nil {
			id, err := uuid.Parse(*a.Text)
			if err != nil {
				return "", errors.New("the class applied for is not one this school offers")
			}
			classID = &id
		}
	}
	if classID == nil {
		return "", errors.New("please choose the class you are applying for")
	}
	if core["first_name"] == "" || core["parent_name"] == "" || core["parent_phone"] == "" {
		return "", errors.New("the child's name, a parent's name and a phone number are all required")
	}

	// The form's own campus, or the school's first. applications.campus_id is
	// NOT NULL, and a form that names no campus must still be submittable.
	var campusID uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(f.campus_id, (SELECT id FROM campuses ORDER BY created_at LIMIT 1))
		  FROM admission_forms f WHERE f.id = $1`, def.FormID).Scan(&campusID); err != nil {
		return "", err
	}
	var sessionID *uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT admission_session_id FROM admission_forms WHERE id = $1`, def.FormID).
		Scan(&sessionID); err != nil {
		return "", err
	}

	// Application numbers share the gapless allocator with receipts, so a
	// series filled from the web is auditable the same way as one filled at
	// the counter.
	appNo, err := fees.NextNumber(ctx, tx, inst, "application")
	if err != nil {
		return "", err
	}

	/* THE ENQUIRY THIS FORM CAME FROM.

	   An application filled on the web carried no enquiry_id, which sounds like
	   a missing analytics column and is not. The enquiry is where the family
	   was given their login, and enquiries.guardian_id is what enrolment reads
	   to avoid issuing that family a second credential. With the link missing,
	   the ordinary journey -- enquire at the desk, get a login by email, click
	   the link in it, apply online -- ended in a portal that said "fill in the
	   application form" forever, because it was looking for an application that
	   pointed back at the enquiry and there was none.

	   Matched on the contact the family gave, because that is all the two
	   records share: the form is filled by a parent at home and the enquiry was
	   typed by a clerk, so the names differ far too often to match on. Phone
	   first, since it is the enquiry's only NOT NULL contact.

	   The newest enquiry that has not already been answered by an application.
	   Without that condition a family applying for a second child would attach
	   the new application to the first child's enquiry, and the elder child's
	   tracker would start showing the younger one's progress. */
	var enquiryID *uuid.UUID
	{
		var found uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT e.id FROM enquiries e
			 WHERE (e.phone = $1 OR (NULLIF($2,'') IS NOT NULL AND e.email = $2::citext))
			   AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.enquiry_id = e.id)
			 ORDER BY e.created_at DESC
			 LIMIT 1`, core["parent_phone"], core["parent_email"]).Scan(&found)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		if err == nil {
			enquiryID = &found
		}
	}

	var appID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO applications (institution_id, campus_id, admission_session_id,
		                          enquiry_id, application_no, first_name, middle_name,
		                          last_name, date_of_birth, gender, category, class_sought,
		                          parent_name, parent_phone, parent_email, address,
		                          previous_school, status, form_version_id,
		                          submitted_from, submitted_at)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),NULLIF($9,'')::date,
		        NULLIF($10,''),NULLIF($11,''),$12,$13,$14,NULLIF($15,'')::citext,
		        NULLIF($16,''),NULLIF($17,''),'submitted',$18,$19,now())
		RETURNING id`,
		inst, campusID, sessionID, enquiryID, appNo,
		core["first_name"], core["middle_name"], core["last_name"], core["date_of_birth"],
		core["gender"], core["category"], *classID, core["parent_name"], core["parent_phone"],
		core["parent_email"], core["address"], core["previous_school"], versionID,
		truncate(from, 60)).Scan(&appID); err != nil {
		return "", err
	}

	/* The enquiry has been answered, so say so in the funnel.

	   'applied' is the furthest state the enquiry vocabulary defines; the
	   application row carries the outcome beyond it. Without this an enquiry
	   that produced an application on the web sat at 'new' and the conversion
	   rate the funnel reports was wrong in the school's own favour. */
	if enquiryID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE enquiries SET status = 'applied', updated_at = now()
			 WHERE id = $1 AND status NOT IN ('applied','lost')`, *enquiryID); err != nil {
			return "", err
		}
	}

	for _, a := range answers {
		fieldID, err := uuid.Parse(a.Field.ID)
		if err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO application_form_answers
			    (institution_id, application_id, version_id, field_id,
			     value_text, value_number, value_date, value_bool, file_id, external_url)
			VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10)`,
			inst, appID, versionID, fieldID,
			a.Text, a.Number, a.Date, a.Bool, a.FileID, a.URL); err != nil {
			return "", err
		}
	}
	return appNo, nil
}

// ==============================================================================
// 2. Multi-touch campaign sequences
// ==============================================================================

type campaignRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	IsActive    bool    `json:"is_active"`
	AutoSource  *string `json:"auto_enrol_source,omitempty"`
	Steps       int     `json:"steps"`
	Active      int     `json:"active_leads"`
	Stopped     int     `json:"stopped_leads"`
	Sent        int     `json:"messages_queued"`
	Due         int     `json:"touches_due"`
}

func (s *Server) listAdmissionCampaigns(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT c.id::text, c.name, c.description, c.is_active, c.auto_enrol_source,
		       (SELECT count(*)::int FROM admission_campaign_steps st
		         WHERE st.campaign_id = c.id),
		       (SELECT count(*)::int FROM admission_campaign_enrolments e
		         WHERE e.campaign_id = c.id AND e.status = 'active'),
		       (SELECT count(*)::int FROM admission_campaign_enrolments e
		         WHERE e.campaign_id = c.id AND e.status = 'stopped'),
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		          JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id
		         WHERE e.campaign_id = c.id AND sn.status = 'queued'),
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		          JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id
		         WHERE e.campaign_id = c.id AND sn.status = 'pending' AND sn.due_at <= now())
		  FROM admission_campaigns c
		 ORDER BY c.is_active DESC, lower(c.name)`, nil,
		func(rows pgx.Rows) (campaignRow, error) {
			var v campaignRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Description, &v.IsActive, &v.AutoSource,
				&v.Steps, &v.Active, &v.Stopped, &v.Sent, &v.Due)
		})
	respond(w, r, items, err)
}

type campaignRequest struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	IsActive    bool   `json:"is_active"`
	AutoSource  string `json:"auto_enrol_source,omitempty"`
}

func (s *Server) saveAdmissionCampaign(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req campaignRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the sequence needs a name")
		return
	}
	cid, err := optionalUUID(req.ID)
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if cid != nil {
			return tx.QueryRow(r.Context(), `
				UPDATE admission_campaigns
				   SET name = $2, description = NULLIF($3,''), is_active = $4,
				       auto_enrol_source = NULLIF($5,'')
				 WHERE id = $1 RETURNING id::text`,
				*cid, req.Name, req.Description, req.IsActive, req.AutoSource).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_campaigns
			    (institution_id, name, description, is_active, auto_enrol_source, created_by)
			VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),$6) RETURNING id::text`,
			id.InstitutionID, req.Name, req.Description, req.IsActive, req.AutoSource,
			nullUUIDArg(id.UserID)).Scan(&out)
	})
	switch {
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate", "a sequence with that name already exists")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

type campaignStepRow struct {
	ID         string  `json:"id"`
	StepNo     int     `json:"step_no"`
	Name       string  `json:"name"`
	OffsetDays int     `json:"offset_days"`
	Channel    string  `json:"channel"`
	Template   string  `json:"template_code"`
	QuietFrom  *string `json:"quiet_from,omitempty"`
	QuietTo    *string `json:"quiet_to,omitempty"`
	IsActive   bool    `json:"is_active"`
	Queued     int     `json:"queued"`
	Skipped    int     `json:"skipped"`
}

func (s *Server) listCampaignSteps(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT st.id::text, st.step_no, st.name, st.offset_days, st.channel,
		       st.template_code, st.quiet_from::text, st.quiet_to::text, st.is_active,
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		         WHERE sn.step_id = st.id AND sn.status = 'queued'),
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		         WHERE sn.step_id = st.id AND sn.status IN ('skipped','failed'))
		  FROM admission_campaign_steps st
		 WHERE st.campaign_id = $1
		 ORDER BY st.step_no`, []any{cid},
		func(rows pgx.Rows) (campaignStepRow, error) {
			var v campaignStepRow
			return v, rows.Scan(&v.ID, &v.StepNo, &v.Name, &v.OffsetDays, &v.Channel,
				&v.Template, &v.QuietFrom, &v.QuietTo, &v.IsActive, &v.Queued, &v.Skipped)
		})
	respond(w, r, items, err)
}

type campaignStepRequest struct {
	ID         string `json:"id,omitempty"`
	StepNo     int    `json:"step_no"`
	Name       string `json:"name"`
	OffsetDays int    `json:"offset_days"`
	Channel    string `json:"channel"`
	Template   string `json:"template_code"`
	QuietFrom  string `json:"quiet_from,omitempty"`
	QuietTo    string `json:"quiet_to,omitempty"`
	IsActive   bool   `json:"is_active"`
}

func (s *Server) saveCampaignStep(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req campaignStepRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Template = strings.TrimSpace(req.Template)
	if req.Name == "" || req.Template == "" {
		httpx.BadRequest(w, r, "a touch needs a name and a message template code")
		return
	}
	if !knownChannel(req.Channel) {
		httpx.BadRequest(w, r, "channel must be one of sms, email, whatsapp, push, in_app")
		return
	}
	if req.StepNo < 1 || req.StepNo > 50 {
		httpx.BadRequest(w, r, "step_no must be between 1 and 50")
		return
	}
	if req.OffsetDays < 0 || req.OffsetDays > 365 {
		httpx.BadRequest(w, r, "offset_days must be between 0 and 365")
		return
	}
	if (req.QuietFrom == "") != (req.QuietTo == "") {
		httpx.BadRequest(w, r,
			"set both ends of the quiet window or neither. A half-set window is one the author thinks they set")
		return
	}
	stepID, err := optionalUUID(req.ID)
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if stepID != nil {
			return tx.QueryRow(r.Context(), `
				UPDATE admission_campaign_steps
				   SET step_no = $3, name = $4, offset_days = $5, channel = $6,
				       template_code = $7, quiet_from = NULLIF($8,'')::time,
				       quiet_to = NULLIF($9,'')::time, is_active = $10
				 WHERE id = $1 AND campaign_id = $2 RETURNING id::text`,
				*stepID, cid, req.StepNo, req.Name, req.OffsetDays, req.Channel,
				req.Template, req.QuietFrom, req.QuietTo, req.IsActive).Scan(&out)
		}
		var inst uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM admission_campaigns WHERE id = $1`, cid).Scan(&inst); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_campaign_steps
			    (institution_id, campaign_id, step_no, name, offset_days, channel,
			     template_code, quiet_from, quiet_to, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::time,NULLIF($9,'')::time,$10)
			RETURNING id::text`,
			inst, cid, req.StepNo, req.Name, req.OffsetDays, req.Channel, req.Template,
			req.QuietFrom, req.QuietTo, req.IsActive).Scan(&out)
	})
	switch {
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate", "this sequence already has a touch numbered that")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

func (s *Server) deleteCampaignStep(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	stepID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// A touch already sent is part of what a family received. Deactivate
		// it instead of deleting it, so the outbox keeps making sense.
		var queued int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM admission_campaign_sends
			 WHERE step_id = $1 AND status = 'queued'`, stepID).Scan(&queued); err != nil {
			return err
		}
		if queued > 0 {
			tag, err := tx.Exec(r.Context(),
				`UPDATE admission_campaign_steps SET is_active = false WHERE id = $1`, stepID)
			n = tag.RowsAffected()
			return err
		}
		tag, err := tx.Exec(r.Context(), `DELETE FROM admission_campaign_steps WHERE id = $1`, stepID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": stepID.String()})
}

type enrolmentRow struct {
	ID          string  `json:"id"`
	EnquiryID   string  `json:"enquiry_id"`
	StudentName string  `json:"student_name"`
	ParentName  *string `json:"parent_name,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	LeadStatus  string  `json:"lead_status"`
	Status      string  `json:"status"`
	EnrolledAt  string  `json:"enrolled_at"`
	StoppedAt   *string `json:"stopped_at,omitempty"`
	StopReason  *string `json:"stopped_reason,omitempty"`
	Done        int     `json:"touches_done"`
	Remaining   int     `json:"touches_remaining"`
	NextDue     *string `json:"next_due,omitempty"`
}

func (s *Server) listCampaignEnrolments(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT e.id::text, e.enquiry_id::text, q.student_name, q.parent_name, q.phone,
		       q.status, e.status,
		       to_char(e.enrolled_at at time zone 'Asia/Kolkata','YYYY-MM-DD'),
		       to_char(e.stopped_at at time zone 'Asia/Kolkata','YYYY-MM-DD'),
		       e.stopped_reason,
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		         WHERE sn.enrolment_id = e.id AND sn.status = 'queued'),
		       (SELECT count(*)::int FROM admission_campaign_sends sn
		         WHERE sn.enrolment_id = e.id AND sn.status = 'pending'),
		       to_char((SELECT min(sn.due_at) FROM admission_campaign_sends sn
		                 WHERE sn.enrolment_id = e.id AND sn.status = 'pending')
		               at time zone 'Asia/Kolkata','YYYY-MM-DD')
		  FROM admission_campaign_enrolments e
		  JOIN enquiries q ON q.id = e.enquiry_id
		 WHERE e.campaign_id = $1
		 ORDER BY e.status, e.enrolled_at DESC
		 LIMIT 500`, []any{cid},
		func(rows pgx.Rows) (enrolmentRow, error) {
			var v enrolmentRow
			return v, rows.Scan(&v.ID, &v.EnquiryID, &v.StudentName, &v.ParentName, &v.Phone,
				&v.LeadStatus, &v.Status, &v.EnrolledAt, &v.StoppedAt, &v.StopReason,
				&v.Done, &v.Remaining, &v.NextDue)
		})
	respond(w, r, items, err)
}

type campaignEnrolRequest struct {
	EnquiryIDs []string `json:"enquiry_ids"`
	// Enrol every open lead from one source in one go. How a morning's forty
	// web enquiries actually get put on a sequence.
	Source string `json:"source,omitempty"`
}

/*
enrolLeadsOnCampaign puts leads on a sequence and schedules every touch.

	The schedule is written at enrolment rather than computed at send time, so
	changing a step's offset next month does not silently re-date a touch
	already due — and so the screen can answer "when will this family next hear
	from us" without simulating the runner.
*/
func (s *Server) enrolLeadsOnCampaign(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req campaignEnrolRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.EnquiryIDs) == 0 && strings.TrimSpace(req.Source) == "" {
		httpx.BadRequest(w, r, "name the leads to enrol, or a source to sweep")
		return
	}
	ids := make([]uuid.UUID, 0, len(req.EnquiryIDs))
	for _, raw := range req.EnquiryIDs {
		v, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "enquiry_ids must all be uuids")
			return
		}
		ids = append(ids, v)
	}

	var enrolled, already int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var inst uuid.UUID
		var active bool
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, is_active FROM admission_campaigns WHERE id = $1`, cid).
			Scan(&inst, &active); err != nil {
			return err
		}
		if !active {
			return errors.New("this sequence is paused. Activate it before enrolling anyone")
		}
		steps, err := loadCampaignSteps(r.Context(), tx, cid)
		if err != nil {
			return err
		}
		if len(steps) == 0 {
			return errors.New("this sequence has no touches yet. Add at least one before enrolling anyone")
		}

		// Only leads still in play, and only leads who have not asked to be
		// left alone. Enrolling a lost or converted lead would schedule the
		// exact message this feature exists to prevent.
		rows, err := tx.Query(r.Context(), `
			SELECT id FROM enquiries
			 WHERE status NOT IN ('applied','lost')
			   AND NOT marketing_opt_out
			   AND (cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[]))
			   AND ($2::text IS NULL OR source = $2)`,
			ids, nullString(strings.TrimSpace(req.Source)))
		if err != nil {
			return err
		}
		var leads []uuid.UUID
		for rows.Next() {
			var lid uuid.UUID
			if err := rows.Scan(&lid); err != nil {
				rows.Close()
				return err
			}
			leads = append(leads, lid)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, lead := range leads {
			var enrolID uuid.UUID
			var at time.Time
			err := tx.QueryRow(r.Context(), `
				INSERT INTO admission_campaign_enrolments
				    (institution_id, campaign_id, enquiry_id, enrolled_by)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (campaign_id, enquiry_id) DO NOTHING
				RETURNING id, enrolled_at`,
				inst, cid, lead, nullUUIDArg(id.UserID)).Scan(&enrolID, &at)
			if errors.Is(err, pgx.ErrNoRows) {
				already++
				continue
			}
			if err != nil {
				return err
			}
			if err := scheduleTouches(r.Context(), tx, inst, enrolID, at, steps); err != nil {
				return err
			}
			enrolled++
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"enrolled": enrolled, "already_enrolled": already,
		})
	}
}

// campaignStep is one touch, as the runner needs it.
type campaignStep struct {
	ID         uuid.UUID
	StepNo     int
	Name       string
	OffsetDays int
	Channel    string
	Template   string
	QuietFrom  *string
	QuietTo    *string
}

func loadCampaignSteps(ctx context.Context, tx pgx.Tx, campaignID uuid.UUID) ([]campaignStep, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, step_no, name, offset_days, channel, template_code,
		       quiet_from::text, quiet_to::text
		  FROM admission_campaign_steps
		 WHERE campaign_id = $1 AND is_active
		 ORDER BY step_no`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []campaignStep
	for rows.Next() {
		var st campaignStep
		if err := rows.Scan(&st.ID, &st.StepNo, &st.Name, &st.OffsetDays, &st.Channel,
			&st.Template, &st.QuietFrom, &st.QuietTo); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// scheduleTouches writes the whole schedule for one enrolment. ON CONFLICT DO
// NOTHING so re-running against an enrolment that already has some — a step
// added after enrolment, say — fills the gap rather than failing.
func scheduleTouches(ctx context.Context, tx pgx.Tx, inst, enrolID uuid.UUID,
	from time.Time, steps []campaignStep) error {

	for _, st := range steps {
		if _, err := tx.Exec(ctx, `
			INSERT INTO admission_campaign_sends
			    (institution_id, enrolment_id, step_id, due_at)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (enrolment_id, step_id) DO NOTHING`,
			inst, enrolID, st.ID, from.AddDate(0, 0, st.OffsetDays)); err != nil {
			return err
		}
	}
	return nil
}

type stopRequest struct {
	Reason string `json:"reason,omitempty"`
}

func (s *Server) stopCampaignEnrolment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	enrolID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req stopRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "stopped by the office"
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return stopEnrolment(r.Context(), tx, enrolID, reason, &n)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": enrolID.String(), "status": "stopped"})
}

/*
stopEnrolment closes an enrolment and cancels everything still pending.

	Both halves matter. Closing the enrolment without touching the pending
	sends leaves rows a future runner would happily pick up, which is exactly
	the "still thinking it over?" to a family who has already paid.
*/
func stopEnrolment(ctx context.Context, tx pgx.Tx, enrolID uuid.UUID, reason string, n *int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE admission_campaign_enrolments
		   SET status = 'stopped', stopped_at = now(), stopped_reason = $2
		 WHERE id = $1 AND status = 'active'`, enrolID, truncate(reason, 200))
	if err != nil {
		return err
	}
	if n != nil {
		*n = tag.RowsAffected()
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	_, err = tx.Exec(ctx, `
		UPDATE admission_campaign_sends
		   SET status = 'skipped', note = $2
		 WHERE enrolment_id = $1 AND status = 'pending'`, enrolID, truncate(reason, 200))
	return err
}

type outboxRow struct {
	ID          string  `json:"id"`
	Campaign    string  `json:"campaign"`
	Step        string  `json:"step"`
	StudentName string  `json:"student_name"`
	Phone       *string `json:"phone,omitempty"`
	Channel     string  `json:"channel"`
	DueAt       string  `json:"due_at"`
	Status      string  `json:"status"`
	Note        *string `json:"note,omitempty"`
}

func (s *Server) listCampaignOutbox(w http.ResponseWriter, r *http.Request) {
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	items, err := collect(s, r, `
		SELECT sn.id::text, c.name, st.name, q.student_name, q.phone, st.channel,
		       to_char(sn.due_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI'),
		       sn.status, sn.note
		  FROM admission_campaign_sends sn
		  JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id
		  JOIN admission_campaigns c ON c.id = e.campaign_id
		  JOIN admission_campaign_steps st ON st.id = sn.step_id
		  JOIN enquiries q ON q.id = e.enquiry_id
		 WHERE ($1::text IS NULL OR sn.status = $1)
		 ORDER BY sn.due_at DESC
		 LIMIT 300`, []any{nullString(status)},
		func(rows pgx.Rows) (outboxRow, error) {
			var v outboxRow
			return v, rows.Scan(&v.ID, &v.Campaign, &v.Step, &v.StudentName, &v.Phone,
				&v.Channel, &v.DueAt, &v.Status, &v.Note)
		})
	respond(w, r, items, err)
}

type campaignRunResult struct {
	Considered int `json:"considered"`
	Queued     int `json:"queued"`
	Skipped    int `json:"skipped"`
	Stopped    int `json:"enrolments_stopped"`
	Completed  int `json:"enrolments_completed"`
}

func (s *Server) runCampaignsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var out campaignRunResult
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		out, err = s.runCampaigns(r.Context(), tx, id.InstitutionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
runCampaigns queues every touch that has come due.

	Written to be called by a scheduler once this deployment has one, and by the
	screen in the meantime. Three properties make it safe to call repeatedly and
	from more than one caller:

	  1. The stop check happens per lead, immediately before the send, inside
	     the same transaction. Not at enrolment, not on a nightly sweep — a
	     parent who paid this morning must not get this afternoon's touch, and
	     any check further from the send has a window in which they do.

	  2. UNIQUE (enrolment_id, step_id) plus the status transition means a touch
	     is queued once. A second runner finds it already 'queued' and passes
	     over it.

	  3. Nothing here sends. QueueMessage writes a message_log row, and the
	     dispatcher that already exists takes it from there — including the
	     one-per-occurrence index, which is a second independent guard against
	     the same family being messaged twice.

	A configuration gap is never an error. A school with no SMS gateway gets its
	touches marked 'skipped' with the reason on the row, exactly as the trigger
	rules do, because failing the whole run would mean one unconfigured channel
	silently stopping every other campaign.
*/
func (s *Server) runCampaigns(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (campaignRunResult, error) {
	var out campaignRunResult

	rows, err := tx.Query(ctx, `
		SELECT sn.id, e.id, e.enquiry_id, st.channel, st.template_code, st.name,
		       st.quiet_from::text, st.quiet_to::text,
		       q.student_name, q.parent_name, q.phone, q.email::text, q.status,
		       q.marketing_opt_out, c.name,
		       EXISTS (SELECT 1 FROM applications a
		                WHERE a.enquiry_id = q.id
		                  AND a.status IN ('accepted','offered'))
		  FROM admission_campaign_sends sn
		  JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id AND e.status = 'active'
		  JOIN admission_campaign_steps st ON st.id = sn.step_id AND st.is_active
		  JOIN admission_campaigns c ON c.id = e.campaign_id AND c.is_active
		  JOIN enquiries q ON q.id = e.enquiry_id
		 WHERE sn.institution_id = $1 AND sn.status = 'pending' AND sn.due_at <= now()
		 ORDER BY sn.due_at
		 LIMIT 500`, inst)
	if err != nil {
		return out, err
	}

	type due struct {
		SendID, EnrolID, EnquiryID  uuid.UUID
		Channel, Template, StepName string
		QuietFrom, QuietTo          *string
		Student                     string
		Parent, Phone, Email        *string
		LeadStatus                  string
		OptOut, Converted           bool
		Campaign                    string
	}
	var batch []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.SendID, &d.EnrolID, &d.EnquiryID, &d.Channel, &d.Template,
			&d.StepName, &d.QuietFrom, &d.QuietTo, &d.Student, &d.Parent, &d.Phone,
			&d.Email, &d.LeadStatus, &d.OptOut, &d.Campaign, &d.Converted); err != nil {
			rows.Close()
			return out, err
		}
		batch = append(batch, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Considered = len(batch)

	stopped := map[uuid.UUID]bool{}
	for _, d := range batch {
		if stopped[d.EnrolID] {
			continue
		}
		// The stop rule, in one place. Converted, lost, or asked to be left
		// alone: the sequence ends and everything still pending is cancelled
		// with it, so no later run can resurrect the touch.
		if reason := stopReasonFor(d.LeadStatus, d.OptOut, d.Converted); reason != "" {
			if err := stopEnrolment(ctx, tx, d.EnrolID, reason, nil); err != nil {
				return out, err
			}
			stopped[d.EnrolID] = true
			out.Stopped++
			continue
		}

		address := ""
		if d.Channel == "email" && d.Email != nil {
			address = *d.Email
		} else if d.Channel != "email" && d.Phone != nil {
			address = *d.Phone
		}
		if strings.TrimSpace(address) == "" {
			if err := markSend(ctx, tx, d.SendID, "skipped", nil,
				"no "+d.Channel+" address on the enquiry"); err != nil {
				return out, err
			}
			out.Skipped++
			continue
		}

		name := d.Student
		if d.Parent != nil && *d.Parent != "" {
			name = *d.Parent
		}
		sendID := d.SendID
		when := quietAdjusted(d.QuietFrom, d.QuietTo)
		res, err := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel:      d.Channel,
			TemplateCode: d.Template,
			Vars: map[string]any{
				"recipient_name": name,
				"student_name":   d.Student,
				"campaign":       d.Campaign,
				"step":           d.StepName,
			},
			Recipient: address,
			// The occurrence is this touch for this lead. Keyed on the send
			// row's own id, which is unique per (enrolment, step) — so the
			// message log's one-per-occurrence index agrees with this table's
			// unique index rather than guessing at it.
			SourceKind:    "campaign_step",
			SourceID:      &sendID,
			OccurrenceKey: sendID.String(),
			SendAfter:     when,
		})
		switch {
		case errors.Is(err, ErrProviderNotConfigured), errors.Is(err, ErrNoRecipient):
			if err := markSend(ctx, tx, d.SendID, "skipped", nil, truncate(err.Error(), 200)); err != nil {
				return out, err
			}
			out.Skipped++
		case err != nil:
			// A missing template is the school's problem, not a database
			// fault, and must not abort the other four hundred touches.
			if err := markSend(ctx, tx, d.SendID, "failed", nil, truncate(err.Error(), 200)); err != nil {
				return out, err
			}
			out.Skipped++
		default:
			var msgID *uuid.UUID
			if !res.Duplicate {
				id := res.ID
				msgID = &id
			}
			if err := markSend(ctx, tx, d.SendID, "queued", msgID, ""); err != nil {
				return out, err
			}
			out.Queued++
		}
	}

	// An enrolment with nothing left pending is finished, not merely quiet.
	// Saying so is what lets the screen distinguish "we have said everything
	// we planned to" from "the runner has not caught up".
	tag, err := tx.Exec(ctx, `
		UPDATE admission_campaign_enrolments e
		   SET status = 'completed', stopped_at = now(), stopped_reason = 'sequence finished'
		 WHERE e.institution_id = $1 AND e.status = 'active'
		   AND NOT EXISTS (SELECT 1 FROM admission_campaign_sends sn
		                    WHERE sn.enrolment_id = e.id AND sn.status = 'pending')
		   AND EXISTS (SELECT 1 FROM admission_campaign_sends sn WHERE sn.enrolment_id = e.id)`, inst)
	if err != nil {
		return out, err
	}
	out.Completed = int(tag.RowsAffected())
	return out, nil
}

// stopReasonFor is the single statement of when a nurture sequence must end.
// One function so the runner, the enrolment sweep and any future caller cannot
// come to different conclusions about the same family.
func stopReasonFor(leadStatus string, optOut, converted bool) string {
	switch {
	case optOut:
		return "the parent asked not to be contacted"
	case converted:
		return "the parent has been offered a seat or accepted one"
	case leadStatus == "applied":
		return "the lead converted. An application was made"
	case leadStatus == "lost":
		return "the lead was closed as lost"
	}
	return ""
}

// quietAdjusted turns a step's quiet window into a send_after, reusing the
// same clock arithmetic the trigger rules use so a campaign and a reminder
// treat 21:00 identically.
func quietAdjusted(from, to *string) *time.Time {
	if from == nil || to == nil {
		return nil
	}
	now := nowInIndia()
	at := afterQuiet(now, *from, *to)
	if at.Sub(now) < time.Minute {
		return nil
	}
	return &at
}

func markSend(ctx context.Context, tx pgx.Tx, sendID uuid.UUID, status string,
	msgID *uuid.UUID, note string) error {

	_, err := tx.Exec(ctx, `
		UPDATE admission_campaign_sends
		   SET status = $2, message_id = $3, note = NULLIF($4,''),
		       queued_at = CASE WHEN $2 = 'queued' THEN now() ELSE queued_at END
		 WHERE id = $1`, sendID, status, msgID, note)
	return err
}

// ==============================================================================
// 3. Lost lead reason analysis
// ==============================================================================

// listLostReasonOptions publishes the vocabulary the screen offers: the
// built-in five plus whatever the school has added under custom_options.
func (s *Server) listLostReasonOptions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []option{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		out, err = optionsForKind(r.Context(), tx, "lost_reason")
		return err
	})
	respond(w, r, out, err)
}

type markLostRequest struct {
	Reason string `json:"reason"`
	Note   string `json:"note,omitempty"`
}

/*
markLeadLost closes a lead and records why.

	The reason is required. A lost lead with no reason is the row that makes
	the whole report say "Not recorded: 61%", and the moment the counsellor
	closes it is the only moment anybody still knows the answer.

	Closing the lead also stops every nurture sequence it is on. Doing that
	here rather than in the runner means the family stops hearing from the
	school the moment the counsellor presses the button, not at the next run.
*/
func (s *Server) markLeadLost(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	leadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req markLostRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r,
			"say why this lead was lost. The reason is the whole point of closing it here rather than deleting it")
		return
	}
	// "Other" without a note is a row that tells the school nothing next
	// season, which is the season the report is read in.
	if req.Reason == "other" && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "\"Other\" needs a note saying what actually happened")
		return
	}
	ok, err := s.allowsValue(r, "lost_reason", req.Reason)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !ok {
		httpx.BadRequest(w, r,
			"that is not one of the reasons your school records. Add it to the list first if it is a real one.")
		return
	}

	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE enquiries
			   SET status = 'lost', lost_reason = $2, lost_reason_note = NULLIF($3,''),
			       lost_at = now(), lost_by = $4, updated_at = now()
			 WHERE id = $1`,
			leadID, req.Reason, strings.TrimSpace(req.Note), nullUUIDArg(id.UserID))
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		if n == 0 {
			return nil
		}
		return stopEnrolmentsForLead(r.Context(), tx, leadID, "the lead was closed as lost")
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": leadID.String(), "status": "lost", "reason": req.Reason,
	})
}

// reopenLead undoes a closure. Reopening happens — a family rings back in
// August — and a lost reason that cannot be taken off is a report that
// overstates the loss for the rest of the season.
func (s *Server) reopenLead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	leadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE enquiries
			   SET status = 'contacted', lost_reason = NULL, lost_reason_note = NULL,
			       lost_at = NULL, lost_by = NULL, updated_at = now()
			 WHERE id = $1 AND status = 'lost'`, leadID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_lost", "that lead is not closed as lost")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": leadID.String(), "status": "contacted"})
}

// optLeadOut records that a family asked to be left alone, and stops every
// sequence they are on. A fact about the family, not about one campaign.
func (s *Server) optLeadOut(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	leadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE enquiries
			   SET marketing_opt_out = true, opted_out_at = now(), updated_at = now()
			 WHERE id = $1`, leadID)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		if n == 0 {
			return nil
		}
		return stopEnrolmentsForLead(r.Context(), tx, leadID,
			"the parent asked not to be contacted")
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": leadID.String(), "opted_out": true})
}

func stopEnrolmentsForLead(ctx context.Context, tx pgx.Tx, leadID uuid.UUID, reason string) error {
	rows, err := tx.Query(ctx, `
		SELECT id FROM admission_campaign_enrolments
		 WHERE enquiry_id = $1 AND status = 'active'`, leadID)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var v uuid.UUID
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, v := range ids {
		if err := stopEnrolment(ctx, tx, v, reason, nil); err != nil {
			return err
		}
	}
	return nil
}

type lostLeadRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	ParentName  *string `json:"parent_name,omitempty"`
	ClassSought *string `json:"class_sought,omitempty"`
	Source      string  `json:"source"`
	Counsellor  *string `json:"counsellor,omitempty"`
	Reason      *string `json:"reason,omitempty"`
	ReasonLabel string  `json:"reason_label"`
	Note        *string `json:"note,omitempty"`
	LostOn      *string `json:"lost_on,omitempty"`
	// How long the school worked it before giving up. A lead lost after two
	// days on "no response" and one lost after seven weeks on "fees" are
	// different failures.
	DaysWorked int `json:"days_worked"`
}

func (s *Server) listLostLeads(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT e.id::text, e.student_name, e.parent_name, c.name, e.source,
		       u.full_name, e.lost_reason,
		       COALESCE(NULLIF(co.label,''), initcap(replace(COALESCE(e.lost_reason,'not recorded'),'_',' '))),
		       e.lost_reason_note,
		       to_char(e.lost_at at time zone 'Asia/Kolkata','YYYY-MM-DD'),
		       GREATEST(0, EXTRACT(day FROM COALESCE(e.lost_at, now()) - e.created_at)::int)
		  FROM enquiries e
		  LEFT JOIN classes c ON c.id = e.class_sought
		  LEFT JOIN users u ON u.id = e.assigned_to
		  LEFT JOIN custom_options co
		         ON co.kind = 'lost_reason' AND co.value = e.lost_reason
		        AND co.institution_id = e.institution_id
		 WHERE e.status = 'lost'
		   AND (e.lost_at IS NULL OR e.lost_at::date BETWEEN $1::date AND $2::date)
		   AND ($3::text IS NULL OR e.lost_reason = $3)
		   AND ($4::uuid IS NULL OR e.class_sought = $4::uuid)
		 ORDER BY e.lost_at DESC NULLS LAST, e.created_at DESC
		 LIMIT 500`,
		[]any{rng.From, rng.To, nullString(q.Get("reason")), nullString(q.Get("class_sought"))},
		func(rows pgx.Rows) (lostLeadRow, error) {
			var v lostLeadRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.ParentName, &v.ClassSought,
				&v.Source, &v.Counsellor, &v.Reason, &v.ReasonLabel, &v.Note, &v.LostOn,
				&v.DaysWorked)
		})
	respond(w, r, items, err)
}

type lostAnalysisRow struct {
	Group string `json:"group"`
	Lost  int    `json:"lost"`
	// Every enquiry in the same bucket over the same period, so a reason can
	// be read as a share rather than as a raw count. Forty lost on fees means
	// nothing until it is forty out of a hundred.
	Total int      `json:"total"`
	Share *float64 `json:"share_percent,omitempty"`
	// The largest single reason in this bucket, which is the sentence a
	// principal actually wants: "Class 1, 38% lost, mostly on fees".
	TopReason *string `json:"top_reason,omitempty"`
	TopCount  int     `json:"top_reason_count,omitempty"`
}

/*
getLostLeadAnalysis groups lost leads four ways, and by month.

	Every dimension is one query over one set of rows, so reason, class, source
	and counsellor always add up to the same total — a dashboard assembled from
	four separately-filtered queries famously does not.

	Share is null rather than zero below five enquiries in a bucket. One lost
	enquiry from a newspaper is not a 100% loss rate, it is not yet a rate, and
	printing it as one is how a school cancels the advertisement that was
	working.
*/
func (s *Server) getLostLeadAnalysis(w http.ResponseWriter, r *http.Request) {
	by := strings.TrimSpace(r.URL.Query().Get("by"))
	if by == "" {
		by = "reason"
	}
	/* The grouping expression is chosen from a fixed list and never built
	   from anything the caller typed. `by` is matched against this switch and
	   an unrecognised value is refused — the string that reaches the query is
	   one of five literals in this file, so there is no path from a query
	   parameter into the SQL. */
	var groupSQL string
	switch by {
	case "reason":
		groupSQL = `COALESCE(NULLIF(co.label,''),
		            initcap(replace(COALESCE(e.lost_reason,'Not recorded'),'_',' ')))`
	case "class":
		groupSQL = `COALESCE(c.name, 'Not stated')`
	case "source":
		groupSQL = `COALESCE(NULLIF(btrim(e.source),''), 'Not recorded')`
	case "counsellor":
		groupSQL = `COALESCE(u.full_name, 'Unassigned')`
	case "month":
		/* The month the enquiry ARRIVED, not the month it was lost.

		   This looked wrong until the shares were read. Grouping by the month
		   of loss puts only lost rows in every bucket, so the denominator is
		   the numerator and every month reports 100% — a number that is
		   arithmetically correct and tells a principal nothing. The arrival
		   cohort is the honest trend: of the forty enquiries that came in in
		   July, eighteen were eventually lost, and that is a figure that can
		   move. */
		groupSQL = `to_char(date_trunc('month', e.created_at at time zone 'Asia/Kolkata'),'YYYY-MM')`
	case "lost_month":
		// When the losses actually landed. A count, deliberately without a
		// share — see above for why a share here would be a lie.
		groupSQL = `COALESCE(to_char(e.lost_month,'YYYY-MM'), 'Not dated')`
	default:
		httpx.BadRequest(w, r,
			"by must be one of reason, class, source, counsellor, month, lost_month")
		return
	}

	rng := resolveRange(r)
	/* The group is computed inside the CTE, so the outer query refers to it by
	   name once and the "biggest single reason in this bucket" subquery can
	   join on it without the expression being written out three times in three
	   different aliasings. Every variant carries the same joins: an unused
	   LEFT JOIN over one school's enquiries costs nothing, and a second query
	   string per dimension would be a second place for the totals to diverge.

	   Both counts come off the same scan. A "lost" number and a "total" number
	   from separately filtered queries is how a dashboard ends up reporting a
	   share above 100%. */
	sql := `
		WITH scoped AS (
		    SELECT e.status,
		           e.lost_reason,
		           COALESCE(NULLIF(co.label,''),
		                    initcap(replace(COALESCE(e.lost_reason,'Not recorded'),'_',' '))) AS reason_label,
		           ` + groupSQL + ` AS grp
		      FROM enquiries e
		      LEFT JOIN classes c ON c.id = e.class_sought
		      LEFT JOIN users u ON u.id = e.assigned_to
		      LEFT JOIN custom_options co
		             ON co.kind = 'lost_reason' AND co.value = e.lost_reason
		            AND co.institution_id = e.institution_id
		     WHERE e.created_at::date BETWEEN $1::date AND $2::date
		)
		SELECT s.grp,
		       count(*) FILTER (WHERE s.status = 'lost')::int AS lost,
		       count(*)::int AS total,
		       (SELECT x.reason_label FROM scoped x
		         WHERE x.status = 'lost' AND x.grp IS NOT DISTINCT FROM s.grp
		         GROUP BY x.reason_label ORDER BY count(*) DESC, x.reason_label LIMIT 1),
		       COALESCE((SELECT count(*)::int FROM scoped x
		                  WHERE x.status = 'lost' AND x.grp IS NOT DISTINCT FROM s.grp
		                  GROUP BY x.reason_label ORDER BY count(*) DESC, x.reason_label LIMIT 1), 0)
		  FROM scoped s
		 GROUP BY s.grp
		HAVING count(*) FILTER (WHERE s.status = 'lost') > 0
		 ORDER BY lost DESC, s.grp`

	items, err := collect(s, r, sql, []any{rng.From, rng.To},
		func(rows pgx.Rows) (lostAnalysisRow, error) {
			var v lostAnalysisRow
			if err := rows.Scan(&v.Group, &v.Lost, &v.Total, &v.TopReason, &v.TopCount); err != nil {
				return v, err
			}
			// Every row in a lost_month bucket is a lost row, so the share
			// would be 100% by construction.
			if v.Total >= 5 && by != "lost_month" {
				p := round2(100 * float64(v.Lost) / float64(v.Total))
				v.Share = &p
			}
			return v, nil
		})
	respond(w, r, items, err)
}

// --- small helpers ------------------------------------------------------------

// validFormSlug mirrors the CHECK on admission_forms.slug, so a bad slug is
// refused with a sentence rather than a constraint violation.
func validFormSlug(s string) bool {
	if len(s) < 3 || len(s) > 64 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0:
		default:
			return false
		}
	}
	return true
}

func validFieldCode(s string) bool {
	if len(s) < 2 || len(s) > 49 {
		return false
	}
	if s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}

// formSlug derives a web address from a form's name. Hyphens rather than
// underscores because this one goes on a poster.
func formSlug(name string) string {
	v := strings.ReplaceAll(optionValue(name), "_", "-")
	if len(v) > 64 {
		v = strings.Trim(v[:64], "-")
	}
	return v
}

/*
matchStoredPattern applies a school-authored pattern to an answer.

	Deliberately not regexp. A pattern is authored by a school administrator
	and applied on an unauthenticated endpoint, and Go's regexp is linear-time
	but the compile is not free — a form with forty patterned fields would
	compile forty expressions per submission. More to the point, a school
	wanting "eleven digits" should not have to learn regular expressions.

	So the vocabulary is small and named: digits:N, digits:N-M, letters,
	alnum, starts:xyz. Anything unrecognised returns an error and the caller
	accepts the answer rather than blaming the applicant for the school's typo.
*/
func matchStoredPattern(pattern, value string) (bool, error) {
	kind, arg, _ := strings.Cut(pattern, ":")
	switch strings.TrimSpace(kind) {
	case "digits":
		if !allDigits(value) {
			return false, nil
		}
		if arg == "" {
			return true, nil
		}
		lo, hi, ok := parseRange(arg)
		if !ok {
			return false, errors.New("unreadable digit range")
		}
		return len(value) >= lo && len(value) <= hi, nil
	case "letters":
		for _, r := range value {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == ' ' || r == '.' || r == '\'' || r == '-') {
				return false, nil
			}
		}
		return true, nil
	case "alnum":
		for _, r := range value {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == ' ') {
				return false, nil
			}
		}
		return true, nil
	case "starts":
		return strings.HasPrefix(strings.ToLower(value), strings.ToLower(arg)), nil
	}
	return false, errors.New("unknown pattern: " + pattern)
}

// allDigits lives in banking.go. isDigits in setup_profile.go answers a
// different question — "is this exactly N digits" — and is not the one wanted
// by a pattern of "digits" with no range.

func parseRange(arg string) (int, int, bool) {
	lo, hi, found := strings.Cut(arg, "-")
	n, err := strconv.Atoi(strings.TrimSpace(lo))
	if err != nil {
		return 0, 0, false
	}
	if !found {
		return n, n, true
	}
	m, err := strconv.Atoi(strings.TrimSpace(hi))
	if err != nil {
		return 0, 0, false
	}
	return n, m, true
}
