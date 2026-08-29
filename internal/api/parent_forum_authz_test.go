package api

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The parent community forum, asserted on the router production builds.

	The scope tests come first in this file, deliberately. The permission tests
	matter, but the failure this feature is most likely to ship is not "a parent
	moderated something" — it is "a parent read another class's board", which is
	the leak this codebase has already had once with circulars. A permission
	guard cannot catch it, because every parent legitimately holds the only
	permission on the parent-facing routes.

	identityWith and statusOf already exist in this package
	(fee_engine_authz_test.go) and are reused rather than redeclared.
*/

func mountedParentForum(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountParentForum(r)
	return r
}

// --- scope ------------------------------------------------------------------

/*
Every parent-facing read is narrowed by a section list, in the SQL.

	This is the scope test, and it is a source test rather than a request test
	because the property is about what the queries say. A parent's board is the
	sections their own children are actively enrolled in, computed per request
	by parentForumSections; a query that forgot the predicate would serve every
	class's threads to every parent, and would look completely correct in
	development where one school has one class.

	The three parent-facing reads must each carry a section predicate:

	  listParentForumBoards    e.student_id = ANY($1) -- the enrolment IS the
	                           board list, so narrowing on the children is the
	                           same statement as narrowing on the sections.
	  listParentForumThreads   t.section_id = ANY($3)
	  getParentForumThread     checked in Go against inSections, because the
	                           thread is fetched by id and the id is the
	                           attacker-controlled part.

	Asserting on the text is crude and it is the only thing that survives an
	agent rewriting the handler six months from now without a database to hand.
*/
func TestParentForumNarrowsEveryParentReadToTheirOwnSections(t *testing.T) {
	src := parentForumSource(t)

	for _, want := range []string{
		// The board picker cannot show a class no child of the caller is in.
		"WHERE e.student_id = ANY($1) AND e.status = 'active'",
		// The thread list is bounded by the computed section list, never by a
		// section id the client sent.
		"WHERE t.section_id = ANY($3)",
		// parentForumSections itself derives that list from active enrolments
		// of children the caller owns, and from nothing else.
		"FROM enrollments e\n\t\t\t WHERE e.student_id = ANY($1) AND e.status = 'active'",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("the scope predicate %q is gone from parent_forum.go — "+
				"without it a parent reads every class's board", want)
		}
	}
}

/*
A section_id from the client narrows and never widens.

	The list endpoint accepts ?section_id=, which is exactly the parameter an
	attacker changes. It must be intersected against the caller's own boards
	rather than substituted for them, and the refusal must be indistinguishable
	from "no such board".

	Pinned on the source for the same reason as above: the alternative is a
	seeded database, and the check that gets deleted in a refactor is the one
	no test mentions by name.
*/
func TestParentForumIntersectsAClientSuppliedSection(t *testing.T) {
	src := parentForumSource(t)
	if !strings.Contains(src, "if err != nil || !inSections(sections, want)") {
		t.Error("listParentForumThreads no longer intersects ?section_id= against " +
			"the caller's own boards — a parent can now name another class")
	}
	if !strings.Contains(src, "} else if !inSections(sections, section) {") {
		t.Error("getParentForumThread no longer re-checks the thread's section " +
			"against the caller's boards; a thread id is client-supplied on every request")
	}
}

/*
Writes resolve one child, reads resolve the family, and neither uses whichChild.

	The two resolvers mean opposite things by an absent student_id.
	familyChildren returns every child the caller owns and the SQL runs
	ANY($1); whichChild returns the eldest, silently. A read wants the first —
	a parent of three should see three boards without touching a picker. A
	write wants the second refused outright, which portalChild does: guessing
	the eldest would post 11-A's parent into 6-C's trip thread.

	Getting this backwards showed one parent another child's records twice in
	one week, which is why it is asserted rather than commented.
*/
func TestParentForumUsesTheRightChildResolver(t *testing.T) {
	src := parentForumSource(t)
	if strings.Contains(src, "whichChild") && !strings.Contains(src, "whichChild is deliberately not used") {
		t.Error("parent_forum.go calls whichChild, which silently answers for the eldest child")
	}
	for _, write := range []string{
		"func (s *Server) openParentForumThread",
		"func (s *Server) replyToParentForumThread",
	} {
		body := functionBody(src, write)
		if !strings.Contains(body, "s.portalChild(r, req.StudentID)") {
			t.Errorf("%s does not resolve its child through portalChild — a parent of "+
				"three naming nobody must be refused, not guessed at", write)
		}
	}
}

// --- permissions ------------------------------------------------------------

// The staff moderation surface. Publishing and unpublishing what one family
// says in front of a class list is comms.announcements.write, the same rung
// the student wall took.
var parentForumModerationRoutes = []struct{ method, path string }{
	{http.MethodGet, "/parent-forum/moderation/queue"},
	{http.MethodGet, "/parent-forum/moderation/reports"},
	{http.MethodGet, "/parent-forum/threads/" + uuid.NewString() + "/history"},
	{http.MethodPost, "/parent-forum/threads/" + uuid.NewString() + "/moderate"},
	{http.MethodPost, "/parent-forum/posts/" + uuid.NewString() + "/moderate"},
	{http.MethodGet, "/parent-forum/settings"},
	{http.MethodPut, "/parent-forum/settings"},
}

/*
A parent cannot moderate the forum they post in.

	The sharpest failure available here. A parent who could reach the queue
	reads every pending post and every report on their class board — including
	the reports filed against them, by name. self.profile.read is what a parent
	holds and it must buy none of it.
*/
func TestParentForumRefusesModerationToAParent(t *testing.T) {
	h := mountedParentForum(identityWith(rbac.SelfProfileRead))

	for _, tc := range parentForumModerationRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a parent must not moderate the forum",
				tc.method, tc.path, got)
		}
	}
}

/*
Conversion needs the front desk's rung as well as the moderator's.

	Converting a thread files a row into the grievance queue with an SLA
	stamped on it. That queue belongs to the office, and moderating a class
	board is not authority to put work into somebody else's tracked queue.
	Holding either rung alone is refused; holding both is admitted.
*/
func TestParentForumConversionNeedsBothRungs(t *testing.T) {
	path := "/parent-forum/threads/" + uuid.NewString() + "/convert"

	moderatorOnly := mountedParentForum(identityWith(rbac.SelfProfileRead, rbac.AnnouncementsWrite))
	if got := statusOf(t, moderatorOnly, http.MethodPost, path); got != http.StatusForbidden {
		t.Errorf("convert with only comms.announcements.write: got %d, want 403 — "+
			"filing into the grievance queue is the front desk's authority", got)
	}

	deskOnly := mountedParentForum(identityWith(rbac.SelfProfileRead, rbac.FrontDeskWrite))
	if got := statusOf(t, deskOnly, http.MethodPost, path); got != http.StatusForbidden {
		t.Errorf("convert with only office.front_desk.write: got %d, want 403 — "+
			"taking a thread off a class board is the moderator's authority", got)
	}

	both := mountedParentForum(identityWith(rbac.SelfProfileRead,
		rbac.AnnouncementsWrite, rbac.FrontDeskWrite))
	if got := statusOf(t, both, http.MethodPost, path); got == http.StatusForbidden {
		t.Error("convert with both rungs is 403, but that is exactly the role the route is for")
	}
}

/*
A parent's own routes reach the handler, because that is where the check is.

	Every route here derives its board list from the caller's own children
	inside the handler. If the router refused them the scoping would never run
	and the screens would not work; if a permission were bolted on, the scoping
	would look redundant and the next agent would delete it. So the property is
	exactly "not 403, and mounted".
*/
func TestParentForumLetsAParentReachTheScopeCheck(t *testing.T) {
	h := mountedParentForum(identityWith(rbac.SelfProfileRead))

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/parent-forum/boards"},
		{http.MethodGet, "/parent-forum/threads"},
		{http.MethodPost, "/parent-forum/threads"},
		{http.MethodGet, "/parent-forum/threads/" + uuid.NewString()},
		{http.MethodPost, "/parent-forum/threads/" + uuid.NewString() + "/posts"},
		{http.MethodPost, "/parent-forum/threads/" + uuid.NewString() + "/report"},
		{http.MethodPost, "/parent-forum/posts/" + uuid.NewString() + "/report"},
	} {
		got := statusOf(t, h, tc.method, tc.path)
		if got == http.StatusForbidden {
			t.Errorf("%s %s: 403 — a parent's own screen must reach the scope check, "+
				"not be refused at the door", tc.method, tc.path)
		}
		if got == http.StatusNotFound || got == http.StatusMethodNotAllowed {
			t.Errorf("%s %s: %d — the route is not mounted", tc.method, tc.path, got)
		}
	}
}

// --- moderation invariants --------------------------------------------------

/*
No takedown exists without an account of who did it and why.

	00083's property, inherited rather than reinvented: the state change and
	the log row are written in one transaction, so there is no moment in which
	a post is gone and nothing says who removed it. Every write handler that
	changes what is on the board must call logStudentContent, and every
	negative verb must demand a reason.
*/
func TestParentForumLogsEveryTakedown(t *testing.T) {
	src := parentForumSource(t)

	for _, fn := range []string{
		"func (s *Server) moderateParentForumThread",
		"func (s *Server) moderateParentForumPost",
		"func (s *Server) convertParentForumThread",
		"func (s *Server) reportParentForumContent",
	} {
		if !strings.Contains(functionBody(src, fn), "logStudentContent(") {
			t.Errorf("%s does not write the moderation trail; a takedown nobody "+
				"can account for is the one thing the shared log exists to prevent", fn)
		}
	}

	// The reason is required for the verbs that take words off a board.
	for _, verb := range []string{`"reject": true`, `"remove": true`, `"lock": true`} {
		if !strings.Contains(src, verb) {
			t.Errorf("pfNeedsReason no longer requires a reason for %s — "+
				"a takedown with no reason is one nobody is prepared to defend", verb)
		}
	}
}

/*
A report enqueues; it does not hide.

	00083's rule, kept verbatim, and the reason is stronger here than on the
	wall: a report that auto-hid on a parents' board would be a heckler's veto
	whose first use is against whoever raised the uncomfortable question about
	the trip money. The report handler may write the queue row and the log row
	and must not touch the target's status.
*/
func TestParentForumReportDoesNotHideAnything(t *testing.T) {
	body := functionBody(parentForumSource(t), "func (s *Server) reportParentForumContent")

	for _, forbidden := range []string{
		"UPDATE parent_forum_threads",
		"UPDATE parent_forum_posts",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("reportParentForumContent now runs %q — a report that hides its "+
				"target is a heckler's veto handed to every parent on the board", forbidden)
		}
	}
	if !strings.Contains(body, "INSERT INTO parent_forum_reports") {
		t.Error("reportParentForumContent no longer files the report itself")
	}
}

/*
A converted thread raises its grievance in the parent's name, not the
moderator's.

	getPortalFeedback in comms.go matches on raised_by. A ticket filed under
	the moderator's name is one the family can never open, so the conversion
	would have taken the post down and eaten the concern — the exact outcome
	converting rather than deleting exists to avoid. The INSERT therefore
	passes the thread's author, and the timeline entry it writes is
	parent-visible.
*/
func TestParentForumConversionFilesInTheParentsName(t *testing.T) {
	body := functionBody(parentForumSource(t), "func (s *Server) convertParentForumThread")

	if !strings.Contains(body, "id.InstitutionID, author, student, category,") {
		t.Error("the converted grievance is no longer raised_by the thread's author; " +
			"a ticket in the moderator's name is invisible to the family it belongs to")
	}
	// The last argument of insertFeedbackUpdate here is the author id; the one
	// before it is visible_to_parent, which must be true.
	if !strings.Contains(body, `"note", req.Note, nil, true, id.UserID`) {
		t.Error("the conversion's timeline entry is no longer visible to the parent — " +
			"they would be told nothing about where their words went")
	}
	if !strings.Contains(body, "subject_employee_id") {
		t.Error("the conversion no longer carries subject_employee_id, which is the " +
			"column that keeps a complaint about a teacher away from that teacher")
	}
}

// --- helpers ----------------------------------------------------------------

// parentForumSource reads the handler file so the tests above can assert on
// predicates that need a seeded database to exercise. Crude, and the only
// thing that survives a rewrite done without one to hand.
func parentForumSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("parent_forum.go")
	if err != nil {
		t.Fatalf("reading parent_forum.go: %v", err)
	}
	/* Line endings normalised before anything is matched against it.

	   Every assertion below is a literal containing a newline, and a checkout
	   on Windows has CRLF — so all of them missed at once and the suite
	   reported that the predicate keeping a parent inside their own child's
	   sections had been deleted. It had not. That is the worse of the two
	   failures: a guard that cannot run looks exactly like the thing it
	   guards against, and the only way to tell them apart is to open the file
	   it is accusing. */
	return strings.ReplaceAll(string(b), "\r\n", "\n")
}

// functionBody returns the text from a function's signature to the next
// top-level declaration, which is close enough to scope an assertion to one
// handler without parsing Go.
func functionBody(src, signature string) string {
	i := strings.Index(src, signature)
	if i < 0 {
		return ""
	}
	rest := src[i+len(signature):]
	if j := strings.Index(rest, "\nfunc "); j >= 0 {
		return rest[:j]
	}
	return rest
}
