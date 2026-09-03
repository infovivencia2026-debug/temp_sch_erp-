package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

func mountedDriverNoticeAdmin(id *httpx.Identity) *chi.Mux {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	(&Server{}).mountBusTrackerAdmin(r)
	return r
}

/*
The roster routes are on the mounts the phone and the office already use.

	No database: this asks the routers what they serve. The device walk in
	bus_tracker_test.go proves every route on the device mount refuses a
	caller with no token; this proves the four roster routes are on that
	mount at all, because a handler nobody mounted passes every guard test.
	The office's two are checked the same way, plus the one gate that
	matters: transport.read may see what was sent and may not send.
*/
func TestBusTrackerRosterRoutesAreMounted(t *testing.T) {
	s := &Server{}
	device := chi.NewRouter()
	s.mountBusTrackerDevice(device)
	want := map[string]bool{
		"GET /bus-tracker/trips/{id}/roster":    false,
		"POST /bus-tracker/trips/{id}/boarding": false,
		"GET /bus-tracker/students/{id}/photo":  false,
		"POST /bus-tracker/notices/{id}/ack":    false,
		"GET /transport/vehicles/{id}/notices":  false,
		"POST /transport/vehicles/{id}/notices": false,
	}
	admin := chi.NewRouter()
	s.mountBusTrackerAdmin(admin)
	for _, mux := range []chi.Router{device, admin} {
		err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if _, ok := want[method+" "+route]; ok {
				want[method+" "+route] = true
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk: %v", err)
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("%s is not mounted", k)
		}
	}
}

func TestDriverNoticesReadCannotSend(t *testing.T) {
	path := strings.ReplaceAll("/transport/vehicles/{id}/notices", "{id}", uuid.NewString())
	reader := mountedDriverNoticeAdmin(identityWith(rbac.TransportRead))
	if got := statusOf(t, reader, http.MethodPost, path); got != http.StatusForbidden {
		t.Errorf("POST notices with transport.read: got %d, want 403", got)
	}
	if got := statusOf(t, reader, http.MethodGet, path); got == http.StatusForbidden {
		t.Error("GET notices with transport.read: got 403, want the handler reached")
	}
	writer := mountedDriverNoticeAdmin(identityWith(rbac.TransportRead, rbac.TransportWrite))
	if got := statusOf(t, writer, http.MethodPost, path); got == http.StatusForbidden {
		t.Error("POST notices with transport.write: got 403, want reachable")
	}
}
