package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Dropdowns a school is allowed to disagree with.

   Every list offered during setup was a Go slice, and oneOf refused anything
   not on it. The defaults are good ones for a Telangana school and wrong for
   some school somewhere: a board nobody thought of, a management type that
   does not translate, a medium of instruction this state does not teach in.
   The product's answer to "we are not on your list" was "then you cannot say
   what you are", and the school's workaround was to pick the nearest wrong
   option — which is worse than an empty field, because it reads as a fact.

   So the built-in lists stay and the school may extend them. Both halves
   matter. A dropdown that starts empty has handed the school work instead of
   a product; a dropdown that cannot be extended has handed them a lie. */

// customisableKinds is the whole vocabulary, with the built-in list each kind
// extends. A kind absent from here cannot be extended at all — which is the
// right answer for anything the code branches on, such as a subscription
// status or a gender the reports aggregate by.
//
// The value is nil where there is no built-in list and the school defines the
// entire vocabulary itself.
var customisableKinds = map[string][]option{
	"affiliation_board": affiliationBoards,
	"school_category":   schoolCategories,
	"management_type":   managementTypes,
	"medium":            mediumOptions,
	"religion":          nil,
	"mother_tongue":     nil,
	"caste_category":    nil,
	"blood_group":       bloodGroupOptions,
	"document_type":     nil,
	"subject_type":      subjectTypeOptions,
	"fee_head_type":     nil,
	"staff_designation": nil,
	"leaving_reason":    nil,
	"concession_reason": nil,

	// Vocabulary the rest of the product asks for. Each is a list a school
	// genuinely disagrees about — a designation one school calls "Senior
	// Assistant" and another calls "Head Clerk" — as distinct from the state
	// machines below, which are logic and stay closed.
	"employee_type":     nil,
	"qualification":     nil,
	"department_type":   nil,
	"room_type":         nil,
	"vehicle_type":      nil,
	"stop_landmark":     nil,
	"item_category":     nil,
	"book_category":     nil,
	"hostel_block_type": nil,
	"visitor_purpose":   nil,
	"complaint_type":    nil,
	"activity_type":     nil,
	"exam_type":         nil,
	"lead_source":       nil,
	"relation":          nil,
	"nationality":       nil,
	"payment_mode":      nil,
	"expense_head":      nil,
	"health_condition":  nil,
	"achievement_type":  nil,
}

/* Deliberately NOT customisable, and worth naming so the next person does not
   add them: any status, state or scope the code branches on. A school
   inventing a sixth invoice status does not gain a category — it loses every
   report that groups by the five, and the handler that decides what "paid"
   means stops covering its own data. */

// Built-in lists that had no named slice of their own, because until now they
// were literals inside a single form.
var (
	mediumOptions = []option{
		{"telugu", "Telugu"}, {"english", "English"}, {"urdu", "Urdu"},
		{"hindi", "Hindi"}, {"other", "Other"},
	}
	bloodGroupOptions = []option{
		{"A+", "A+"}, {"A-", "A−"}, {"B+", "B+"}, {"B-", "B−"},
		{"AB+", "AB+"}, {"AB-", "AB−"}, {"O+", "O+"}, {"O-", "O−"},
	}
	subjectTypeOptions = []option{
		{"scholastic", "Scholastic"},
		{"co_scholastic", "Co-scholastic"},
	}
)

type customOption struct {
	ID       string `json:"id,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Value    string `json:"value"`
	Label    string `json:"label"`
	Sequence int    `json:"sequence,omitempty"`
	// Custom marks a school's own addition, so the client can offer to remove
	// it without offering to remove a built-in it cannot delete.
	Custom bool `json:"custom,omitempty"`
}

// listCustomisableKinds publishes the vocabulary, so the management screen is
// built from what the server actually accepts rather than a second list in the
// client that drifts from it.
func (s *Server) listCustomisableKinds(w http.ResponseWriter, r *http.Request) {
	type kindInfo struct {
		Kind     string `json:"kind"`
		Label    string `json:"label"`
		Builtins int    `json:"builtins"`
	}
	out := make([]kindInfo, 0, len(customisableKinds))
	for kind, builtin := range customisableKinds {
		out = append(out, kindInfo{Kind: kind, Label: kindLabels[kind], Builtins: len(builtin)})
	}
	sortByKind(out, func(k kindInfo) string { return k.Label })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

var kindLabels = map[string]string{
	"affiliation_board": "Affiliation boards",
	"school_category":   "School categories",
	"management_type":   "Management types",
	"medium":            "Media of instruction",
	"religion":          "Religions",
	"mother_tongue":     "Mother tongues",
	"caste_category":    "Caste categories",
	"blood_group":       "Blood groups",
	"document_type":     "Document types",
	"subject_type":      "Subject types",
	"fee_head_type":     "Fee head types",
	"staff_designation": "Staff designations",
	"leaving_reason":    "Reasons for leaving",
	"concession_reason": "Concession reasons",
	"employee_type":     "Employment types",
	"qualification":     "Qualifications",
	"department_type":   "Department types",
	"room_type":         "Room types",
	"vehicle_type":      "Vehicle types",
	"stop_landmark":     "Bus stop landmarks",
	"item_category":     "Stores item categories",
	"book_category":     "Book categories",
	"hostel_block_type": "Hostel block types",
	"visitor_purpose":   "Visitor purposes",
	"complaint_type":    "Complaint types",
	"activity_type":     "Activity types",
	"exam_type":         "Examination types",
	"lead_source":       "Enquiry sources",
	"relation":          "Guardian relations",
	"nationality":       "Nationalities",
	"payment_mode":      "Payment modes",
	"expense_head":      "Expense heads",
	"health_condition":  "Health conditions",
	"achievement_type":  "Achievement types",
}

// listOptions returns one kind: the built-in list first, then the school's own
// additions. Order matters — a clerk scanning for "CBSE" should find it where
// it has always been, with the school's additions after rather than
// interleaved by some alphabetical rule that moves them about.
func (s *Server) listOptions(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	builtin, ok := customisableKinds[kind]
	if !ok {
		httpx.BadRequest(w, r, "unknown option list: "+kind)
		return
	}

	out := make([]customOption, 0, len(builtin)+8)
	for _, o := range builtin {
		out = append(out, customOption{Value: o.Value, Label: o.Label})
	}

	custom, err := s.customOptionsFor(r, kind)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out = append(out, custom...)
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) customOptionsFor(r *http.Request, kind string) ([]customOption, error) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || id.InstitutionID == uuid.Nil {
		return nil, nil
	}
	var out []customOption
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, value, label, sequence
			  FROM custom_options
			 WHERE kind = $1 AND active
			 ORDER BY sequence, label`, kind)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v customOption
			if err := rows.Scan(&v.ID, &v.Value, &v.Label, &v.Sequence); err != nil {
				return err
			}
			v.Custom = true
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}

type addOptionRequest struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Value is optional. A school types a label; the stored value is derived
	// from it unless they care what goes into the export.
	Value    string `json:"value,omitempty"`
	Sequence int    `json:"sequence,omitempty"`
}

// addOption adds one entry to a school's own list.
func (s *Server) addOption(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req addOptionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Kind = strings.TrimSpace(req.Kind)
	req.Label = strings.TrimSpace(req.Label)
	builtin, ok := customisableKinds[req.Kind]
	if !ok {
		httpx.BadRequest(w, r, "unknown option list: "+req.Kind)
		return
	}
	if req.Label == "" {
		httpx.BadRequest(w, r, "the option needs a label")
		return
	}

	value := strings.TrimSpace(req.Value)
	if value == "" {
		value = optionValue(req.Label)
	}
	if value == "" {
		httpx.BadRequest(w, r, "that label has no letters or digits to make a value from")
		return
	}

	// Adding something the built-in list already offers is a mistake worth
	// naming: the school ends up with two entries that mean one thing, and
	// their own reports stop grouping.
	for _, o := range builtin {
		if strings.EqualFold(o.Value, value) || strings.EqualFold(o.Label, req.Label) {
			httpx.BadRequest(w, r, "that one is already on the standard list as "+o.Label)
			return
		}
	}

	var out customOption
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO custom_options (institution_id, kind, value, label, sequence)
			VALUES ($1,$2,$3,$4,$5)
			RETURNING id::text, value, label, sequence`,
			id.InstitutionID, req.Kind, value, req.Label, req.Sequence).
			Scan(&out.ID, &out.Value, &out.Label, &out.Sequence)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate", "your school already has that one")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Kind, out.Custom = req.Kind, true
	httpx.JSON(w, http.StatusCreated, out)
}

// retireOption stops offering one of the school's own additions.
//
// Retired, not deleted. Records already carry the value, and a student
// admitted under a board the school has stopped using must keep rendering a
// label rather than a bare code on their transfer certificate.
func (s *Server) retireOption(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	oid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid option id")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE custom_options SET active = false WHERE id = $1`, oid)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no such option")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": oid.String(), "active": false})
}

// allowsValue reports whether a value is acceptable for a kind: on the
// built-in list, or on this school's own.
//
// This is what lets oneOf stop being a wall. Validation still happens — a
// typo in an API call is still refused — but the set it validates against is
// now the school's, not the vendor's.
func (s *Server) allowsValue(r *http.Request, kind, value string) (bool, error) {
	if value == "" {
		return true, nil
	}
	for _, o := range customisableKinds[kind] {
		if o.Value == value {
			return true, nil
		}
	}
	custom, err := s.customOptionsFor(r, kind)
	if err != nil {
		return false, err
	}
	for _, o := range custom {
		if o.Value == value {
			return true, nil
		}
	}
	return false, nil
}

// sortByKind is a tiny insertion sort, used once on a list of fourteen. Pulling
// in a comparator package for this would be more code than the loop.
func sortByKind[T any](items []T, key func(T) string) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && key(items[j]) < key(items[j-1]); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

// optionValue derives a stored value from a label.
//
// Not slugify: that one appends eight hex characters to guarantee a unique
// tenant slug, which is right for a URL nobody reads and wrong here. This
// value is what lands in a UDISE return and a transfer certificate, and
// "telangana-open-school-society-9abe93fc" in a state filing is the kind of
// thing that gets a school telephoned about. Uniqueness is already enforced by
// the index, which reports a duplicate rather than inventing a way around it.
func optionValue(label string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(label) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('_')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "_")
}
