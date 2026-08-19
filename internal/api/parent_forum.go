package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* The parent community forum — the third forum in this product and the first
   one for adults.

   student_wall_posts and homework_forum_threads (00083) are children writing
   where children read. This is parents writing where parents read, and almost
   every design decision differs from those two because the risk differs:

     1. SCOPE IS THE SECTION, and it is enforced in the SQL.

        There is no school-wide parent forum here. Parents of 8-B discussing
        the 8-B trip is a product; every parent in the school discussing every
        teacher is a different one, and it is not the one the catalogue asked
        for ("class-level parent forums for event coordination"). Who may read
        8-B's board is exactly who has a child actively enrolled in 8-B, which
        the enrolment already says — so there is no membership table to drift
        out of date the day a child transfers.

        Every read runs through parentForumSections, which turns the caller's
        own resolved scope into the section ids they may see, and every query
        carries `section_id = ANY($n)` against that list. This codebase has
        already shipped one leak where every parent saw every circular; the
        first test in parent_forum_authz_test.go is the scope test, not the
        permission test, for that reason.

     2. POST-MODERATION, by recommendation, with the school's switch beside it.

        The wall pre-moderates and says why: its authors are children, and the
        cost is latency on a compliment. Inverting both halves of that argument
        gives the answer here. The authors are named adults, accountable
        through the guardian row printed under every post. The traffic is "what
        time does the coach leave" — a forum that answers that twelve hours
        later, once an adult has read it, is a forum nobody opens, and an
        unopened coordination tool is not the safe outcome, it is the absent
        one. Pre-moderating adults also reads, correctly, as the school
        appointing itself censor of what parents may say to each other.

        What carries the liability instead is everything around the post:
        real names, a report route that reaches a moderator in one click, an
        immediate takedown with a mandatory reason, a lock that ends a thread
        without deleting it, and the conversion route below. And because that
        judgement is the school's to revisit rather than mine to impose,
        parent_forum_settings.premoderate turns it around for a school that has
        been burned — same queue, same reasons, same trail, no deployment.

     3. A COMPLAINT IS CONVERTED, NOT DELETED.

        The sharp risk in a parents' forum is that it becomes the public
        version of the grievance hub: a thread about a named teacher, read by
        forty families and by the teacher, with no SLA and no route to an
        answer. comms.go already owns that problem properly and enforces the
        one rule that matters — a grievance about a member of staff is not
        visible to, or assignable to, that member of staff.

        So a moderator who finds a grievance in the forum does not press
        remove. They press convert, and one transaction takes the thread off
        the board, raises a support_tickets row RAISED BY THE PARENT (not by
        the moderator — otherwise the family could never see it in the portal,
        and the takedown would have eaten the concern), names the staff member
        it is about so the exclusion applies, writes the visible timeline entry
        that tells the parent where their words went, and logs the takedown.
        Deleting instead would destroy a parent's concern along with their
        post, which is how a school ends up with a complaint on Facebook.

     4. THE MODERATION TRAIL IS 00083's, NOT A SECOND ONE.

        student_content_moderation carries two new content kinds and every
        removal here writes the state change and the reason in the same
        transaction, through the same logStudentContent, exactly as the wall
        and the homework forum do. Two takedown logs would drift, and the half
        that drifts is always the one a school is asked about.

     5. A REPORT ENQUEUES; IT DOES NOT HIDE.

        Kept from the wall verbatim. A report that auto-hid would be a
        heckler's veto, and on a parents' forum the first use of it would be
        against the parent asking the uncomfortable question. parent_forum_reports
        is the queue; the post stays up until an adult decides.

   RBAC. Nothing is invented. The parent-facing routes ride the /portal group's
   self.profile.read, which every account holds and which is therefore not the
   access control — parentForumSections and portalChild are, inside every
   handler. Staff moderation names comms.announcements.write, the same rung the
   student wall took, because publishing and unpublishing what one family says
   about another in front of a class list is the same authority as publishing a
   circular. Conversion additionally requires office.front_desk.write, because
   raising a ticket into the grievance queue is a front-desk act and the queue
   is theirs.

   whichChild vs familyChildren. Reads here use familyChildren (every child the
   caller owns, ANY($1)) so a parent of three sees all three classes' boards
   without touching a picker. Writes use portalChild, which refuses a parent of
   three who names nobody — a thread has to be posted into ONE class's board,
   and guessing the eldest would post 11-A's parent into 6-C's trip thread.
   whichChild is deliberately not used anywhere in this file. */

// --- mount -------------------------------------------------------------------

/*
mountParentForum registers the parent community forum.

	Spliced by the integrator with a bare s.mountParentForum(r) inside the
	existing /portal group in api.go, beside s.mountParentSchoolLife(r) — the
	parent side of the product is where this belongs, and the group's
	self.profile.read gate is the one the parent routes below assume. This
	worker does not edit api.go.

	Paths are relative to that group, so they resolve as
	/api/v1/portal/parent-forum/...
*/
func (s *Server) mountParentForum(r chi.Router) {
	r.Route("/parent-forum", func(r chi.Router) {
		// --- what a parent sees and does ------------------------------
		//
		// No permission beyond the group's. The gate is the section list
		// derived from the caller's own children, computed per request.
		r.Get("/boards", s.listParentForumBoards)
		r.Get("/threads", s.listParentForumThreads)
		r.Post("/threads", s.openParentForumThread)
		r.Get("/threads/{id}", s.getParentForumThread)
		r.Post("/threads/{id}/posts", s.replyToParentForumThread)
		r.Post("/threads/{id}/report", s.reportParentForumThread)
		r.Post("/posts/{id}/report", s.reportParentForumPost)

		// --- moderation ------------------------------------------------
		//
		// comms.announcements.write: the rung the student wall took. Taking
		// down or pinning what one parent says in front of a class list is
		// the same authority as publishing a circular to them.
		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AnnouncementsWrite))
			r.Get("/moderation/queue", s.listParentForumQueue)
			r.Get("/moderation/reports", s.listParentForumReports)
			r.Get("/threads/{id}/history", s.listParentForumHistory)
			r.Post("/threads/{id}/moderate", s.moderateParentForumThread)
			r.Post("/posts/{id}/moderate", s.moderateParentForumPost)
			r.Get("/settings", s.getParentForumSettings)
			r.Put("/settings", s.saveParentForumSettings)
		})

		// Conversion raises a row in the grievance queue, which is the front
		// desk's. Holding the moderation rung alone lets you take a thread
		// down; it does not let you file into somebody else's queue.
		r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).
			With(httpx.RequirePermission(rbac.FrontDeskWrite)).
			Post("/threads/{id}/convert", s.convertParentForumThread)
	})
}

// --- scoping -----------------------------------------------------------------

// errNoForumBoard is a caller with no active enrolment behind them: an account
// linked to no child, or to a child who has left. Distinguished from an empty
// board so the screen can say which it is.
var errNoForumBoard = errors.New("no class board")

/*
parentForumSections is the whole access-control story of the parent side.

	It turns "who is this caller" into "which section boards may they read", by
	the only fact that answers it: an active enrolment of a child they own.
	Nothing else is a route in — not a permission, not a teaching relationship,
	not a campus. The counsellor channel in comms.go takes the same line about
	its participant table, and for the same reason: a readership defined by a
	list is auditable, and one defined by a role quietly widens the day
	somebody is granted that role for an unrelated purpose.

	raw is the caller-supplied student_id and narrows further. It goes through
	familyChildren, so an absent one means every child the caller owns — the
	right default for a read, and the reason a parent of three sees three
	boards without touching the picker. Somebody else's child id is refused as
	though it did not exist.

	Staff never come through here. Their sections come from resolveScope, which
	is what reachesSection reads.
*/
func (s *Server) parentForumSections(r *http.Request, raw string) (*scope.Resolved, []uuid.UUID, error) {
	id := httpx.IdentityFrom(r.Context())
	res, kids, err := s.familyChildren(r, raw)
	if err != nil {
		return res, nil, err
	}
	if len(kids) == 0 {
		return res, nil, errNoForumBoard
	}
	var sections []uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT DISTINCT e.section_id
			  FROM enrollments e
			 WHERE e.student_id = ANY($1) AND e.status = 'active'`, kids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var sid uuid.UUID
			if err := rows.Scan(&sid); err != nil {
				return err
			}
			sections = append(sections, sid)
		}
		return rows.Err()
	})
	if err != nil {
		return res, nil, err
	}
	if len(sections) == 0 {
		return res, nil, errNoForumBoard
	}
	return res, sections, nil
}

// denyForumScope writes the single refusal both scoping failures get.
//
// errNotYourChild is a 404, matching every other portal endpoint — a parent
// guessing student ids must not learn which exist. No board is a 409 with a
// name, because "your child has no enrolment" is a real state the office has
// to fix and an empty list would read as "your class never talks".
func denyForumScope(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, errNoForumBoard) {
		httpx.Error(w, r, http.StatusConflict, "no_board",
			"your child has no active enrolment, so there is no class board to show; ask the office to complete the admission")
		return true
	}
	return denyChild(w, r, err)
}

// inSections reports whether a section is one of the caller's boards.
func inSections(sections []uuid.UUID, id uuid.UUID) bool {
	for _, s := range sections {
		if s == id {
			return true
		}
	}
	return false
}

// --- settings ----------------------------------------------------------------

type pfSettings struct {
	Premoderate bool  `json:"premoderate"`
	ThreadLimit int32 `json:"daily_thread_limit"`
	PostLimit   int32 `json:"daily_post_limit"`
}

// loadParentForumSettings reads the school's policy, defaulting to the shipped
// one when no row has been written.
//
// The defaults live here and in the column DEFAULTs and must agree. A school
// that has never opened the settings screen gets post-moderation and five
// threads a day, which is the recommendation this file argues for.
func loadParentForumSettings(r *http.Request, tx pgx.Tx, inst uuid.UUID) (pfSettings, error) {
	v := pfSettings{Premoderate: false, ThreadLimit: 5, PostLimit: 30}
	err := tx.QueryRow(r.Context(), `
		SELECT premoderate, daily_thread_limit, daily_post_limit
		  FROM parent_forum_settings WHERE institution_id = $1`, inst).
		Scan(&v.Premoderate, &v.ThreadLimit, &v.PostLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	return v, err
}

func (s *Server) getParentForumSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v pfSettings
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		v, err = loadParentForumSettings(r, tx, id.InstitutionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) saveParentForumSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pfSettings
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ThreadLimit < 1 || req.ThreadLimit > 100 {
		httpx.BadRequest(w, r, "daily_thread_limit must be between 1 and 100")
		return
	}
	if req.PostLimit < 1 || req.PostLimit > 500 {
		httpx.BadRequest(w, r, "daily_post_limit must be between 1 and 500")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO parent_forum_settings
			    (institution_id, premoderate, daily_thread_limit, daily_post_limit, updated_by)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (institution_id) DO UPDATE
			   SET premoderate = EXCLUDED.premoderate,
			       daily_thread_limit = EXCLUDED.daily_thread_limit,
			       daily_post_limit = EXCLUDED.daily_post_limit,
			       updated_by = EXCLUDED.updated_by,
			       updated_at = now()`,
			id.InstitutionID, req.Premoderate, req.ThreadLimit, req.PostLimit, id.UserID)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}

// --- boards ------------------------------------------------------------------

type pfBoard struct {
	SectionID string `json:"section_id"`
	Class     string `json:"class"`
	StudentID string `json:"student_id"`
	Student   string `json:"student_name"`
	Threads   int32  `json:"open_threads"`
	LastAt    string `json:"last_activity_at,omitempty"`
}

// listParentForumBoards is the picker: one row per class the caller has a
// child in, which is also the exact list of boards they may read.
//
// The counts come from the same predicate the thread list uses, so a board
// that says three threads opens on three threads. A count computed over a
// wider set than the list is how a parent concludes something is hidden from
// them — which, here, it would be.
func (s *Server) listParentForumBoards(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	items, err := collect(s, r, `
		SELECT e.section_id::text, concat_ws('-', cl.name, sec.name),
		       st.id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       (SELECT count(*) FROM parent_forum_threads t
		         WHERE t.section_id = e.section_id AND t.status = 'open')::int,
		       COALESCE(to_char((SELECT max(t.last_activity_at)
		                           FROM parent_forum_threads t
		                          WHERE t.section_id = e.section_id
		                            AND t.status = 'open'),
		                        'YYYY-MM-DD"T"HH24:MI'), '')
		  FROM enrollments e
		  JOIN students st  ON st.id  = e.student_id
		  JOIN sections sec ON sec.id = e.section_id
		  JOIN classes  cl  ON cl.id  = e.class_id
		 WHERE e.student_id = ANY($1) AND e.status = 'active'
		 ORDER BY cl.level, sec.name`,
		[]any{kids},
		func(rows pgx.Rows) (pfBoard, error) {
			var v pfBoard
			return v, rows.Scan(&v.SectionID, &v.Class, &v.StudentID, &v.Student,
				&v.Threads, &v.LastAt)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// --- threads: the parent's read ----------------------------------------------

type pfThread struct {
	ID       string  `json:"id"`
	Section  string  `json:"section_id"`
	Class    string  `json:"class"`
	Category string  `json:"category"`
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	Author   string  `json:"author_name"`
	Relation string  `json:"author_relation"`
	Status   string  `json:"status"`
	Mine     bool    `json:"written_by_me"`
	Pinned   bool    `json:"pinned"`
	Locked   bool    `json:"locked"`
	LockWhy  *string `json:"lock_reason,omitempty"`
	Replies  int32   `json:"replies"`
	Reports  int32   `json:"open_reports"`
	OpenedAt string  `json:"opened_at"`
	LastAt   string  `json:"last_activity_at"`
	Note     *string `json:"moderation_note,omitempty"`
	// Set when this thread became a grievance. The parent sees their own
	// ticket id and can follow it in the portal; nobody else sees it at all.
	TicketID *string `json:"grievance_id,omitempty"`
}

const pfThreadColumns = `
		t.id::text, t.section_id::text, concat_ws('-', cl.name, sec.name),
		t.category, t.title,
		-- A thread taken off the board keeps its body for its own author and
		-- for staff, and loses it for everybody else. Blanking rather than
		-- omitting so the author still sees the row and the reason.
		CASE WHEN t.status IN ('open', 'pending') OR t.author_user_id = $1 OR $2
		     THEN t.body ELSE '' END,
		g.full_name, g.relation, t.status, t.author_user_id = $1,
		t.pinned_at IS NOT NULL, t.locked_at IS NOT NULL, t.lock_reason,
		(SELECT count(*) FROM parent_forum_posts p
		  WHERE p.thread_id = t.id AND p.status = 'visible')::int,
		(SELECT count(*) FROM parent_forum_reports rp
		  WHERE rp.content_kind = 'parent_forum_thread' AND rp.content_id = t.id
		    AND rp.handled_at IS NULL)::int,
		to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI'),
		to_char(t.last_activity_at,'YYYY-MM-DD"T"HH24:MI'),
		t.moderation_note,
		CASE WHEN t.author_user_id = $1 OR $2 THEN t.converted_ticket_id::text END`

func scanPFThread(rows pgx.Rows) (pfThread, error) {
	var v pfThread
	return v, rows.Scan(&v.ID, &v.Section, &v.Class, &v.Category, &v.Title, &v.Body,
		&v.Author, &v.Relation, &v.Status, &v.Mine, &v.Pinned, &v.Locked, &v.LockWhy,
		&v.Replies, &v.Reports, &v.OpenedAt, &v.LastAt, &v.Note, &v.TicketID)
}

/*
listParentForumThreads is one class board, or all of the caller's boards.

	The scope predicate is `t.section_id = ANY($3)` and $3 is
	parentForumSections — never a section id the client sent. A section_id in
	the query narrows within that list and is intersected against it rather
	than trusted, so asking for 9-C's board when your child is in 8-B returns
	your own boards' threads, not 9-C's.

	Pinned first, then most recently active. A board ordered by opening date
	buries the conversation that is actually happening, which on a coordination
	forum is the only one worth reading.
*/
func (s *Server) listParentForumThreads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	_, sections, err := s.parentForumSections(r, r.URL.Query().Get("student_id"))
	if denyForumScope(w, r, err) {
		return
	}
	// A named section narrows; it never widens. Intersected, not substituted.
	if raw := strings.TrimSpace(r.URL.Query().Get("section_id")); raw != "" {
		want, err := uuid.Parse(raw)
		if err != nil || !inSections(sections, want) {
			// Same answer for a malformed id and for another class's board.
			httpx.NotFound(w, r)
			return
		}
		sections = []uuid.UUID{want}
	}
	items, err := collect(s, r, `
		SELECT`+pfThreadColumns+`
		  FROM parent_forum_threads t
		  JOIN guardians g   ON g.id   = t.author_guardian_id
		  JOIN sections  sec ON sec.id = t.section_id
		  JOIN classes   cl  ON cl.id  = sec.class_id
		 WHERE t.section_id = ANY($3)
		   -- Published threads, plus the caller's own whatever state it is in.
		   -- Somebody else's pending or removed thread is not visible to a
		   -- parent at all; that is the moderation queue's job.
		   AND (t.status = 'open' OR t.author_user_id = $1)
		   AND ($4::text IS NULL OR t.category = $4)
		 ORDER BY (t.pinned_at IS NOT NULL) DESC, t.last_activity_at DESC
		 LIMIT 200`,
		[]any{id.UserID, false, sections,
			nullString(strings.TrimSpace(r.URL.Query().Get("category")))},
		scanPFThread)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "moderation": "post",
	})
}

type pfPost struct {
	ID       string  `json:"id"`
	Body     string  `json:"body"`
	Author   string  `json:"author_name"`
	Relation *string `json:"author_relation,omitempty"`
	Staff    bool    `json:"from_staff"`
	Mine     bool    `json:"written_by_me"`
	Status   string  `json:"status"`
	Reports  int32   `json:"open_reports"`
	At       string  `json:"at"`
	Note     *string `json:"moderation_note,omitempty"`
}

/*
getParentForumThread returns one thread and its replies.

	The section check is repeated here rather than inherited from the list.
	A thread id is guessable in principle and arrives from the client on every
	request; a handler that trusts "they must have got this id from the list"
	is a handler that reads another class's board for anyone who tries.

	Staff who hold the moderation rung read any thread in a section they reach,
	which is what makes the queue and the history screens work. That is checked
	against resolveScope, not against the permission alone — announcements.write
	says "this person may publish", not "this person may read every class's
	parents talking".
*/
func (s *Server) getParentForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	staff := id.Can(rbac.AnnouncementsWrite)

	var sections []uuid.UUID
	if !staff {
		var err error
		_, sections, err = s.parentForumSections(r, "")
		if denyForumScope(w, r, err) {
			return
		}
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var head pfThread
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT`+pfThreadColumns+`, t.section_id
			  FROM parent_forum_threads t
			  JOIN guardians g   ON g.id   = t.author_guardian_id
			  JOIN sections  sec ON sec.id = t.section_id
			  JOIN classes   cl  ON cl.id  = sec.class_id
			 WHERE t.id = $3`, id.UserID, staff, threadID).
			Scan(&head.ID, &head.Section, &head.Class, &head.Category, &head.Title,
				&head.Body, &head.Author, &head.Relation, &head.Status, &head.Mine,
				&head.Pinned, &head.Locked, &head.LockWhy, &head.Replies, &head.Reports,
				&head.OpenedAt, &head.LastAt, &head.Note, &head.TicketID, &section); err != nil {
			return err
		}
		if staff {
			if !reachesSection(res, section) {
				return pgx.ErrNoRows
			}
		} else if !inSections(sections, section) {
			return pgx.ErrNoRows
		}
		// A thread off the board is visible only to its author and to staff.
		// The author keeps it deliberately: a parent whose post vanishes with
		// no trace concludes the school is hiding things, which is worse than
		// the post was.
		if head.Status != "open" && head.Status != "pending" && !head.Mine && !staff {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	posts, err := collect(s, r, `
		SELECT p.id::text,
		       CASE WHEN p.status IN ('visible', 'pending') OR p.author_user_id = $2 OR $3
		            THEN p.body ELSE '' END,
		       COALESCE(g.full_name, u.full_name), g.relation, p.is_staff,
		       p.author_user_id = $2, p.status,
		       (SELECT count(*) FROM parent_forum_reports rp
		         WHERE rp.content_kind = 'parent_forum_post' AND rp.content_id = p.id
		           AND rp.handled_at IS NULL)::int,
		       to_char(p.created_at,'YYYY-MM-DD"T"HH24:MI'), p.moderation_note
		  FROM parent_forum_posts p
		  LEFT JOIN guardians g ON g.id = p.author_guardian_id
		  LEFT JOIN users     u ON u.id = p.author_user_id
		 WHERE p.thread_id = $1
		   AND (p.status = 'visible' OR p.author_user_id = $2 OR $3)
		 ORDER BY p.created_at`,
		[]any{threadID, id.UserID, staff},
		func(rows pgx.Rows) (pfPost, error) {
			var v pfPost
			return v, rows.Scan(&v.ID, &v.Body, &v.Author, &v.Relation, &v.Staff,
				&v.Mine, &v.Status, &v.Reports, &v.At, &v.Note)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"thread": head, "posts": posts})
}

// --- threads: the parent's write ---------------------------------------------

type pfThreadRequest struct {
	// Which child's class board. Required for a parent of more than one:
	// portalChild refuses rather than guessing, because posting 11-A's parent
	// into 6-C's trip thread is the mistake whichChild would make silently.
	StudentID string `json:"student_id,omitempty"`
	Category  string `json:"category,omitempty"`
	Title     string `json:"title"`
	Body      string `json:"body"`
}

var pfCategories = map[string]bool{
	"general": true, "event": true, "trip": true, "volunteering": true,
	"logistics": true, "lost_found": true, "question": true,
}

var errPFLimit = errors.New("daily limit reached")
var errPFNoGuardian = errors.New("no guardian record")

/*
callerGuardian is the named person behind the account.

	Every thread and every reply prints a guardian's name and relation, so an
	account with no guardians row cannot post — and that refusal is the correct
	one rather than an inconvenience. It means a staff account cannot
	accidentally post as a parent, and it means there is no path by which an
	unnamed row reaches the board. Anonymity is not a mode here; accountability
	is most of what keeps a parents' forum civil.

	Scoped to the child being posted about: the guardian must actually be
	linked to that student. Without the join a parent of 8-B could pass a
	guardian id from another family and sign somebody else's name to a post.
*/
func callerGuardian(r *http.Request, tx pgx.Tx, user, student uuid.UUID) (uuid.UUID, error) {
	var g uuid.UUID
	err := tx.QueryRow(r.Context(), `
		SELECT g.id
		  FROM guardians g
		  JOIN student_guardians sg ON sg.guardian_id = g.id
		 WHERE g.user_id = $1 AND sg.student_id = $2
		 ORDER BY sg.is_primary DESC
		 LIMIT 1`, user, student).Scan(&g)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errPFNoGuardian
	}
	return g, err
}

/*
openParentForumThread starts a conversation on one class's board.

	Four things stand between a parent and the board, all of them here rather
	than in the client:

	  - The child must be one the caller owns. portalChild, which refuses a
	    parent of several who names none.
	  - That child must have an active enrolment, and the thread lands in that
	    enrolment's section. The client does not choose the section at all,
	    which is why there is no way to post into another class's board.
	  - The caller must be a named guardian of that child.
	  - No more than the school's daily thread limit, counted across every
	    status so a removed thread does not buy a fresh allowance.

	Where the school has turned pre-moderation on the row lands 'pending' and
	no other parent sees it until an adult approves. Where it has not — the
	default, and the recommendation — it lands 'open' and is readable at once.
*/
func (s *Server) openParentForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pfThreadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Body = strings.TrimSpace(req.Body)
	if req.Title == "" || req.Body == "" {
		httpx.BadRequest(w, r, "a thread needs a title and something to say")
		return
	}
	if len(req.Title) > 200 {
		httpx.BadRequest(w, r, "keep the title under 200 characters")
		return
	}
	if len(req.Body) > 4000 {
		httpx.BadRequest(w, r, "keep a post under 4000 characters")
		return
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		category = "general"
	}
	if !pfCategories[category] {
		httpx.BadRequest(w, r, "choose one of the listed categories")
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"this child has no enrolment on record, so there is no class board to post to")
		return
	}

	var out, status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		guardian, err := callerGuardian(r, tx, id.UserID, student)
		if err != nil {
			return err
		}
		cfg, err := loadParentForumSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		var used int32
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FROM parent_forum_threads
			 WHERE author_user_id = $1 AND posted_on = CURRENT_DATE`,
			id.UserID).Scan(&used); err != nil {
			return err
		}
		if used >= cfg.ThreadLimit {
			return errPFLimit
		}
		status = "open"
		if cfg.Premoderate {
			status = "pending"
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO parent_forum_threads
			    (institution_id, section_id, author_user_id, author_guardian_id,
			     via_student_id, category, title, body, status)
			VALUES ($1, $2, $3, $4, $5, $6, btrim($7), btrim($8), $9)
			RETURNING id::text`,
			id.InstitutionID, room.SectionID, id.UserID, guardian, student,
			category, req.Title, req.Body, status).Scan(&out); err != nil {
			return err
		}
		threadID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "parent_forum_thread",
			threadID, "submitted", actorPtr(id), "")
	})
	switch {
	case errors.Is(err, errPFNoGuardian):
		httpx.Error(w, r, http.StatusConflict, "not_a_guardian",
			"the forum prints the name of whoever posts, and this account is not recorded as a guardian of that child; ask the office to link it")
	case errors.Is(err, errPFLimit):
		httpx.Error(w, r, http.StatusConflict, "daily_limit",
			"you have opened your threads for today; the board is for coordinating, not broadcasting")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": status})
	}
}

type pfReplyRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Body      string `json:"body"`
}

/*
replyToParentForumThread posts a reply.

	Staff reply through the same endpoint and carry no guardian row, exactly as
	they do in the homework forum — a teacher answering a question about their
	own trip must not be forced through a guardians record. Their reply is
	never pre-moderated: the school is not a liability to itself here.

	A locked thread refuses. Locking is the moderator's way of ending a
	conversation without deleting it, and a lock that could be replied through
	would be a label rather than a control.
*/
func (s *Server) replyToParentForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req pfReplyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		httpx.BadRequest(w, r, "write something")
		return
	}
	if len(req.Body) > 4000 {
		httpx.BadRequest(w, r, "keep a reply under 4000 characters")
		return
	}
	staff := id.Can(rbac.AnnouncementsWrite)
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// A parent's reply resolves a child they own, and the board they may reach
	// is derived from that child's enrolment. Done before the transaction so
	// the ownership refusal is identical to every other portal endpoint.
	var student uuid.UUID
	var sections []uuid.UUID
	if !staff {
		_, student, err = s.portalChild(r, req.StudentID)
		if denyChild(w, r, err) {
			return
		}
		_, sections, err = s.parentForumSections(r, student.String())
		if denyForumScope(w, r, err) {
			return
		}
	}

	var out, status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		var tStatus string
		var locked bool
		if err := tx.QueryRow(r.Context(), `
			SELECT section_id, status, locked_at IS NOT NULL
			  FROM parent_forum_threads WHERE id = $1`, threadID).
			Scan(&section, &tStatus, &locked); err != nil {
			return err
		}
		if staff {
			if !reachesSection(res, section) {
				return pgx.ErrNoRows
			}
		} else if !inSections(sections, section) {
			return pgx.ErrNoRows
		}
		if tStatus != "open" {
			return errors.New("this thread is not open")
		}
		if locked {
			return errors.New("this thread is locked")
		}
		var guardian any
		status = "visible"
		if !staff {
			g, err := callerGuardian(r, tx, id.UserID, student)
			if err != nil {
				return err
			}
			guardian = g
			cfg, err := loadParentForumSettings(r, tx, id.InstitutionID)
			if err != nil {
				return err
			}
			var used int32
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*) FROM parent_forum_posts
				 WHERE author_user_id = $1 AND posted_on = CURRENT_DATE`,
				id.UserID).Scan(&used); err != nil {
				return err
			}
			if used >= cfg.PostLimit {
				return errPFLimit
			}
			if cfg.Premoderate {
				status = "pending"
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO parent_forum_posts
			    (institution_id, thread_id, author_user_id, author_guardian_id,
			     is_staff, body, status)
			VALUES ($1, $2, $3, $4, $5, btrim($6), $7)
			RETURNING id::text`,
			id.InstitutionID, threadID, id.UserID, guardian, staff,
			req.Body, status).Scan(&out); err != nil {
			return err
		}
		// Only a reply somebody can read moves the thread up the board. A
		// pending reply that bumped it would advertise its own existence.
		if status == "visible" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE parent_forum_threads
				   SET last_activity_at = now(), updated_at = now()
				 WHERE id = $1`, threadID); err != nil {
				return err
			}
		}
		postID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "parent_forum_post",
			postID, "submitted", actorPtr(id), "")
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errPFNoGuardian):
		httpx.Error(w, r, http.StatusConflict, "not_a_guardian",
			"this account is not recorded as a guardian of that child; ask the office to link it")
	case errors.Is(err, errPFLimit):
		httpx.Error(w, r, http.StatusConflict, "daily_limit",
			"you have written your replies for today")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": status})
	}
}

// --- reporting ---------------------------------------------------------------

type pfReportRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) reportParentForumThread(w http.ResponseWriter, r *http.Request) {
	s.reportParentForumContent(w, r, "parent_forum_thread")
}

func (s *Server) reportParentForumPost(w http.ResponseWriter, r *http.Request) {
	s.reportParentForumContent(w, r, "parent_forum_post")
}

/*
reportParentForumContent flags one thread or reply for an adult to read.

	It writes the queue row and the log row in one transaction and changes
	nothing else. The post stays up. That is 00083's rule kept deliberately: a
	report that hid its target would be a heckler's veto, and the first use of
	it on a parents' board would be against whoever raised the uncomfortable
	question about the trip money.

	A second report of the same item by the same person is refused rather than
	stacked, so the count a moderator weighs is a count of people.
*/
func (s *Server) reportParentForumContent(w http.ResponseWriter, r *http.Request, kind string) {
	id := httpx.IdentityFrom(r.Context())
	targetID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req pfReportRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r, "say what is wrong with it")
		return
	}
	if len(req.Reason) > 1000 {
		httpx.BadRequest(w, r, "keep the report under 1000 characters")
		return
	}
	_, sections, err := s.parentForumSections(r, "")
	if denyForumScope(w, r, err) {
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Only something on a board the caller can actually read. Without this
		// the report route is an oracle for whether a thread id exists.
		var section uuid.UUID
		var q string
		if kind == "parent_forum_thread" {
			q = `SELECT section_id FROM parent_forum_threads
			      WHERE id = $1 AND status = 'open'`
		} else {
			q = `SELECT t.section_id FROM parent_forum_posts p
			       JOIN parent_forum_threads t ON t.id = p.thread_id
			      WHERE p.id = $1 AND p.status = 'visible'`
		}
		if err := tx.QueryRow(r.Context(), q, targetID).Scan(&section); err != nil {
			return err
		}
		if !inSections(sections, section) {
			return pgx.ErrNoRows
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO parent_forum_reports
			    (institution_id, content_kind, content_id, reported_by, reason)
			VALUES ($1, $2, $3, $4, btrim($5))
			ON CONFLICT DO NOTHING`,
			id.InstitutionID, kind, targetID, id.UserID, req.Reason); err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, kind, targetID,
			"reported", actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"reported": true,
		"message":  "a member of staff will read it; the post stays up until they decide",
	})
}

// --- moderation --------------------------------------------------------------

/*
listParentForumQueue is what is waiting for a moderator.

	Narrowed to sections the caller actually reaches, not to everyone holding
	comms.announcements.write — the permission says "this person may publish",
	and a queue that ignored scope would hand a year-8 class teacher every
	class's parents. Oldest first, because the item that has sat three days is
	the one doing damage and a newest-first queue never reaches it.

	Carries pending threads where the school pre-moderates, and reported ones
	everywhere: those are the two things an adult has to look at.
*/
func (s *Server) listParentForumQueue(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.SectionIDs) == 0 && !res.AllStudents {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []pfThread{}})
		return
	}
	items, err := collect(s, r, `
		SELECT`+pfThreadColumns+`
		  FROM parent_forum_threads t
		  JOIN guardians g   ON g.id   = t.author_guardian_id
		  JOIN sections  sec ON sec.id = t.section_id
		  JOIN classes   cl  ON cl.id  = sec.class_id
		 WHERE ($3 OR t.section_id = ANY($4))
		   AND (t.status = 'pending'
		        OR EXISTS (SELECT 1 FROM parent_forum_reports rp
		                    WHERE rp.content_id IN (
		                              SELECT t.id
		                              UNION ALL
		                              SELECT p.id FROM parent_forum_posts p
		                               WHERE p.thread_id = t.id)
		                      AND rp.handled_at IS NULL)
		        OR EXISTS (SELECT 1 FROM parent_forum_posts p
		                    WHERE p.thread_id = t.id AND p.status = 'pending'))
		 ORDER BY t.created_at
		 LIMIT 300`,
		[]any{id.UserID, true, res.AllStudents, res.SectionIDs},
		scanPFThread)
	respond(w, r, items, err)
}

type pfReportRow struct {
	ID       string  `json:"id"`
	Kind     string  `json:"content_kind"`
	Content  string  `json:"content_id"`
	ThreadID string  `json:"thread_id"`
	Title    string  `json:"thread_title"`
	Class    string  `json:"class"`
	Body     string  `json:"body"`
	Reporter string  `json:"reported_by"`
	Reason   string  `json:"reason"`
	At       string  `json:"at"`
	Outcome  *string `json:"outcome,omitempty"`
}

// listParentForumReports is the report queue itself, one row per person who
// objected rather than one per item — a moderator weighing "four people" needs
// to see four names, and the unique index is what makes that count true.
func (s *Server) listParentForumReports(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	open := strings.TrimSpace(r.URL.Query().Get("status")) != "handled"
	items, err := collect(s, r, `
		SELECT rp.id::text, rp.content_kind, rp.content_id::text,
		       th.id::text, th.title, concat_ws('-', cl.name, sec.name),
		       COALESCE(po.body, th.body), u.full_name, rp.reason,
		       to_char(rp.created_at,'YYYY-MM-DD"T"HH24:MI'), rp.outcome
		  FROM parent_forum_reports rp
		  LEFT JOIN parent_forum_posts po ON po.id = rp.content_id
		                                 AND rp.content_kind = 'parent_forum_post'
		  JOIN parent_forum_threads th
		    ON th.id = COALESCE(po.thread_id, rp.content_id)
		  JOIN sections sec ON sec.id = th.section_id
		  JOIN classes  cl  ON cl.id  = sec.class_id
		  LEFT JOIN users u ON u.id = rp.reported_by
		 WHERE ($1 OR th.section_id = ANY($2))
		   AND (rp.handled_at IS NULL) = $3
		 ORDER BY rp.created_at
		 LIMIT 300`,
		[]any{res.AllStudents, res.SectionIDs, open},
		func(rows pgx.Rows) (pfReportRow, error) {
			var v pfReportRow
			return v, rows.Scan(&v.ID, &v.Kind, &v.Content, &v.ThreadID, &v.Title,
				&v.Class, &v.Body, &v.Reporter, &v.Reason, &v.At, &v.Outcome)
		})
	respond(w, r, items, err)
}

// listParentForumHistory is the trail for one thread: every submission,
// report, takedown, lock and conversion, with who and why.
//
// Reads student_content_moderation, the one log — the same table that answers
// the same question about a child's wall post. A parent asking "who took my
// post down and why" is answered from it precisely because the removal and the
// log entry cannot come apart.
func (s *Server) listParentForumHistory(w http.ResponseWriter, r *http.Request) {
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT m.action, u.full_name, m.reason,
		       to_char(m.created_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM student_content_moderation m
		  LEFT JOIN users u ON u.id = m.actor_user_id
		 WHERE (m.content_kind = 'parent_forum_thread' AND m.content_id = $1)
		    OR (m.content_kind = 'parent_forum_post'
		        AND m.content_id IN (SELECT id FROM parent_forum_posts
		                              WHERE thread_id = $1))
		 ORDER BY m.created_at`, []any{threadID},
		func(rows pgx.Rows) (moderationEvent, error) {
			var v moderationEvent
			return v, rows.Scan(&v.Action, &v.Actor, &v.Reason, &v.At)
		})
	respond(w, r, items, err)
}

type pfModerationRequest struct {
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

// The moderator's verbs, and the state each lands the row in. Written as a
// table rather than a switch limb per verb so the thread and the post paths
// cannot drift into disagreeing about what "remove" means.
var pfThreadActions = map[string]string{
	"approve": "open", "reject": "rejected", "remove": "removed",
	"restore": "open", "lock": "", "unlock": "", "pin": "", "unpin": "",
}

var pfPostActions = map[string]string{
	"approve": "visible", "reject": "rejected", "remove": "removed",
	"restore": "visible",
}

// Verbs that take somebody's words off a board, and therefore require a
// reason. "Removed" with no reason is the shape of a decision nobody is
// prepared to defend, and a parent told only that their post is gone assumes
// the worst about why.
var pfNeedsReason = map[string]bool{
	"reject": true, "remove": true, "lock": true,
}

/*
moderateParentForumThread approves, rejects, removes, restores, locks, unlocks,
pins or unpins one thread.

	Every branch is a single transaction containing the state change and its
	log row, so no takedown can exist without an account of who did it and why.
	That is 00083's property and it is the reason this handler does not simply
	call a generic update helper: the two writes have to be inseparable.

	Lock is here rather than as its own route because it is a moderation
	decision on the same object with the same reason requirement, and a school
	auditing "what did we do to this thread" should read one list.

	Delete is not offered. Nothing in this feature hard-deletes a parent's
	words; the strongest verb is remove, which leaves the row, the reason, the
	author's own view of it, and the trail.
*/
func (s *Server) moderateParentForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req pfModerationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	action := strings.TrimSpace(req.Action)
	req.Reason = strings.TrimSpace(req.Reason)
	status, known := pfThreadActions[action]
	if !known {
		httpx.BadRequest(w, r,
			"action must be approve, reject, remove, restore, lock, unlock, pin or unpin")
		return
	}
	if pfNeedsReason[action] && req.Reason == "" {
		httpx.BadRequest(w, r,
			"give a reason — a parent whose post disappears without one concludes the school is hiding something, which is worse than the post was")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT section_id FROM parent_forum_threads WHERE id = $1`,
			threadID).Scan(&section); err != nil {
			return err
		}
		// A holder of announcements.write in another year group is not a
		// moderator of this one.
		if !reachesSection(res, section) {
			return pgx.ErrNoRows
		}
		var q string
		switch action {
		case "lock":
			q = `UPDATE parent_forum_threads
			        SET locked_at = now(), locked_by = $2,
			            lock_reason = nullif(btrim($3), ''), updated_at = now()
			      WHERE id = $1 AND locked_at IS NULL`
		case "unlock":
			q = `UPDATE parent_forum_threads
			        SET locked_at = NULL, locked_by = NULL, lock_reason = NULL,
			            updated_at = now()
			      WHERE id = $1 AND locked_at IS NOT NULL`
		case "pin":
			q = `UPDATE parent_forum_threads
			        SET pinned_at = now(), pinned_by = $2, updated_at = now()
			      WHERE id = $1 AND status = 'open'`
		case "unpin":
			q = `UPDATE parent_forum_threads
			        SET pinned_at = NULL, pinned_by = NULL, updated_at = now()
			      WHERE id = $1 AND pinned_at IS NOT NULL`
		default:
			// A thread coming back onto the board loses its pin: restoring a
			// removed post to the top of the class board is not a decision
			// anybody made.
			q = `UPDATE parent_forum_threads
			        SET status = '` + status + `', moderated_by = $2,
			            moderated_at = now(),
			            moderation_note = nullif(btrim($3), ''),
			            pinned_at = CASE WHEN '` + status + `' = 'open'
			                             THEN pinned_at ELSE NULL END,
			            pinned_by  = CASE WHEN '` + status + `' = 'open'
			                             THEN pinned_by  ELSE NULL END,
			            updated_at = now()
			      WHERE id = $1 AND status <> 'converted'`
		}
		tag, err := tx.Exec(r.Context(), q, threadID, id.UserID, req.Reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Already in that state, or converted and no longer the forum's to
			// move. Same answer either way.
			return pgx.ErrNoRows
		}
		// Handling the thread answers every open report against it: a
		// moderator who acted has looked, and a queue that still lists what
		// was dealt with is a queue nobody trusts.
		outcome := "dismissed"
		if action == "reject" || action == "remove" || action == "lock" {
			outcome = "upheld"
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE parent_forum_reports
			   SET handled_by = $2, handled_at = now(), outcome = $3
			 WHERE content_kind = 'parent_forum_thread' AND content_id = $1
			   AND handled_at IS NULL`, threadID, id.UserID, outcome); err != nil {
			return err
		}
		logged := map[string]string{
			"approve": "approved", "reject": "rejected", "remove": "removed",
			"restore": "restored", "lock": "locked", "unlock": "unlocked",
			"pin": "pinned", "unpin": "unpinned",
		}[action]
		return logStudentContent(r, tx, id.InstitutionID, "parent_forum_thread",
			threadID, logged, actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": threadID.String(), "action": action})
}

// moderateParentForumPost is the same decision on one reply.
//
// Separate handler, same shape and the same inseparable pair of writes. A
// reply has no pin and no lock — those are properties of a conversation, not
// of a sentence in it.
func (s *Server) moderateParentForumPost(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	postID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req pfModerationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	action := strings.TrimSpace(req.Action)
	req.Reason = strings.TrimSpace(req.Reason)
	status, known := pfPostActions[action]
	if !known {
		httpx.BadRequest(w, r, "action must be approve, reject, remove or restore")
		return
	}
	if pfNeedsReason[action] && req.Reason == "" {
		httpx.BadRequest(w, r,
			"give a reason — a takedown a parent cannot be told the reason for is one nobody will defend")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT t.section_id FROM parent_forum_posts p
			  JOIN parent_forum_threads t ON t.id = p.thread_id
			 WHERE p.id = $1`, postID).Scan(&section); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return pgx.ErrNoRows
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE parent_forum_posts
			   SET status = $4, moderated_by = $2, moderated_at = now(),
			       moderation_note = nullif(btrim($3), '')
			 WHERE id = $1 AND status <> $4`,
			postID, id.UserID, req.Reason, status)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		outcome := "dismissed"
		if action == "reject" || action == "remove" {
			outcome = "upheld"
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE parent_forum_reports
			   SET handled_by = $2, handled_at = now(), outcome = $3
			 WHERE content_kind = 'parent_forum_post' AND content_id = $1
			   AND handled_at IS NULL`, postID, id.UserID, outcome); err != nil {
			return err
		}
		logged := map[string]string{
			"approve": "approved", "reject": "rejected",
			"remove": "removed", "restore": "restored",
		}[action]
		return logStudentContent(r, tx, id.InstitutionID, "parent_forum_post",
			postID, logged, actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": postID.String(), "action": action})
}

// --- conversion to a grievance -----------------------------------------------

type pfConvertRequest struct {
	// The grievance category. Same closed list the portal's own concern form
	// uses, so the office's queue stays sortable and does not grow a second
	// vocabulary that only converted threads speak.
	Category string `json:"category,omitempty"`
	// The member of staff the complaint is about, when there is one. This is
	// the load-bearing field: with it named, every staff-facing grievance query
	// excludes the case from that person's view. Omitting it on a complaint
	// about a teacher is how the teacher ends up reading it.
	SubjectEmployeeID string `json:"subject_employee_id,omitempty"`
	// What the parent is told, in the timeline they can actually see.
	Note string `json:"note"`
}

/*
convertParentForumThread moves a thread into the grievance hub.

	This is the answer to the sharpest risk in the whole feature. A parents'
	forum is where a school's reputation is discussed, and sooner or later a
	thread appears that is really a complaint about a named teacher — read by
	forty families and by the teacher, with no SLA and no route to an answer.

	The wrong response is delete. It takes the post down and the concern with
	it, tells the parent nothing, and produces the version of the thread that
	appears on Facebook instead. So the moderation queue's strongest verb on
	such a thread is not remove, it is convert, and one transaction does all of:

	  - takes the thread off the board, status 'converted', with the reason,
	  - raises a support_tickets row RAISED BY THE THREAD'S AUTHOR. Not by the
	    moderator: getPortalFeedback in comms.go matches on raised_by, so a
	    ticket filed under the moderator's name is one the family can never
	    see, and the takedown would have eaten their concern after all,
	  - names subject_employee_id, which is the column every staff-facing
	    grievance query excludes on. That exclusion is the reason the hub is
	    the right home for this and the forum is not,
	  - writes a parent-visible timeline entry saying where their words went,
	  - logs the takedown in the one moderation trail.

	The moderator may not convert a thread that names them as its subject —
	filing a complaint about yourself into a queue you then own is not a
	control anyone should be asked to trust.

	Requires the front desk's write rung on top of the moderation rung, because
	the row lands in the front desk's queue and the SLA it stamps is theirs.
*/
func (s *Server) convertParentForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req pfConvertRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Note = strings.TrimSpace(req.Note)
	if req.Note == "" {
		httpx.BadRequest(w, r,
			"say why this belongs in the grievance queue — the parent reads this note, and a post that vanishes into a case number with no explanation is a takedown wearing a better word")
		return
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		category = "other"
	}
	if !concernCategories[category] {
		httpx.BadRequest(w, r, "choose one of the listed grievance categories")
		return
	}
	var subject any
	if raw := strings.TrimSpace(req.SubjectEmployeeID); raw != "" {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "subject_employee_id must be a uuid")
			return
		}
		subject = v
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var ticket string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section, author uuid.UUID
		var student uuid.UUID
		var title, body, status string
		if err := tx.QueryRow(r.Context(), `
			SELECT section_id, author_user_id, via_student_id, title, body, status
			  FROM parent_forum_threads WHERE id = $1`, threadID).
			Scan(&section, &author, &student, &title, &body, &status); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return pgx.ErrNoRows
		}
		if status == "converted" {
			return errors.New("this thread is already a grievance")
		}
		// A moderator may not file a complaint about themselves into a queue
		// they then work. callerEmployeeID is comms.go's, reused rather than
		// re-derived so the two agree about who a user is as an employee.
		if subject != nil {
			me, err := callerEmployeeID(r.Context(), tx, id.UserID)
			if err != nil {
				return err
			}
			if me != nil && *me == subject.(uuid.UUID) {
				return errors.New(
					"you cannot convert a thread that names you as its subject; hand it to a colleague")
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO support_tickets
			    (institution_id, raised_by, student_id, category, subject, body,
			     priority, audience, subject_employee_id)
			VALUES ($1, $2, $3, $4, $5, $6, 'normal', 'school', $7)
			RETURNING id::text`,
			id.InstitutionID, author, student, category,
			title, body, subject).Scan(&ticket); err != nil {
			return err
		}
		ticketID, err := uuid.Parse(ticket)
		if err != nil {
			return err
		}
		// The parent sees this. visible_to_parent is true deliberately: the
		// whole point of converting rather than deleting is that the family is
		// told where their words went.
		if err := insertFeedbackUpdate(r.Context(), tx, id.InstitutionID, ticketID,
			"note", req.Note, nil, true, id.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE parent_forum_threads
			   SET status = 'converted', converted_ticket_id = $2,
			       moderated_by = $3, moderated_at = now(),
			       moderation_note = btrim($4),
			       pinned_at = NULL, pinned_by = NULL,
			       locked_at = COALESCE(locked_at, now()),
			       locked_by = COALESCE(locked_by, $3),
			       updated_at = now()
			 WHERE id = $1`,
			threadID, ticketID, id.UserID, req.Note); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE parent_forum_reports
			   SET handled_by = $2, handled_at = now(), outcome = 'converted'
			 WHERE content_kind = 'parent_forum_thread' AND content_id = $1
			   AND handled_at IS NULL`, threadID, id.UserID); err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "parent_forum_thread",
			threadID, "converted", actorPtr(id), req.Note)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": threadID.String(), "status": "converted", "grievance_id": ticket,
	})
}
