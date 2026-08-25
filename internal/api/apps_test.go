package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/school-erp/erp/internal/templates"
)

// A published build must be the one a school is offered, and 1.10 must beat
// 1.9. String ordering gets that backwards, which is invisible until the tenth
// release and then ships every school the wrong app.
func TestLatestPicksHighestVersion(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"bus-tracker-1.9.0.apk", "bus-tracker-1.10.0.apk", "bus-tracker-1.2.0.apk",
		"sms-gateway-2.0.1.apk", "notes.txt", "bus-tracker-nightly.apk",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := &AppsPage{Dir: dir}

	path, version, ok := a.latest("bus-tracker")
	if !ok || version != "1.10.0" {
		t.Fatalf("got %q %q ok=%v, want 1.10.0", path, version, ok)
	}
	if _, _, ok := a.latest("no-such-app"); ok {
		t.Error("an app with no build reported one")
	}
}

// An empty APK_DIR is the state of a fresh server, and the page must render
// rather than 500. A school looking for a download and finding a stack trace
// telephones the vendor.
func TestShowWithNoBuilds(t *testing.T) {
	tpl, err := templates.Parse()
	if err != nil {
		t.Fatal(err)
	}
	a := &AppsPage{Tpl: tpl, Dir: t.TempDir()}

	rec := httptest.NewRecorder()
	a.Show(rec, httptest.NewRequest(http.MethodGet, "/apps", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "No build has been published") {
		t.Error("page does not say that nothing is published")
	}
	if strings.Contains(body, "/apps/bus-tracker.apk") {
		t.Error("page offers a download for a build that does not exist")
	}
}

// The digest is the only integrity check a sideloaded APK gets, so it has to
// be on the page and it has to be of the file actually served.
func TestShowCarriesDigestAndSize(t *testing.T) {
	tpl, err := templates.Parse()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "sms-gateway-1.0.0.apk"), []byte("pretend apk"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &AppsPage{Tpl: tpl, Dir: dir}

	rec := httptest.NewRecorder()
	a.Show(rec, httptest.NewRequest(http.MethodGet, "/apps", nil))
	body := rec.Body.String()

	sum := sha256.Sum256([]byte("pretend apk"))
	if !strings.Contains(body, hex.EncodeToString(sum[:])) {
		t.Error("the page does not carry the digest of the file it serves")
	}
	if !strings.Contains(body, "/apps/sms-gateway.apk") {
		t.Error("no download link for a published build")
	}

	if rec.Header().Get("X-Robots-Tag") == "" {
		t.Error("the install page is indexable; an APK link in search results is a phishing lure")
	}
}

// The slug reaching the filesystem must be one of the two this package wrote.
func TestDownloadRejectsUnknownSlug(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "bus-tracker-1.0.0.apk"), []byte("apk"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &AppsPage{Dir: dir}

	r := chi.NewRouter()
	r.Get("/apps/{slug}.apk", a.Download)

	for _, path := range []string{"/apps/passwd.apk", "/apps/..%2f..%2fetc%2fpasswd.apk"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, rec.Code)
		}
	}

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/apps/bus-tracker.apk", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/vnd.android.package-archive" {
		t.Errorf("content-type %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "bus-tracker-1.0.0.apk") {
		t.Errorf("content-disposition %q does not name the version", cd)
	}
	if rec.Body.String() != "apk" {
		t.Errorf("body %q", rec.Body.String())
	}
}
