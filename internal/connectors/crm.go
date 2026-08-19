/*
Package connectors carries the two platform integrations whose far end does not
exist on this deployment: the admissions CRMs (Meritto, LeadSquared) and the
meeting providers behind the live-class launcher (Zoom, Meet, Teams).

	It is written the way internal/tally is written, and for the same reason. A
	product that ships a screen headed "CRM sync" and quietly means "we hope
	somebody buys a licence one day" is lying in the place a school notices
	last and minds most. So each integration is an interface with one
	implementation that genuinely works — a file the school moves by hand, or a
	join URL a teacher pastes — and the live implementations sit beside them
	returning a named error, always, with a test pinning that refusal so a later
	edit cannot turn it into a fabricated success.

	Everything here is a pure function of its inputs: no database, no clock, no
	request. That is what lets the CSV export, the CSV import and the API
	handlers share one set of rules rather than growing three slightly
	different ones, and it is what makes the idempotency rule testable without
	a CRM to test against.
*/
package connectors

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

/* --- the lead ---------------------------------------------------------------

   Our half of the mapping. These are the enquiries columns a CRM has an
   opinion about, named exactly as crm_field_mappings.local_field constrains
   them — the CHECK in the migration and LeadFields below must agree, and a
   test pins that they do. */

// LeadFields is every local field a mapping may name, in the order a person
// reads them rather than alphabetically.
var LeadFields = []string{
	"student_name", "parent_name", "phone", "email", "class_sought",
	"source", "campaign", "status", "assigned_to", "next_follow_up",
	"notes", "utm_source", "utm_medium", "utm_campaign", "referred_by",
	"created_at",
}

// LeadFieldLabels is what the mapping screen shows beside each field.
var LeadFieldLabels = map[string]string{
	"student_name":   "Child's name",
	"parent_name":    "Parent's name",
	"phone":          "Phone",
	"email":          "Email",
	"class_sought":   "Class sought",
	"source":         "Source",
	"campaign":       "Campaign",
	"status":         "Status",
	"assigned_to":    "Counsellor",
	"next_follow_up": "Next follow-up",
	"notes":          "Notes",
	"utm_source":     "UTM source",
	"utm_medium":     "UTM medium",
	"utm_campaign":   "UTM campaign",
	"referred_by":    "Referred by",
	"created_at":     "Enquiry date",
}

// IsLeadField reports whether a mapping may name this field. Checked before a
// mapping is saved, so a bad name is refused at the screen rather than
// discovered by a run at midnight.
func IsLeadField(f string) bool {
	for _, k := range LeadFields {
		if k == f {
			return true
		}
	}
	return false
}

// Lead is one enquiry on its way out, already flattened to strings.
//
// Strings rather than typed columns because everything downstream is a CSV
// cell or a JSON field in somebody else's schema, and a lead that has been
// through three type conversions to arrive as text again has only gained three
// chances to be wrong.
type Lead struct {
	// EnquiryID is our enquiries.id. Carried so a run can record exactly which
	// rows it sent without re-deriving the set.
	EnquiryID string
	// ExternalID is the CRM's own id, empty for a lead that has never been
	// pushed. Empty here is what makes a push a create.
	ExternalID string
	// UpdatedAt is when the lead last changed on our side. The left-hand clock
	// of every conflict decision.
	UpdatedAt time.Time
	Values    map[string]string
}

/* --- the mapping ------------------------------------------------------------

   Their half. A per-tenant table rather than a constant, because the CRM side
   is a custom field name that differs between two accounts of the same
   product: LeadSquared calls it mx_Class_Sought in one school and
   mx_ClassApplied in the next. */

// Mapping is one field of ours against one field of theirs.
type Mapping struct {
	LocalField string `json:"local_field"`
	CRMField   string `json:"crm_field"`
	// Direction is push, pull or both. A mapping that does not apply in the
	// direction being run is not an error; it is simply not used.
	Direction string `json:"direction"`
	Required  bool   `json:"is_required"`
}

func (m Mapping) appliesTo(direction string) bool {
	return m.Direction == "both" || m.Direction == direction
}

// ErrNothingMapped is what a run returns before it reads a single lead.
var ErrNothingMapped = errors.New("no fields are mapped for this direction")

// ForDirection is the mappings that apply to one direction, in a stable order
// so two exports of the same configuration produce byte-identical headers. A
// column order that wobbles between runs is a diff nobody can read and an
// import somebody's script breaks on.
func ForDirection(ms []Mapping, direction string) []Mapping {
	out := []Mapping{}
	for _, m := range ms {
		if m.appliesTo(direction) {
			out = append(out, m)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return indexOfLeadField(out[i].LocalField) < indexOfLeadField(out[j].LocalField)
	})
	return out
}

func indexOfLeadField(f string) int {
	for i, k := range LeadFields {
		if k == f {
			return i
		}
	}
	return len(LeadFields)
}

/* --- the CSV ----------------------------------------------------------------

   The route that works today, because it is the one a school can actually
   take: export here, import in the CRM's own bulk-upload screen, and back the
   same way. Both CRMs have one, both are used, and neither needs anybody to
   buy an API tier or open a firewall. */

// ExternalIDColumn is the column that carries the CRM's own id.
//
// It is not optional and it is not a courtesy. A file exported without it can
// only be imported as a page of new leads, so the second import of the same
// file gives the school two rows per child and two counsellors ringing one
// parent. Everything about the idempotency of this connector rests on this
// column surviving the round trip, so it is written first and read first.
const ExternalIDColumn = "external_id"

// EnquiryIDColumn carries our id, so a file that comes back can be matched even
// if the CRM never issued an id — a lead the school deleted and re-created, or
// a bulk upload that failed halfway.
const EnquiryIDColumn = "enquiry_id"

// RenderLeadCSV writes the leads out under the CRM's own column names.
func RenderLeadCSV(ms []Mapping, leads []Lead) ([]byte, error) {
	cols := ForDirection(ms, "push")
	if len(cols) == 0 {
		return nil, ErrNothingMapped
	}
	for _, m := range cols {
		if m.Required {
			for _, l := range leads {
				if strings.TrimSpace(l.Values[m.LocalField]) == "" {
					return nil, fmt.Errorf(
						"lead %s has no %s, and that field is marked required: fill it in or clear the requirement",
						l.EnquiryID, LeadFieldLabels[m.LocalField])
				}
			}
		}
	}

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)

	head := []string{ExternalIDColumn, EnquiryIDColumn}
	for _, m := range cols {
		head = append(head, m.CRMField)
	}
	if err := w.Write(head); err != nil {
		return nil, err
	}
	for _, l := range leads {
		rec := []string{l.ExternalID, l.EnquiryID}
		for _, m := range cols {
			rec = append(rec, l.Values[m.LocalField])
		}
		if err := w.Write(rec); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ImportRow is one line of a file coming back from the CRM, already translated
// out of their column names into ours.
type ImportRow struct {
	// Line is the 1-based line number in the uploaded file, header included,
	// so "row 14: phone is blank" names the row the person is looking at.
	Line       int
	ExternalID string
	EnquiryID  string
	// RemoteUpdated is when the CRM says the lead last changed, when the file
	// carries it. Nil means unknown, which is treated as "changed" — assuming
	// unchanged would silently drop a counsellor's edit.
	RemoteUpdated *time.Time
	Values        map[string]string
}

// ParseLeadCSV reads a file the CRM produced back into our vocabulary.
//
// Unknown columns are ignored rather than refused: a CRM export carries thirty
// columns of its own housekeeping and a parser that insists on recognising all
// of them is a parser nobody can feed.
func ParseLeadCSV(ms []Mapping, data []byte) ([]ImportRow, error) {
	cols := ForDirection(ms, "pull")
	if len(cols) == 0 {
		return nil, ErrNothingMapped
	}

	r := csv.NewReader(bytes.NewReader(data))
	// Rows of differing length are normal in a hand-edited export; short rows
	// are padded below rather than rejected.
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("this file is not readable as CSV: %w", err)
	}
	if len(records) == 0 {
		return nil, errors.New("the file is empty")
	}

	head := map[string]int{}
	for i, h := range records[0] {
		head[strings.ToLower(strings.TrimSpace(h))] = i
	}
	extIdx, ok := head[ExternalIDColumn]
	if !ok {
		return nil, fmt.Errorf(
			"the file has no %s column. Without it every row reads as a new lead, "+
				"and a second import gives one child two leads and two counsellors. "+
				"Export from this screen first and keep that column",
			ExternalIDColumn)
	}
	enqIdx, hasEnq := head[EnquiryIDColumn]

	at := func(rec []string, i int) string {
		if i < 0 || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	out := []ImportRow{}
	for n, rec := range records[1:] {
		row := ImportRow{
			Line:       n + 2,
			ExternalID: at(rec, extIdx),
			Values:     map[string]string{},
		}
		if hasEnq {
			row.EnquiryID = at(rec, enqIdx)
		}
		for _, m := range cols {
			if i, ok := head[strings.ToLower(m.CRMField)]; ok {
				row.Values[m.LocalField] = at(rec, i)
			}
		}
		// A wholly blank line is the trailing newline every spreadsheet adds.
		if row.ExternalID == "" && row.EnquiryID == "" && allBlank(row.Values) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func allBlank(v map[string]string) bool {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return false
		}
	}
	return true
}

/* --- the decision -----------------------------------------------------------

   What a run does with one record, and the only part of this connector that is
   genuinely hard.

   Two syncs of the same data must not produce two leads. That is not achieved
   by care at the call site; it is achieved by keying on a stable external id
   and making the second pass a no-op, which is what the rules below encode and
   what the tests beside them pin. */

// Action is what a run did with one record.
type Action string

const (
	ActionCreate Action = "created"
	// ActionUpdate is an existing link whose remote side moved.
	ActionUpdate Action = "updated"
	// ActionSkip is the second run finding nothing to do. A success, and the
	// count that proves idempotency held.
	ActionSkip Action = "skipped"
	// ActionConflict is both sides moved and the school asked to be told.
	ActionConflict Action = "conflict"
	ActionFail     Action = "failed"
)

// Link is what crm_lead_links already knows about a record, as the decision
// needs it.
type Link struct {
	EnquiryID string
	// LocalUpdated is when our enquiry last changed.
	LocalUpdated *time.Time
	// LastSynced is when this link last moved in the direction being run.
	// Anything later than it on either side is a change this run has not seen.
	LastSynced *time.Time
}

func movedSince(at, since *time.Time) bool {
	if at == nil {
		// Unknown is treated as moved. The other reading — assume nothing
		// changed — silently drops edits, and a sync that drops edits is worse
		// than one that asks.
		return true
	}
	if since == nil {
		return true
	}
	return at.After(*since)
}

/*
DecideImport is what a pulled record does to our copy.

	The order of the tests is the whole rule and is worth reading as prose:

	  no link            -> create. First time we have seen this lead.
	  remote unchanged   -> skip.   The second run over the same file. THIS is
	                                the case that stops duplicates, and it is
	                                reached before anything is written.
	  only remote moved  -> update. The ordinary case.
	  both moved         -> the school's conflict_policy decides, and 'flag'
	                        decides nothing, which is the honest default.
*/
func DecideImport(row ImportRow, link *Link, policy string) (Action, string) {
	if strings.TrimSpace(row.ExternalID) == "" {
		return ActionFail, fmt.Sprintf("row %d has no %s", row.Line, ExternalIDColumn)
	}
	if link == nil {
		return ActionCreate, ""
	}

	remoteMoved := movedSince(row.RemoteUpdated, link.LastSynced)
	if !remoteMoved {
		return ActionSkip, "already imported and unchanged in the CRM"
	}
	localMoved := movedSince(link.LocalUpdated, link.LastSynced)
	if !localMoved {
		return ActionUpdate, ""
	}

	switch policy {
	case "theirs":
		return ActionUpdate, "both sides changed; the CRM wins by policy"
	case "ours":
		return ActionSkip, "both sides changed; this school's record wins by policy"
	case "newest":
		if row.RemoteUpdated != nil && link.LocalUpdated != nil &&
			link.LocalUpdated.After(*row.RemoteUpdated) {
			return ActionSkip, "both sides changed; this school's record is newer"
		}
		return ActionUpdate, "both sides changed; the CRM's record is newer"
	default:
		return ActionConflict, "changed here and in the CRM since the last sync"
	}
}

/*
DecidePush is the same question in the other direction.

	A lead with no external id has never been out and is a create. One that has
	been out and has not changed since is a skip — and that skip is what keeps
	a nightly push from re-uploading the whole enquiry book every night and
	minting a second lead for every child the day somebody's dedupe rule in the
	CRM is switched off.
*/
func DecidePush(lead Lead, link *Link) (Action, string) {
	if link == nil || strings.TrimSpace(lead.ExternalID) == "" {
		return ActionCreate, ""
	}
	if !movedSince(&lead.UpdatedAt, link.LastSynced) {
		return ActionSkip, "already sent and unchanged here"
	}
	return ActionUpdate, ""
}

/* --- delivery ---------------------------------------------------------------

   The seam. One route that works, two that refuse by name. */

// Batch is a set of leads on their way to a CRM.
type Batch struct {
	Provider string
	Mappings []Mapping
	Leads    []Lead
}

// Receipt is what a delivery produced. Filename and Body are set by a provider
// that hands back a file; a provider that posted somewhere sets neither.
type Receipt struct {
	Filename string
	Body     []byte
	Detail   string
	// Applied is what the far end did, per lead, for a provider that knows.
	// Empty for the file route, where the CRM's own import screen decides.
	Applied []AppliedLead
}

// AppliedLead is one lead's outcome at the far end.
type AppliedLead struct {
	EnquiryID  string
	ExternalID string
	Action     Action
	Message    string
}

// CRMProvider is a route between this product's leads and a CRM.
type CRMProvider interface {
	// Key is the stored identifier. Do not rename one that is in use.
	Key() string
	Label() string
	// LiveSync reports whether this provider actually reaches the CRM. The
	// screen reads this rather than deciding for itself: whether a live sync
	// exists is a fact about the deployment, not a label.
	LiveSync() bool
	Push(Batch) (Receipt, error)
	Pull(PullRequest) ([]ImportRow, error)
}

// PullRequest is what a pull would ask the CRM for.
type PullRequest struct {
	Provider string
	Mappings []Mapping
	// Since is the watermark, so a second pull does not re-read the history.
	Since *time.Time
	// File is the uploaded CSV for the file route. Nil for a live provider.
	File []byte
}

// CSVProvider is the route that works: a file out, a file back.
type CSVProvider struct{}

func (CSVProvider) Key() string    { return "csv" }
func (CSVProvider) Label() string  { return "CSV export and import" }
func (CSVProvider) LiveSync() bool { return false }

func (CSVProvider) Push(b Batch) (Receipt, error) {
	out, err := RenderLeadCSV(b.Mappings, b.Leads)
	if err != nil {
		return Receipt{}, err
	}
	return Receipt{
		Filename: "leads-" + b.Provider + ".csv",
		Body:     out,
		Detail: "Upload this in the CRM's bulk import screen. Keep the " +
			ExternalIDColumn + " column: it is what stops the next import creating " +
			"a second lead for the same child.",
	}, nil
}

// ErrCSVPullIsAnUpload says what a CSV pull actually is, rather than returning
// an empty list that reads as "the CRM had nothing".
var ErrCSVPullIsAnUpload = errors.New(
	"a CSV pull is a file upload, not a poll: export the leads from the CRM and " +
		"upload that file here")

func (CSVProvider) Pull(req PullRequest) ([]ImportRow, error) {
	if len(req.File) == 0 {
		return nil, ErrCSVPullIsAnUpload
	}
	return ParseLeadCSV(req.Mappings, req.File)
}

/*
ErrCRMAPIUnavailable is what both live providers return, always, until somebody
configures a real account and implements the calls.

	Deliberately one error for both, and deliberately not a "not implemented"
	that reads like a bug. The reason is the same for Meritto and LeadSquared:
	the API tier is a paid add-on, the key is issued per account, and this
	installation has neither. Saying so is the honest answer; returning an
	empty success is how a school discovers at the end of the admissions season
	that nothing was ever sent.
*/
var ErrCRMAPIUnavailable = errors.New(
	"live CRM sync needs an API key for this school's own Meritto or LeadSquared " +
		"account, which is a paid tier and is not configured on this installation. " +
		"Export the CSV and use the CRM's bulk import instead")

// apiProvider is the shape both live CRMs share today: a name, a label, and a
// refusal. Written once rather than twice so the two cannot drift into one of
// them quietly starting to pretend.
type apiProvider struct {
	key   string
	label string
}

func (p apiProvider) Key() string    { return p.key }
func (p apiProvider) Label() string  { return p.label }
func (apiProvider) LiveSync() bool   { return false }
func (apiProvider) Push(Batch) (Receipt, error) {
	return Receipt{}, ErrCRMAPIUnavailable
}
func (apiProvider) Pull(PullRequest) ([]ImportRow, error) {
	return nil, ErrCRMAPIUnavailable
}

// MerittoAPI and LeadSquaredAPI are placeholders that refuse rather than
// pretend. Neither is wired to a URL: the endpoint differs by data centre and
// guessing one produces a 401 that reads as a bad key.
func MerittoAPI() CRMProvider     { return apiProvider{"meritto", "Meritto API (not available)"} }
func LeadSquaredAPI() CRMProvider { return apiProvider{"leadsquared", "LeadSquared API (not available)"} }

// CRMProviders is every transport the screen may offer.
func CRMProviders() []CRMProvider {
	return []CRMProvider{CSVProvider{}, MerittoAPI(), LeadSquaredAPI()}
}

// CRMProviderFor returns the transport for a stored setting.
//
// Anything but an explicitly live transport falls back to the file, never the
// other way about: an unknown key must not resolve to something that claims to
// reach a CRM.
func CRMProviderFor(transport, provider string) CRMProvider {
	if transport != "api" {
		return CSVProvider{}
	}
	if provider == "leadsquared" {
		return LeadSquaredAPI()
	}
	return MerittoAPI()
}

// CRMSystems is the CRMs this connector knows, for the screen's picker.
var CRMSystems = map[string]string{
	"meritto":     "Meritto (formerly NoPaperForms)",
	"leadsquared": "LeadSquared",
}

// IsCRMSystem guards the provider column before a save reaches the CHECK.
func IsCRMSystem(k string) bool { _, ok := CRMSystems[k]; return ok }
