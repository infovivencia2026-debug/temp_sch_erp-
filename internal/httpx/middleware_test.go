package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRealIP(t *testing.T) {
	cases := []struct {
		name string
		xff  string
		cf   string
		want string
	}{
		{"no headers", "", "", "10.0.0.1:1234"},
		{"xff single", "203.0.113.5", "", "203.0.113.5"},
		{"xff multi, last wins", "1.2.3.4, 203.0.113.5 , 198.51.100.7", "", "198.51.100.7"},
		{"cf-connecting-ip wins over xff", "1.2.3.4, 198.51.100.7", "203.0.113.9", "203.0.113.9"},
		{"cf-connecting-ip ipv6", "198.51.100.7", "2001:db8::1", "2001:db8::1"},
		{"invalid cf-connecting-ip falls back", "1.2.3.4, 198.51.100.7", "not-an-ip", "198.51.100.7"},
		{"invalid cf-connecting-ip, no xff", "", "garbage", "10.0.0.1:1234"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			h := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.RemoteAddr
			}))
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = "10.0.0.1:1234"
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.cf != "" {
				r.Header.Set("CF-Connecting-IP", tc.cf)
			}
			h.ServeHTTP(httptest.NewRecorder(), r)
			if got != tc.want {
				t.Fatalf("RemoteAddr = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRealIPOriginSecret(t *testing.T) {
	t.Setenv("ORIGIN_SHARED_SECRET", "s3cret")
	cases := []struct {
		name   string
		secret string
		want   string
	}{
		{"no secret header: cf ignored, last xff hop wins", "", "198.51.100.7"},
		{"wrong secret: cf ignored", "nope", "198.51.100.7"},
		{"right secret: cf believed", "s3cret", "203.0.113.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			h := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.RemoteAddr
			}))
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = "10.0.0.1:1234"
			r.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.7")
			r.Header.Set("CF-Connecting-IP", "203.0.113.9")
			if tc.secret != "" {
				r.Header.Set("X-Origin-Secret", tc.secret)
			}
			h.ServeHTTP(httptest.NewRecorder(), r)
			if got != tc.want {
				t.Fatalf("RemoteAddr = %q, want %q", got, tc.want)
			}
		})
	}
}
