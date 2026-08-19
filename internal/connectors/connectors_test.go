package connectors

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func at(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 9, 0, 0, 0, time.UTC)
}

func ptr(t time.Time) *time.Time { return &t }

func standardMappings() []Mapping {
	return []Mapping{
		{LocalField: "student_name", CRMField: "mx_Child_Name", Direction: "both", Required: true},
		{LocalField: "phone", CRMField: "Phone", Direction: "both", Required: true},
		{LocalField: "class_sought", CRMField: "mx_Class_Sought", Direction: "push"},
		{LocalField: "status", CRMField: "ProspectStage", Direction: "pull"},
	}
}

/*
The assertion this whole connector rests on.

	Two syncs of the same data must not produce two leads. A school with
	duplicate leads has two counsellors ringing the same parent, which is worse
	than having no integration at all — and it is not prevented by care at the
	call site, it is prevented by keying on a stable external id and making the
	second pass a no-op before anything is written.
*/
func TestASecondImportOfTheSameFileChangesNothing(t *testing.T) {
	rows := []ImportRow{
		{Line: 2, ExternalID: "LSQ-1", RemoteUpdated: ptr(at(2026, time.June, 1))},
		{Line: 3, ExternalID: "LSQ-2", RemoteUpdated: ptr(at(2026, time.June, 2))},
	}

	// First pass: nothing is linked, so both are creates.
	for _, row := range rows {
		if got, _ := DecideImport(row, nil, "flag"); got != ActionCreate {
			t.Fatalf("first import of %s: got %s, want %s", row.ExternalID, got, ActionCreate)
		}
	}

	// The run links them and stamps last_synced_at after the remote clock.
	synced := at(2026, time.June, 3)
	for _, row := range rows {
		link := &Link{EnquiryID: "e-" + row.ExternalID, LastSynced: &synced,
			LocalUpdated: ptr(at(2026, time.June, 1))}
		got, why := DecideImport(row, link, "flag")
		if got != ActionSkip {
			t.Fatalf("second import of %s: got %s (%s), want %s — this is a duplicate lead",
				row.ExternalID, got, why, ActionSkip)
		}
	}
}

// And the same in the other direction: a nightly push must not re-upload the
// enquiry book every night.
func TestASecondPushOfAnUnchangedLeadIsSkipped(t *testing.T) {
	lead := Lead{EnquiryID: "e1", ExternalID: "LSQ-1", UpdatedAt: at(2026, time.June, 1)}

	if got, _ := DecidePush(lead, nil); got != ActionCreate {
		t.Fatalf("never-pushed lead: got %s, want %s", got, ActionCreate)
	}

	synced := at(2026, time.June, 2)
	if got, _ := DecidePush(lead, &Link{EnquiryID: "e1", LastSynced: &synced}); got != ActionSkip {
		t.Fatalf("unchanged lead pushed again: got %s, want %s", got, ActionSkip)
	}

	// Edited since, so it goes out as an update against the SAME external id —
	// never as a second create.
	lead.UpdatedAt = at(2026, time.June, 5)
	if got, _ := DecidePush(lead, &Link{EnquiryID: "e1", LastSynced: &synced}); got != ActionUpdate {
		t.Fatalf("edited lead: got %s, want %s", got, ActionUpdate)
	}
}

// A row with no external id cannot be matched and must not be guessed at.
func TestARowWithNoExternalIdFails(t *testing.T) {
	got, why := DecideImport(ImportRow{Line: 7}, nil, "flag")
	if got != ActionFail {
		t.Fatalf("got %s, want %s", got, ActionFail)
	}
	if !strings.Contains(why, "7") {
		t.Errorf("the message does not name the row: %q", why)
	}
}

// Both sides moved: every policy, including the one that decides nothing.
func TestConflictPolicies(t *testing.T) {
	synced := at(2026, time.June, 1)
	row := ImportRow{Line: 2, ExternalID: "LSQ-1", RemoteUpdated: ptr(at(2026, time.June, 4))}
	link := func(local time.Time) *Link {
		return &Link{EnquiryID: "e1", LastSynced: &synced, LocalUpdated: &local}
	}

	for _, tc := range []struct {
		policy string
		local  time.Time
		want   Action
	}{
		{"flag", at(2026, time.June, 3), ActionConflict},
		{"theirs", at(2026, time.June, 3), ActionUpdate},
		{"ours", at(2026, time.June, 3), ActionSkip},
		// newest: ours is later, so ours stands.
		{"newest", at(2026, time.June, 6), ActionSkip},
		// newest: theirs is later.
		{"newest", at(2026, time.June, 2), ActionUpdate},
	} {
		if got, _ := DecideImport(row, link(tc.local), tc.policy); got != tc.want {
			t.Errorf("policy %s, local %s: got %s, want %s",
				tc.policy, tc.local.Format("2 Jan"), got, tc.want)
		}
	}
}

// An unknown remote timestamp is treated as a change. The other reading —
// assume unchanged — silently drops a counsellor's edit.
func TestAnUnknownRemoteClockIsTreatedAsChanged(t *testing.T) {
	synced := at(2026, time.June, 1)
	row := ImportRow{Line: 2, ExternalID: "LSQ-1"} // no RemoteUpdated
	link := &Link{EnquiryID: "e1", LastSynced: &synced, LocalUpdated: &synced}
	if got, _ := DecideImport(row, link, "theirs"); got == ActionSkip {
		t.Error("a row with no timestamp was skipped; an edit would be lost")
	}
}

/*
The round trip, which is what the whole CSV route is.

	The file goes to the CRM, the CRM gives it back with its own ids and a
	changed status, and the external id survives. If it does not survive, every
	returning row reads as new.
*/
func TestTheExternalIdSurvivesTheRoundTrip(t *testing.T) {
	ms := standardMappings()
	out, err := RenderLeadCSV(ms, []Lead{{
		EnquiryID: "e1", ExternalID: "LSQ-1",
		Values: map[string]string{"student_name": "Aarav Sharma", "phone": "9876543210",
			"class_sought": "Class 1"},
	}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	head := strings.SplitN(string(out), "\n", 2)[0]
	if !strings.HasPrefix(head, ExternalIDColumn+","+EnquiryIDColumn) {
		t.Fatalf("the id columns are not first: %q", head)
	}
	// Only push-direction fields go out; ProspectStage is pull-only.
	if strings.Contains(head, "ProspectStage") {
		t.Errorf("a pull-only field was exported: %q", head)
	}

	back := "external_id,enquiry_id,Phone,ProspectStage\nLSQ-1,e1,9876543210,Application Started\n"
	rows, err := ParseLeadCSV(ms, []byte(back))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].ExternalID != "LSQ-1" || rows[0].EnquiryID != "e1" {
		t.Fatalf("ids lost: %+v", rows[0])
	}
	if rows[0].Values["status"] != "Application Started" {
		t.Errorf("status did not map back: %+v", rows[0].Values)
	}
	// A push-only field must not be read back in.
	if _, ok := rows[0].Values["class_sought"]; ok {
		t.Error("a push-only field was imported")
	}
	if rows[0].Line != 2 {
		t.Errorf("line %d, want 2", rows[0].Line)
	}
}

// A file without the id column is refused, and the refusal explains the
// consequence rather than saying "invalid".
func TestAFileWithoutTheIdColumnIsRefused(t *testing.T) {
	_, err := ParseLeadCSV(standardMappings(), []byte("Phone,ProspectStage\n99,New\n"))
	if err == nil {
		t.Fatal("a file with no external_id column was accepted")
	}
	if !strings.Contains(err.Error(), ExternalIDColumn) {
		t.Errorf("the message does not name the column: %v", err)
	}
}

func TestARequiredFieldBlocksTheExport(t *testing.T) {
	_, err := RenderLeadCSV(standardMappings(), []Lead{{
		EnquiryID: "e1",
		Values:    map[string]string{"student_name": "Aarav Sharma"}, // no phone
	}})
	if err == nil {
		t.Fatal("a lead missing a required field was exported")
	}
	if !strings.Contains(err.Error(), "e1") {
		t.Errorf("the message does not name the lead: %v", err)
	}
}

func TestNothingMappedIsRefusedBeforeAnyLeadIsRead(t *testing.T) {
	if _, err := RenderLeadCSV(nil, []Lead{{EnquiryID: "e1"}}); !errors.Is(err, ErrNothingMapped) {
		t.Fatalf("got %v, want ErrNothingMapped", err)
	}
}

/*
The refusal, pinned.

	This is the test that matters most in the file, and it is here so a later
	edit cannot quietly turn "we cannot reach the CRM" into an empty success. An
	empty success is the shape a school discovers at the end of the admissions
	season, when nothing was ever sent and there is no error anywhere to explain
	it.
*/
func TestTheLiveCRMProvidersAlwaysRefuse(t *testing.T) {
	batch := Batch{Provider: "meritto", Mappings: standardMappings(),
		Leads: []Lead{{EnquiryID: "e1", Values: map[string]string{
			"student_name": "Aarav Sharma", "phone": "9876543210"}}}}

	for _, p := range []CRMProvider{MerittoAPI(), LeadSquaredAPI()} {
		if p.LiveSync() {
			t.Errorf("%s claims a live sync", p.Key())
		}
		if _, err := p.Push(batch); !errors.Is(err, ErrCRMAPIUnavailable) {
			t.Errorf("%s.Push: got %v, want ErrCRMAPIUnavailable", p.Key(), err)
		}
		if _, err := p.Pull(PullRequest{Provider: p.Key()}); !errors.Is(err, ErrCRMAPIUnavailable) {
			t.Errorf("%s.Pull: got %v, want ErrCRMAPIUnavailable", p.Key(), err)
		}
	}

	// And no provider anywhere in the list claims to be live, which is what
	// the screen reads to decide what it may promise.
	for _, p := range CRMProviders() {
		if p.LiveSync() {
			t.Errorf("%s claims a live sync; no far end exists on this deployment", p.Key())
		}
	}
}

// An unknown transport must resolve to the file, never to something that
// claims to reach a CRM.
func TestAnUnknownTransportFallsBackToTheFile(t *testing.T) {
	if got := CRMProviderFor("something-else", "meritto").Key(); got != "csv" {
		t.Fatalf("got %q, want csv", got)
	}
	if got := CRMProviderFor("api", "leadsquared").Key(); got != "leadsquared" {
		t.Fatalf("got %q, want leadsquared", got)
	}
}

func TestACSVPullWithNoFileSaysWhatAPullIs(t *testing.T) {
	_, err := CSVProvider{}.Pull(PullRequest{Mappings: standardMappings()})
	if !errors.Is(err, ErrCSVPullIsAnUpload) {
		t.Fatalf("got %v, want ErrCSVPullIsAnUpload", err)
	}
}

// --- the meeting seam --------------------------------------------------------

/*
The same refusal, for the same reason, on the other connector.

	A launcher that invents a plausible meeting URL sends thirty children to a
	room that does not exist, and the failure surfaces at 9am on the day rather
	than when the row was written.
*/
func TestTheLiveMeetingProvidersAlwaysRefuse(t *testing.T) {
	req := MeetingRequest{SessionID: "s1", Topic: "Fractions", Minutes: 40,
		StartsAt: at(2026, time.July, 1), ManualJoinURL: "https://zoom.us/j/999"}

	for _, p := range MeetingProviders() {
		if p.LiveCreate() {
			t.Errorf("%s claims to create meetings; no credential exists here", p.Key())
		}
		if p.Key() == "manual" {
			continue
		}
		m, err := p.Create(req)
		if !errors.Is(err, ErrMeetingAPIUnavailable) {
			t.Errorf("%s.Create: got %v, want ErrMeetingAPIUnavailable", p.Key(), err)
		}
		// And it must not have echoed the pasted link back as its own work.
		if m.JoinURL != "" {
			t.Errorf("%s returned a join URL it did not create: %q", p.Key(), m.JoinURL)
		}
	}
}

// The pasted link keeps working. It is the fallback and it stays the fallback.
func TestThePastedLinkStillWorks(t *testing.T) {
	m, err := ManualMeetingProvider{}.Create(MeetingRequest{
		SessionID: "s1", ManualJoinURL: " https://meet.google.com/abc-defg-hij "})
	if err != nil {
		t.Fatalf("manual: %v", err)
	}
	if m.JoinURL != "https://meet.google.com/abc-defg-hij" {
		t.Fatalf("join url %q", m.JoinURL)
	}
	if m.Status != "manual" {
		t.Errorf("status %q, want manual", m.Status)
	}
}

func TestTheManualProviderRefusesSomethingThatIsNotALink(t *testing.T) {
	manual := ManualMeetingProvider{}
	if _, err := manual.Create(MeetingRequest{SessionID: "s1"}); !errors.Is(err, ErrManualJoinURLRequired) {
		t.Fatalf("empty link: got %v, want ErrManualJoinURLRequired", err)
	}
	if _, err := manual.Create(MeetingRequest{
		SessionID: "s1", ManualJoinURL: "ask Priya for the link"}); err == nil {
		t.Fatal("a sentence was accepted as a meeting link")
	}
}

// An unknown provider key falls back to the manual route, never to one that
// claims to create meetings.
func TestAnUnknownMeetingProviderFallsBackToManual(t *testing.T) {
	if got := MeetingProviderFor("webex").Key(); got != "manual" {
		t.Fatalf("got %q, want manual", got)
	}
	if got := MeetingProviderFor("zoom").Key(); got != "zoom" {
		t.Fatalf("got %q, want zoom", got)
	}
}

// The field list here and the CHECK in the migration must agree; a field this
// package cannot read is a mapping that fails at run time rather than at save.
func TestEveryLeadFieldHasALabel(t *testing.T) {
	for _, f := range LeadFields {
		if LeadFieldLabels[f] == "" {
			t.Errorf("%s has no label", f)
		}
		if !IsLeadField(f) {
			t.Errorf("%s is not accepted by IsLeadField", f)
		}
	}
	if IsLeadField("aadhaar_no") {
		t.Error("IsLeadField accepted a field no mapping may name")
	}
}
