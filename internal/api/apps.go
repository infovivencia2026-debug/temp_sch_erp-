package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

/* Where the staff apps come from before Google does.

   Two Android apps ship with this system — the SMS gateway and the bus
   tracker — and neither is on Play yet. Until they are, the schools that have
   bought this need somewhere to get them, and "the vendor WhatsApps you an
   APK" is not somewhere. It is unversioned, unverifiable, and it teaches the
   exact habit that gets a school's phones malware: install what arrives.

   So this page. It is deliberately public, with no sign-in in front of it,
   because the two people who need it cannot sign in: the driver has no ERP
   account, and the gateway phone lives in a drawer. Publishing the binary
   costs nothing, because the binary is inert — neither app does anything at
   all until an administrator generates a pair code in the console and somebody
   types it into that handset. The secret is the pair code, never the APK.

   What the page must carry, because Play is not carrying it:

     the version    — so a school can answer "which one am I running"
     the size       — so nobody starts a 40MB download on a metered SIM blind
     the SHA-256    — the only integrity check a sideloaded APK gets, since
                      there is no store signature being verified on the way in
     the date       — a build from March tells a different story from one from
                      last week
     the steps      — sideloading needs "Install unknown apps" turned on, and
                      a page that omits it produces a support call per install

   Builds are read off disk rather than embedded. An APK is tens of megabytes
   and changes on its own schedule; embedding one would mean rebuilding and
   redeploying the whole server to ship a driver-app bugfix, and would put the
   binary's size up by the two of them. `make deploy-server` does not build
   Android, and should not start.

   A host with no disk (Cloud Run, or the Pages proxy in front of it) has no
   APK_DIR, and the page must not read as a broken deployment there. The same
   three APKs are checked in as static files under web/public/download/ and are
   part of every web build, so when no disk build exists for an app the card
   links the static file instead. What the static file does not carry is the
   version, the size, the build date and the digest — those are read off the
   disk build, and a number the server did not measure must not be printed.
   The card says the build is served as a static file and stops there.
*/

// AppsPage serves the sideload page and the APKs it lists.
type AppsPage struct {
	Tpl *template.Template
	// Dir holds the published builds, named "<slug>-<version>.apk".
	Dir string

	mu   sync.Mutex
	sums map[string]cachedSum
}

// cachedSum keys a digest to the file it was taken from. Size and modtime
// together are what invalidate it: hashing forty megabytes on every page view
// would make the page slower the more successful it got, and a stale hash
// printed beside a new build is worse than printing none.
type cachedSum struct {
	size    int64
	modTime time.Time
	sum     string
}

// appInfo is what this repo knows about each app without looking at disk.
// Hardcoded, and short: the page describes three apps that live in this same
// repository, so a table in a database would be a table with three rows in it
// that nobody would remember to fill in.
type appInfo struct {
	Slug     string
	Name     string
	Tagline  string
	Who      string   // the handset this belongs on, in the school's words
	Needs    []string // what the phone must have, before they download 40MB
	Contract string   // the wire contract, for anyone who wants to know
	// Static is the path of the checked-in build under web/public/download/,
	// served as a plain file by whatever fronts the SPA (nginx, Pages, or the
	// Go process itself under WEB_DIST). Offered only when no disk build exists.
	Static string
}

var appCatalogue = []appInfo{
	{
		Slug:    "bus-tracker",
		Name:    "School Bus Tracker",
		Tagline: "Turns the driver's own phone into the bus's GPS unit. The driver opens a run, the bus shows on the office map until the run is closed, and between runs the app collects nothing.",
		Who:     "The driver's phone, one per bus.",
		Needs: []string{
			"Android 8.0 or newer",
			"A SIM with data, and location switched on",
			"Left on charge in the cab. It reports for the whole run",
		},
		Contract: "docs/BUS_TRACKER_CONTRACT.md",
		Static:   "/download/bus-tracker.apk",
	},
	{
		Slug:    "sms-gateway",
		Name:    "School SMS Gateway",
		Tagline: "Turns a spare phone with a SIM into the school's SMS sender. It collects queued messages from the school's server, sends them through the handset's radio, and reports back what happened to each one.",
		Who:     "One spare handset in the office. Not a staff member's own phone.",
		Needs: []string{
			"Android 8.0 or newer",
			"A SIM with an SMS pack on it",
			"Left plugged in. It works whenever the school queues a message",
		},
		Contract: "docs/SMS_GATEWAY_CONTRACT.md",
		Static:   "/download/sms-gateway.apk",
	},
	{
		// The parent app existed and had no way to reach a parent: the
		// catalogue named two apps, so the third could not be published to
		// this page or downloaded from it.
		Slug:    "parent",
		Name:    "EDU CLOUD for Parents",
		Tagline: "The school's own parent portal as an app: fees, the bus on a map, homework and notices. It is the same site the browser shows, so nothing in it goes out of date.",
		Who:     "A parent's own phone.",
		Needs: []string{
			"Android 7.0 or newer",
			"A data connection; it shows the school's site",
		},
		Static: "/download/parent.apk",
	},
}

// appBuild is one app as the page renders it: the catalogue entry plus
// whatever was actually found on disk. Available is false when nothing has
// been published to APK_DIR; the card then links the static file if the
// catalogue names one, and otherwise says so rather than offering a link to
// a 404. Version, Size, SHA256, Built and File are only ever set from a disk
// build.
type appBuild struct {
	appInfo
	Available bool
	Version   string
	Size      string
	SHA256    string
	Built     string
	File      string
}

type appsView struct {
	AssetVersion string
	Apps         []appBuild
	// AnyAvailable drives the difference between "no build for this app yet"
	// and a page with no disk builds at all. With AnyStatic false as well that
	// is a deployment fault and should read like one; with it true the page is
	// the diskless host's normal state and says where the downloads come from.
	AnyAvailable bool
	AnyStatic    bool
}

// buildName matches "<slug>-<version>.apk". The version is whatever the
// Android build stamped, so it is matched loosely and compared numerically
// below; anything that does not parse sorts last rather than crashing the page.
var buildName = regexp.MustCompile(`^([a-z0-9-]+)-v?([0-9]+(?:\.[0-9]+)*)\.apk$`)

func (a *AppsPage) Show(w http.ResponseWriter, r *http.Request) {
	v := appsView{AssetVersion: static.Version()}
	for _, info := range appCatalogue {
		b := appBuild{appInfo: info}
		if path, version, ok := a.latest(info.Slug); ok {
			if st, err := os.Stat(path); err == nil {
				b.Available = true
				b.Version = version
				b.Size = humanBytes(st.Size())
				b.Built = st.ModTime().Local().Format("2 January 2006")
				b.File = filepath.Base(path)
				b.SHA256 = a.digest(r, path, st)
				v.AnyAvailable = true
			}
		}
		if !b.Available && b.Static != "" {
			v.AnyStatic = true
		}
		v.Apps = append(v.Apps, b)
	}

	// Not a page for a search index: it is an install page for two schools'
	// worth of handsets, and an APK link in results is a phishing lure with
	// our name on it.
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := a.Tpl.ExecuteTemplate(w, "apps.gohtml", v); err != nil {
		httpx.Internal(w, r, err)
	}
}

// Download serves one APK.
//
// The slug is matched against the catalogue rather than cleaned, so the path
// that reaches the filesystem is one of two strings this file wrote. A
// traversal check that works by inspecting the input is a check that has to be
// right; an allow-list of two is right by construction.
func (a *AppsPage) Download(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var info *appInfo
	for i := range appCatalogue {
		if appCatalogue[i].Slug == slug {
			info = &appCatalogue[i]
			break
		}
	}
	if info == nil {
		http.NotFound(w, r)
		return
	}

	path, version, ok := a.latest(slug)
	if !ok {
		// No disk build. A handset that was given this URL before the host
		// lost its disk is sent to the static file rather than told the app
		// is gone; the page itself links the static file directly.
		if info.Static != "" {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
			http.Redirect(w, r, info.Static, http.StatusFound)
			return
		}
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-%s.apk"`, slug, version))
	// A driver on a moving bus loses the connection halfway through forty
	// megabytes. ServeContent answers Range requests, so the download resumes
	// instead of starting again; io.Copy would not.
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
}

// latest returns the newest published build for a slug, by version rather than
// by modification time — a rebuilt older tag is still an older app, and a file
// copied onto the server gets today's timestamp regardless of what it holds.
func (a *AppsPage) latest(slug string) (path, version string, ok bool) {
	if a.Dir == "" {
		return "", "", false
	}
	entries, err := os.ReadDir(a.Dir)
	if err != nil {
		return "", "", false
	}
	type found struct {
		name    string
		version string
	}
	var builds []found
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := buildName.FindStringSubmatch(e.Name())
		if m == nil || m[1] != slug {
			continue
		}
		builds = append(builds, found{name: e.Name(), version: m[2]})
	}
	if len(builds) == 0 {
		return "", "", false
	}
	sort.Slice(builds, func(i, j int) bool {
		return compareVersions(builds[i].version, builds[j].version) > 0
	})
	return filepath.Join(a.Dir, builds[0].name), builds[0].version, true
}

// compareVersions orders dotted numeric versions field by field, so that 1.10
// is newer than 1.9. String comparison puts them the other way round, which is
// the bug that ships a school the wrong build and is invisible until the tenth
// release.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

func (a *AppsPage) digest(r *http.Request, path string, st os.FileInfo) string {
	a.mu.Lock()
	if c, hit := a.sums[path]; hit && c.size == st.Size() && c.modTime.Equal(st.ModTime()) {
		a.mu.Unlock()
		return c.sum
	}
	a.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		httpx.LogError(r, err)
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		httpx.LogError(r, err)
		return ""
	}
	sum := hex.EncodeToString(h.Sum(nil))

	a.mu.Lock()
	if a.sums == nil {
		a.sums = map[string]cachedSum{}
	}
	a.sums[path] = cachedSum{size: st.Size(), modTime: st.ModTime(), sum: sum}
	a.mu.Unlock()
	return sum
}

// humanBytes prints a download size the way a person deciding whether to start
// it on mobile data would want it: two significant figures, in megabytes.
func humanBytes(n int64) string {
	const mb = 1 << 20
	if n < mb {
		return fmt.Sprintf("%d KB", (n+1023)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/mb)
}
