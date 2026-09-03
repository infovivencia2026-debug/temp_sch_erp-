package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
)

// A handler that counts how many times it actually ran, and says something
// different each time so a replayed answer is distinguishable from a fresh one.
func counting(runs *int) http.Handler {
	var mu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*runs++
		n := *runs
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]int{"run": n})
	})
}

func post(t *testing.T, h http.Handler, id *httpx.Identity, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", strings.NewReader(body))
	// As the real client sends it. Without this the Content-Type guard would
	// wave every one of these through and the tests would prove nothing.
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	req = req.WithContext(httpx.WithIdentity(req.Context(), id))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

/*
The whole point, stated as a test: the same press, sent twice, pays once.

	This is what makes the offline outbox safe. A client that loses the network
	mid-request cannot tell "never arrived" from "arrived and the reply was
	lost", so it must be free to resend. If resending ran the handler again,
	every dropped response on a bad line would be a second fee receipt.
*/
func TestTheSameKeySentTwiceRunsTheWorkOnce(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	runs := 0
	h := s.Idempotent(counting(&runs))
	id := sc.as(sc.teacher)
	key := uuid.NewString()

	first := post(t, h, id, key, `{"amount":500}`)
	second := post(t, h, id, key, `{"amount":500}`)

	if runs != 1 {
		t.Fatalf("the handler ran %d times; the money moved more than once", runs)
	}
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("statuses %d then %d; a replay must answer exactly as the original did",
			first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("replay said %q, original said %q; the client would see the second press "+
			"as a different outcome", second.Body.String(), first.Body.String())
	}
	if second.Header().Get("Idempotent-Replay") != "true" {
		t.Error("a replayed response should say so, so a client can tell it apart")
	}
}

/*
A key reused for a different request is refused, not answered.

	The failure this guards against is a client bug that mints one key and
	reuses it: without the check, the first write would become a lid over every
	later one, each silently answered with the first one's receipt and never
	executed. Loudly wrong beats quietly wrong.
*/
func TestOneKeyCannotCoverTwoDifferentRequests(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	runs := 0
	h := s.Idempotent(counting(&runs))
	id := sc.as(sc.teacher)
	key := uuid.NewString()

	post(t, h, id, key, `{"amount":500}`)
	clash := post(t, h, id, key, `{"amount":50000}`)

	if clash.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409: a different body under the same key must be refused",
			clash.Code)
	}
	if runs != 1 {
		t.Fatalf("the handler ran %d times", runs)
	}
}

/*
Two people, one staffroom laptop, one guessed key.

	Keys are minted by the client, so one account must never be answered from
	another's receipt — that would hand over a response containing somebody
	else's data.
*/
func TestAKeyBelongsToTheAccountThatMintedIt(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	runs := 0
	h := s.Idempotent(counting(&runs))
	key := uuid.NewString()

	post(t, h, sc.as(sc.teacher), key, `{"amount":500}`)
	other := post(t, h, sc.as(uuid.New()), key, `{"amount":500}`)

	if other.Code != http.StatusConflict {
		t.Fatalf("got %d, want 409: a second account was served the first one's answer",
			other.Code)
	}
}

/*
A 500 must not become the permanent answer.

	A server error is the server saying it does not know what happened. Storing
	that would freeze the outcome: every retry of a write that may yet have
	succeeded would be told 500 forever, and the queued row could never be
	attempted for real again. The claim is released instead.
*/
func TestAServerErrorLeavesTheKeyFreeToTryAgain(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	calls := 0
	h := s.Idempotent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	}))
	id := sc.as(sc.teacher)
	key := uuid.NewString()

	if got := post(t, h, id, key, `{}`).Code; got != http.StatusInternalServerError {
		t.Fatalf("first call got %d", got)
	}
	retry := post(t, h, id, key, `{}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry got %d, want 200: the failed attempt locked the key", retry.Code)
	}
	if calls != 2 {
		t.Fatalf("handler ran %d times, want 2", calls)
	}
}

// No key, no bookkeeping: every existing caller keeps working unchanged.
func TestWithoutAKeyNothingChanges(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	runs := 0
	h := s.Idempotent(counting(&runs))
	id := sc.as(sc.teacher)

	post(t, h, id, "", `{"amount":500}`)
	post(t, h, id, "", `{"amount":500}`)

	if runs != 2 {
		t.Fatalf("handler ran %d times, want 2: two unkeyed presses are two intents", runs)
	}
}

/*
A file upload is not queued, and must not be truncated on the way past.

	The body has to be read to be hashed, so anything this middleware handles is
	held in memory. Applying that to multipart would cap every upload the
	product accepts at whatever limit was chosen here — a bulk-import sheet or a
	student photograph failing for a reason invisible from the screen. Uploads
	are also not the offline case: nobody re-sends a photograph from a bus.
*/
func TestAnUploadPassesStraightThrough(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	var got string
	h := s.Idempotent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(http.StatusOK)
	}))

	big := strings.Repeat("x", 32<<20) // comfortably past any in-memory cap
	req := httptest.NewRequest(http.MethodPost, "/api/v1/imports", strings.NewReader(big))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=zzz")
	req.Header.Set("Idempotency-Key", uuid.NewString())
	req = req.WithContext(httpx.WithIdentity(req.Context(), sc.as(sc.teacher)))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if len(got) != len(big) {
		t.Fatalf("handler saw %d bytes of a %d byte upload; the middleware truncated it",
			len(got), len(big))
	}
}
