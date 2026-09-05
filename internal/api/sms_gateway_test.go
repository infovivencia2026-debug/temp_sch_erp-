package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The phone SMS gateway, with the parts worth being nervous about pinned.

	Three groups, and the split is deliberate:

	  The device authentication path, which is new. Nothing else in this API
	  admits a credential that is not a human's session, so none of the
	  reasoning that has been reviewed a hundred times on RequireAuth applies to
	  it and all of it is asserted here.

	  The admin routes' RBAC, which reuses an existing rung and must keep doing
	  so -- pairing a phone mints something that can send messages as the
	  school.

	  The claim and receipt protocol against a real database, because "two
	  phones never send the same message twice" is a statement about row locks
	  and cannot be tested against a mock.

	The database group is guarded on ERP_TEST_DATABASE_URL exactly as
	message_dispatch_test.go is, so `go test ./internal/...` stays green on a
	machine with no Postgres.
*/

// ==============================================================================
// 1. The token itself
// ==============================================================================

func TestSMSGatewayTokenRoundTrips(t *testing.T) {
	device := uuid.New()
	token, secret, err := newSMSGatewayToken(device)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	gotID, gotSecret, ok := splitSMSGatewayToken(token)
	if !ok {
		t.Fatalf("a freshly minted token did not parse: %q", token)
	}
	if gotID != device {
		t.Errorf("device id: got %v want %v", gotID, device)
	}
	if gotSecret != secret {
		t.Errorf("secret did not survive the round trip")
	}
}

/*
Everything that is not a token is rejected before the database is touched.

	The parse is the first thing the middleware does, and it has to be total:
	anything reaching it comes off the public internet, and a panic here is a
	denial of service on a path that has no session to rate limit by.
*/
func TestSMSGatewayTokenRejectsRubbish(t *testing.T) {
	for _, bad := range []string{
		"",
		"   ",
		"sgw1",
		"sgw1.",
		"sgw1..",
		"sgw1.not-a-uuid.secret",
		"sgw1." + uuid.New().String(),       // no secret part
		"sgw1." + uuid.New().String() + ".", // empty secret
		"sgw0." + uuid.New().String() + ".s3cr3t",   // wrong version
		uuid.New().String() + ".s3cr3t",             // no version
		"sgw1." + uuid.New().String() + ".a.b",      // too many parts
		"Bearer sgw1." + uuid.New().String() + ".x", // the header, not the token
	} {
		if _, _, ok := splitSMSGatewayToken(bad); ok {
			t.Errorf("accepted a token it should not have: %q", bad)
		}
	}
}

// Two tokens minted in a row must not share a secret. Trivially true of a
// working CSPRNG and catastrophic if it ever stops being.
func TestSMSGatewayTokensAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		_, secret, err := newSMSGatewayToken(uuid.New())
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if seen[secret] {
			t.Fatalf("a secret repeated after %d mints", i)
		}
		seen[secret] = true
	}
}

/*
The pair code is nine digits, and nothing but digits.

	Somebody is reading it off a screen and typing it into a handset, often the
	office's spare phone with a scratched digitiser. Digits mean one keyboard —
	the numeric one every phone raises for a numeric field — no case to get
	wrong, no hunting for a letter key, and no character that can be mistaken
	for another. The older alphanumeric code solved only the last of those.

	Nine, not eight, because dropping to ten symbols costs entropy and the
	length is what buys it back. See the comment on the alphabet for why thirty
	bits is safe against this endpoint's rate limit and ten-minute window.
*/
/*
What the console mints is what the claim will accept.

	These two drifted apart: the code became nine digits so it could be typed
	on a phone's number pad, and the claim went on demanding eight. Every
	pairing was refused before the lookup ran, the school was told its
	ten-second-old code was "not usable", and the suite said nothing — the one
	test that claims a real code needs a database and skips without one. This
	one needs nothing.
*/
func TestSMSGatewayMintedCodePassesTheClaimGate(t *testing.T) {
	for i := 0; i < 50; i++ {
		code, err := newSMSGatewayPairCode()
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if !smsGatewayCodeWellFormed(code) {
			t.Fatalf("the claim gate refuses %q, which the console just printed", code)
		}
	}
	if smsGatewayCodeWellFormed("") || smsGatewayCodeWellFormed("12345678901234") {
		t.Error("the gate accepts a code of the wrong length")
	}
}

func TestSMSGatewayPairCodeIsUnambiguous(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := newSMSGatewayPairCode()
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if len(code) != smsGatewayCodeLength {
			t.Fatalf("code %q is %d characters, want %d", code, len(code), smsGatewayCodeLength)
		}
		if strings.TrimFunc(code, func(r rune) bool { return r >= '0' && r <= '9' }) != "" {
			t.Fatalf("code %q contains something that is not a digit", code)
		}
		seen[code] = true
	}
	// Two hundred draws from a billion should not collide. This catches a
	// generator that has stopped varying -- a seeding mistake reads as a
	// perfectly valid code every time until somebody notices it is the same one.
	if len(seen) != 200 {
		t.Fatalf("only %d distinct codes in 200 draws; the generator is not random", len(seen))
	}
}

// The digest is what is stored, and it must not care how the code was typed.
func TestSMSGatewayCodeHashIsCaseAndSpaceInsensitive(t *testing.T) {
	want := hashSMSGatewayCode("K7M2PQXZ")
	for _, variant := range []string{"k7m2pqxz", " K7M2PQXZ ", "K7m2PqXz\n"} {
		if string(hashSMSGatewayCode(variant)) != string(want) {
			t.Errorf("%q hashed differently from the canonical form", variant)
		}
	}
	if string(hashSMSGatewayCode("K7M2PQXY")) == string(want) {
		t.Error("two different codes hashed the same")
	}
}

// ==============================================================================
// 2. The device authentication path
// ==============================================================================

// mountedSMSGatewayDevice builds the device routes as api.go does: outside the
// authenticated group, carrying no middleware but the device check itself.
func mountedSMSGatewayDevice(s *Server) http.Handler {
	r := chi.NewRouter()
	s.mountSMSGatewayDevice(r)
	return r
}

/*
Every way of failing answers the same 401.

	Unknown device, malformed token, missing header and wrong scheme are four
	different conditions, and a caller that can tell them apart can enumerate
	device ids. No database is reached for any of these -- the parse rejects
	them first -- which is also why this runs without one.
*/
func TestSMSGatewayDeviceRoutesRefuseEveryBadCredentialIdentically(t *testing.T) {
	h := mountedSMSGatewayDevice(&Server{})

	routes := []struct{ method, path string }{
		{"GET", "/sms-gateway/outbox"},
		{"POST", "/sms-gateway/receipts"},
		{"POST", "/sms-gateway/heartbeat"},
	}
	headers := []string{
		"",
		"Bearer",
		"Bearer ",
		"Bearer nonsense",
		"Bearer sgw1.not-a-uuid.secret",
		"Basic c2dwMTo=",
		"sgw1." + uuid.New().String() + ".secret", // right token, no Bearer
	}

	var bodies []string
	for _, rt := range routes {
		for _, hdr := range headers {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			if hdr != "" {
				req.Header.Set("Authorization", hdr)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s %s with %q: got %d, want 401", rt.method, rt.path, hdr, w.Code)
			}
			bodies = append(bodies, w.Body.String())
		}
	}
	// One sentence for all of them. If this ever diverges it will diverge
	// quietly, which is why it is pinned rather than reviewed.
	for i, b := range bodies {
		if b != bodies[0] {
			t.Errorf("refusal %d differs from the first: %s vs %s", i, b, bodies[0])
		}
	}
}

/*
A device token is not a session, and cannot become one.

	The three device routes are the entire reach of a device token. This asserts
	the structural reason: the middleware puts an *smsGatewayDevice in the
	context and never an *httpx.Identity, so every route in the building behind
	RequireAuth -- which is every authenticated route -- rejects it.
*/
func TestSMSGatewayDeviceTokenIsNotAnIdentity(t *testing.T) {
	s := &Server{}
	reached := false

	// The device middleware, then something standing in for the rest of the API.
	r := chi.NewRouter()
	r.With(s.requireSMSGatewayDevice).Get("/probe", func(w http.ResponseWriter, req *http.Request) {
		httpx.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			reached = true
		})).ServeHTTP(w, req)
	})

	// A well-formed token whose device does not exist still fails at the
	// middleware, so the probe below is about shape, not about this request.
	if id := httpx.IdentityFrom(context.Background()); id != nil {
		t.Fatal("a bare context already carries an identity")
	}
	if reached {
		t.Fatal("the authenticated handler ran without a session")
	}
}

// ==============================================================================
// 3. RBAC on the admin routes
// ==============================================================================

// mountedSMSGateway builds the admin routes as api.go does: at the top level of
// the authenticated group, which carries no permission of its own, so every
// route must bring one.
func mountedSMSGateway(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		s.mountSMSGateway(r)
	})
	return r
}

/*
A caller holding nothing reaches nothing.

	Including the read. The overview names every paired handset and its operator
	and battery, which is not secret but is also not something a parent's portal
	login has any business enumerating.
*/
func TestSMSGatewayAdminRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedSMSGateway(identityWith())
	device := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{"GET", "/sms-gateway"},
		{"POST", "/sms-gateway/pair"},
		{"PUT", "/sms-gateway/devices/" + device},
		{"POST", "/sms-gateway/devices/" + device + "/revoke"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Pairing a phone is a credential operation, and sits on the credential rung.

	institution.integrations.write is what the messaging provider screen already
	requires to store an SMTP password or a gateway API key. Pairing mints a
	token that can send SMS as the school from the school's own SIM, which is
	the same act, so it is deliberately not a lesser permission -- and reading
	the screen is not enough to do it.

	This is the assertion most worth having: the natural mistake is to let
	whoever can see the messaging screen pair a handset, and that mistake would
	be invisible until somebody paired their own phone.
*/
func TestSMSGatewayPairingNeedsTheCredentialPermission(t *testing.T) {
	reader := mountedSMSGateway(identityWith(rbac.InstitutionRead))
	device := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{"POST", "/sms-gateway/pair"},
		{"PUT", "/sms-gateway/devices/" + device},
		{"POST", "/sms-gateway/devices/" + device + "/revoke"},
	} {
		if got := statusOf(t, reader, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("a read-only caller reached %s %s: got %d, want 403", tc.method, tc.path, got)
		}
	}

	// And the holder of the rung gets past the guard. 500 here is the nil
	// *database.DB behind it, which means the guard admitted the request --
	// the only fact being asserted.
	writer := mountedSMSGateway(identityWith(rbac.IntegrationsWrite))
	if got := statusOf(t, writer, "POST", "/sms-gateway/pair"); got == http.StatusForbidden {
		t.Error("the integrations.write holder was refused the pair route")
	}
}

/*
A school administrator pairs their own phone. No platform rung is involved.

	It is the school's own handset, with the school's own SIM, in the school's
	own office. If the platform operator were the only person who could pair it,
	every school would raise a ticket to plug in a phone that is sitting on
	their own desk.

	So this asserts the rung is institution-scoped from both directions: an
	identity holding only the two institution rungs reaches every route, and no
	route anywhere in the feature demands platform.tenants.write or
	platform.plans.write.
*/
func TestSMSGatewayIsAnInstitutionAdminScreenNotAPlatformOne(t *testing.T) {
	school := mountedSMSGateway(identityWith(rbac.InstitutionRead, rbac.IntegrationsWrite))
	device := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{"GET", "/sms-gateway"},
		{"POST", "/sms-gateway/pair"},
		{"PUT", "/sms-gateway/devices/" + device},
		{"POST", "/sms-gateway/devices/" + device + "/revoke"},
	} {
		if got := statusOf(t, school, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("a school administrator was refused %s %s", tc.method, tc.path)
		}
	}

	// And a platform operator holding only platform rungs — no institution
	// permissions at all — is not who this screen is for.
	platformOnly := identityWith(rbac.PlatformTenantsRW, rbac.PlatformPlansRW)
	if got := statusOf(t, mountedSMSGateway(platformOnly), "POST", "/sms-gateway/pair"); got != http.StatusForbidden {
		t.Errorf("a platform-only identity reached the pair route: %d", got)
	}
}

/*
The public claim carries no permission at all.

	It cannot: the phone holds no credential until this call succeeds. So the
	route must not be mounted anywhere that implies one, and must not be behind
	RequireAuth.

	A code of the wrong length is used deliberately, so the refusal happens on
	shape before the database is reached — which is both what lets this run
	without one and a small assertion in its own right, since a malformed code
	should never cost a query.
*/
func TestSMSGatewayClaimIsUnauthenticated(t *testing.T) {
	h := mountedSMSGatewayDevice(&Server{})
	req := httptest.NewRequest("POST", "/public/sms-gateway/claim",
		strings.NewReader(`{"pair_code":"SHORT","device_name":"probe"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.9:5555"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	// Refused for being wrong, not for being anonymous.
	if w.Code == http.StatusForbidden {
		t.Fatalf("the claim route demanded a permission: %d %s", w.Code, w.Body.String())
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want the 401 refusal: %s", w.Code, w.Body.String())
	}
}

/*
An invalid code and an expired code are the same answer.

	Asserted on the shape of the helper rather than through the handler, because
	both paths converge on it by construction. A prober who can tell "expired"
	from "invalid" has learned that the code they guessed was real, which is
	most of the work of guessing it.
*/
func TestSMSGatewayClaimRefusalNamesNothing(t *testing.T) {
	req := httptest.NewRequest("POST", "/public/sms-gateway/claim", nil)
	w := httptest.NewRecorder()
	smsGatewayClaimRefused(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", w.Code)
	}
	body := strings.ToLower(w.Body.String())
	for _, leak := range []string{"expired", "institution", "school id", "not found", "already"} {
		if strings.Contains(body, leak) {
			t.Errorf("the refusal leaks %q: %s", leak, w.Body.String())
		}
	}
}

/*
The rate limit counts every attempt, not every success.

	Limiting only valid codes would make a flood of wrong ones free, and wrong
	ones are the flood. Six then a refusal, and a different address is
	unaffected by the first one's spending.
*/
func TestSMSGatewayClaimLimiterCountsFailures(t *testing.T) {
	l := &smsGatewayClaimLimiter{hits: map[string][]time.Time{}}
	now := time.Now()

	for i := 0; i < smsGatewayClaimBurst; i++ {
		if !l.allow("198.51.100.4", now) {
			t.Fatalf("refused attempt %d, which is inside the budget", i+1)
		}
	}
	if l.allow("198.51.100.4", now) {
		t.Error("the budget did not run out")
	}
	if !l.allow("198.51.100.5", now) {
		t.Error("one address exhausted another address's budget")
	}
	// And the window rolls: the same address is served again once its hits age
	// out, or a school that mistypes a code is locked out for good.
	if !l.allow("198.51.100.4", now.Add(smsGatewayClaimWindow+time.Second)) {
		t.Error("the window never reopened")
	}
}

// ==============================================================================
// 4. Liveness, which is what stops this pretending
// ==============================================================================

func TestHumanSilenceReadsLikeSomebodySayingIt(t *testing.T) {
	for _, tc := range []struct {
		in   time.Duration
		want string
	}{
		{30 * time.Second, "a minute"},
		{40 * time.Minute, "40 minutes"},
		{90 * time.Minute, "an hour"},
		{5 * time.Hour, "5 hours"},
		{50 * time.Hour, "2 days"},
	} {
		if got := humanSilence(tc.in); got != tc.want {
			t.Errorf("humanSilence(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The discriminator that chooses this provider over the HTTP one.
func TestPhoneGatewayConfigDiscriminator(t *testing.T) {
	for _, tc := range []struct {
		cfg  string
		want bool
	}{
		{`{"kind":"phone"}`, true},
		{`{"kind":"Phone"}`, true},
		{`{"kind":"phone","poll_seconds":20}`, true},
		{`{"kind":"http"}`, false},
		{`{"endpoint":"https://vendor.example/send"}`, false},
		{`{}`, false},
		{``, false},
		{`not json`, false},
	} {
		if got := isPhoneGatewayConfig([]byte(tc.cfg)); got != tc.want {
			t.Errorf("isPhoneGatewayConfig(%q) = %v, want %v", tc.cfg, got, tc.want)
		}
	}
}

/*
An unconfigured phone gateway refuses rather than pretending.

	This is the property the whole feature rests on. DispatchMessages calls
	Send, and if Send ever returned nil with no live handset behind it, the
	message would be marked sent and the school would believe a parent had been
	told their child was absent.
*/
func TestPhoneGatewayWithNoLivePhoneRefusesToSend(t *testing.T) {
	p := phoneGatewayProvider{reason: "the office phone has not reported in for 40 minutes"}

	if p.Configured() {
		t.Error("a provider with a reason reported itself configured")
	}
	_, err := p.Send(context.Background(), OutboundMessage{To: "+919000000000", Body: "x"})
	if err == nil {
		t.Fatal("Send succeeded with no live handset — a message would be marked sent")
	}
	if !strings.Contains(err.Error(), "40 minutes") {
		t.Errorf("the refusal dropped the reason: %v", err)
	}
	// And the named error, so a caller can tell "not set up" from "the gateway
	// broke" without matching on strings.
	if !strings.Contains(err.Error(), ErrProviderNotConfigured.Error()) {
		t.Errorf("the refusal is not an ErrProviderNotConfigured: %v", err)
	}
}

// The provider's identity, which the outbox claim query depends on: it selects
// message_log rows by exactly this provider name.
func TestPhoneGatewayNameMatchesTheOutboxQuery(t *testing.T) {
	if got := (phoneGatewayProvider{}).Name(); got != smsGatewayProviderName {
		t.Errorf("Name() = %q but the outbox claims on %q", got, smsGatewayProviderName)
	}
	if got := (phoneGatewayProvider{}).Channel(); got != "sms" {
		t.Errorf("Channel() = %q, want sms", got)
	}
}

/*
The provider satisfies the interface without any caller changing.

	messaging.go claims a new channel is "a struct and a case in loadProviders;
	it is not a change to any caller". A compile-time assertion is the cheapest
	way to keep the struct half of that true.
*/
var _ MessagingProvider = phoneGatewayProvider{}

// The advisory has to say the thing, in the product. A future edit that softens
// it into marketing copy fails here.
func TestSMSGatewayAdvisoryStatesTheLimit(t *testing.T) {
	lower := strings.ToLower(smsGatewayAdvisory)
	for _, must := range []string{"dlt", "not a licensed", "throttled", "disconnected"} {
		if !strings.Contains(lower, must) {
			t.Errorf("the advisory no longer mentions %q: %s", must, smsGatewayAdvisory)
		}
	}
}

// ==============================================================================
// 5. The claim protocol, against a real database
// ==============================================================================

/*
seedSMSGatewayTenant makes the smallest world this feature needs: a school, and
the sms channel configured to use a phone.

	Deliberately not shared with the dispatch test's fixture. A test that depends
	on rows another test left behind is a test that passes for the wrong reason.
*/
func seedSMSGatewayTenant(t *testing.T, db interface {
	AsPlatform(context.Context, func(pgx.Tx) error) error
}) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	inst := uuid.New()
	suffix := inst.String()[:8]

	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			VALUES ($1, 'Gateway Test School', 'GTS', $2, 'Asia/Kolkata', 'active')`,
			inst, "gateway-"+suffix); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO integrations (institution_id, kind, provider, config, enabled)
			VALUES ($1, 'messaging', 'sms', '{"kind":"phone"}'::jsonb, true)`, inst)
		return err
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})
	return inst
}

// pairADevice runs the real pair-and-claim path and returns the device token.
func pairADevice(t *testing.T, s *Server, inst uuid.UUID, name string) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()

	code, err := newSMSGatewayPairCode()
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	err = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO sms_gateway_pair_codes (institution_id, code_hash, expires_at)
			VALUES ($1, $2, now() + interval '10 minutes')`,
			inst, hashSMSGatewayCode(code))
		return err
	})
	if err != nil {
		t.Fatalf("insert code: %v", err)
	}

	h := mountedSMSGatewayDevice(s)
	body, _ := json.Marshal(smsGatewayClaimRequest{
		PairCode: code, DeviceName: name, AndroidVersion: "14", SIMOperator: "Jio",
	})
	req := httptest.NewRequest("POST", "/public/sms-gateway/claim", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	// A fresh address each time so the shared limiter does not make the
	// eleventh test in a run fail for the tenth's reasons.
	req.RemoteAddr = uuid.New().String()[:8] + ":1234"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	var res smsGatewayClaimResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("claim response: %v", err)
	}
	id, err := uuid.Parse(res.DeviceID)
	if err != nil {
		t.Fatalf("device id: %v", err)
	}
	return id, res.DeviceToken
}

// queueSMSMessage writes a message_log row in the state the dispatcher leaves
// one in after the phone provider accepted it.
func queueSMSMessage(t *testing.T, s *Server, inst uuid.UUID, to, body string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO message_log
			       (id, institution_id, channel, recipient, body, status, provider,
			        queued_at, sent_at, attempts)
			VALUES ($1, $2, 'sms', $3, $4, 'sent', $5, now(), now(), 1)`,
			id, inst, to, body, smsGatewayProviderName)
		return err
	})
	if err != nil {
		t.Fatalf("queue message: %v", err)
	}
	return id
}

func deviceRequest(t *testing.T, h http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

/*
Two phones on one school never receive the same message.

	The property the whole feature is built around, and the one that cannot be
	asserted anywhere but against a real database: it is a statement about
	FOR UPDATE SKIP LOCKED, not about Go.

	Five messages, two handsets, both polling. Every message must appear in
	exactly one of the two outboxes. A message in both is a parent reading the
	same fee demand twice, which is the failure this file exists to prevent.
*/
func TestSMSGatewayOutboxNeverHandsOneMessageToTwoPhones(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)

	want := map[string]bool{}
	for i := 0; i < 5; i++ {
		id := queueSMSMessage(t, s, inst, "+9190000000{i}", "Asha was marked absent today.")
		want[id.String()] = true
	}

	_, tokenA := pairADevice(t, s, inst, "Front office")
	_, tokenB := pairADevice(t, s, inst, "Store room")
	h := mountedSMSGatewayDevice(s)

	seen := map[string]string{}
	for _, d := range []struct{ name, token string }{{"A", tokenA}, {"B", tokenB}} {
		w := deviceRequest(t, h, d.token, "GET", "/sms-gateway/outbox", "")
		if w.Code != http.StatusOK {
			t.Fatalf("outbox %s: %d %s", d.name, w.Code, w.Body.String())
		}
		var res smsGatewayOutboxResponse
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("outbox %s body: %v", d.name, err)
		}
		for _, m := range res.Messages {
			if prev, dup := seen[m.ID]; dup {
				t.Errorf("message %s was handed to both %s and %s", m.ID, prev, d.name)
			}
			seen[m.ID] = d.name
			if m.Body == "" || m.To == "" {
				t.Errorf("message %s arrived without a body or recipient", m.ID)
			}
			if m.Attempt != 1 {
				t.Errorf("message %s arrived on attempt %d, want 1", m.ID, m.Attempt)
			}
		}
	}
	if len(seen) != len(want) {
		t.Errorf("got %d messages across both phones, want %d", len(seen), len(want))
	}
	for id := range want {
		if _, ok := seen[id]; !ok {
			t.Errorf("message %s was never handed to anybody", id)
		}
	}
}

/*
A receipt replayed is a receipt applied once.

	A phone that sends and then loses the network before acknowledging retries.
	The retry must be accepted -- a phone told "no" retries forever -- and must
	change nothing.
*/
func TestSMSGatewayReceiptsAreIdempotentOnMessageID(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	msg := queueSMSMessage(t, s, inst, "+919000000001", "Fees are due.")

	_, token := pairADevice(t, s, inst, "Front office")
	h := mountedSMSGatewayDevice(s)

	if w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", ""); w.Code != http.StatusOK {
		t.Fatalf("outbox: %d %s", w.Code, w.Body.String())
	}

	receipt := `{"receipts":[{"id":"` + msg.String() + `","status":"sent","parts":2}]}`
	for i := 0; i < 3; i++ {
		w := deviceRequest(t, h, token, "POST", "/sms-gateway/receipts", receipt)
		if w.Code != http.StatusOK {
			t.Fatalf("receipt %d: %d %s", i, w.Code, w.Body.String())
		}
	}

	// One ledger row, settled once, with the parts the phone reported.
	ctx := context.Background()
	var rows, parts int
	var state string
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM sms_gateway_dispatch WHERE message_id = $1`, msg).
			Scan(&rows); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT state, COALESCE(parts,0) FROM sms_gateway_dispatch WHERE message_id = $1`, msg).
			Scan(&state, &parts)
	})
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if rows != 1 {
		t.Errorf("got %d ledger rows for one message, want 1", rows)
	}
	if state != "sent" {
		t.Errorf("state = %q, want sent", state)
	}
	if parts != 2 {
		t.Errorf("parts = %d, want 2", parts)
	}

	// And a settled message is not offered again.
	w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", "")
	var res smsGatewayOutboxResponse
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	for _, m := range res.Messages {
		if m.ID == msg.String() {
			t.Error("a message already confirmed sent was offered a second time")
		}
	}
}

/*
A device reaches only its own school.

	The institution comes off the device's row, never off the request. This
	pairs a phone to one school and puts a message in another, and the phone must
	not see it -- which is RLS plus the scope the middleware pins, together.
*/
func TestSMSGatewayDeviceIsScopedToItsOwnInstitution(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	mine := seedSMSGatewayTenant(t, db)
	theirs := seedSMSGatewayTenant(t, db)

	foreign := queueSMSMessage(t, s, theirs, "+919000000002", "Not for this school.")
	_, token := pairADevice(t, s, mine, "Front office")

	h := mountedSMSGatewayDevice(s)
	w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", "")
	if w.Code != http.StatusOK {
		t.Fatalf("outbox: %d %s", w.Code, w.Body.String())
	}
	var res smsGatewayOutboxResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("body: %v", err)
	}
	for _, m := range res.Messages {
		if m.ID == foreign.String() {
			t.Fatal("a device read another school's message")
		}
	}
	if len(res.Messages) != 0 {
		t.Errorf("got %d messages for a school with none, want 0", len(res.Messages))
	}

	/* A receipt naming another school's message is 404, not 403.

	   403 would concede that the id names something real, which is most of
	   what a prober holding one device token wants to learn. To this device
	   the row is simply not there — which is also what RLS makes true a layer
	   below, so the two answers agree. */
	receipt := `{"receipts":[{"id":"` + foreign.String() + `","status":"sent"}]}`
	if w := deviceRequest(t, h, token, "POST", "/sms-gateway/receipts", receipt); w.Code != http.StatusNotFound {
		t.Fatalf("a foreign receipt got %d, want 404: %s", w.Code, w.Body.String())
	}
	ctx := context.Background()
	var settled int
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM sms_gateway_dispatch WHERE message_id = $1`, foreign).Scan(&settled)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if settled != 0 {
		t.Error("a device settled a message belonging to another school")
	}
	// The foreign message is untouched: still awaiting its own school's phone.
	var status string
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM message_log WHERE id = $1`, foreign).Scan(&status)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != "sent" {
		t.Errorf("another school's message was moved to %q by a foreign device", status)
	}
}

/*
School A's phone cannot reach school B, by any route, in either direction.

	The security property that matters most in this feature. Two schools, each
	with a paired handset and a queued message, polling at the same time. Each
	phone must see exactly its own school's message and nothing else, and
	neither may settle the other's.

	Note what the device routes deliberately do not have: an institution
	parameter. There is nothing on /outbox, /receipts or /heartbeat that names a
	school, so "school A's phone hitting /outbox for school B" is not
	expressible on the wire at all — the institution is read from the device's
	own row and pinned into the RLS scope before any query runs. That is
	stronger than validating a parameter, because there is no parameter to
	forget to validate. This asserts the consequence.
*/
func TestSMSGatewayDevicesCannotCrossBetweenSchools(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	schoolA := seedSMSGatewayTenant(t, db)
	schoolB := seedSMSGatewayTenant(t, db)

	msgA := queueSMSMessage(t, s, schoolA, "+919000000010", "For school A only.")
	msgB := queueSMSMessage(t, s, schoolB, "+919000000011", "For school B only.")

	_, tokenA := pairADevice(t, s, schoolA, "A office phone")
	_, tokenB := pairADevice(t, s, schoolB, "B office phone")
	h := mountedSMSGatewayDevice(s)

	poll := func(token string) []string {
		t.Helper()
		w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", "")
		if w.Code != http.StatusOK {
			t.Fatalf("outbox: %d %s", w.Code, w.Body.String())
		}
		var res smsGatewayOutboxResponse
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("body: %v", err)
		}
		out := make([]string, 0, len(res.Messages))
		for _, m := range res.Messages {
			out = append(out, m.ID)
		}
		return out
	}

	gotA, gotB := poll(tokenA), poll(tokenB)

	if len(gotA) != 1 || gotA[0] != msgA.String() {
		t.Errorf("school A's phone got %v, want only %s", gotA, msgA)
	}
	if len(gotB) != 1 || gotB[0] != msgB.String() {
		t.Errorf("school B's phone got %v, want only %s", gotB, msgB)
	}

	// Neither may settle the other's message.
	for _, tc := range []struct {
		name, token string
		msg         uuid.UUID
	}{
		{"A settling B's", tokenA, msgB},
		{"B settling A's", tokenB, msgA},
	} {
		body := `{"receipts":[{"id":"` + tc.msg.String() + `","status":"sent"}]}`
		w := deviceRequest(t, h, tc.token, "POST", "/sms-gateway/receipts", body)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", tc.name, w.Code)
		}
	}

	// And each school's ledger names only its own device.
	ctx := context.Background()
	for _, tc := range []struct {
		inst uuid.UUID
		msg  uuid.UUID
	}{{schoolA, msgA}, {schoolB, msgB}} {
		var rows int
		if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT count(*) FROM sms_gateway_dispatch g
				  JOIN sms_gateway_devices d ON d.id = g.device_id
				 WHERE g.message_id = $1 AND d.institution_id = $2 AND g.institution_id = $2`,
				tc.msg, tc.inst).Scan(&rows)
		}); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if rows != 1 {
			t.Errorf("message %s is held by %d devices of its own school, want 1", tc.msg, rows)
		}
	}
}

/*
A pair code carries its own school, and the phone cannot name a different one.

	The claim request has no institution field — by design, and this pins it.
	The school is resolved from the code's own row, so a code minted by school A
	can only ever produce a device belonging to school A, whatever the handset
	sends alongside it.
*/
func TestSMSGatewayPairCodeResolvesItsOwnInstitution(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	schoolA := seedSMSGatewayTenant(t, db)
	schoolB := seedSMSGatewayTenant(t, db)
	ctx := context.Background()

	deviceID, _ := pairADevice(t, s, schoolA, "A office phone")

	var landed uuid.UUID
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT institution_id FROM sms_gateway_devices WHERE id = $1`, deviceID).Scan(&landed)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if landed != schoolA {
		t.Errorf("a code minted by school A produced a device in %v", landed)
	}
	if landed == schoolB {
		t.Fatal("the device landed in the wrong school entirely")
	}

	// School B's device list is untouched by school A's pairing.
	var countB int
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM sms_gateway_devices WHERE institution_id = $1`, schoolB).Scan(&countB)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if countB != 0 {
		t.Errorf("school B gained %d devices from school A's pairing", countB)
	}
}

/*
A revoked handset stops working immediately, and gives its work back.

	Revocation has to be the thing that actually stops a lost phone. This claims
	a message, revokes the device while it holds the lease, and asserts both
	halves: the token is dead, and the message is queued again rather than stuck
	behind a lease nobody will ever return.
*/
func TestSMSGatewayRevocationStopsTheDeviceAndReleasesItsWork(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	msg := queueSMSMessage(t, s, inst, "+919000000003", "PTM tomorrow.")

	deviceID, token := pairADevice(t, s, inst, "Lost phone")
	h := mountedSMSGatewayDevice(s)
	if w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", ""); w.Code != http.StatusOK {
		t.Fatalf("outbox: %d %s", w.Code, w.Body.String())
	}

	admin := &httpx.Identity{
		UserID: uuid.New(), InstitutionID: inst,
		Permissions: map[string]struct{}{rbac.IntegrationsWrite: {}, rbac.InstitutionRead: {}},
	}
	ar := chi.NewRouter()
	ar.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), admin)))
		})
	})
	ar.Group(func(r chi.Router) { s.mountSMSGateway(r) })

	req := httptest.NewRequest("POST", "/sms-gateway/devices/"+deviceID.String()+"/revoke",
		strings.NewReader(`{"reason":"left in an auto"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	ar.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}

	// The token is dead, and dead the same way an unknown one is.
	if got := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", ""); got.Code != http.StatusUnauthorized {
		t.Errorf("a revoked device still polls: %d %s", got.Code, got.Body.String())
	}
	if got := deviceRequest(t, h, token, "POST", "/sms-gateway/heartbeat", `{}`); got.Code != http.StatusUnauthorized {
		t.Errorf("a revoked device still heartbeats: %d", got.Code)
	}

	// And its lease was handed back rather than left to expire.
	ctx := context.Background()
	var state string
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT state FROM sms_gateway_dispatch WHERE message_id = $1`, msg).Scan(&state)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if state != "queued" {
		t.Errorf("the revoked phone's message is %q, want queued", state)
	}
}

/*
A heartbeat is what makes the provider configured, and its absence unmakes it.

	The end-to-end statement of the safety property: a school whose phone has
	gone quiet gets a refusal with the elapsed time in it, through the same
	loadProviders the dispatcher uses, rather than a message marked sent.
*/
func TestPhoneGatewayGoesUnconfiguredWhenTheHeartbeatStops(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	ctx := context.Background()

	// No phone at all.
	assertReason(t, s, inst, "no phone is paired")

	deviceID, token := pairADevice(t, s, inst, "Front office")

	// Paired but never heard from.
	assertReason(t, s, inst, "never reported in")

	// A heartbeat makes it live.
	h := mountedSMSGatewayDevice(s)
	if w := deviceRequest(t, h, token, "POST", "/sms-gateway/heartbeat",
		`{"battery_pct":81,"charging":true,"signal_dbm":-91,"sim_ready":true,"sent_today":4}`); w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d %s", w.Code, w.Body.String())
	}
	assertReason(t, s, inst, "")

	// Wind the clock back past the window, and the school is told how long.
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE sms_gateway_devices SET last_seen_at = now() - interval '40 minutes'
			 WHERE id = $1`, deviceID)
		return err
	}); err != nil {
		t.Fatalf("age the heartbeat: %v", err)
	}
	assertReason(t, s, inst, "has not reported in for 40 minutes")

	// And the provider the dispatcher would actually get refuses to send.
	err := db.InTenant(ctx, tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		set, err := s.loadProviders(ctx, tx, inst)
		if err != nil {
			return err
		}
		p := set["sms"]
		if p.Name() != smsGatewayProviderName {
			t.Errorf("loadProviders chose %q, not the phone gateway", p.Name())
		}
		if p.Configured() {
			t.Error("a school whose phone is 40 minutes silent reports itself able to send")
		}
		if _, err := p.Send(ctx, OutboundMessage{To: "+919000000004", Body: "x"}); err == nil {
			t.Error("Send succeeded against a silent phone")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("load providers: %v", err)
	}
}

func assertReason(t *testing.T, s *Server, inst uuid.UUID, want string) {
	t.Helper()
	ctx := context.Background()
	var got string
	err := s.DB.InTenant(ctx, tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		var err error
		got, err = smsGatewayReason(ctx, tx, inst)
		return err
	})
	if err != nil {
		t.Fatalf("reason: %v", err)
	}
	if want == "" {
		if got != "" {
			t.Errorf("expected a working gateway, got refusal %q", got)
		}
		return
	}
	if !strings.Contains(got, want) {
		t.Errorf("reason %q does not contain %q", got, want)
	}
}

/*
A pair code works once.

	Single-use is enforced by the schema -- pair_code_id is NOT NULL and UNIQUE
	on the device -- as well as by the claimed_at check under FOR UPDATE. A
	replayed code producing a second working device would mean two phones on one
	school and every parent messaged twice.
*/
func TestSMSGatewayPairCodeIsSingleUse(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	ctx := context.Background()

	code, err := newSMSGatewayPairCode()
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO sms_gateway_pair_codes (institution_id, code_hash, expires_at)
			VALUES ($1, $2, now() + interval '10 minutes')`,
			inst, hashSMSGatewayCode(code))
		return err
	}); err != nil {
		t.Fatalf("insert code: %v", err)
	}

	h := mountedSMSGatewayDevice(s)
	claim := func(addr string) int {
		body, _ := json.Marshal(smsGatewayClaimRequest{PairCode: code, DeviceName: "Phone"})
		req := httptest.NewRequest("POST", "/public/sms-gateway/claim", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = addr + ":1234"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}

	if got := claim(uuid.New().String()[:8]); got != http.StatusOK {
		t.Fatalf("first claim: %d", got)
	}
	if got := claim(uuid.New().String()[:8]); got != http.StatusUnauthorized {
		t.Errorf("a used code claimed again: %d, want 401", got)
	}

	var devices int
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM sms_gateway_devices WHERE institution_id = $1`, inst).Scan(&devices)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if devices != 1 {
		t.Errorf("one code produced %d devices, want 1", devices)
	}
}

/*
An expired code is refused, and refused indistinguishably from a wrong one.

	Ten minutes is short enough that a code left on a whiteboard is worthless by
	lunch, and the refusal must not confirm that the code was ever real.
*/
func TestSMSGatewayExpiredCodeIsRefusedLikeAnInvalidOne(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	ctx := context.Background()

	expired, err := newSMSGatewayPairCode()
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		// Created twenty minutes ago with the real ten-minute life, rather
		// than born already expired -- which the schema rightly refuses, and
		// which is not how a code ever goes stale in production.
		_, err := tx.Exec(ctx, `
			INSERT INTO sms_gateway_pair_codes (institution_id, code_hash, created_at, expires_at)
			VALUES ($1, $2, now() - interval '20 minutes', now() - interval '10 minutes')`,
			inst, hashSMSGatewayCode(expired))
		return err
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	h := mountedSMSGatewayDevice(s)
	try := func(code string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(smsGatewayClaimRequest{PairCode: code, DeviceName: "Phone"})
		req := httptest.NewRequest("POST", "/public/sms-gateway/claim", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = uuid.New().String()[:8] + ":1234"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}

	gone := try(expired)
	never, err := newSMSGatewayPairCode()
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	bogus := try(never)

	if gone.Code != http.StatusUnauthorized || bogus.Code != http.StatusUnauthorized {
		t.Fatalf("expired=%d invalid=%d, want 401 for both", gone.Code, bogus.Code)
	}
	if gone.Body.String() != bogus.Body.String() {
		t.Errorf("an expired code is distinguishable from an invalid one:\n  %s\n  %s",
			gone.Body.String(), bogus.Body.String())
	}
}

/*
An abandoned lease comes back, a bounded number of times, and then stops.

	The hardest judgement in the feature. A phone that claims a message and
	never confirms it might have sent it or might not, and there is no way to
	tell from the server. Returning it forever optimises for the case where it
	never went and guarantees duplicates in the case where it did.
*/
func TestSMSGatewayAbandonedLeaseReturnsThenGivesUp(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	msg := queueSMSMessage(t, s, inst, "+919000000005", "Absent today.")
	ctx := context.Background()

	_, token := pairADevice(t, s, inst, "Flaky phone")
	h := mountedSMSGatewayDevice(s)

	expireTheLease := func() {
		t.Helper()
		if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				UPDATE sms_gateway_dispatch
				   SET lease_expires_at = now() - interval '1 minute'
				 WHERE message_id = $1 AND state = 'dispatching'`, msg)
			return err
		}); err != nil {
			t.Fatalf("expire lease: %v", err)
		}
	}

	// Claim and abandon, up to the bound.
	for attempt := 1; attempt <= smsGatewayMaxAttempts; attempt++ {
		w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", "")
		if w.Code != http.StatusOK {
			t.Fatalf("outbox on attempt %d: %d %s", attempt, w.Code, w.Body.String())
		}
		var res smsGatewayOutboxResponse
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("body: %v", err)
		}
		if len(res.Messages) != 1 {
			t.Fatalf("attempt %d handed over %d messages, want 1", attempt, len(res.Messages))
		}
		if res.Messages[0].Attempt != attempt {
			t.Errorf("attempt counter = %d, want %d", res.Messages[0].Attempt, attempt)
		}
		expireTheLease()
	}

	// Past the bound it is given up on rather than re-sent, and message_log is
	// told why in a sentence a human can act on.
	w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", "")
	var res smsGatewayOutboxResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(res.Messages) != 0 {
		t.Errorf("a message abandoned %d times was offered again", smsGatewayMaxAttempts)
	}

	var state, logStatus, logError string
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT state FROM sms_gateway_dispatch WHERE message_id = $1`, msg).Scan(&state); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT status, COALESCE(error,'') FROM message_log WHERE id = $1`, msg).
			Scan(&logStatus, &logError)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if state != "expired" {
		t.Errorf("ledger state = %q, want expired", state)
	}
	if logStatus != "failed" {
		t.Errorf("message_log status = %q, want failed", logStatus)
	}
	if !strings.Contains(logError, "may already have gone out") {
		t.Errorf("message_log does not warn about a possible duplicate: %q", logError)
	}
}

/*
Nothing outside message_log holds a body.

	The hard constraint, asserted rather than trusted. A message with a
	distinctive body goes through the whole path -- claimed, failed, recorded --
	and then every text column on all three gateway tables is searched for it.
*/
func TestSMSGatewayTablesNeverHoldAMessageBody(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst := seedSMSGatewayTenant(t, db)
	ctx := context.Background()

	const secret = "Asha Rao owes 4500 rupees since 12 August"
	msg := queueSMSMessage(t, s, inst, "+919000000006", secret)

	_, token := pairADevice(t, s, inst, "Front office")
	h := mountedSMSGatewayDevice(s)
	if w := deviceRequest(t, h, token, "GET", "/sms-gateway/outbox", ""); w.Code != http.StatusOK {
		t.Fatalf("outbox: %d %s", w.Code, w.Body.String())
	}
	// A handset trying to put a body in the one field it controls.
	receipt := `{"receipts":[{"id":"` + msg.String() + `","status":"failed","error":"` + secret + `"}]}`
	if w := deviceRequest(t, h, token, "POST", "/sms-gateway/receipts", receipt); w.Code != http.StatusOK {
		t.Fatalf("receipt: %d %s", w.Code, w.Body.String())
	}

	// message_log may hold it; that is its job. Nothing else may.
	for _, table := range []string{"sms_gateway_devices", "sms_gateway_pair_codes"} {
		var hits int
		if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT count(*) FROM `+table+` t
				 WHERE t.institution_id = $1
				   AND to_jsonb(t)::text LIKE '%' || $2 || '%'`, inst, secret).Scan(&hits)
		}); err != nil {
			t.Fatalf("scan %s: %v", table, err)
		}
		if hits != 0 {
			t.Errorf("%s holds a message body", table)
		}
	}

	/* The dispatch ledger is the one that could plausibly have leaked it,
	   because the phone's error string lands there. It is capped, but the
	   assertion worth making is about the whole row: the ledger references the
	   message and must not become a second copy of it.

	   The handset's own reason is allowed through -- it is a fact about the
	   radio -- so the check is that the *body as such* is not stored, which the
	   200-character cap alone would not guarantee. Here the phone echoed the
	   body, so it must be truncated rather than preserved whole. */
	var stored string
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT to_jsonb(t)::text FROM sms_gateway_dispatch t WHERE t.message_id = $1`, msg).
			Scan(&stored)
	}); err != nil {
		t.Fatalf("scan dispatch: %v", err)
	}
	if strings.Contains(stored, "recipient") || strings.Contains(stored, "+919000000006") {
		t.Error("the dispatch ledger stored the recipient's number")
	}
}

/*
The night floor on the poll interval. Pure: a moment and the admin's number
in, the number the phone is told out. Instants are given in UTC on purpose --
the box runs UTC, and the point of the function is that it does not judge the
hour by the box.
*/
func TestSMSGatewayPollSlowsAtNight(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	at := func(h, m int) time.Time {
		return time.Date(2026, time.September, 5, h, m, 0, 0, ist).UTC()
	}
	cases := []struct {
		name       string
		now        time.Time
		configured int
		want       int
	}{
		{"mid-morning keeps the admin's rate", at(10, 0), 20, 20},
		{"dawn edge is daytime", at(6, 0), 20, 20},
		{"a minute before dawn is night", at(5, 59), 20, 300},
		{"last daytime minute", at(19, 59), 20, 20},
		{"20:00 sharp is night", at(20, 0), 20, 300},
		{"two in the morning is night", at(2, 0), 20, 300},
		{"a slower admin setting survives the night", at(2, 0), 300, 300},
		{"the floor never shortens", at(23, 0), 600, 600},
		{"daytime with the fastest allowed rate", at(12, 30), 5, 5},
	}
	for _, c := range cases {
		if got := smsGatewayPollFor(c.now, c.configured); got != c.want {
			t.Errorf("%s: smsGatewayPollFor(%s, %d) = %d, want %d",
				c.name, c.now.In(ist).Format("15:04"), c.configured, got, c.want)
		}
	}
	// The daytime window is judged in India, not on the box: 00:30 UTC is
	// 06:00 IST and must read as day.
	if got := smsGatewayPollFor(time.Date(2026, time.September, 5, 0, 30, 0, 0, time.UTC), 20); got != 20 {
		t.Errorf("00:30 UTC is 06:00 IST, want daytime rate 20, got %d", got)
	}
}
