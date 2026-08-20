package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/go-chi/chi/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* Six more of the child's own screens, and the awkward half of the product.

   Four of the six are children writing where other children read: the wall,
   the homework forum, a lost-property claim naming what is inside somebody's
   bag, and a hand-raise record that says which children are never called on.
   None of those is protected by a permission, because every role in the
   product holds self.profile.read and the group these routes mount inside asks
   for nothing more. What protects a child from another child here is the same
   thing that protects them in student_learning.go: portalChild resolves every
   student id against the caller's own resolved scope before a single row is
   read or written, and a miss is 404 rather than 403 so the endpoint cannot be
   walked to learn which admission numbers exist.

   Three properties are load-bearing and are stated here because they are
   invisible in any single handler:

     1. Pre-moderation on the wall. A post is 'pending' until an adult approves
        it. Post-moderation would leave an unkind post visible for the hours
        between writing and reading, and on a wall of children those are the
        hours that do the harm.

     2. Solutions in the forum are withheld. A reply marked 'solution' is
        invisible to every student but its author until the homework's due date
        has passed. Staff always see it. Without that rule the feature is a
        homework-copying service.

     3. A claim is decided by a person, never by string comparison. The
        claimant describes something the photo does not show; the finder or the
        office reads it and decides, and the row records who and when.

   Mounted from inside the existing /portal group, so paths are relative and
   self.profile.read already applies. Staff acts inside these screens -- moderating
   the wall, taking down a thread, calling on a raised hand -- carry their own
   permission on the route, exactly as the club check-in already does. */

// mountStudentLife registers the wall, diary, display-preference, homework
// forum, hand-raise and lost-property-claim routes.
func (s *Server) mountStudentLife(r chi.Router) {
	// --- lost and found: the photo and the claim -------------------------
	//
	// The board itself lives in student_learning.go and is not duplicated
	// here. What is added is the evidence half: a photo on the notice, a
	// question only the owner can answer, and a decided claim.
	r.Post("/campus/lost-found/{id}/photo", s.attachLostFoundPhoto)
	r.Get("/campus/lost-found/{id}/claims", s.listLostFoundClaims)
	r.Post("/campus/lost-found/{id}/claims", s.claimLostFoundItem)
	r.Post("/campus/lost-found/claims/{id}/withdraw", s.withdrawLostFoundClaim)
	// Deciding is not gated on a permission: the child who handed the bag in
	// is the person who knows what is in the front pocket, and the handler
	// admits them or the front desk and nobody else.
	r.Post("/campus/lost-found/claims/{id}/decide", s.decideLostFoundClaim)

	// --- the student wall ------------------------------------------------
	r.Get("/campus/wall", s.listWallPosts)
	r.Post("/campus/wall", s.postToWall)
	r.Post("/campus/wall/{id}/report", s.reportWallPost)
	r.Group(func(r chi.Router) {
		// Publishing and unpublishing what children say about children is the
		// same authority as publishing an announcement, which class teachers,
		// the office and the principal hold and pupils do not.
		r.Use(httpx.RequirePermission(rbac.AnnouncementsWrite))
		r.Get("/campus/wall/queue", s.listWallQueue)
		r.Post("/campus/wall/{id}/moderate", s.moderateWallPost)
		r.Get("/campus/wall/{id}/history", s.listWallModeration)
	})

	// --- digital diary and schedule --------------------------------------
	r.Get("/diary", s.getStudentDiary)
	r.Get("/diary/notes", s.listDiaryNotes)
	r.Post("/diary/notes", s.createDiaryNote)
	r.Post("/diary/notes/{id}", s.updateDiaryNote)
	r.Delete("/diary/notes/{id}", s.deleteDiaryNote)

	// --- display preferences ---------------------------------------------
	//
	// About the caller's own account, never a child's, so these do not go
	// through portalChild: there is nothing to resolve.
	r.Get("/preferences/display", s.getDisplayPreferences)
	r.Put("/preferences/display", s.saveDisplayPreferences)

	// --- classmate homework help forum -----------------------------------
	r.Get("/homework/forum/threads", s.listForumThreads)
	r.Post("/homework/forum/threads", s.openForumThread)
	r.Get("/homework/forum/threads/{id}", s.getForumThread)
	r.Post("/homework/forum/threads/{id}/posts", s.replyToForumThread)
	r.Post("/homework/forum/threads/{id}/resolve", s.resolveForumThread)
	r.Group(func(r chi.Router) {
		// A teacher sees the threads hanging off their own homework and can
		// take one down. academics.homework.write is the authority over set
		// work throughout the product; see mountTeaching for why not exams.
		r.Use(httpx.RequirePermission(rbac.HomeworkWrite))
		r.Get("/homework/forum/supervision", s.superviseForumThreads)
		r.Post("/homework/forum/threads/{id}/remove", s.removeForumThread)
		r.Post("/homework/forum/posts/{id}/remove", s.removeForumPost)
	})

	// --- virtual classroom hand raise ------------------------------------
	r.Get("/live-classes", s.listMyLiveClasses)
	r.Post("/live-classes/{id}/hand", s.raiseHand)
	r.Post("/live-classes/{id}/hand/lower", s.lowerHand)
	r.Get("/live-classes/my-engagement", s.getMyHandRaiseHistory)
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.HomeworkWrite))
		r.Get("/live-classes/{id}/hands", s.listRaisedHands)
		r.Post("/live-classes/hands/{id}/call-on", s.callOnRaisedHand)
		r.Get("/live-classes/engagement", s.getHandRaiseTelemetry)
	})
}

// --- shared helpers -----------------------------------------------------------

// logStudentContent writes one row of the takedown trail.
//
// Runs inside the caller's transaction so a removal and its record commit
// together. A takedown whose log entry failed separately is a takedown nobody
// can account for, which is the single thing this table exists to prevent.
func logStudentContent(r *http.Request, tx pgx.Tx, inst uuid.UUID, kind string,
	id uuid.UUID, action string, actor *uuid.UUID, reason string) error {
	_, err := tx.Exec(r.Context(), `
		INSERT INTO student_content_moderation
		    (institution_id, content_kind, content_id, action, actor_user_id, reason)
		VALUES ($1, $2, $3, $4, $5, nullif(btrim($6), ''))`,
		inst, kind, id, action, actor, reason)
	return err
}

// actorPtr is the caller's user id in the shape the log column wants.
func actorPtr(id *httpx.Identity) *uuid.UUID {
	u := id.UserID
	return &u
}

// pathUUID reads a uuid out of the path, answering 404 on anything else.
//
// 404 rather than 400 deliberately: on these routes the id is a child's post
// or another child's claim, and "that is not a uuid" and "that is not yours"
// should be indistinguishable from outside.
func pathUUID(w http.ResponseWriter, r *http.Request, key string) (uuid.UUID, bool) {
	v, err := uuid.Parse(chi.URLParam(r, key))
	if err != nil {
		httpx.NotFound(w, r)
		return uuid.Nil, false
	}
	return v, true
}

// --- lost and found: photo ----------------------------------------------------

type lostFoundPhotoRequest struct {
	FileID      string `json:"file_id,omitempty"`
	ExternalURL string `json:"external_url,omitempty"`
	// The question the claimant has to answer. Optional; a found umbrella
	// needs no interrogation.
	ClaimPrompt string `json:"claim_prompt,omitempty"`
}

/*
attachLostFoundPhoto puts a picture and a challenge question on a notice.

	Takes a file_id minted by POST /api/v1/files/presign, or an external_url.
	The second exists because object storage is unconfigured on this deployment
	and presign answers 503 -- without it the photo half of a "photo board"
	would be dead in production while looking finished. Copied deliberately from
	addSQAAEvidence rather than invented, so both attach points fail the same way.

	Only the person who posted the notice, or the front desk, may do this. A
	third child replacing the photo on somebody else's notice is how a board
	stops being believed.
*/
func (s *Server) attachLostFoundPhoto(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	itemID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req lostFoundPhotoRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.ExternalURL = strings.TrimSpace(req.ExternalURL)
	req.ClaimPrompt = strings.TrimSpace(req.ClaimPrompt)
	fileRef := strings.TrimSpace(req.FileID)
	if (fileRef == "") == (req.ExternalURL == "") {
		httpx.BadRequest(w, r,
			"attach exactly one of file_id (upload it first) or external_url")
		return
	}
	var fileArg any
	if fileRef != "" {
		f, err := uuid.Parse(fileRef)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		fileArg = f
	}
	staff := id.Can(rbac.FrontDeskWrite)

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE lost_found_items
			   SET file_id      = $3,
			       photo_url    = nullif($4, ''),
			       claim_prompt = COALESCE(nullif($5, ''), claim_prompt)
			 WHERE id = $1
			   AND status IN ('open', 'claimed')
			   AND (reported_by = $2 OR $6)
			RETURNING id::text`,
			itemID, id.UserID, fileArg, req.ExternalURL, req.ClaimPrompt, staff).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

// --- lost and found: claims ---------------------------------------------------

type lostFoundClaim struct {
	ID        string `json:"id"`
	ItemID    string `json:"item_id"`
	ItemTitle string `json:"item_title"`
	StudentID string `json:"claimant_student_id"`
	Claimant  string `json:"claimant_name"`
	// The class rather than a phone number, same as the board itself.
	ClaimantClass *string `json:"claimant_class,omitempty"`
	// Withheld from everyone but the finder, the office and its author. The
	// point of the answer is that it is not public; a list that showed it
	// would coach the next claimant.
	Answer     *string `json:"answer,omitempty"`
	Status     string  `json:"status"`
	DecidedBy  *string `json:"decided_by,omitempty"`
	DecidedAt  *string `json:"decided_at,omitempty"`
	Decision   *string `json:"decision_note,omitempty"`
	ClaimedOn  string  `json:"claimed_on"`
	Mine       bool    `json:"claimed_by_me"`
	CanDecide  bool    `json:"can_decide"`
	ClaimPromp *string `json:"claim_prompt,omitempty"`
}

type lostFoundClaimRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Answer    string `json:"answer"`
}

/*
claimLostFoundItem files a claim, with the description that has to hold up.

	The whole feature is the answer field. A board where the first click wins
	hands a bag to whoever refreshes fastest; requiring a description of
	something the photo does not show costs the honest owner ten seconds and
	costs an opportunist the one thing they do not have.

	Nothing is compared automatically. There is no string equality that
	survives "a red bus sticker" against "sticker of a bus, red", and a
	comparison that fails closed hands the bag to nobody while one that fails
	open hands it to anybody. A person reads it and the row records which
	person.
*/
func (s *Server) claimLostFoundItem(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	itemID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req lostFoundClaimRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	req.Answer = strings.TrimSpace(req.Answer)
	if len(req.Answer) < 10 {
		httpx.BadRequest(w, r,
			"describe something about the item the photo does not show — a few words is not enough to tell one bottle from another")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The notice has to exist, be open, and not be the claimant's own.
		// Claiming your own found item is not a claim, it is a typo.
		var reporter uuid.UUID
		var reporterStudent *uuid.UUID
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT reported_by, reporter_student_id, status
			  FROM lost_found_items
			 WHERE id = $1 AND status IN ('open', 'claimed')`, itemID).
			Scan(&reporter, &reporterStudent, &status); err != nil {
			return err
		}
		if reporterStudent != nil && *reporterStudent == student {
			return errors.New("this is your own notice")
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO lost_found_claims
			    (institution_id, item_id, claimant_student_id, claimed_by, answer)
			VALUES ($1, $2, $3, $4, btrim($5))
			RETURNING id::text`,
			id.InstitutionID, itemID, student, id.UserID, req.Answer).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "already_claimed",
			"you have already claimed this item; wait for it to be decided")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": "pending"})
	}
}

/*
listLostFoundClaims shows the claims on one notice.

	Who sees what is the whole of the authorization here. The finder and the
	front desk see every claim and every answer, because deciding is their job.
	Anyone else sees only their own claim, and never the answer text of
	another -- publishing the answers would turn the verification into a
	multiple-choice question with the answer printed underneath.
*/
func (s *Server) listLostFoundClaims(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	itemID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	staff := id.Can(rbac.FrontDeskWrite)

	items, err := collect(s, r, `
		SELECT c.id::text, c.item_id::text, lf.title, c.claimant_student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       concat_ws('-', cl.name, sec.name),
		       CASE WHEN lf.reported_by = $2 OR $3 OR c.claimed_by = $2
		            THEN c.answer END,
		       c.status, u.full_name,
		       to_char(c.decided_at,'YYYY-MM-DD"T"HH24:MI'), c.decision_note,
		       to_char(c.created_at,'YYYY-MM-DD'),
		       c.claimed_by = $2,
		       (lf.reported_by = $2 OR $3) AND c.status = 'pending',
		       CASE WHEN lf.reported_by = $2 OR $3 OR c.claimed_by = $2
		            THEN lf.claim_prompt END
		  FROM lost_found_claims c
		  JOIN lost_found_items lf ON lf.id = c.item_id
		  JOIN students st ON st.id = c.claimant_student_id
		  LEFT JOIN users u ON u.id = c.decided_by
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  cl  ON cl.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE c.item_id = $1
		   -- The finder and the office see the lot; a claimant sees their own.
		   AND (lf.reported_by = $2 OR $3 OR c.claimant_student_id = ANY($4))
		 ORDER BY c.created_at`,
		[]any{itemID, id.UserID, staff, res.StudentIDs},
		func(rows pgx.Rows) (lostFoundClaim, error) {
			var v lostFoundClaim
			return v, rows.Scan(&v.ID, &v.ItemID, &v.ItemTitle, &v.StudentID,
				&v.Claimant, &v.ClaimantClass, &v.Answer, &v.Status, &v.DecidedBy,
				&v.DecidedAt, &v.Decision, &v.ClaimedOn, &v.Mine, &v.CanDecide,
				&v.ClaimPromp)
		})
	respond(w, r, items, err)
}

type claimDecisionRequest struct {
	Decision string `json:"decision"`
	Note     string `json:"note,omitempty"`
}

/*
decideLostFoundClaim releases the item, or refuses.

	Approving does three things in one transaction, and all three or none: the
	claim is approved, the notice is marked returned, and the notice records
	which child walked away with it and who handed it over. 00037's
	resolved_by is not that fact -- the clerk who closes a stale notice is not
	the person who released a bag -- so released_to/released_by/released_at sit
	beside it.

	Every other pending claim on the same item is rejected in the same
	transaction. Leaving them pending would show three children a claim still
	being considered on an item that is already in somebody's hand.
*/
func (s *Server) decideLostFoundClaim(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req claimDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	decision := strings.TrimSpace(req.Decision)
	if decision != "approved" && decision != "rejected" {
		httpx.BadRequest(w, r, "decision must be approved or rejected")
		return
	}
	staff := id.Can(rbac.FrontDeskWrite)

	var itemTitle string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var itemID, claimant uuid.UUID
		// The finder decides their own notice; the front desk decides any,
		// because unclaimed property ends up at the office in practice.
		if err := tx.QueryRow(r.Context(), `
			SELECT c.item_id, c.claimant_student_id, lf.title
			  FROM lost_found_claims c
			  JOIN lost_found_items lf ON lf.id = c.item_id
			 WHERE c.id = $1 AND c.status = 'pending'
			   AND (lf.reported_by = $2 OR $3)
			   FOR UPDATE OF c`, claimID, id.UserID, staff).
			Scan(&itemID, &claimant, &itemTitle); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE lost_found_claims
			   SET status = $2, decided_by = $3, decided_at = now(),
			       decision_note = nullif(btrim($4), '')
			 WHERE id = $1`, claimID, decision, id.UserID, req.Note); err != nil {
			return err
		}
		if decision != "approved" {
			return nil
		}
		// Everyone else waiting on this item is told now, not never.
		if _, err := tx.Exec(r.Context(), `
			UPDATE lost_found_claims
			   SET status = 'rejected', decided_by = $2, decided_at = now(),
			       decision_note = 'the item was released to another claimant'
			 WHERE item_id = $1 AND id <> $3 AND status = 'pending'`,
			itemID, id.UserID, claimID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE lost_found_items
			   SET status = 'returned',
			       resolved_at = COALESCE(resolved_at, now()),
			       resolved_by = COALESCE(resolved_by, $2),
			       released_to_student_id = $3,
			       released_by = $2,
			       released_at = now(),
			       resolution_note = COALESCE(nullif(btrim($4), ''), resolution_note)
			 WHERE id = $1`, itemID, id.UserID, claimant, req.Note)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Not yours to decide, or already decided. Both are "there is nothing
		// here for you".
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"id": claimID.String(), "status": decision, "item": itemTitle})
	}
}

// withdrawLostFoundClaim lets a child take back a claim they filed by mistake.
//
// Only their own, and only while it is pending. Withdrawing frees the partial
// unique index so they can claim again with a better description.
func (s *Server) withdrawLostFoundClaim(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE lost_found_claims SET status = 'withdrawn'
			 WHERE id = $1 AND claimed_by = $2 AND status = 'pending'
			RETURNING id::text`, claimID, id.UserID).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": "withdrawn"})
}

// --- the student wall ---------------------------------------------------------

// wallDailyLimit caps how many recognitions one child may write in a day.
//
// Three. Not because three is principled but because unbounded is not: a child
// who can post forty times decides who the wall is about, and a wall that one
// child decides is an instrument of exclusion whatever the words say. Rejected
// and removed posts count toward it too -- otherwise the way to a fresh
// allowance is to write something that gets taken down.
const wallDailyLimit = 3

type wallPost struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Body     string `json:"body"`
	Author   string `json:"author_name"`
	// The class, not the section roll. Enough to know who is being thanked.
	AuthorClass  *string `json:"author_class,omitempty"`
	Subject      string  `json:"subject_name"`
	SubjectClass *string `json:"subject_class,omitempty"`
	Status       string  `json:"status"`
	Mine         bool    `json:"written_by_me"`
	AboutMe      bool    `json:"about_me"`
	PostedOn     string  `json:"posted_on"`
	Note         *string `json:"moderation_note,omitempty"`
	ModeratedBy  *string `json:"moderated_by,omitempty"`
}

/*
listWallPosts is the wall as a child reads it.

	Published posts only, campus-wide, newest first, plus the caller's own
	pending ones so a child can see their compliment is waiting rather than
	assume it vanished. A pending post written by somebody else is not here and
	must never be: the whole point of pre-moderation is that nobody reads it
	until an adult has.
*/
func (s *Server) listWallPosts(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT p.id::text, p.category, p.body,
		       concat_ws(' ', a.first_name, a.last_name),
		       concat_ws('-', acl.name, asec.name),
		       concat_ws(' ', t.first_name, t.last_name),
		       concat_ws('-', tcl.name, tsec.name),
		       p.status, p.author_student_id = ANY($3),
		       p.subject_student_id = ANY($3),
		       to_char(p.posted_on,'YYYY-MM-DD'), p.moderation_note, mu.full_name
		  FROM student_wall_posts p
		  JOIN students a ON a.id = p.author_student_id
		  JOIN students t ON t.id = p.subject_student_id
		  LEFT JOIN users mu ON mu.id = p.moderated_by
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = a.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) ae ON true
		  LEFT JOIN classes  acl  ON acl.id  = ae.class_id
		  LEFT JOIN sections asec ON asec.id = ae.section_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = t.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) te ON true
		  LEFT JOIN classes  tcl  ON tcl.id  = te.class_id
		  LEFT JOIN sections tsec ON tsec.id = te.section_id
		 WHERE p.campus_id = $1
		   AND (p.status = 'published'
		        -- Your own, whatever state it is in. Somebody else's pending
		        -- post is not visible to anyone without a permission.
		        OR (p.status <> 'published' AND p.author_student_id = ANY($3)))
		   AND ($2::text IS NULL OR p.category = $2)
		 ORDER BY (p.status = 'published') DESC, p.created_at DESC
		 LIMIT 200`,
		[]any{room.CampusID, nullString(strings.TrimSpace(r.URL.Query().Get("category"))),
			res.StudentIDs},
		func(rows pgx.Rows) (wallPost, error) {
			var v wallPost
			return v, rows.Scan(&v.ID, &v.Category, &v.Body, &v.Author, &v.AuthorClass,
				&v.Subject, &v.SubjectClass, &v.Status, &v.Mine, &v.AboutMe,
				&v.PostedOn, &v.Note, &v.ModeratedBy)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "daily_limit": wallDailyLimit,
		"moderation": "pre",
	})
}

type wallPostRequest struct {
	StudentID string `json:"student_id,omitempty"`
	// Who is being recognised.
	SubjectStudentID string `json:"subject_student_id"`
	Category         string `json:"category"`
	Body             string `json:"body"`
}

var errWallLimit = errors.New("daily limit reached")

/*
postToWall writes a recognition, which nobody sees until an adult approves it.

	Three checks stand between a child and the wall, and all three are here
	rather than in the UI:

	  - The author must be a child the caller actually owns. portalChild.
	  - The subject must be a real student on the same campus, and not the
	    author. A recognition of yourself is a status update.
	  - No more than wallDailyLimit in a day.

	The subject is NOT narrowed to the caller's own scope, and that is
	deliberate: the point of the feature is thanking a child in another class
	who returned your bag. What stops it being an enumeration oracle is that
	the response never says whether the id existed -- an unknown subject and a
	subject on another campus both come back as the same refusal.
*/
func (s *Server) postToWall(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req wallPostRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, author, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	room, err := s.classroomOf(r, author)
	if err != nil {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"you need an enrolment before you can post to the wall")
		return
	}
	subject, err := uuid.Parse(strings.TrimSpace(req.SubjectStudentID))
	if err != nil {
		httpx.BadRequest(w, r, "subject_student_id must be a uuid")
		return
	}
	if subject == author {
		httpx.BadRequest(w, r, "you cannot recognise yourself")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if len(req.Body) < 10 {
		httpx.BadRequest(w, r,
			"say what they actually did — a wall of one-word compliments is a popularity contest")
		return
	}
	if len(req.Body) > 500 {
		httpx.BadRequest(w, r, "keep it under 500 characters")
		return
	}
	category := strings.TrimSpace(req.Category)
	if category == "" {
		httpx.BadRequest(w, r, "category is required")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var onCampus bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM students WHERE id = $1 AND campus_id = $2)`,
			subject, room.CampusID).Scan(&onCampus); err != nil {
			return err
		}
		if !onCampus {
			return pgx.ErrNoRows
		}
		var used int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FROM student_wall_posts
			 WHERE author_student_id = $1 AND posted_on = CURRENT_DATE`,
			author).Scan(&used); err != nil {
			return err
		}
		if used >= wallDailyLimit {
			return errWallLimit
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO student_wall_posts
			    (institution_id, campus_id, author_student_id, author_user_id,
			     subject_student_id, category, body)
			VALUES ($1, $2, $3, $4, $5, $6, btrim($7))
			RETURNING id::text`,
			id.InstitutionID, room.CampusID, author, id.UserID, subject,
			category, req.Body).Scan(&out); err != nil {
			return err
		}
		postID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "wall_post", postID,
			"submitted", actorPtr(id), "")
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Unknown subject, or a child on another campus. Same answer for both.
		httpx.NotFound(w, r)
	case errors.Is(err, errWallLimit):
		httpx.Error(w, r, http.StatusConflict, "daily_limit",
			"you have written your posts for today; the wall is not a feed")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": out, "status": "pending",
			"message": "a teacher will read it before it goes up",
		})
	}
}

// listWallQueue is the moderator's list: what is waiting, oldest first.
//
// Oldest first because a compliment that sat for three days is the one whose
// latency is doing damage, and a newest-first queue never reaches it.
func (s *Server) listWallQueue(w http.ResponseWriter, r *http.Request) {
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "" {
		status = "pending"
	}
	items, err := collect(s, r, `
		SELECT p.id::text, p.category, p.body,
		       concat_ws(' ', a.first_name, a.last_name),
		       concat_ws('-', acl.name, asec.name),
		       concat_ws(' ', t.first_name, t.last_name),
		       concat_ws('-', tcl.name, tsec.name),
		       p.status, false, false,
		       to_char(p.posted_on,'YYYY-MM-DD'), p.moderation_note, mu.full_name
		  FROM student_wall_posts p
		  JOIN students a ON a.id = p.author_student_id
		  JOIN students t ON t.id = p.subject_student_id
		  LEFT JOIN users mu ON mu.id = p.moderated_by
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = a.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) ae ON true
		  LEFT JOIN classes  acl  ON acl.id  = ae.class_id
		  LEFT JOIN sections asec ON asec.id = ae.section_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = t.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) te ON true
		  LEFT JOIN classes  tcl  ON tcl.id  = te.class_id
		  LEFT JOIN sections tsec ON tsec.id = te.section_id
		 WHERE p.status = $1
		 ORDER BY p.created_at
		 LIMIT 300`, []any{status},
		func(rows pgx.Rows) (wallPost, error) {
			var v wallPost
			return v, rows.Scan(&v.ID, &v.Category, &v.Body, &v.Author, &v.AuthorClass,
				&v.Subject, &v.SubjectClass, &v.Status, &v.Mine, &v.AboutMe,
				&v.PostedOn, &v.Note, &v.ModeratedBy)
		})
	respond(w, r, items, err)
}

type moderationRequest struct {
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

/*
moderateWallPost approves, rejects, removes or restores one post.

	Takedown is immediate -- one UPDATE, no queue, no soft window -- and it is
	logged in the same transaction, so there is no state in which a post is
	gone and no row says who took it down. A parent asking "who removed what my
	child wrote, and why" is answered from student_content_moderation, and it
	is answerable precisely because the two writes cannot come apart.

	A reason is required for anything negative. "Removed" with no reason is the
	shape of a decision nobody is prepared to defend.
*/
func (s *Server) moderateWallPost(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	postID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req moderationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	action := strings.TrimSpace(req.Action)
	req.Reason = strings.TrimSpace(req.Reason)
	var status string
	switch action {
	case "approve":
		status = "published"
	case "reject":
		status = "rejected"
	case "remove":
		status = "removed"
	case "restore":
		status = "published"
	default:
		httpx.BadRequest(w, r, "action must be approve, reject, remove or restore")
		return
	}
	if (action == "reject" || action == "remove") && req.Reason == "" {
		httpx.BadRequest(w, r,
			"give a reason — a takedown a child cannot be told the reason for is one nobody will defend")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var got string
		if err := tx.QueryRow(r.Context(), `
			UPDATE student_wall_posts
			   SET status = $2, moderated_by = $3, moderated_at = now(),
			       moderation_note = nullif(btrim($4), '')
			 WHERE id = $1
			RETURNING id::text`, postID, status, id.UserID, req.Reason).Scan(&got); err != nil {
			return err
		}
		logged := map[string]string{
			"approve": "approved", "reject": "rejected",
			"remove": "removed", "restore": "restored",
		}[action]
		return logStudentContent(r, tx, id.InstitutionID, "wall_post", postID,
			logged, actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": postID.String(), "status": status})
}

// reportWallPost lets any reader flag a published post for an adult to read.
//
// Writes only the log row; it does not hide the post. A report that took a
// post down on its own would be a heckler's veto handed to thirty children,
// and the first use of it would be against the child nobody likes.
func (s *Server) reportWallPost(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	postID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req moderationRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say what is wrong with it")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM student_wall_posts
			                WHERE id = $1 AND status = 'published')`,
			postID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		return logStudentContent(r, tx, id.InstitutionID, "wall_post", postID,
			"reported", actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"reported": true})
}

type moderationEvent struct {
	Action string  `json:"action"`
	Actor  *string `json:"actor,omitempty"`
	Reason *string `json:"reason,omitempty"`
	At     string  `json:"at"`
}

// listWallModeration is the trail for one post, for the adult who has to
// account for it.
func (s *Server) listWallModeration(w http.ResponseWriter, r *http.Request) {
	postID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT m.action, u.full_name, m.reason,
		       to_char(m.created_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM student_content_moderation m
		  LEFT JOIN users u ON u.id = m.actor_user_id
		 WHERE m.content_kind = 'wall_post' AND m.content_id = $1
		 ORDER BY m.created_at`, []any{postID},
		func(rows pgx.Rows) (moderationEvent, error) {
			var v moderationEvent
			return v, rows.Scan(&v.Action, &v.Actor, &v.Reason, &v.At)
		})
	respond(w, r, items, err)
}

// --- digital diary and schedule -----------------------------------------------

type diaryEntry struct {
	Date     string  `json:"on_date"`
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	Detail   *string `json:"detail,omitempty"`
	StartsAt *string `json:"starts_at,omitempty"`
	EndsAt   *string `json:"ends_at,omitempty"`
	// Set for notes, so the day view can offer the tick.
	RefID *string `json:"ref_id,omitempty"`
	Done  bool    `json:"done"`
}

/*
getStudentDiary is the child's day and week in one read.

	Every source but one already exists and is read rather than copied:
	timetable_entries is the periods, homework the work due, exam_subjects the
	tests, holidays the closures and parents' evenings, club_events the rest.
	Copying any of them into a diary table would mean a diary that disagrees
	with the timetable the day the office moves a period, and the child would
	believe the wrong one.

	The one thing the school does not already know is what the child wrote for
	themselves, which is student_diary_notes and is unioned in here so a day
	reads as a day rather than as two lists to reconcile.

	Defaults to today through the next six days. A week is the horizon a child
	plans over; a term of periods is a wall.
*/
func (s *Server) getStudentDiary(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	from, err := optionalDate(strings.TrimSpace(r.URL.Query().Get("from")))
	if err != nil {
		httpx.BadRequest(w, r, "from must be YYYY-MM-DD")
		return
	}
	to, err := optionalDate(strings.TrimSpace(r.URL.Query().Get("to")))
	if err != nil {
		httpx.BadRequest(w, r, "to must be YYYY-MM-DD")
		return
	}
	today := nowInIndia()
	if from == nil {
		v := today.Format(time.DateOnly)
		from = &v
	}
	if to == nil {
		v := today.AddDate(0, 0, 6).Format(time.DateOnly)
		to = &v
	}

	items, err := collect(s, r, `
		WITH bounds AS (SELECT $4::date AS f, LEAST($5::date, $4::date + 60) AS t),
		     days AS (
		         SELECT d::date AS on_date
		           FROM bounds b, generate_series(b.f, b.t, interval '1 day') d
		     )
		SELECT * FROM (
		    -- The timetable, expanded onto real dates. weekday is ISO 1-7,
		    -- which is what EXTRACT(ISODOW) gives, so Sunday is 7 on both sides.
		    SELECT to_char(d.on_date,'YYYY-MM-DD') AS on_date,
		           'period'::text AS kind,
		           concat_ws(' · ', p.name, sub.name) AS title,
		           concat_ws(' · ', nullif(te.room, ''), tu.full_name) AS detail,
		           to_char(p.starts_at,'HH24:MI') AS starts_at,
		           to_char(p.ends_at,'HH24:MI')   AS ends_at,
		           NULL::text AS ref_id, false AS done
		      FROM days d
		      JOIN timetable_entries te
		        ON te.section_id = $2
		       AND te.academic_year_id = $3
		       AND te.weekday = EXTRACT(ISODOW FROM d.on_date)
		      JOIN periods        p   ON p.id  = te.period_id
		      JOIN class_subjects cs  ON cs.id = te.class_subject_id
		      JOIN subjects       sub ON sub.id = cs.subject_id
		      LEFT JOIN users     tu  ON tu.id = te.teacher_user_id
		     WHERE NOT p.is_break
		       -- A closure that covers the day removes its periods. A diary
		       -- that lists six lessons on Diwali is not a diary.
		       AND NOT EXISTS (
		           SELECT 1 FROM holidays h
		            WHERE h.applies_to IN ('all','students')
		              AND h.kind IN ('holiday','vacation')
		              AND (h.campus_id IS NULL OR h.campus_id = $6)
		              AND d.on_date BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date))

		    UNION ALL

		    -- Work due, not work set. A child planning a week needs the
		    -- deadline; the set date is history by then.
		    SELECT to_char(hw.due_on,'YYYY-MM-DD'), 'homework',
		           hw.title, sub.name, NULL, NULL, hw.id::text, false
		      FROM homework hw
		      LEFT JOIN class_subjects cs  ON cs.id = hw.class_subject_id
		      LEFT JOIN subjects       sub ON sub.id = cs.subject_id,
		           bounds b
		     WHERE hw.section_id = $2 AND hw.is_published
		       AND hw.due_on BETWEEN b.f AND b.t

		    UNION ALL

		    -- The papers this child's own class sits, and only those.
		    SELECT to_char(es.exam_date,'YYYY-MM-DD'), 'exam',
		           ex.name || ' — ' || sub.name,
		           concat_ws(' · ',
		                     CASE WHEN es.duration_minutes IS NOT NULL
		                          THEN es.duration_minutes || ' min' END,
		                     'max ' || es.max_marks),
		           to_char(es.starts_at,'HH24:MI'), NULL, es.id::text, false
		      FROM exam_subjects es
		      JOIN exams          ex  ON ex.id = es.exam_id
		      JOIN class_subjects cs  ON cs.id = es.class_subject_id
		      JOIN subjects       sub ON sub.id = cs.subject_id, bounds b
		     WHERE cs.class_id = $1 AND es.exam_date BETWEEN b.f AND b.t

		    UNION ALL

		    -- Closures, vacations, parents' evenings.
		    SELECT to_char(h.on_date,'YYYY-MM-DD'), h.kind, h.name, h.description,
		           NULL, NULL, NULL, false
		      FROM holidays h, bounds b
		     WHERE h.on_date BETWEEN b.f AND b.t
		       AND h.applies_to IN ('all','students')
		       AND (h.campus_id IS NULL OR h.campus_id = $6)

		    UNION ALL

		    -- Club nights this year group may attend.
		    SELECT to_char(ev.starts_at,'YYYY-MM-DD'), 'club_event',
		           ev.club_name || ' — ' || ev.title, ev.venue,
		           to_char(ev.starts_at,'HH24:MI'), NULL, ev.id::text, false
		      FROM club_events ev, bounds b
		     WHERE ev.campus_id = $6 AND ev.status IN ('open','closed','done')
		       AND ev.starts_at::date BETWEEN b.f AND b.t

		    UNION ALL

		    -- What the child wrote for themselves. Private: there is no path
		    -- in this file by which a teacher reads one.
		    SELECT to_char(n.on_date,'YYYY-MM-DD'), 'note', n.body, n.kind,
		           NULL, NULL, n.id::text, n.done_at IS NOT NULL
		      FROM student_diary_notes n, bounds b
		     WHERE n.student_id = $7 AND n.on_date BETWEEN b.f AND b.t
		) diary
		 ORDER BY on_date, starts_at NULLS LAST, kind, title`,
		[]any{room.ClassID, room.SectionID, room.YearID, from, to, room.CampusID,
			room.StudentID},
		func(rows pgx.Rows) (diaryEntry, error) {
			var v diaryEntry
			return v, rows.Scan(&v.Date, &v.Kind, &v.Title, &v.Detail, &v.StartsAt,
				&v.EndsAt, &v.RefID, &v.Done)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": room.StudentID.String(),
		"class_name": room.ClassName, "section_name": room.SectionName,
		"from": *from, "to": *to, "items": items,
	})
}

type diaryNote struct {
	ID     string  `json:"id"`
	Date   string  `json:"on_date"`
	Kind   string  `json:"kind"`
	Body   string  `json:"body"`
	DoneAt *string `json:"done_at,omitempty"`
}

// listDiaryNotes returns the child's own notes over a window.
func (s *Server) listDiaryNotes(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	from, err := optionalDate(strings.TrimSpace(r.URL.Query().Get("from")))
	if err != nil {
		httpx.BadRequest(w, r, "from must be YYYY-MM-DD")
		return
	}
	to, err := optionalDate(strings.TrimSpace(r.URL.Query().Get("to")))
	if err != nil {
		httpx.BadRequest(w, r, "to must be YYYY-MM-DD")
		return
	}
	items, err := collect(s, r, `
		SELECT id::text, to_char(on_date,'YYYY-MM-DD'), kind, body,
		       to_char(done_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM student_diary_notes
		 WHERE student_id = $1
		   AND ($2::date IS NULL OR on_date >= $2)
		   AND ($3::date IS NULL OR on_date <= $3)
		 ORDER BY on_date DESC, created_at
		 LIMIT 500`, []any{room.StudentID, from, to},
		func(rows pgx.Rows) (diaryNote, error) {
			var v diaryNote
			return v, rows.Scan(&v.ID, &v.Date, &v.Kind, &v.Body, &v.DoneAt)
		})
	respond(w, r, items, err)
}

type diaryNoteRequest struct {
	StudentID string `json:"student_id,omitempty"`
	OnDate    string `json:"on_date,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Body      string `json:"body"`
	// Tri-state on update: nil leaves it alone, true ticks, false unticks.
	Done *bool `json:"done,omitempty"`
}

func (s *Server) createDiaryNote(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req diaryNoteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		httpx.BadRequest(w, r, "write something")
		return
	}
	if len(req.Body) > 2000 {
		httpx.BadRequest(w, r, "keep a note under 2000 characters")
		return
	}
	on, err := optionalDate(req.OnDate)
	if err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	if on == nil {
		v := nowInIndia().Format(time.DateOnly)
		on = &v
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = "note"
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_diary_notes
			    (institution_id, student_id, author_user_id, on_date, kind, body)
			VALUES ($1, $2, $3, $4::date, $5, btrim($6))
			RETURNING id::text`,
			id.InstitutionID, student, id.UserID, on, kind, req.Body).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

/*
updateDiaryNote edits or ticks off one note.

	The WHERE clause carries the authorization: student_id = ANY(the caller's
	own children). A note belonging to another child does not 403, it does not
	exist, which is the same answer a made-up uuid gets.
*/
func (s *Server) updateDiaryNote(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	noteID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req diaryNoteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(req.Body) > 2000 {
		httpx.BadRequest(w, r, "keep a note under 2000 characters")
		return
	}
	on, err := optionalDate(strings.TrimSpace(req.OnDate))
	if err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE student_diary_notes
			   SET body    = COALESCE(nullif(btrim($3), ''), body),
			       kind    = COALESCE(nullif(btrim($4), ''), kind),
			       on_date = COALESCE($5::date, on_date),
			       done_at = CASE WHEN $6::boolean IS NULL THEN done_at
			                      WHEN $6 THEN COALESCE(done_at, now())
			                      ELSE NULL END,
			       updated_at = now()
			 WHERE id = $1 AND student_id = ANY($2)
			RETURNING id::text`,
			noteID, res.StudentIDs, req.Body, req.Kind, on, req.Done).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteDiaryNote(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	noteID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			DELETE FROM student_diary_notes
			 WHERE id = $1 AND student_id = ANY($2)
			RETURNING id::text`, noteID, res.StudentIDs).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": out})
}

// --- display preferences ------------------------------------------------------

// displayPreference is what this account has chosen, plus what it is allowed to
// choose. The options ride along with the value so the selector never offers a
// theme the stylesheet does not implement.
type displayPreference struct {
	Theme        string `json:"theme"`
	Density      string `json:"density"`
	ReduceMotion bool   `json:"reduce_motion"`
	// Interface language, and the high-contrast override. Both live on this
	// same row rather than a store of their own: they are the same kind of
	// fact -- this account's own reading comfort -- and one Save must not be
	// able to half-succeed across two tables. See internal/api/i18n.go.
	Locale       string `json:"locale"`
	HighContrast bool   `json:"high_contrast"`
	// Which dashboard layout the shell renders. Same row, same Save, same
	// reasoning as the locale above: one row, one write, and a header toggle
	// that cannot disagree with a settings screen. See
	// docs/BENTO_UI_CONTRACT.md.
	Layout string `json:"layout"`
}

// themeChoices and densityChoices are exactly what web/src/index.css already
// implements: a light palette on :root, a .dark override, and a data-density
// dial with three steps.
//
// Adding a value to either list without adding the tokens to index.css yields
// a setting that appears to work and does nothing, which is worse than not
// offering it. The product owner has frozen visual changes, so the lists are
// closed here and the API validates against them.
var (
	themeChoices   = []string{"system", "light", "dark"}
	densityChoices = []string{"compact", "comfortable", "relaxed"}
	// The layouts the client actually implements. Closed for the same reason
	// the theme list is closed: a stored layout with no implementation behind
	// it is a preference that appears to work and does nothing. It must stay
	// in step with LAYOUTS in web/src/lib/layout.tsx and with the CHECK
	// constraint added in migrations/00136_bento_layout.sql.
	layoutChoices = []string{"classic", "bento"}
)

// defaultLayout is the layout an account that has never touched the switch
// gets, and the one anything unrecognised falls through to. Classic is the
// product as it ships; see docs/BENTO_UI_CONTRACT.md.
const defaultLayout = "classic"

func isAllowedChoice(v string, allowed []string) bool {
	for _, a := range allowed {
		if a == v {
			return true
		}
	}
	return false
}

/*
getDisplayPreferences returns this account's choice, defaulted.

	No row means no choice has been made, and the defaults returned are exactly
	the product's current defaults -- 'system' theme and 'comfortable' density
	-- so a user who has never opened the selector sees the application look
	precisely as it does today. That is the whole reason the default is
	'system' rather than 'light': the shell already follows the OS on first
	load, and a stored 'light' would silently change what an existing user sees.
*/
func (s *Server) getDisplayPreferences(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	pref := displayPreference{Theme: "system", Density: "comfortable", Locale: defaultLocale, Layout: defaultLayout}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT theme, density, reduce_motion, locale, high_contrast, layout
			  FROM user_display_preferences WHERE user_id = $1`, id.UserID).
			Scan(&pref.Theme, &pref.Density, &pref.ReduceMotion, &pref.Locale,
				&pref.HighContrast, &pref.Layout)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"preference":      pref,
		"theme_choices":   themeChoices,
		"density_choices": densityChoices,
		"default_theme":   "system",
		"default_density": "comfortable",
		"locale_choices":  localeChoices,
		"default_locale":  defaultLocale,
		"layout_choices":  layoutChoices,
		"default_layout":  defaultLayout,
	})
}

/*
saveDisplayPreferences stores the choice against the account.

	Keyed on user_id, never on a student id and never taking one from the
	request: this is about the caller's own eyes and there is nothing to
	resolve. A body that named a student would be a way to change somebody
	else's display, which is a small harm and a completely unnecessary one.
*/
func (s *Server) saveDisplayPreferences(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req displayPreference
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Theme = strings.TrimSpace(req.Theme)
	req.Density = strings.TrimSpace(req.Density)
	if req.Theme == "" {
		req.Theme = "system"
	}
	if req.Density == "" {
		req.Density = "comfortable"
	}
	if !isAllowedChoice(req.Theme, themeChoices) {
		httpx.BadRequest(w, r, "theme must be one of system, light, dark")
		return
	}
	if !isAllowedChoice(req.Density, densityChoices) {
		httpx.BadRequest(w, r, "density must be one of compact, comfortable, relaxed")
		return
	}
	// An unknown locale is rejected rather than quietly coerced to English:
	// storing something this build cannot render turns every screen into a
	// list of message keys. Empty means "not sent", which is the default.
	req.Locale = strings.TrimSpace(req.Locale)
	if req.Locale == "" {
		req.Locale = defaultLocale
	}
	if !isAllowedLocale(req.Locale) {
		httpx.BadRequest(w, r, "locale is not one this build has strings for")
		return
	}
	// An unknown layout is rejected rather than coerced, for the same reason
	// an unknown locale is: storing a value this build cannot render is a
	// setting that is silently dead.
	//
	// Empty is NOT coerced to the default here. Every client that predates
	// the layout switch -- the settings screen among them -- PUTs this body
	// without a layout field, and defaulting that to 'classic' would mean
	// saving your theme silently threw away your layout. Empty means "not
	// sent, leave the stored value alone", handled by the COALESCE below.
	req.Layout = strings.TrimSpace(req.Layout)
	if req.Layout != "" && !isAllowedChoice(req.Layout, layoutChoices) {
		httpx.BadRequest(w, r, "layout must be one of classic, bento")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO user_display_preferences
			    (user_id, institution_id, theme, density, reduce_motion,
			     locale, high_contrast, layout, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7,
			        COALESCE(NULLIF($8, ''), 'classic'), now())
			ON CONFLICT (user_id) DO UPDATE
			   SET theme = EXCLUDED.theme, density = EXCLUDED.density,
			       reduce_motion = EXCLUDED.reduce_motion,
			       locale = EXCLUDED.locale,
			       high_contrast = EXCLUDED.high_contrast,
			       -- Not EXCLUDED.layout: the VALUES clause has already
			       -- coerced an empty layout to 'classic' for the insert
			       -- path, so EXCLUDED can never be empty here. The
			       -- parameter itself is the only thing that still knows
			       -- whether the caller sent one.
			       layout = COALESCE(NULLIF($8, ''),
			                         user_display_preferences.layout),
			       updated_at = now()`,
			id.UserID, id.InstitutionID, req.Theme, req.Density, req.ReduceMotion,
			req.Locale, req.HighContrast, req.Layout)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if req.Layout == "" {
		// The response is what the account now holds, so a caller that sent no
		// layout must not be told it holds "".
		req.Layout = defaultLayout
		_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT layout FROM user_display_preferences WHERE user_id = $1`,
				id.UserID).Scan(&req.Layout)
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"preference": req})
}

// --- classmate homework help forum --------------------------------------------

type forumThread struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	Homework *string `json:"homework_title,omitempty"`
	HwID     *string `json:"homework_id,omitempty"`
	Subject  *string `json:"subject,omitempty"`
	Author   string  `json:"author_name"`
	Status   string  `json:"status"`
	Mine     bool    `json:"opened_by_me"`
	Replies  int32   `json:"reply_count"`
	// How many of those replies are answers currently withheld from students.
	Withheld  int32   `json:"withheld_count"`
	OpenedAt  string  `json:"opened_at"`
	DueOn     *string `json:"due_on,omitempty"`
	Removal   *string `json:"removal_reason,omitempty"`
	Section   *string `json:"section,omitempty"`
	LastReply *string `json:"last_reply_at,omitempty"`
}

/*
listForumThreads is the board for a child's own section.

	Section-scoped, not campus-scoped, and that is the difference between this
	and the wall. A question about tonight's maths is a question about one
	class's set work; opening it to the school means a child in another section
	posting the answer to a paper that section has not sat yet.

	Removed threads are excluded for students. Their author sees them, with the
	reason, because "my thread disappeared and nobody said why" is how a child
	learns the forum is arbitrary.
*/
func (s *Server) listForumThreads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	hw := nullString(strings.TrimSpace(r.URL.Query().Get("homework_id")))
	cs := nullString(strings.TrimSpace(r.URL.Query().Get("class_subject_id")))
	items, err := collect(s, r, `
		SELECT t.id::text, t.title, t.body, hw.title, t.homework_id::text, sub.name,
		       concat_ws(' ', a.first_name, a.last_name), t.status,
		       t.author_user_id = $2,
		       (SELECT count(*) FROM homework_forum_posts fp
		         WHERE fp.thread_id = t.id AND fp.status = 'visible')::int,
		       (SELECT count(*) FROM homework_forum_posts fp
		         WHERE fp.thread_id = t.id AND fp.status = 'visible'
		           AND fp.kind = 'solution' AND NOT fp.is_staff
		           AND (hw.due_on IS NULL OR hw.due_on >= CURRENT_DATE))::int,
		       to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(hw.due_on,'YYYY-MM-DD'), t.removal_reason,
		       concat_ws('-', cl.name, sec.name),
		       to_char((SELECT max(fp.created_at) FROM homework_forum_posts fp
		                 WHERE fp.thread_id = t.id AND fp.status = 'visible'),
		               'YYYY-MM-DD"T"HH24:MI')
		  FROM homework_forum_threads t
		  JOIN students a ON a.id = t.author_student_id
		  LEFT JOIN homework      hw  ON hw.id  = t.homework_id
		  LEFT JOIN class_subjects cs ON cs.id  = COALESCE(t.class_subject_id, hw.class_subject_id)
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN sections      sec ON sec.id = t.section_id
		  LEFT JOIN classes       cl  ON cl.id  = sec.class_id
		 WHERE t.section_id = $1
		   AND (t.status <> 'removed' OR t.author_user_id = $2)
		   AND ($3::uuid IS NULL OR t.homework_id = $3)
		   AND ($4::uuid IS NULL OR t.class_subject_id = $4)
		 ORDER BY (t.status = 'open') DESC, t.created_at DESC
		 LIMIT 200`,
		[]any{room.SectionID, id.UserID, hw, cs},
		func(rows pgx.Rows) (forumThread, error) {
			var v forumThread
			return v, rows.Scan(&v.ID, &v.Title, &v.Body, &v.Homework, &v.HwID,
				&v.Subject, &v.Author, &v.Status, &v.Mine, &v.Replies, &v.Withheld,
				&v.OpenedAt, &v.DueOn, &v.Removal, &v.Section, &v.LastReply)
		})
	respond(w, r, items, err)
}

type forumThreadRequest struct {
	StudentID      string `json:"student_id,omitempty"`
	HomeworkID     string `json:"homework_id,omitempty"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	Title          string `json:"title"`
	Body           string `json:"body"`
}

/*
openForumThread starts a question.

	Anchored to a homework or to a subject, exactly one. The homework must be
	one set for this child's own section and the subject one their class
	studies, both checked against the database rather than trusted: without
	that a child could hang a thread off another section's paper and read the
	replies to it.
*/
func (s *Server) openForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req forumThreadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"you need an enrolment before you can use the forum")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Body = strings.TrimSpace(req.Body)
	if req.Title == "" || req.Body == "" {
		httpx.BadRequest(w, r, "a question needs a title and a body")
		return
	}
	if len(req.Body) > 2000 {
		httpx.BadRequest(w, r, "keep a question under 2000 characters")
		return
	}
	hwRef := strings.TrimSpace(req.HomeworkID)
	csRef := strings.TrimSpace(req.ClassSubjectID)
	if (hwRef == "") == (csRef == "") {
		httpx.BadRequest(w, r,
			"anchor the question to exactly one of homework_id or class_subject_id")
		return
	}
	var hwArg, csArg any
	if hwRef != "" {
		v, err := uuid.Parse(hwRef)
		if err != nil {
			httpx.BadRequest(w, r, "homework_id must be a uuid")
			return
		}
		hwArg = v
	}
	if csRef != "" {
		v, err := uuid.Parse(csRef)
		if err != nil {
			httpx.BadRequest(w, r, "class_subject_id must be a uuid")
			return
		}
		csArg = v
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var ok bool
		if hwArg != nil {
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM homework
				                WHERE id = $1 AND section_id = $2 AND is_published)`,
				hwArg, room.SectionID).Scan(&ok); err != nil {
				return err
			}
		} else {
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM class_subjects
				                WHERE id = $1 AND class_id = $2)`,
				csArg, room.ClassID).Scan(&ok); err != nil {
				return err
			}
		}
		if !ok {
			// Not this child's work. Indistinguishable from "no such id".
			return pgx.ErrNoRows
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO homework_forum_threads
			    (institution_id, section_id, homework_id, class_subject_id,
			     author_student_id, author_user_id, title, body)
			VALUES ($1, $2, $3, $4, $5, $6, btrim($7), btrim($8))
			RETURNING id::text`,
			id.InstitutionID, room.SectionID, hwArg, csArg, student, id.UserID,
			req.Title, req.Body).Scan(&out); err != nil {
			return err
		}
		threadID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "forum_thread", threadID,
			"submitted", actorPtr(id), "")
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
	}
}

type forumPost struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Body   string `json:"body"`
	Author string `json:"author_name"`
	Staff  bool   `json:"from_staff"`
	Mine   bool   `json:"written_by_me"`
	At     string `json:"at"`
	// True when this is a solution the caller may not read yet. The body is
	// empty in that case; the row is still returned so the thread can say "an
	// answer is waiting until the due date" rather than pretend it is silent.
	Withheld bool    `json:"withheld"`
	Removal  *string `json:"removal_reason,omitempty"`
}

/*
getForumThread returns one thread and its replies.

	The withholding rule lives in the SQL, not in the client, and it is the
	feature: a reply marked 'solution' has its body blanked for every student
	but its author until the homework's due date has passed. Staff see
	everything always, which is what makes the teacher supervision screen
	worth anything.

	A thread anchored to a subject rather than a homework has no due date, so
	'solution' there is withheld from other students indefinitely. That is the
	safe direction -- a general subject thread is exactly where a worked answer
	to next week's paper would be parked.
*/
func (s *Server) getForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	staff := id.Can(rbac.HomeworkWrite)

	var head forumThread
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT t.id::text, t.title, t.body, hw.title, t.homework_id::text,
			       sub.name, concat_ws(' ', a.first_name, a.last_name), t.status,
			       t.author_user_id = $2,
			       to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI'),
			       to_char(hw.due_on,'YYYY-MM-DD'), t.removal_reason, t.section_id
			  FROM homework_forum_threads t
			  JOIN students a ON a.id = t.author_student_id
			  LEFT JOIN homework       hw  ON hw.id  = t.homework_id
			  LEFT JOIN class_subjects cs  ON cs.id  = COALESCE(t.class_subject_id, hw.class_subject_id)
			  LEFT JOIN subjects       sub ON sub.id = cs.subject_id
			 WHERE t.id = $1`, threadID, id.UserID).
			Scan(&head.ID, &head.Title, &head.Body, &head.Homework, &head.HwID,
				&head.Subject, &head.Author, &head.Status, &head.Mine,
				&head.OpenedAt, &head.DueOn, &head.Removal, &section); err != nil {
			return err
		}
		// Reading a thread requires belonging to its section, or teaching it.
		// The permission on the router is not evidence of either.
		res, err := s.resolveScope(r)
		if err != nil {
			return err
		}
		if !(staff && reachesSection(res, section)) {
			var mine bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				    SELECT 1 FROM enrollments e
				     WHERE e.student_id = ANY($1) AND e.section_id = $2)`,
				res.StudentIDs, section).Scan(&mine); err != nil {
				return err
			}
			if !mine {
				return pgx.ErrNoRows
			}
		}
		if head.Status == "removed" && !head.Mine && !staff {
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
		SELECT p.id::text, p.kind,
		       CASE WHEN $3 OR p.author_user_id = $2 OR p.is_staff
		                 OR p.kind <> 'solution'
		                 OR (hw.due_on IS NOT NULL AND hw.due_on < CURRENT_DATE)
		            THEN p.body ELSE '' END,
		       COALESCE(concat_ws(' ', st.first_name, st.last_name), u.full_name),
		       p.is_staff, p.author_user_id = $2,
		       to_char(p.created_at,'YYYY-MM-DD"T"HH24:MI'),
		       NOT ($3 OR p.author_user_id = $2 OR p.is_staff
		            OR p.kind <> 'solution'
		            OR (hw.due_on IS NOT NULL AND hw.due_on < CURRENT_DATE)),
		       p.removal_reason
		  FROM homework_forum_posts p
		  JOIN homework_forum_threads t ON t.id = p.thread_id
		  LEFT JOIN homework hw ON hw.id = t.homework_id
		  LEFT JOIN students st ON st.id = p.author_student_id
		  LEFT JOIN users    u  ON u.id  = p.author_user_id
		 WHERE p.thread_id = $1
		   AND (p.status = 'visible' OR $3 OR p.author_user_id = $2)
		 ORDER BY p.created_at`,
		[]any{threadID, id.UserID, staff},
		func(rows pgx.Rows) (forumPost, error) {
			var v forumPost
			return v, rows.Scan(&v.ID, &v.Kind, &v.Body, &v.Author, &v.Staff,
				&v.Mine, &v.At, &v.Withheld, &v.Removal)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"thread": head, "posts": posts})
}

type forumReplyRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Body      string `json:"body"`
}

/*
replyToForumThread posts a hint, a follow-up question, or the answer.

	kind is required to be chosen honestly and the product makes the honest
	choice the easy one: 'hint' is the default and is visible immediately,
	while 'solution' is withheld until the due date. A child who wants their
	help read today marks it a hint, which is the behaviour the feature exists
	to encourage. A child who mislabels a worked answer as a hint has not
	defeated anything the software could have detected anyway -- what catches
	that is the teacher supervision screen, which is why it exists.

	Staff reply through the same endpoint and their posts are never withheld:
	a teacher's answer to their own homework is the thing that should be read.
*/
func (s *Server) replyToForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req forumReplyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		httpx.BadRequest(w, r, "write something")
		return
	}
	if len(req.Body) > 2000 {
		httpx.BadRequest(w, r, "keep a reply under 2000 characters")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = "hint"
	}
	if kind != "question" && kind != "hint" && kind != "solution" {
		httpx.BadRequest(w, r, "kind must be question, hint or solution")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	staff := id.Can(rbac.HomeworkWrite)

	// A staff reply carries no student id; a child's reply must resolve to one
	// the caller owns. Doing this before the transaction keeps the ownership
	// refusal identical to every other endpoint in the portal.
	var author uuid.UUID
	if !staff {
		_, author, err = s.portalChild(r, req.StudentID)
		if denyChild(w, r, err) {
			return
		}
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT section_id, status FROM homework_forum_threads WHERE id = $1`,
			threadID).Scan(&section, &status); err != nil {
			return err
		}
		if status != "open" {
			return errors.New("this thread is closed")
		}
		if staff {
			if !reachesSection(res, section) {
				return pgx.ErrNoRows
			}
		} else {
			var mine bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM enrollments
				                WHERE student_id = $1 AND section_id = $2)`,
				author, section).Scan(&mine); err != nil {
				return err
			}
			if !mine {
				return pgx.ErrNoRows
			}
		}
		var authorArg any
		if !staff {
			authorArg = author
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO homework_forum_posts
			    (institution_id, thread_id, author_student_id, author_user_id,
			     is_staff, kind, body)
			VALUES ($1, $2, $3, $4, $5, $6, btrim($7))
			RETURNING id::text`,
			id.InstitutionID, threadID, authorArg, id.UserID, staff, kind,
			req.Body).Scan(&out); err != nil {
			return err
		}
		postID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, "forum_post", postID,
			"submitted", actorPtr(id), "")
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": out, "kind": kind,
			"withheld_until_due": kind == "solution" && !staff,
		})
	}
}

// resolveForumThread closes a question. The author closes their own; a teacher
// of the section closes any, because a thread left open after the work is
// marked keeps attracting answers to a paper already sat.
func (s *Server) resolveForumThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	threadID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	staff := id.Can(rbac.HomeworkWrite)
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE homework_forum_threads
			   SET status = 'resolved', updated_at = now()
			 WHERE id = $1 AND status = 'open'
			   AND (author_user_id = $2 OR ($3 AND section_id = ANY($4)))
			RETURNING id::text`,
			threadID, id.UserID, staff, res.SectionIDs).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": "resolved"})
}

/*
superviseForumThreads is the teacher's view of threads on their own work.

	Narrowed to sections the caller actually teaches, not to everyone holding
	homework.write: the permission says "this person sets homework", not "this
	person may read every class's discussion". withheld_count is the column
	worth looking at -- it is how many worked answers are queued behind a due
	date, which is the number that says whether the forum is being used as a
	forum.
*/
func (s *Server) superviseForumThreads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.SectionIDs) == 0 && !res.AllStudents {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []forumThread{}})
		return
	}
	items, err := collect(s, r, `
		SELECT t.id::text, t.title, t.body, hw.title, t.homework_id::text, sub.name,
		       concat_ws(' ', a.first_name, a.last_name), t.status,
		       t.author_user_id = $3,
		       (SELECT count(*) FROM homework_forum_posts fp
		         WHERE fp.thread_id = t.id AND fp.status = 'visible')::int,
		       (SELECT count(*) FROM homework_forum_posts fp
		         WHERE fp.thread_id = t.id AND fp.status = 'visible'
		           AND fp.kind = 'solution' AND NOT fp.is_staff
		           AND (hw.due_on IS NULL OR hw.due_on >= CURRENT_DATE))::int,
		       to_char(t.created_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(hw.due_on,'YYYY-MM-DD'), t.removal_reason,
		       concat_ws('-', cl.name, sec.name),
		       to_char((SELECT max(fp.created_at) FROM homework_forum_posts fp
		                 WHERE fp.thread_id = t.id AND fp.status = 'visible'),
		               'YYYY-MM-DD"T"HH24:MI')
		  FROM homework_forum_threads t
		  JOIN students a ON a.id = t.author_student_id
		  LEFT JOIN homework       hw  ON hw.id  = t.homework_id
		  LEFT JOIN class_subjects cs  ON cs.id  = COALESCE(t.class_subject_id, hw.class_subject_id)
		  LEFT JOIN subjects       sub ON sub.id = cs.subject_id
		  LEFT JOIN sections       sec ON sec.id = t.section_id
		  LEFT JOIN classes        cl  ON cl.id  = sec.class_id
		 WHERE ($1 OR t.section_id = ANY($2))
		 ORDER BY (t.status = 'open') DESC, t.created_at DESC
		 LIMIT 300`,
		[]any{res.AllStudents, res.SectionIDs, id.UserID},
		func(rows pgx.Rows) (forumThread, error) {
			var v forumThread
			return v, rows.Scan(&v.ID, &v.Title, &v.Body, &v.Homework, &v.HwID,
				&v.Subject, &v.Author, &v.Status, &v.Mine, &v.Replies, &v.Withheld,
				&v.OpenedAt, &v.DueOn, &v.Removal, &v.Section, &v.LastReply)
		})
	respond(w, r, items, err)
}

// removeForumThread takes a whole question down, immediately and with a reason.
func (s *Server) removeForumThread(w http.ResponseWriter, r *http.Request) {
	s.removeForumContent(w, r, "forum_thread")
}

// removeForumPost takes one reply down.
func (s *Server) removeForumPost(w http.ResponseWriter, r *http.Request) {
	s.removeForumContent(w, r, "forum_post")
}

/*
removeForumContent is the one takedown path for both threads and replies.

	Written once on purpose. Two takedown routines drift, and the half that
	drifts is always the log -- which is the half a school is asked about.
	Every removal here is a single transaction containing the state change and
	its record, so no removal exists without an account of who and why.
*/
func (s *Server) removeForumContent(w http.ResponseWriter, r *http.Request, kind string) {
	id := httpx.IdentityFrom(r.Context())
	targetID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req moderationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r,
			"give a reason — a child whose question vanishes without one learns the forum is arbitrary")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Both statements are gated on the caller teaching the thread's
		// section. A holder of homework.write in another year group is not a
		// moderator of this one.
		var section uuid.UUID
		var q string
		if kind == "forum_thread" {
			q = `SELECT section_id FROM homework_forum_threads WHERE id = $1 AND status <> 'removed'`
		} else {
			q = `SELECT t.section_id FROM homework_forum_posts p
			       JOIN homework_forum_threads t ON t.id = p.thread_id
			      WHERE p.id = $1 AND p.status = 'visible'`
		}
		if err := tx.QueryRow(r.Context(), q, targetID).Scan(&section); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return pgx.ErrNoRows
		}
		if kind == "forum_thread" {
			_, err = tx.Exec(r.Context(), `
				UPDATE homework_forum_threads
				   SET status = 'removed', removed_by = $2, removed_at = now(),
				       removal_reason = btrim($3), updated_at = now()
				 WHERE id = $1`, targetID, id.UserID, req.Reason)
		} else {
			_, err = tx.Exec(r.Context(), `
				UPDATE homework_forum_posts
				   SET status = 'removed', removed_by = $2, removed_at = now(),
				       removal_reason = btrim($3)
				 WHERE id = $1`, targetID, id.UserID, req.Reason)
		}
		if err != nil {
			return err
		}
		return logStudentContent(r, tx, id.InstitutionID, kind, targetID,
			"removed", actorPtr(id), req.Reason)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": targetID.String(), "status": "removed"})
}

// --- virtual classroom hand raise ---------------------------------------------

type liveClassRow struct {
	ID       string  `json:"id"`
	Topic    string  `json:"topic"`
	Subject  *string `json:"subject,omitempty"`
	When     string  `json:"scheduled_at"`
	Minutes  int32   `json:"duration_minutes"`
	Status   string  `json:"status"`
	JoinURL  *string `json:"join_url,omitempty"`
	Teacher  *string `json:"teacher,omitempty"`
	HandUp   bool    `json:"hand_up"`
	MyRaises int32   `json:"my_raises"`
	MyCalled int32   `json:"my_times_called"`
}

/*
listMyLiveClasses is the child's own live classes, with their hand state.

	Reads virtual_class_sessions from 00041 and adds nothing to it. A second
	session model would mean a hand raised against a meeting the class did not
	sit in, which answers none of the questions the telemetry exists for.
*/
func (s *Server) listMyLiveClasses(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT v.id::text, v.topic, sub.name,
		       to_char(v.scheduled_at,'YYYY-MM-DD"T"HH24:MI'),
		       v.duration_minutes, v.status, v.join_url, u.full_name,
		       EXISTS (SELECT 1 FROM virtual_class_hand_raises h
		                WHERE h.session_id = v.id AND h.student_id = $2
		                  AND h.lowered_at IS NULL AND h.answered_at IS NULL),
		       (SELECT count(*) FROM virtual_class_hand_raises h
		         WHERE h.session_id = v.id AND h.student_id = $2)::int,
		       (SELECT count(*) FROM virtual_class_hand_raises h
		         WHERE h.session_id = v.id AND h.student_id = $2
		           AND h.answered_at IS NOT NULL)::int
		  FROM virtual_class_sessions v
		  LEFT JOIN class_subjects cs  ON cs.id  = v.class_subject_id
		  LEFT JOIN subjects       sub ON sub.id = cs.subject_id
		  LEFT JOIN users          u   ON u.id   = v.created_by
		 WHERE v.section_id = $1
		   AND v.scheduled_at >= now() - interval '60 days'
		 ORDER BY v.scheduled_at DESC
		 LIMIT 100`, []any{room.SectionID, room.StudentID},
		func(rows pgx.Rows) (liveClassRow, error) {
			var v liveClassRow
			return v, rows.Scan(&v.ID, &v.Topic, &v.Subject, &v.When, &v.Minutes,
				&v.Status, &v.JoinURL, &v.Teacher, &v.HandUp, &v.MyRaises, &v.MyCalled)
		})
	respond(w, r, items, err)
}

type handRaiseRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Note      string `json:"note,omitempty"`
}

/*
raiseHand records a hand up in a live class.

	Only in a session the child's own section is sitting, and only while it is
	live. Raising a hand in a class that has ended is telemetry about nothing,
	and raising one in another section's class is a way to appear in a register
	you are not on.

	The unique partial index makes a second raise while one is up a 409 rather
	than a duplicate row. A child hammering the button otherwise fills the
	teacher's queue with themselves.
*/
func (s *Server) raiseHand(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sessionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req handRaiseRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"you need an enrolment to join a class")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT status FROM virtual_class_sessions
			 WHERE id = $1 AND section_id = $2`, sessionID, room.SectionID).
			Scan(&status); err != nil {
			return err
		}
		if status != "live" {
			return errors.New("that class is not live")
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO virtual_class_hand_raises
			    (institution_id, session_id, student_id, raised_by, note)
			VALUES ($1, $2, $3, $4, nullif(btrim($5), ''))
			RETURNING id::text`,
			id.InstitutionID, sessionID, student, id.UserID, req.Note).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "hand_already_up",
			"your hand is already up")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "hand_up": true})
	}
}

// lowerHand takes the child's own hand down.
//
// Distinct from being called on, and that distinction is the whole point of
// the table: a withdrawn hand and an ignored one look identical if both just
// disappear, and the report that cannot tell them apart is a lie about which
// children are being passed over.
func (s *Server) lowerHand(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sessionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req handRaiseRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE virtual_class_hand_raises
			   SET lowered_at = now()
			 WHERE session_id = $1 AND student_id = $2
			   AND lowered_at IS NULL AND answered_at IS NULL
			RETURNING id::text`, sessionID, student).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "hand_up": false})
}

type raisedHand struct {
	ID        string `json:"id"`
	StudentID string `json:"student_id"`
	Student   string `json:"student_name"`
	RaisedAt  string `json:"raised_at"`
	// Seconds the hand has been up, or was up before it was answered. The
	// number a teacher actually needs mid-class.
	WaitingSeconds int32   `json:"waiting_seconds"`
	AnsweredAt     *string `json:"answered_at,omitempty"`
	LoweredAt      *string `json:"lowered_at,omitempty"`
	Note           *string `json:"note,omitempty"`
}

// listRaisedHands is the teacher's queue for one session, oldest hand first.
//
// Oldest first is not a display preference. Newest-first is exactly how the
// same three confident children get picked every lesson.
func (s *Server) listRaisedHands(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT h.id::text, h.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char(h.raised_at,'YYYY-MM-DD"T"HH24:MI:SS'),
		       EXTRACT(EPOCH FROM
		           COALESCE(h.answered_at, h.lowered_at, now()) - h.raised_at)::int,
		       to_char(h.answered_at,'HH24:MI:SS'),
		       to_char(h.lowered_at,'HH24:MI:SS'), h.note
		  FROM virtual_class_hand_raises h
		  JOIN virtual_class_sessions v ON v.id = h.session_id
		  JOIN students st ON st.id = h.student_id
		 WHERE h.session_id = $1
		   AND ($2 OR v.section_id = ANY($3))
		 ORDER BY (h.answered_at IS NULL AND h.lowered_at IS NULL) DESC, h.raised_at`,
		[]any{sessionID, res.AllStudents, res.SectionIDs},
		func(rows pgx.Rows) (raisedHand, error) {
			var v raisedHand
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.RaisedAt,
				&v.WaitingSeconds, &v.AnsweredAt, &v.LoweredAt, &v.Note)
		})
	respond(w, r, items, err)
}

// callOnRaisedHand records that the teacher picked this child.
//
// Gated on the caller teaching the session's section, not merely on holding
// homework.write: the permission says a person sets work, not that they run
// this class.
func (s *Server) callOnRaisedHand(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	handID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE virtual_class_hand_raises h
			   SET answered_at = now(), answered_by = $2
			  FROM virtual_class_sessions v
			 WHERE h.id = $1 AND v.id = h.session_id
			   AND h.answered_at IS NULL AND h.lowered_at IS NULL
			   AND ($3 OR v.section_id = ANY($4))
			RETURNING h.id::text`,
			handID, id.UserID, res.AllStudents, res.SectionIDs).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "answered": true})
}

// handRaiseStat is one child's engagement over a window.
type handRaiseStat struct {
	StudentID string `json:"student_id"`
	Student   string `json:"student_name"`
	Section   string `json:"section"`
	// Live classes this child's section sat in the window. The denominator;
	// without it "raised twice" is not a fact about anything.
	Sessions int32 `json:"sessions"`
	// Sessions in which they raised at least one hand.
	SessionsWithHand int32 `json:"sessions_with_hand"`
	Raises           int32 `json:"raises"`
	TimesCalled      int32 `json:"times_called"`
	// Raised and neither answered nor withdrawn by the end. The number the
	// feature exists for.
	Unanswered int32 `json:"unanswered"`
	// Median-ish: the mean wait in seconds before being called on.
	AvgWaitSeconds *int32  `json:"avg_wait_seconds,omitempty"`
	LastRaisedAt   *string `json:"last_raised_at,omitempty"`
}

/*
getHandRaiseTelemetry is the pattern, which is the only part worth having.

	One lesson's hands are noise. Two questions justify the whole feature and
	both are about the shape over a term:

	  - which children never raise a hand at all, which is why every child in
	    the section appears here with zero rather than being absent from the
	    list. A report that lists only the children who participated is a
	    report about the children you already noticed.

	  - which children raise one and are never picked, which is the
	    unanswered column. A teacher who believes they call on everyone is
	    usually right about the children they remember.
*/
func (s *Server) getHandRaiseTelemetry(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.SectionIDs) == 0 && !res.AllStudents {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []handRaiseStat{}})
		return
	}
	days := 90
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > 365 {
			httpx.BadRequest(w, r, "days must be between 1 and 365")
			return
		}
		days = v
	}
	var sectionArg any
	if raw := strings.TrimSpace(r.URL.Query().Get("section_id")); raw != "" {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "section_id must be a uuid")
			return
		}
		if !reachesSection(res, v) {
			httpx.NotFound(w, r)
			return
		}
		sectionArg = v
	}

	items, err := collect(s, r, `
		WITH win AS (SELECT now() - make_interval(days => $3) AS since),
		     sess AS (
		         SELECT v.id, v.section_id
		           FROM virtual_class_sessions v, win
		          WHERE v.status IN ('live','ended')
		            AND v.scheduled_at >= win.since
		            AND ($1 OR v.section_id = ANY($2))
		            AND ($4::uuid IS NULL OR v.section_id = $4)
		     ),
		     -- The denominator, per section. Computed once rather than as a
		     -- correlated count per child.
		     held AS (
		         SELECT section_id, count(*)::int AS n FROM sess GROUP BY section_id
		     ),
		     -- Every child on the roll of a section that held a class, so the
		     -- children who never raised a hand are rows rather than absences.
		     roll AS (
		         SELECT DISTINCT e.student_id, e.section_id
		           FROM enrollments e
		           JOIN held h ON h.section_id = e.section_id
		          WHERE e.status = 'active'
		     )
		SELECT r.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       concat_ws('-', cl.name, sec.name),
		       h.n,
		       count(DISTINCT hr.session_id)::int,
		       count(hr.id)::int,
		       count(hr.answered_at)::int,
		       count(*) FILTER (
		           WHERE hr.id IS NOT NULL
		             AND hr.answered_at IS NULL AND hr.lowered_at IS NULL)::int,
		       avg(EXTRACT(EPOCH FROM hr.answered_at - hr.raised_at))::int,
		       to_char(max(hr.raised_at),'YYYY-MM-DD"T"HH24:MI')
		  FROM roll r
		  JOIN held     h   ON h.section_id = r.section_id
		  JOIN students st  ON st.id = r.student_id
		  JOIN sections sec ON sec.id = r.section_id
		  JOIN classes  cl  ON cl.id  = sec.class_id
		  LEFT JOIN sess s ON s.section_id = r.section_id
		  LEFT JOIN virtual_class_hand_raises hr
		         ON hr.session_id = s.id AND hr.student_id = r.student_id
		 GROUP BY r.student_id, st.first_name, st.last_name, cl.name, sec.name, h.n
		 ORDER BY count(hr.id), concat_ws(' ', st.first_name, st.last_name)
		 LIMIT 600`,
		[]any{res.AllStudents, res.SectionIDs, days, sectionArg},
		func(rows pgx.Rows) (handRaiseStat, error) {
			var v handRaiseStat
			return v, rows.Scan(&v.StudentID, &v.Student, &v.Section, &v.Sessions,
				&v.SessionsWithHand, &v.Raises, &v.TimesCalled, &v.Unanswered,
				&v.AvgWaitSeconds, &v.LastRaisedAt)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "days": days})
}

// getMyHandRaiseHistory is the same record from the child's own side: every
// hand they put up and whether anyone picked it.
//
// Shown to the child deliberately. A pupil who has raised their hand nine
// times and been called on once is entitled to know that, and it is a far
// better prompt to a conversation than a teacher's impression.
func (s *Server) getMyHandRaiseHistory(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT h.id::text, h.student_id::text, v.topic,
		       to_char(h.raised_at,'YYYY-MM-DD"T"HH24:MI'),
		       EXTRACT(EPOCH FROM
		           COALESCE(h.answered_at, h.lowered_at, now()) - h.raised_at)::int,
		       to_char(h.answered_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(h.lowered_at,'YYYY-MM-DD"T"HH24:MI'), h.note
		  FROM virtual_class_hand_raises h
		  JOIN virtual_class_sessions v ON v.id = h.session_id
		 WHERE h.student_id = $1
		 ORDER BY h.raised_at DESC
		 LIMIT 200`, []any{room.StudentID},
		func(rows pgx.Rows) (raisedHand, error) {
			var v raisedHand
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.RaisedAt,
				&v.WaitingSeconds, &v.AnsweredAt, &v.LoweredAt, &v.Note)
		})
	respond(w, r, items, err)
}

// compile-time assertion that the scope package stays imported even if a
// future edit drops the last direct reference.
var _ = (*scope.Resolved)(nil)
