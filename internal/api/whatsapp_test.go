package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The three things about WhatsApp that will break quietly if nobody pins them.

	No live call to Meta can succeed on this machine -- there is no token, and
	there is deliberately no way to put one in a test. So what is asserted here
	is what can be asserted without one, which is more than it sounds:

	  1. The unconfigured state is honest. Without a token the provider refuses
	     by name, before any network call, and says what is missing. This is
	     the same shape tally.go and connectors.go pin for their own far ends.

	  2. The request shape is right. body() is separated from Send() precisely
	     so the exact JSON Meta will receive can be compared against Meta's
	     documented contract without a wire.

	  3. Free text is refused. This is the one that would otherwise ship
	     working and fail for every real parent: a {"type":"text"} send passes
	     any local test and is rejected outside the 24-hour window, which every
	     message this product sends is.

	And beside them the allowlist, whose whole value is that it fails closed --
	a guard that silently defaults to "allow" is worse than no guard, because
	somebody believes it is on.
*/

// --- the unconfigured state --------------------------------------------------

func TestWhatsAppRefusesWithoutAToken(t *testing.T) {
	p := whatsappCloudProvider{cfg: whatsappCloudSettings{PhoneNumberID: "1133027929890477"}}

	if p.Configured() {
		t.Fatal("a provider with no access token reports itself configured")
	}
	if !strings.Contains(p.Why(), "token") {
		t.Errorf("Why() = %q, want a sentence naming the missing token", p.Why())
	}

	_, err := p.Send(context.Background(), OutboundMessage{To: "+919100575183", Body: "hello"})
	if !errors.Is(err, ErrProviderNotConfigured) {
		t.Fatalf("Send err = %v, want ErrProviderNotConfigured", err)
	}
	// The refusal must be by name, not by a network call that happens to fail:
	// a machine with no route to graph.facebook.com must report the missing
	// token, not a DNS error.
	if strings.Contains(err.Error(), "graph.facebook.com") {
		t.Errorf("Send err = %v, want a refusal before any network call", err)
	}
}

func TestWhatsAppRefusesAPhoneNumberInPlaceOfThePhoneNumberID(t *testing.T) {
	p := whatsappCloudProvider{
		cfg:   whatsappCloudSettings{PhoneNumberID: "+91 8121306701"},
		token: "not-a-real-token",
	}
	if p.Configured() {
		t.Fatal("a phone number was accepted as a phone number id")
	}
	if !strings.Contains(p.Why(), "numeric id") {
		t.Errorf("Why() = %q, want it to name the confusion", p.Why())
	}
}

func TestWhatsAppEndpointUsesTheConfiguredNumberAndVersion(t *testing.T) {
	p := whatsappCloudProvider{cfg: whatsappCloudSettings{PhoneNumberID: "1133027929890477"}}
	if got, want := p.waEndpoint(),
		"https://graph.facebook.com/v21.0/1133027929890477/messages"; got != want {
		t.Errorf("endpoint = %q, want %q", got, want)
	}
	p.cfg.APIVersion = "v22.0"
	if !strings.Contains(p.waEndpoint(), "/v22.0/") {
		t.Errorf("endpoint = %q, want the configured version", p.waEndpoint())
	}
}

// --- the wire contract -------------------------------------------------------

/*
The template body, compared against Meta's documented shape.

	Every field here is one Meta rejects the request without. Asserting the
	whole marshalled object rather than a field at a time is deliberate: the
	failure this guards against is a field quietly dropped in a refactor, and a
	per-field assertion passes when a sibling disappears.
*/
func TestWhatsAppSendsAnApprovedTemplate(t *testing.T) {
	p := whatsappCloudProvider{
		cfg:   whatsappCloudSettings{PhoneNumberID: "1133027929890477"},
		token: "x",
	}
	body, err := p.body("919100575183", OutboundMessage{
		Body: "the rendered body, which a template send does not carry",
		WA: &whatsappTemplateSend{
			Name:     "absence_alert",
			Language: "te",
			Params:   []string{"Asha Rao", "19 August"},
		},
	})
	if err != nil {
		t.Fatalf("body: %v", err)
	}

	raw, _ := json.Marshal(body)
	const want = `{"messaging_product":"whatsapp",` +
		`"template":{"components":[{"parameters":[{"text":"Asha Rao","type":"text"},` +
		`{"text":"19 August","type":"text"}],"type":"body"}],` +
		`"language":{"code":"te"},"name":"absence_alert"},` +
		`"to":"919100575183","type":"template"}`
	if string(raw) != want {
		t.Errorf("request body\n got %s\nwant %s", raw, want)
	}
}

// A template with no parameters must not carry an empty components array:
// Meta answers that with 132000, which reads as a parameter count mismatch and
// sends an administrator looking at the wrong thing.
func TestWhatsAppOmitsComponentsForATemplateWithNoParameters(t *testing.T) {
	p := whatsappCloudProvider{
		cfg:   whatsappCloudSettings{PhoneNumberID: "1", DefaultLanguage: "en_US"},
		token: "x",
	}
	body, err := p.body("919100575183", OutboundMessage{
		WA: &whatsappTemplateSend{Name: "holiday_notice"},
	})
	if err != nil {
		t.Fatalf("body: %v", err)
	}
	tmpl := body["template"].(map[string]any)
	if _, present := tmpl["components"]; present {
		t.Error("components was sent for a template with no parameters")
	}
	// The account's default language fills in when the mapping names none.
	if got := tmpl["language"].(map[string]any)["code"]; got != "en_US" {
		t.Errorf("language = %v, want the configured default en_US", got)
	}
}

/*
The refusal that matters most: free text, with no window to send it in.

	A naive provider POSTs {"type":"text"} and passes every test anybody would
	think to write here. It is then rejected for every real parent, because
	free text is permitted only inside 24 hours of that parent's own inbound
	message and no parent messages the school first. This product has no
	inbound webhook, so it cannot demonstrate an open window for anybody --
	and a path whose precondition cannot be checked is not a path.
*/
func TestWhatsAppRefusesFreeTextWhenNoTemplateIsMapped(t *testing.T) {
	p := whatsappCloudProvider{
		cfg:   whatsappCloudSettings{PhoneNumberID: "1133027929890477"},
		token: "a-token",
	}
	_, err := p.body("919100575183", OutboundMessage{Body: "Your fees are overdue."})
	if err == nil {
		t.Fatal("a free-text WhatsApp send was allowed with no approved template")
	}
	if !errors.Is(err, ErrProviderNotConfigured) {
		t.Errorf("err = %v, want ErrProviderNotConfigured so the screen reads it as setup, not a fault", err)
	}
	for _, want := range []string{"24-hour", "approved template"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to mention %q", err, want)
		}
	}
}

// Free text is reachable only when a human deliberately switched it on, and
// even then it is the exception rather than the shape the product uses.
func TestWhatsAppFreeTextIsReachableOnlyDeliberately(t *testing.T) {
	p := whatsappCloudProvider{
		cfg:   whatsappCloudSettings{PhoneNumberID: "1", AllowFreeText: true},
		token: "x",
	}
	body, err := p.body("919100575183", OutboundMessage{Body: "hello"})
	if err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["type"] != "text" {
		t.Errorf("type = %v, want text once the school has switched it on", body["type"])
	}
}

// --- Meta's errors -----------------------------------------------------------

/*
Four problems, four fixes, four different people who can apply them.

	"send failed" is the answer that helps nobody. A revoked token looks
	exactly like an outage for the fortnight nobody checks it, and a paused
	template looks exactly like a revoked token.
*/
func TestMetaErrorsAreExplained(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		want string
	}{
		{"revoked token", 190, "generate a new long-lived System User token"},
		{"template not approved", 132001, "no such approved template in that language"},
		{"number not registered", 133010, "not registered on the WhatsApp Business platform"},
		{"quota spent", 4, "request quota for this hour is spent"},
		{"outside the window", 131047, "outside the 24-hour window"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(`{"error":{"message":"Meta's own words","type":"OAuthException","code":` +
				itoa(tc.code) + `,"error_subcode":33,"fbtrace_id":"Axb1"}}`)
			err := explainMetaError(http.StatusBadRequest, raw)
			if err == nil {
				t.Fatal("no error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %q, want it to contain %q", err, tc.want)
			}
			// The vendor's own message and the trace id survive: they are what
			// Meta's support will ask for, and a log line without them means
			// asking the school to reproduce the failure.
			if !strings.Contains(err.Error(), "Meta's own words") ||
				!strings.Contains(err.Error(), "Axb1") {
				t.Errorf("err = %q, want the vendor message and fbtrace_id kept", err)
			}
		})
	}
}

// A proxy or a captive portal answering in HTML is reported as what it is,
// rather than being guessed at as one of Meta's codes.
func TestMetaErrorHandlesAnAnswerThatIsNotMetas(t *testing.T) {
	err := explainMetaError(502, []byte("<html>Bad Gateway</html>"))
	if err == nil || !strings.Contains(err.Error(), "not an error object") {
		t.Errorf("err = %v, want it to say the answer was not an error object", err)
	}
}

func TestWhatsAppRejectsA200WithNoMessageID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"messaging_product":"whatsapp"}`)
	}))
	defer srv.Close()

	p := whatsappCloudProvider{
		cfg:    whatsappCloudSettings{PhoneNumberID: "1"},
		token:  "x",
		client: srv.Client(),
	}
	// Point the provider at the stub by overriding the version segment is not
	// possible, so the request is made through body() + the stub's client
	// against the stub's URL via a hand-built round trip.
	p.client = &http.Client{Transport: rewriteTo(srv.URL)}

	if _, err := p.Send(context.Background(), OutboundMessage{
		To: "+919100575183",
		WA: &whatsappTemplateSend{Name: "t", Language: "en"},
	}); err == nil || !strings.Contains(err.Error(), "cannot be confirmed") {
		t.Errorf("err = %v, want a refusal to record an unconfirmed send as sent", err)
	}
}

// rewriteTo sends every request to a local stub instead of graph.facebook.com,
// so the real endpoint is never contacted from a test.
type rewriter struct{ base string }

func (rw rewriter) RoundTrip(r *http.Request) (*http.Response, error) {
	u := *r.URL
	stub, err := http.NewRequest(r.Method, rw.base+u.Path, r.Body)
	if err != nil {
		return nil, err
	}
	stub.Header = r.Header
	return http.DefaultTransport.RoundTrip(stub)
}

func rewriteTo(base string) http.RoundTripper { return rewriter{base: base} }

// --- normalisation -----------------------------------------------------------

/*
One number, however it was typed.

	The school's allowlist entry is +91 9100575183. A guardian record holds
	9100575183, an imported spreadsheet holds 919100575183, and somebody typed
	the third. If those are three entries then the guard half-works, which is
	the worst state for a guard to be in: it appears configured and lets things
	through.
*/
func TestPhoneNumbersNormaliseToOneEntry(t *testing.T) {
	same := []string{
		"9100575183", "+919100575183", "919100575183",
		"+91 91005 75183", "091 00575183", "0091-9100575183",
	}
	want := "919100575183"
	for _, in := range same {
		if got := waNormalisePhone(in); got != want {
			t.Errorf("waNormalisePhone(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUnreadableNumbersAreRefusedRatherThanGuessed(t *testing.T) {
	// A number this cannot read must not be prefixed into somebody else's.
	for _, in := range []string{"", "abc", "12345", "1234567890", "9"} {
		if got := waNormalisePhone(in); got != "" {
			t.Errorf("waNormalisePhone(%q) = %q, want a refusal", in, got)
		}
	}
}

// --- the guard ---------------------------------------------------------------

/*
The default is the safe one, and this is the assertion that proves it.

	A school that has never opened the screen has no policy row and no
	entries. If that ever comes to mean "send to everybody" it will do so
	silently, on the first scheduled sweep, to every parent in the school.
*/
func TestAnUnconfiguredSchoolSendsToNobody(t *testing.T) {
	g := recipientGuard{Mode: "allowlist", allowed: map[string]bool{}}

	for _, ch := range []string{"sms", "whatsapp", "email", "push"} {
		ok, why := g.permits(ch, "+919876543210")
		if ok {
			t.Errorf("%s: an unconfigured school was allowed to send", ch)
		}
		if !strings.Contains(why, "allowlist") {
			t.Errorf("%s: reason = %q, want it to name the allowlist", ch, why)
		}
	}
}

// The guard covers every channel that leaves the building. A guard on one
// channel is not a guard.
func TestTheGuardAppliesToEveryOutboundChannel(t *testing.T) {
	g := recipientGuard{
		Mode:    "allowlist",
		allowed: map[string]bool{"phone:919100575183": true},
	}

	for _, ch := range []string{"sms", "whatsapp", "push"} {
		if ok, _ := g.permits(ch, "9876543210"); ok {
			t.Errorf("%s: a number that is not on the list was allowed", ch)
		}
		// The one number on the list goes out, however it was written.
		for _, form := range []string{"9100575183", "+919100575183", "919100575183"} {
			if ok, why := g.permits(ch, form); !ok {
				t.Errorf("%s: %q was refused (%s), want it allowed", ch, form, why)
			}
		}
	}
	if ok, _ := g.permits("email", "office@school.edu.in"); ok {
		t.Error("email: an address that is not on the list was allowed")
	}
	g.allowed["email:office@school.edu.in"] = true
	if ok, _ := g.permits("email", "Office@School.edu.in"); !ok {
		t.Error("email: the listed address was refused because of its capitals")
	}
}

// in_app is the one exemption, and it is exempt because nothing leaves the
// building: the message_log row is the delivery, read inside the product by a
// signed-in user of the same school. No charge, no phone, no family messaged.
func TestInAppIsNotGuarded(t *testing.T) {
	g := recipientGuard{Mode: "allowlist", allowed: map[string]bool{}}
	if ok, _ := g.permits("in_app", uuid.NewString()); !ok {
		t.Error("in-app delivery was suppressed; it never leaves the building")
	}
}

func TestEveryoneModeTurnsTheGuardOff(t *testing.T) {
	g := recipientGuard{Mode: "everyone", allowed: map[string]bool{}}
	if ok, _ := g.permits("sms", "+919876543210"); !ok {
		t.Error("a school that deliberately went live was still guarded")
	}
}

/*
The guard on the real dispatcher, against a real database.

	The unit tests above prove permits() decides correctly. This proves the
	decision is actually taken on the path every message travels -- the one the
	scheduler drives every five minutes -- and that a held message is left
	visible rather than dropped. Those are different claims, and it is the
	second that fails silently when somebody moves the check.

	Guarded on ERP_TEST_DATABASE_URL like the rest of the dispatch tests, so
	`go test ./internal/...` stays green on a machine with no Postgres.
*/
func TestTheDispatcherSuppressesARecipientNotOnTheAllowlist(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst, _ := seedTenant(t, db)
	ctx := context.Background()

	queue := func(to string) {
		t.Helper()
		if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO message_log (institution_id, channel, recipient, body, status)
				VALUES ($1,'sms',$2,'body','queued')`, inst, to)
			return err
		}); err != nil {
			t.Fatalf("queue: %v", err)
		}
	}

	// No policy row and no entries: the state every school is in the moment
	// this ships. Nothing may go out.
	queue("+919876543210")
	if _, _, err := s.DispatchMessages(ctx, inst, false, 50); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	rows := readLog(t, db, inst)
	if len(rows) != 1 || rows[0].Status != "suppressed" {
		t.Fatalf("rows = %+v, want one suppressed row", rows)
	}
	if rows[0].Error == nil || !strings.Contains(*rows[0].Error, "not on the allowlist") {
		t.Errorf("error = %v, want the reason recorded against the message", rows[0].Error)
	}

	// The school adds the one number it is allowed to reach, in a different
	// form from the one the message carries.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO messaging_allowed_recipients (institution_id, kind, raw, normalised)
			VALUES ($1,'phone','+91 91005 75183','919100575183')`, inst)
		return err
	}); err != nil {
		t.Fatalf("allow: %v", err)
	}

	queue("9100575183")
	if _, _, err := s.DispatchMessages(ctx, inst, false, 50); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	for _, r := range readLog(t, db, inst) {
		if r.Recipient == "9100575183" && r.Status == "suppressed" {
			t.Error("the allowlisted number was suppressed; the forms did not normalise to one entry")
		}
	}
}

/*
One school's allowlist cannot widen another's.

	A guard one tenant can edit for another is not a guard. The list is read
	inside the dispatcher's own tenant transaction, filtered on the
	institution the dispatch is for, and the table carries FORCE ROW LEVEL
	SECURITY on top of that -- but "it should be fine, RLS is on" is exactly
	the reasoning that produces a cross-tenant read, so it is pinned.

	The assertion is the strong direction: school B permits nobody even though
	school A has permitted this very number. If the guard ever read across
	tenants, B would start sending.
*/
func TestOneSchoolsAllowlistDoesNotReachAnother(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	a, _ := seedTenant(t, db)
	b, _ := seedTenant(t, db)
	ctx := context.Background()

	if err := db.InTenant(ctx, database.Scope{InstitutionID: a}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO messaging_allowed_recipients (institution_id, kind, raw, normalised)
			VALUES ($1,'phone','+919100575183','919100575183')`, a)
		return err
	}); err != nil {
		t.Fatalf("allow for A: %v", err)
	}

	var ga, gb recipientGuard
	if err := db.InTenant(ctx, database.Scope{InstitutionID: a}, func(tx pgx.Tx) error {
		var err error
		ga, err = s.loadRecipientGuard(ctx, tx, a)
		return err
	}); err != nil {
		t.Fatalf("guard A: %v", err)
	}
	if err := db.InTenant(ctx, database.Scope{InstitutionID: b}, func(tx pgx.Tx) error {
		var err error
		gb, err = s.loadRecipientGuard(ctx, tx, b)
		return err
	}); err != nil {
		t.Fatalf("guard B: %v", err)
	}

	if ok, _ := ga.permits("whatsapp", "9100575183"); !ok {
		t.Error("school A cannot reach the number it allowed")
	}
	if ok, _ := gb.permits("whatsapp", "9100575183"); ok {
		t.Error("school B inherited school A's allowlist entry")
	}
	if gb.Mode != "allowlist" {
		t.Errorf("school B mode = %q, want the fail-closed default", gb.Mode)
	}
}

// --- authorization -----------------------------------------------------------

func mountedWhatsApp(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountWhatsApp(r) })
	return r
}

var whatsappRoutes = []struct{ method, path string }{
	{http.MethodGet, "/whatsapp/settings"},
	{http.MethodPut, "/whatsapp/settings"},
	{http.MethodDelete, "/whatsapp/settings"},
	{http.MethodPost, "/whatsapp/test"},
	{http.MethodGet, "/whatsapp/templates"},
	{http.MethodPut, "/whatsapp/templates"},
	{http.MethodGet, "/whatsapp/log"},
	{http.MethodGet, "/messaging/recipients"},
	{http.MethodPut, "/messaging/recipients/mode"},
	{http.MethodPost, "/messaging/recipients"},
	{http.MethodDelete, "/messaging/recipients/" + uuid.NewString()},
}

// A caller holding nothing reaches nothing. Every route brings its own
// permission, because the /admin group api.go mounts these under carries none.
func TestWhatsAppRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedWhatsApp(identityWith())
	for _, tc := range whatsappRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Reading the configuration is not permission to change the account.

	The access token this screen holds can send from the school's own WhatsApp
	number to any parent in it. A teacher who can read the institution must not
	be able to replace it, nor to turn the recipient guard off -- which is the
	single most consequential switch on the screen.
*/
func TestWhatsAppWritesNeedMoreThanRead(t *testing.T) {
	h := mountedWhatsApp(identityWith(rbac.InstitutionRead))

	for _, tc := range []struct{ method, path string }{
		{http.MethodPut, "/whatsapp/settings"},
		{http.MethodDelete, "/whatsapp/settings"},
		{http.MethodPost, "/whatsapp/test"},
		{http.MethodPut, "/whatsapp/templates"},
		{http.MethodPut, "/messaging/recipients/mode"},
		{http.MethodPost, "/messaging/recipients"},
		{http.MethodDelete, "/messaging/recipients/" + uuid.NewString()},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s = %d for a read-only caller, want 403", tc.method, tc.path, got)
		}
	}
	// ...and reading is genuinely allowed, or the test above proves nothing.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/whatsapp/settings"},
		{http.MethodGet, "/whatsapp/templates"},
		{http.MethodGet, "/messaging/recipients"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s = 403 for institution.read, want it allowed", tc.method, tc.path)
		}
	}
}

/*
Turning the guard off takes more than a click.

	The confirmation is checked on the server. A dialog in the browser is not
	a control -- it is a suggestion the next caller ignores -- and the action
	it guards reaches every family the school has on file.
*/
func TestTurningTheGuardOffNeedsAnExplicitConfirmation(t *testing.T) {
	h := mountedWhatsApp(identityWith(rbac.IntegrationsWrite))

	req := httptest.NewRequest(http.MethodPut, "/messaging/recipients/mode",
		strings.NewReader(`{"mode":"everyone"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d without a confirmation, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "every real parent") {
		t.Errorf("body = %s, want it to say what is about to happen", w.Body.String())
	}
}

// --- the template mapping ----------------------------------------------------

func TestPlaceholdersAreListedInOrderOnceEach(t *testing.T) {
	got := templatePlaceholders(
		"Dear parent, {{student_name}} was absent on {{on_date}}. — {{school_name}} ({{student_name}})")
	want := []string{"student_name", "on_date", "school_name"}
	if len(got) != len(want) {
		t.Fatalf("placeholders = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("placeholders = %v, want %v", got, want)
		}
	}
}

// WhatsApp rejects a parameter containing a newline, a tab or four consecutive
// spaces with 132007, which reads as a template format violation and sends an
// administrator looking at the approved template rather than at the value.
func TestTemplateParametersAreFlattened(t *testing.T) {
	if got := waCleanParam("  Asha\n\tRao    Kumari "); got != "Asha Rao Kumari" {
		t.Errorf("waCleanParam = %q, want %q", got, "Asha Rao Kumari")
	}
}
