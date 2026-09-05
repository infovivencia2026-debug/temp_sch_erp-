package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Two groups, for the reason hr_growth_test.go has two.

	The first needs no database. It covers the pieces that decide whether a
	fix is believed at all — the haversine, the token split, the pair-code
	alphabet — and walks the real device router, because a route added to
	mountBusTrackerDevice later without the middleware would otherwise be
	an unauthenticated write of a school bus's position.

	The second needs a real Postgres and is skipped without TEST_DATABASE_URL.
	Everything it asserts is a property of a unique index or of SQL under row
	level security — single-use codes, idempotent batches, one arrival per
	stop — and a fake would only prove the fake works.
*/

// --- geometry, no database needed --------------------------------------------

/*
The haversine against distances that can be checked by hand.

	The second assertion is the one with teeth. The cheap approximation treats
	a degree of longitude as the same metres as a degree of latitude, which at
	Hyderabad's latitude overstates east-west distance by about 5%. On a 120m
	geofence that is the difference between a bus that arrived and a bus that
	did not, so this test fails if anybody ever "simplifies" the function.
*/
func TestMetresBetweenIsHaversineNotEquirectangular(t *testing.T) {
	const degreeOfLatitude = 111194.9 // 6371008.8 m * pi/180

	got := metresBetween(17.0, 78.0, 18.0, 78.0)
	if math.Abs(got-degreeOfLatitude) > 100 {
		t.Errorf("one degree of latitude: got %.0f m, want ~%.0f m", got, degreeOfLatitude)
	}

	// A degree of longitude at 17.5N is the same arc shrunk by cos(17.5).
	want := degreeOfLatitude * math.Cos(17.5*math.Pi/180)
	east := metresBetween(17.5, 78.0, 17.5, 79.0)
	if math.Abs(east-want) > 200 {
		t.Errorf("one degree of longitude at 17.5N: got %.0f m, want ~%.0f m", east, want)
	}
	if degreeOfLatitude-east < 4000 {
		t.Errorf("east-west distance %.0f m is not shrunk by the cosine of the latitude — "+
			"this looks like the equirectangular approximation the comment warns about", east)
	}

	if d := metresBetween(17.385, 78.4867, 17.385, 78.4867); d != 0 {
		t.Errorf("a point from itself: got %.6f m, want 0", d)
	}
	// Antipodal-ish inputs are where an unclamped Asin returns NaN.
	if d := metresBetween(-89.999999, 0, 89.999999, 180); math.IsNaN(d) {
		t.Error("antipodal points produced NaN; the clamp before Asin is gone")
	}
	// Symmetric, because the geofence walk and the parent's distance read call
	// it with the arguments in opposite orders.
	a := metresBetween(17.4, 78.4, 17.45, 78.46)
	b := metresBetween(17.45, 78.46, 17.4, 78.4)
	if math.Abs(a-b) > 1e-6 {
		t.Errorf("not symmetric: %.6f vs %.6f", a, b)
	}
}

// --- credentials, no database needed -----------------------------------------

func TestBusTrackerTokenRoundTrips(t *testing.T) {
	device := uuid.New()
	token, secret, err := newBusTrackerToken(device)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	gotID, gotSecret, ok := splitBusTrackerToken(token)
	if !ok {
		t.Fatalf("a freshly minted token was rejected: %q", token)
	}
	if gotID != device {
		t.Errorf("device id: got %s, want %s", gotID, device)
	}
	if gotSecret != secret {
		t.Errorf("secret: got %q, want %q", gotSecret, secret)
	}
	// Two handsets paired a moment apart must not share a credential.
	other, _, err := newBusTrackerToken(device)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if other == token {
		t.Error("two mints for the same device produced the same token")
	}
}

func TestSplitBusTrackerTokenRejectsMalformedTokens(t *testing.T) {
	device := uuid.New().String()
	for _, tc := range []struct{ name, token string }{
		{"empty", ""},
		{"no prefix", device + ".abc"},
		{"wrong prefix", "smsgw." + device + ".abc"},
		{"prefix only", busTrackerTokenPrefix},
		{"middle is not a uuid", busTrackerTokenPrefix + ".not-a-uuid.abc"},
		{"empty secret", busTrackerTokenPrefix + "." + device + "."},
		{"too many parts", busTrackerTokenPrefix + "." + device + ".abc.def"},
		{"too few parts", busTrackerTokenPrefix + "." + device},
	} {
		if _, _, ok := splitBusTrackerToken(tc.token); ok {
			t.Errorf("%s: %q was accepted", tc.name, tc.token)
		}
	}
	// Surrounding whitespace survives a copy-paste out of a support chat.
	if _, _, ok := splitBusTrackerToken("  " + busTrackerTokenPrefix + "." + device + ".s3cret\n"); !ok {
		t.Error("a token with surrounding whitespace was rejected")
	}
}

/*
The code is read off one screen and typed into another.

	Nine digits, the same shape the SMS gateway uses, so a school setting up
	both is not typing two different kinds of code. Digits also mean there is
	nothing to confuse for anything: the letter alphabet this replaces was
	unambiguous to read and still a layout switch per character to type.
*/
func TestBusTrackerPairCodeShapeAndAlphabet(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := newBusTrackerPairCode()
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if len(code) != busTrackerCodeLength {
			t.Fatalf("code %q is %d characters, want %d", code, len(code), busTrackerCodeLength)
		}
		if strings.TrimFunc(code, func(r rune) bool { return r >= '0' && r <= '9' }) != "" {
			t.Fatalf("code %q contains something that is not a digit", code)
		}
		seen[code] = true
	}
	// Two hundred draws from a billion should not collide. A generator that
	// has stopped varying reads as a perfectly valid code every time.
	if len(seen) != 200 {
		t.Errorf("only %d distinct codes in 200 draws", len(seen))
	}
}

// A driver types the code in lower case with a trailing space, and it has to
// pair. The hash is the lookup key, so this is the only place that can forgive
// it.
func TestHashBusTrackerCodeIgnoresCaseAndWhitespace(t *testing.T) {
	want := hashBusTrackerCode("A2C4E6G8")
	for _, variant := range []string{"a2c4e6g8", " A2C4E6G8 ", "\ta2c4e6g8\n", "A2c4E6g8"} {
		if got := hashBusTrackerCode(variant); string(got) != string(want) {
			t.Errorf("%q hashed differently from the code it is", variant)
		}
	}
	if string(hashBusTrackerCode("A2C4E6G9")) == string(want) {
		t.Error("two different codes hashed the same")
	}
	// Inner spacing is not whitespace a person adds by accident, and folding it
	// would make two distinct codes collide.
	if string(hashBusTrackerCode("A2C4 E6G8")) == string(want) {
		t.Error("inner whitespace was folded; two distinct codes now collide")
	}
}

// --- the device router, no database needed -----------------------------------

// busTrackerDeviceRouter builds the tree exactly as api.go will: outside the
// authenticated group, because a handset holds no session.
func busTrackerDeviceRouter(s *Server) http.Handler {
	r := chi.NewRouter()
	s.mountBusTrackerDevice(r)
	return r
}

// busTrackerCall issues one request, optionally bearing a device token, and
// reports what the router produced. A handler that gets past the middleware
// reaches a nil *database.DB and panics; that is recovered and reported as 500,
// because for the walk below it means the same thing as any other non-401 —
// the guard let the request through.
func busTrackerCall(t *testing.T, h http.Handler, method, path, token, body string) (int, map[string]any) {
	t.Helper()
	return busTrackerCallFrom(t, h, busTestCallerAddress(t), method, path, token, body)
}

/*
busTestCallerAddress is the network a test's handset calls from.

	The claim is limited per caller address, six in ten minutes, and
	httptest.NewRequest gives every request the same 192.0.2.1. While the
	limiter was a package variable that meant the seventh claim in a `go test`
	process — the third test to call pairAndClaim, or the second -count run of
	the first — was refused with a 429 that had nothing to do with the test
	asserting it. The limiter now counts in the Server's own store (see
	ratelimits.go), which isolates tests that build their own Server; this
	isolates the key as well, so a shared Server, a repeated run in one
	process, or a store that outlives the process (RATE_LIMIT_STORE=postgres)
	still cannot hand one test another's attempts.

	Each *testing.T gets its own address, made up once and forgotten when the
	test ends. The limiter itself is not disabled:
	TestBusTrackerClaimIsRateLimitedPerAddress below still proves it bites.
*/
var busTestCallers sync.Map // *testing.T -> string

func busTestCallerAddress(t *testing.T) string {
	if v, ok := busTestCallers.Load(t); ok {
		return v.(string)
	}
	// callerAddress only splits host from port, so the host need not parse
	// as an IP; a fresh token per test is what matters.
	v, loaded := busTestCallers.LoadOrStore(t, "test-"+uuid.NewString()[:8]+":1234")
	if !loaded {
		t.Cleanup(func() { busTestCallers.Delete(t) })
	}
	return v.(string)
}

// busTrackerCallFrom is busTrackerCall with the caller's address chosen by
// the test, for the one test that wants the limiter to see the same network
// more than six times.
func busTrackerCallFrom(t *testing.T, h http.Handler, remoteAddr, method, path, token, body string) (int, map[string]any) {
	t.Helper()
	return busTrackerCallWith(t, h, remoteAddr, nil, method, path, token, body)
}

// busTrackerCallWith is the one that builds the request; headers beyond the
// bearer token -- the driver's X-Staff-Session -- are the caller's to add.
func busTrackerCallWith(t *testing.T, h http.Handler, remoteAddr string, headers map[string]string,
	method, path, token, body string) (int, map[string]any) {
	t.Helper()
	type result struct {
		code int
		out  map[string]any
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- result{http.StatusInternalServerError, nil}
			}
		}()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = remoteAddr
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		out := map[string]any{}
		if w.Body.Len() > 0 {
			_ = json.Unmarshal(w.Body.Bytes(), &out)
		}
		done <- result{w.Code, out}
	}()
	r := <-done
	return r.code, r.out
}

/*
Every device route refuses an unauthenticated caller, and says 401 saying it.

	The walk is over the real router rather than a written-down list, so a route
	added to mountBusTrackerDevice later without the middleware fails here. The
	status matters as much as the refusal: 403 would tell the phone it is paired
	but not allowed, and 500 would send somebody out to look at a handset that
	is fine. Only 401 means "pair again", which is the one thing the app can do.
*/
func TestBusTrackerDeviceRoutesRefuseAnUnauthenticatedCaller(t *testing.T) {
	s := &Server{}
	h := busTrackerDeviceRouter(s)

	probe := chi.NewRouter()
	s.mountBusTrackerDevice(probe)

	walked := 0
	err := chi.Walk(probe, func(method, route string, _ http.Handler,
		_ ...func(http.Handler) http.Handler) error {
		/* The two public doors, and they are public because they are the
		   only way a phone can ever get a token in the first place.

		   /claim carries a pair code and /enrol carries a phone number and a
		   PIN. Both authenticate, just not with a device token they do not yet
		   have, and both are rate limited per address in the handler. Every
		   OTHER route on this mount must refuse an unauthenticated caller, and
		   that is what the walk below is for. */
		if route == "/public/bus-tracker/claim" || route == "/public/bus-tracker/enrol" {
			return nil
		}
		walked++
		path := strings.ReplaceAll(route, "{id}", uuid.NewString())
		code, _ := busTrackerCall(t, h, method, path, "", `{}`)
		if code != http.StatusUnauthorized {
			t.Errorf("%s %s with no token: got %d, want 401", method, path, code)
		}
		// A token that is merely malformed must fail the same way, and before
		// the handler reaches a database.
		code, _ = busTrackerCall(t, h, method, path, "bustrk.not-a-uuid.x", `{}`)
		if code != http.StatusUnauthorized {
			t.Errorf("%s %s with a malformed token: got %d, want 401", method, path, code)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if walked == 0 {
		t.Fatal("no device routes were walked; the mount is empty or the router changed shape")
	}
}

/*
The public claim is limited per caller network, and the limit is the SMS
gateway's: six attempts in ten minutes, every attempt counted.

	No database: a bad code is refused before the handler needs one, and a
	refusal counts exactly as a success would, because a flood of wrong codes
	is the flood the limiter exists for. The address is this test's own, so the
	count starts at zero here and no other test inherits what it spends.
*/
func TestBusTrackerClaimIsRateLimitedPerAddress(t *testing.T) {
	h := busTrackerDeviceRouter(&Server{})
	addr := busTestCallerAddress(t)
	for i := 1; i <= smsGatewayClaimBurst; i++ {
		code, _ := busTrackerCallFrom(t, h, addr, http.MethodPost, "/public/bus-tracker/claim", "", `{}`)
		if code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d, want 401 (not yet limited)", i, code)
		}
	}
	code, body := busTrackerCallFrom(t, h, addr, http.MethodPost, "/public/bus-tracker/claim", "", `{}`)
	if code != http.StatusTooManyRequests {
		t.Fatalf("attempt %d: got %d, want 429", smsGatewayClaimBurst+1, code)
	}
	if e, _ := body["error"].(map[string]any); e == nil || e["code"] != "rate_limited" {
		t.Errorf("the refusal answered %v, not rate_limited", body["error"])
	}
	// Another network is not punished for this one's attempts.
	code, _ = busTrackerCallFrom(t, h, "198.51.100.7:1234", http.MethodPost,
		"/public/bus-tracker/claim", "", `{}`)
	if code != http.StatusUnauthorized {
		t.Errorf("a different address: got %d, want 401", code)
	}
}

// The claim is the one route with no credential at all — the handset has none
// until it succeeds — so it must not be behind the token check.
func TestBusTrackerClaimIsReachableWithoutAToken(t *testing.T) {
	h := busTrackerDeviceRouter(&Server{})
	code, _ := busTrackerCall(t, h, http.MethodPost, "/public/bus-tracker/claim",
		"", `{"pair_code":"A2C4E6G8"}`)
	if code == http.StatusUnauthorized {
		t.Error("the claim was refused for want of a token; a phone can never pair")
	}
	// An empty code is refused by the handler rather than by the router, and
	// says as little as an expired one: a caller guessing eight characters must
	// not learn that they were close.
	code, body := busTrackerCall(t, h, http.MethodPost, "/public/bus-tracker/claim", "", `{}`)
	if code != http.StatusUnauthorized {
		t.Errorf("an empty pair code: got %d, want 401", code)
	}
	if e, _ := body["error"].(map[string]any); e == nil || e["code"] != "bad_pair_code" {
		t.Errorf("an empty pair code answered %v, not bad_pair_code", body["error"])
	}
}

// --- staleness ---------------------------------------------------------------

// Three missed pings plus a margin. One missed push is a tunnel; three is a
// phone that has stopped, and the screens must not colour that one live.
func TestStaleAfterIsThreePingsAndAMargin(t *testing.T) {
	for _, tc := range []struct {
		ping int
		want time.Duration
	}{
		{5, 30 * time.Second},
		{15, 60 * time.Second},
		{30, 105 * time.Second},
		{300, 915 * time.Second},
	} {
		if got := staleAfter(tc.ping); got != tc.want {
			t.Errorf("staleAfter(%d): got %s, want %s", tc.ping, got, tc.want)
		}
	}
	// Monotonic: a slower ping can never make a fix go stale sooner.
	for ping := 5; ping < 300; ping++ {
		if staleAfter(ping) >= staleAfter(ping+1) {
			t.Fatalf("staleAfter is not increasing at ping=%d", ping)
		}
	}
}

// --- against a real database -------------------------------------------------

type busSchool struct {
	db      *database.DB
	inst    uuid.UUID
	campus  uuid.UUID
	year    uuid.UUID
	vehicle uuid.UUID
	route   uuid.UUID
	stop    uuid.UUID

	// The transport clerk who pairs phones, and two unrelated families.
	clerkUser  uuid.UUID
	parentUser uuid.UUID
	otherUser  uuid.UUID
	student    uuid.UUID
	otherKid   uuid.UUID
}

// The stop every geofence assertion below is measured against.
const (
	busStopLat = 17.400000
	busStopLon = 78.400000
)

func (sc *busSchool) tx(t *testing.T, fn func(tx pgx.Tx) error) {
	t.Helper()
	if err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, fn); err != nil {
		t.Fatalf("tenant query: %v", err)
	}
}

func (sc *busSchool) as(user uuid.UUID, perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{UserID: user, InstitutionID: sc.inst, Permissions: set}
}

// newBusSchool builds the smallest school this feature needs: one bus, one
// route with one located stop, and two families on it who are not related.
func newBusSchool(t *testing.T) *busSchool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	// The tracker's token is sealed with the same helper that protects the SMTP
	// password, and it refuses to store a credential in clear.
	if strings.TrimSpace(os.Getenv("CREDENTIAL_KEY")) == "" {
		t.Setenv("CREDENTIAL_KEY", "bus-tracker-test-key")
	}
	ctx := context.Background()
	db, err := database.Connect(ctx, url, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)

	sc := &busSchool{db: db}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('Bus Test','Bus',$1) RETURNING id`,
			"bus-"+uuid.NewString()[:8]).Scan(&sc.inst)
	}); err != nil {
		t.Fatalf("institution: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, sc.inst)
			return err
		})
	})

	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO campuses (institution_id, name, code)
			VALUES ($1,'Main','MAIN') RETURNING id`, sc.inst).Scan(&sc.campus); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on, is_current)
			VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31',true) RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.year); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO vehicles (institution_id, campus_id, registration_no, capacity)
			VALUES ($1,$2,'TS07UB1234',40) RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.vehicle); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO routes (institution_id, campus_id, name, code, vehicle_id)
			VALUES ($1,$2,'Kukatpally','R1',$3) RETURNING id`,
			sc.inst, sc.campus, sc.vehicle).Scan(&sc.route); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO route_stops (institution_id, route_id, name, sequence,
			        pickup_time, drop_time, latitude, longitude, geofence_m)
			VALUES ($1,$2,'JNTU','1','07:40','15:40',$3,$4,120) RETURNING id`,
			sc.inst, sc.route, busStopLat, busStopLon).Scan(&sc.stop); err != nil {
			return err
		}

		user := func(email, name string) (uuid.UUID, error) {
			var u uuid.UUID
			err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name, status)
				VALUES ($1,$2::citext,$3,'active') RETURNING id`,
				sc.inst, email, name).Scan(&u)
			return u, err
		}
		var err error
		if sc.clerkUser, err = user("transport@bus.test", "Transport Clerk"); err != nil {
			return err
		}
		if sc.parentUser, err = user("asha@bus.test", "Asha Rao"); err != nil {
			return err
		}
		if sc.otherUser, err = user("ravi@bus.test", "Ravi Kumar"); err != nil {
			return err
		}

		// A child, their guardian, and their allocation to this route. Repeated
		// for a second family so the parent read below has something it must
		// not return.
		family := func(admission, name string, guardianUser uuid.UUID, relation string) (uuid.UUID, error) {
			var student, guardian uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO students (institution_id, campus_id, admission_no, first_name, status)
				VALUES ($1,$2,$3,$4,'active') RETURNING id`,
				sc.inst, sc.campus, admission, name).Scan(&student); err != nil {
				return student, err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO guardians (institution_id, full_name, relation, user_id)
				VALUES ($1,$2,$3,$4) RETURNING id`,
				sc.inst, name+"'s parent", relation, guardianUser).Scan(&guardian); err != nil {
				return student, err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
				VALUES ($1,$2,$3,true)`, student, guardian, sc.inst); err != nil {
				return student, err
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO transport_allocations (institution_id, student_id, academic_year_id,
				        route_id, pickup_stop_id, drop_stop_id, valid_from)
				VALUES ($1,$2,$3,$4,$5,$5, CURRENT_DATE - 1)`,
				sc.inst, student, sc.year, sc.route, sc.stop)
			return student, err
		}
		if sc.student, err = family("A-1", "Meera", sc.parentUser, "mother"); err != nil {
			return err
		}
		sc.otherKid, err = family("A-2", "Vikram", sc.otherUser, "father")
		return err
	})
	return sc
}

// pairAndClaim mints a code as the office would and turns it into a paired
// phone, returning the code and the handset's token.
func (sc *busSchool) pairAndClaim(t *testing.T, s *Server) (code, token string) {
	t.Helper()
	admin := chi.NewRouter()
	admin.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(),
				sc.as(sc.clerkUser, rbac.TransportRead, rbac.TransportWrite))))
		})
	})
	admin.Group(func(r chi.Router) { s.mountBusTrackerAdmin(r) })

	status, body := busTrackerCall(t, admin, http.MethodPost, "/transport/trackers/pair",
		"", fmt.Sprintf(`{"vehicle_id":%q}`, sc.vehicle))
	if status != http.StatusOK {
		t.Fatalf("pair: %d %v", status, body)
	}
	code, _ = body["pair_code"].(string)
	if code == "" {
		t.Fatalf("pair returned no code: %v", body)
	}

	device := busTrackerDeviceRouter(s)
	status, claim := busTrackerCall(t, device, http.MethodPost, "/public/bus-tracker/claim",
		"", fmt.Sprintf(`{"pair_code":%q,"device_name":"Ravi's phone"}`, code))
	if status != http.StatusOK {
		t.Fatalf("claim: %d %v", status, claim)
	}
	token, _ = claim["device_token"].(string)
	if token == "" {
		t.Fatalf("claim returned no token: %v", claim)
	}
	return code, token
}

/*
signInDriver opens a driver session on the paired handset and returns the
X-Staff-Session token the app would carry.

	Since the driver sign-in of 2026-08-29, starting or ending a run needs a
	person as well as a phone (requireBusTrackerDriver), so the trip row can
	say who drove. The session is opened the way signInBusDriver opens it,
	minus the phone-number-and-PIN check that proves the person: this test
	school has no PINs, and the clerk is as good a driver as anyone here. The
	sealed secret needs CREDENTIAL_KEY, which newBusSchool sets.
*/
func (sc *busSchool) signInDriver(t *testing.T, s *Server, deviceToken string) string {
	t.Helper()
	device, _, ok := splitBusTrackerToken(deviceToken)
	if !ok {
		t.Fatalf("device token %q does not split", deviceToken)
	}
	var session string
	err := s.DB.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		var err error
		session, _, _, err = s.openStaffSession(context.Background(), tx,
			staffIdentity{UserID: sc.clerkUser, Institution: sc.inst, Name: "Ravi"},
			"bus_tracker", device)
		return err
	})
	if err != nil {
		t.Fatalf("driver sign-in: %v", err)
	}
	return session
}

// startTrip signs the driver in on the handset, opens a pickup run and
// returns its id.
func (sc *busSchool) startTrip(t *testing.T, s *Server, token string) string {
	t.Helper()
	session := sc.signInDriver(t, s, token)
	status, body := busTrackerCallWith(t, busTrackerDeviceRouter(s), busTestCallerAddress(t),
		map[string]string{"X-Staff-Session": session}, http.MethodPost,
		"/bus-tracker/trips", token, fmt.Sprintf(`{"route_id":%q,"direction":"pickup"}`, sc.route))
	if status != http.StatusCreated {
		t.Fatalf("start trip: %d %v", status, body)
	}
	id, _ := body["trip_id"].(string)
	return id
}

// fixJSON is one fix as the phone sends it, RFC 3339 with an offset.
func fixJSON(at time.Time, lat, lon float64, speed float64) string {
	return fmt.Sprintf(`{"recorded_at":%q,"latitude":%f,"longitude":%f,"speed_kmph":%.1f}`,
		at.Format(time.RFC3339), lat, lon, speed)
}

func (sc *busSchool) countRows(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), query, args...).Scan(&n)
	})
	return n
}

/*
A pair code is single-use, and the index rather than the handler says so.

	The second claim is refused with the same words as an expired code and a
	code that never existed: a caller working through eight characters must not
	learn that one of them landed.
*/
func TestBusTrackerPairCodeIsSingleUse(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	code, _ := sc.pairAndClaim(t, s)

	status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/public/bus-tracker/claim", "", fmt.Sprintf(`{"pair_code":%q}`, code))
	if status != http.StatusUnauthorized {
		t.Fatalf("claiming a claimed code: got %d %v, want 401", status, body)
	}
	if e, _ := body["error"].(map[string]any); e == nil || e["code"] != "bad_pair_code" {
		t.Errorf("a spent code answered %v, not bad_pair_code", body["error"])
	}
	if n := sc.countRows(t,
		`SELECT count(*) FROM vehicle_trackers WHERE vehicle_id = $1`, sc.vehicle); n != 1 {
		t.Errorf("a spent code produced %d trackers, want 1", n)
	}
}

/*
Pairing a replacement handset retires the one it replaces.

	A driver's phone is lost, broken or swapped, and the office must not have to
	revoke first — a claim rejected by a unique index is an error the driver
	standing at the bus cannot act on. One live tracker per vehicle afterwards,
	and the old token stops working.
*/
func TestClaimingRetiresTheLiveTrackerOnTheSameVehicle(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, first := sc.pairAndClaim(t, s)
	_, second := sc.pairAndClaim(t, s)

	if first == second {
		t.Fatal("the replacement handset was given the first phone's token")
	}
	if n := sc.countRows(t,
		`SELECT count(*) FROM vehicle_trackers WHERE vehicle_id = $1 AND revoked_at IS NULL`,
		sc.vehicle); n != 1 {
		t.Errorf("%d live trackers on one bus, want 1", n)
	}
	if n := sc.countRows(t,
		`SELECT count(*) FROM vehicle_trackers WHERE vehicle_id = $1`, sc.vehicle); n != 2 {
		t.Errorf("%d trackers in total, want 2 — the retired one is the record of where the bus went", n)
	}

	device := busTrackerDeviceRouter(s)
	if status, _ := busTrackerCall(t, device, http.MethodPost, "/bus-tracker/heartbeat",
		first, `{"battery_pct":80}`); status != http.StatusUnauthorized {
		t.Errorf("the replaced phone's token: got %d, want 401", status)
	}
	if status, _ := busTrackerCall(t, device, http.MethodPost, "/bus-tracker/heartbeat",
		second, `{"battery_pct":80,"location_ok":true}`); status != http.StatusOK {
		t.Errorf("the new phone's token: got %d, want 200", status)
	}
}

/*
A replayed batch stores one row per fix and is acknowledged both times.

	This is what lets the phone retry a push whose response it never saw. The
	second acknowledgement matters as much as the row count: an accepted list
	that shrank on the retry would leave the phone resending those fixes for
	ever.
*/
func TestBusTrackerPositionsAreIdempotent(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	base := time.Now().Add(-2 * time.Minute).Truncate(time.Second)
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s,%s,%s]}`, trip,
		fixJSON(base, 17.300000, 78.300000, 30),
		fixJSON(base.Add(10*time.Second), 17.301000, 78.301000, 32),
		fixJSON(base.Add(20*time.Second), 17.302000, 78.302000, 34))

	device := busTrackerDeviceRouter(s)
	for attempt := 1; attempt <= 2; attempt++ {
		status, body := busTrackerCall(t, device, http.MethodPost, "/bus-tracker/positions", token, batch)
		if status != http.StatusOK {
			t.Fatalf("push %d: %d %v", attempt, status, body)
		}
		accepted, _ := body["accepted"].([]any)
		if len(accepted) != 3 {
			t.Errorf("push %d acknowledged %d fixes, want 3 — the phone will resend the rest for ever",
				attempt, len(accepted))
		}
		if open, _ := body["trip_open"].(bool); !open {
			t.Errorf("push %d reported the trip closed", attempt)
		}
	}
	if n := sc.countRows(t,
		`SELECT count(*) FROM vehicle_positions WHERE trip_id = $1`, trip); n != 3 {
		t.Errorf("a replayed batch stored %d rows, want 3", n)
	}
}

/*
A batch that arrives out of order is filed in time order.

	The phone buffers through a dead zone and may restart mid-buffer, so the
	newest fix is not necessarily the last one in the array. Everything
	downstream — the live marker, the geofence walk, the speeding episode —
	assumes time moves forwards, and a live map showing the oldest fix of the
	batch is a bus drawn where it was twenty minutes ago.
*/
func TestBusTrackerPositionsAreFiledInTimeOrder(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	base := time.Now().Add(-5 * time.Minute).Truncate(time.Second)
	newest := base.Add(2 * time.Minute)
	// Deliberately shuffled: the newest fix is sent first, the oldest last.
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s,%s,%s]}`, trip,
		fixJSON(newest, 17.320000, 78.320000, 20),
		fixJSON(base, 17.300000, 78.300000, 20),
		fixJSON(base.Add(time.Minute), 17.310000, 78.310000, 20))

	status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, batch)
	if status != http.StatusOK {
		t.Fatalf("push: %d %v", status, body)
	}

	var lastAt time.Time
	var lat float64
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT recorded_at, latitude::float8 FROM vehicle_last_position
			 WHERE vehicle_id = $1`, sc.vehicle).Scan(&lastAt, &lat)
	})
	if !lastAt.Equal(newest) {
		t.Errorf("the live marker holds %s, want the newest fix %s",
			lastAt.Format(time.RFC3339), newest.Format(time.RFC3339))
	}
	if math.Abs(lat-17.320000) > 1e-6 {
		t.Errorf("the live marker is at latitude %f, want the newest fix's 17.320000", lat)
	}

	// And the history reads back in the order the bus actually drove.
	var ordered bool
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT bool_and(ok) FROM (
			    SELECT recorded_at >= lag(recorded_at) OVER (ORDER BY id) IS NOT FALSE AS ok
			      FROM vehicle_positions WHERE trip_id = $1) q`, trip).Scan(&ordered)
	})
	if !ordered {
		t.Error("the history was written in the order the batch arrived, not the order it happened")
	}
}

/*
A bus idling on the edge of a circle produces one arrival, not eleven.

	This is the failure that switches the feature off in week two: eleven "your
	child's bus has arrived" messages in four minutes. The unique index decides
	it rather than the walker remembering, so the assertion is on the row count
	after a push that crosses the boundary repeatedly.
*/
func TestGeofenceRecordsOneArrivalHoweverManyFixesAreInside(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	base := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	// Eight fixes drifting a few metres either side of the stop, well inside
	// its 120m circle, then two that leave it.
	var fixes []string
	for i := 0; i < 8; i++ {
		fixes = append(fixes, fixJSON(base.Add(time.Duration(i*15)*time.Second),
			busStopLat+float64(i%2)*0.0002, busStopLon+float64(i%3)*0.0001, 4))
	}
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s]}`, trip, strings.Join(fixes, ","))
	if status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, batch); status != http.StatusOK {
		t.Fatalf("push: %d %v", status, body)
	}

	if n := sc.countRows(t, `
		SELECT count(*) FROM transport_stop_events
		 WHERE trip_id = $1 AND stop_id = $2 AND kind = 'arrived'`, trip, sc.stop); n != 1 {
		t.Fatalf("an idling bus produced %d arrivals, want exactly 1", n)
	}
	if n := sc.countRows(t, `
		SELECT count(*) FROM transport_stop_events
		 WHERE trip_id = $1 AND kind = 'departed'`, trip); n != 0 {
		t.Errorf("a bus still at the stop produced %d departures, want 0", n)
	}

	// The arrival carries how late the bus was against the stop's 07:40.
	var deviation *int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT deviation_mins FROM transport_stop_events
			 WHERE trip_id = $1 AND kind = 'arrived'`, trip).Scan(&deviation)
	})
	if deviation == nil {
		t.Error("the arrival recorded no deviation against a stop that has a scheduled time")
	}

	// Driving away files exactly one departure, and re-entering does not file a
	// second arrival.
	away := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s,%s]}`, trip,
		fixJSON(base.Add(3*time.Minute), 17.450000, 78.450000, 40),
		fixJSON(base.Add(4*time.Minute), busStopLat, busStopLon, 5))
	if status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, away); status != http.StatusOK {
		t.Fatalf("second push: %d %v", status, body)
	}
	if n := sc.countRows(t, `
		SELECT count(*) FROM transport_stop_events WHERE trip_id = $1 AND kind = 'arrived'`,
		trip); n != 1 {
		t.Errorf("re-entering the circle produced %d arrivals, want 1", n)
	}
	if n := sc.countRows(t, `
		SELECT count(*) FROM transport_stop_events WHERE trip_id = $1 AND kind = 'departed'`,
		trip); n != 1 {
		t.Errorf("%d departures, want 1", n)
	}
}

/*
A burst shorter than the hold is not rash driving and leaves nothing behind.

	One fix reading over the limit on a flyover is what makes a safety list
	nobody opens. The episode has to survive speeding_hold_secs to be filed at
	all, and one that does not is deleted rather than kept and marked short.
*/
func TestShortSpeedingBurstLeavesNoEvent(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	// The default policy: 50 km/h, held for 20 seconds.
	base := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s,%s,%s]}`, trip,
		fixJSON(base, 17.300000, 78.300000, 40),
		fixJSON(base.Add(5*time.Second), 17.301000, 78.301000, 58),
		fixJSON(base.Add(15*time.Second), 17.302000, 78.302000, 42))
	if status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, batch); status != http.StatusOK {
		t.Fatalf("push: %d %v", status, body)
	}
	if n := sc.countRows(t,
		`SELECT count(*) FROM transport_safety_events WHERE trip_id = $1`, trip); n != 0 {
		t.Errorf("a ten-second burst left %d safety events, want 0", n)
	}
}

// Sustained over the limit is one event with a duration and the peak the bus
// actually reached — not one event per fix.
func TestSustainedSpeedingLeavesOneEventWithThePeak(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	base := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s,%s,%s,%s,%s]}`, trip,
		fixJSON(base, 17.300000, 78.300000, 55),
		fixJSON(base.Add(15*time.Second), 17.301000, 78.301000, 64),
		fixJSON(base.Add(30*time.Second), 17.302000, 78.302000, 61),
		fixJSON(base.Add(45*time.Second), 17.303000, 78.303000, 57),
		fixJSON(base.Add(60*time.Second), 17.304000, 78.304000, 44))
	if status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, batch); status != http.StatusOK {
		t.Fatalf("push: %d %v", status, body)
	}

	var (
		n       int
		peak    float64
		limit   int
		started time.Time
		ended   *time.Time
	)
	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(context.Background(), `
			SELECT count(*) FROM transport_safety_events
			 WHERE trip_id = $1 AND kind = 'speeding'`, trip).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			return nil
		}
		return tx.QueryRow(context.Background(), `
			SELECT peak_kmph::float8, limit_kmph, started_at, ended_at
			  FROM transport_safety_events WHERE trip_id = $1`, trip).
			Scan(&peak, &limit, &started, &ended)
	})
	if n != 1 {
		t.Fatalf("a minute over the limit produced %d events, want exactly 1", n)
	}
	if math.Abs(peak-64) > 0.05 {
		t.Errorf("peak %.1f km/h, want 64.0 — the fastest fix of the episode", peak)
	}
	if limit != 50 {
		t.Errorf("limit_kmph %d, want the policy's 50", limit)
	}
	if !started.Equal(base) {
		t.Errorf("the episode starts at %s, want the first over-limit fix %s",
			started.Format(time.RFC3339), base.Format(time.RFC3339))
	}
	if ended == nil {
		t.Error("the episode is still open after the bus slowed down; it reads as still happening")
	} else if !ended.Equal(base.Add(60 * time.Second)) {
		t.Errorf("the episode ends at %s, want the fix that dropped under the limit",
			ended.Format(time.RFC3339))
	}
}

/*
A parent sees their own child's bus and no other family's.

	The narrowing is in SQL, through student_guardians to a guardian whose
	user_id is the caller. This is the assertion that would catch a later
	rewrite that filters in Go and forgets a branch — a family reading another
	family's child's route and stop is the whole feature turned into a
	disclosure.
*/
func TestChildBusReturnsOnlyTheCallersOwnChildren(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}

	view := func(user uuid.UUID) []any {
		r := chi.NewRouter()
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(),
					sc.as(user, rbac.SelfProfileRead))))
			})
		})
		r.Group(func(r chi.Router) { s.mountBusTracking(r) })
		status, body := busTrackerCall(t, r, http.MethodGet, "/me/child-bus", "", "")
		if status != http.StatusOK {
			t.Fatalf("GET /me/child-bus: %d %v", status, body)
		}
		return itemsOf(body)
	}

	names := func(items []any) []string {
		var out []string
		for _, it := range items {
			row, _ := it.(map[string]any)
			name, _ := row["student_name"].(string)
			out = append(out, name)
		}
		return out
	}

	mine := names(view(sc.parentUser))
	if len(mine) != 1 || !strings.Contains(mine[0], "Meera") {
		t.Fatalf("Asha sees %v, want her own child only", mine)
	}
	theirs := names(view(sc.otherUser))
	if len(theirs) != 1 || !strings.Contains(theirs[0], "Vikram") {
		t.Fatalf("Ravi sees %v, want his own child only", theirs)
	}
	// A signed-in user who is nobody's guardian sees nothing rather than
	// everything.
	if none := names(view(sc.clerkUser)); len(none) != 0 {
		t.Errorf("the transport clerk's own /me/child-bus returned %v, want nothing", none)
	}
}

/*
A phone that claims a pair code is approved by the act of the code existing.

	This is a regression test with a live failure behind it. Migration 00156
	added approved_at and backfilled it from paired_at, reasoning that a code
	an authorised person generated is itself the approval. The INSERT in
	claimBusTrackerPairCode was not updated to match, so every handset that
	paired AFTERWARDS came out permanently pending and was refused by
	requireBusTracker with awaiting_approval — a bus paired at the depot and
	never once on the map, with nothing in the app to explain it.

	Asserted against the SQL rather than a database, which is not ideal and is
	what is available here: no Postgres runs on the machine these tests are
	written on. It pins the two facts that broke — that the column is named in
	the insert, and that the enrol path deliberately does not name it.
*/
func TestEveryDriverAuthenticatedDoorApprovesTheTracker(t *testing.T) {
	/* The rule changed on 2026-08-29 with the driver sign-in: a PIN proves
	   who the person is, HR decided which bus, and a principal approving a
	   pairing the office already made is a queue with nothing in it. Enrol
	   used to be the exception, and the exception was the door the pair
	   screen used whenever a sticker was scanned -- so the same driver got a
	   working bus or a silent one by which button he pressed. */
	for _, fn := range []string{"claimBusTrackerPairCode", "enrolBusTracker", "signInBusDriver"} {
		src := busTrackerSourceOf(t, fn)
		if !strings.Contains(src, "approved_at") {
			t.Errorf("%s no longer sets approved_at: every phone that comes in "+
				"this way is refused as awaiting_approval", fn)
		}
	}
}

// busTrackerSourceOf returns the body of one function from this package's
// source, so a test can assert on SQL that has no database to run against.
func busTrackerSourceOf(t *testing.T, fn string) string {
	t.Helper()
	for _, file := range []string{"bus_tracker.go", "device_login.go", "bus_driver_signin.go"} {
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		src := string(b)
		at := strings.Index(src, ") "+fn+"(")
		if at < 0 {
			continue
		}
		end := strings.Index(src[at:], "\n}\n")
		if end < 0 {
			end = len(src) - at
		}
		return src[at : at+end]
	}
	t.Fatalf("could not find %s in this package's source", fn)
	return ""
}

/*
The parent's map follows the bus that ran, not the bus on the route.

	A driver scans whichever bus he is on at the start of the run, so the
	trip's vehicle and the route's standing vehicle are different things and
	the route may have none at all. The position row is keyed by the bus that
	ran. Joining it through the route's vehicle found nothing in exactly that
	case: the run showed open, the phone pushed every fifteen seconds and was
	answered 200, and the parent read "has not sent a position yet". Measured
	on a handset on 5 September; this pins the join to the trip.
*/
func TestChildBusFollowsTheBusThatRanNotTheRoutesStandingBus(t *testing.T) {
	sc := newBusSchool(t)
	s := &Server{DB: sc.db}
	_, token := sc.pairAndClaim(t, s)
	trip := sc.startTrip(t, s, token)

	// The route loses its standing bus after the run opened. The trip still
	// names the bus that is running. The school publishes positions, which
	// is off by default and is the other reason a parent reads no position.
	sc.tx(t, func(tx pgx.Tx) error {
		if _, err := tx.Exec(context.Background(),
			`UPDATE routes SET vehicle_id = NULL WHERE id = $1`, sc.route); err != nil {
			return err
		}
		_, err := tx.Exec(context.Background(), `
			INSERT INTO transport_tracking_policy (institution_id, parents_may_watch)
			VALUES ($1, true)
			ON CONFLICT (institution_id) DO UPDATE SET parents_may_watch = true`, sc.inst)
		return err
	})

	at := time.Now().Add(-30 * time.Second).Truncate(time.Second)
	batch := fmt.Sprintf(`{"trip_id":%q,"fixes":[%s]}`, trip,
		fixJSON(at, busStopLat+0.01, busStopLon+0.01, 20))
	if status, body := busTrackerCall(t, busTrackerDeviceRouter(s), http.MethodPost,
		"/bus-tracker/positions", token, batch); status != http.StatusOK {
		t.Fatalf("push: %d %v", status, body)
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(),
				sc.as(sc.parentUser, rbac.SelfProfileRead))))
		})
	})
	r.Group(func(r chi.Router) { s.mountBusTracking(r) })
	status, body := busTrackerCall(t, r, http.MethodGet, "/me/child-bus", "", "")
	if status != http.StatusOK {
		t.Fatalf("GET /me/child-bus: %d %v", status, body)
	}
	items := itemsOf(body)
	if len(items) != 1 {
		t.Fatalf("parent sees %d rows, want 1", len(items))
	}
	row, _ := items[0].(map[string]any)
	if row["latitude"] == nil {
		t.Fatalf("the feed carries no position (state %v) although the bus that ran pushed one; "+
			"the join reached for the route's vehicle instead of the trip's", row["state"])
	}
}
