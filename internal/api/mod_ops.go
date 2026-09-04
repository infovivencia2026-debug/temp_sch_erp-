package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
)

/* Modules 6-10 — communication, timetable generation, statutory compliance
   exports, payroll, and the operations desks. */

// ------------------------------------------------------------ communication

type circularRequest struct {
	Title        string   `json:"title"`
	Body         string   `json:"body"`
	Kind         string   `json:"kind,omitempty"`
	AudienceRole string   `json:"audience_role,omitempty"`
	SectionIDs   []string `json:"section_ids,omitempty"`
	RequiresAck  bool     `json:"requires_ack"`
	SendSMS      bool     `json:"send_sms"`
	// SendEmail is the other half of "publish it". SMS was the only channel
	// offered, on a deployment with no SMS gateway either — so a circular
	// reached whoever happened to open the portal and nobody else.
	SendEmail bool `json:"send_email"`
	/* And WhatsApp, where the school has it.

	   Two channels were offered and the third is the one most Indian
	   schools actually use: a parent who ignores an SMS reads a
	   WhatsApp. It is a tick like the others rather than the default,
	   because WhatsApp charges per conversation and refuses anything
	   outside an approved template. */
	SendWhatsApp bool `json:"send_whatsapp"`
	/* A file to go with it.

	   Half of what a school circulates is a document: the holiday list,
	   the fee notice, the exam timetable. A composer that takes only a
	   title and a body means those go out as an email from somebody's
	   personal account instead, which is how a school ends up with two
	   channels and one record.

	   Uploaded first through /files, which already stores, checksums and
	   serves attachments for lesson plans and homework; this carries the
	   id it returns. */
	AttachmentFileID string `json:"attachment_file_id,omitempty"`
}

/*
Who a circular is addressed to, as one query used three times.

	The recipient count, the SMS fan-out and the email fan-out were three
	copies of the same SELECT, and only the first two existed. All three ran
	over guardians regardless of audience_role, so a notice addressed to
	students was counted, and would have been sent, to their parents instead.

	audience_role has been on the announcements table from the start and
	nothing had ever read it here. 'parents' is guardians with a login;
	'students' is students with one; 'all' is both, deduplicated, because a
	sixth-former with their own account and a parent on the same address should
	receive one notice each and not two on one screen.
*/
/* Who a circular reaches.

   Five audiences, not three. The list offered parents, students, or both, and
   a principal wanting to tell the staff something had no way to do it from
   here at all -- which is how a school ends up with a WhatsApp group nobody
   can audit.

   The section filter narrows families only. A member of staff does not belong
   to a section the way a child does: a subject teacher stands in five of them
   and the office in none, so applying the filter would silently drop the
   people the notice is for. Choosing sections and 'staff' is read as "the
   staff", and the screen says so.
*/
const circularRecipients = `
	SELECT g.user_id
	  FROM students st
	  JOIN student_guardians sg ON sg.student_id = st.id
	  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
	  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
	 WHERE st.status = 'active'
	   AND $2::text IN ('all','parents','everyone')
	   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))
	UNION
	SELECT st.user_id
	  FROM students st
	  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
	 WHERE st.status = 'active' AND st.user_id IS NOT NULL
	   AND $2::text IN ('all','students','everyone')
	   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))
	UNION
	SELECT u.id
	  FROM employees emp
	  JOIN users u ON u.id = emp.user_id
	 WHERE emp.status = 'active'
	   AND $2::text IN ('staff','everyone')`

// publishCircular posts an announcement and optionally pushes it as SMS.
//
// Targeting is by role and, optionally, by section. A circular aimed at
// "Class 8 parents" must not reach the whole school, which is the difference
// between a notice board and a communication tool.
func (s *Server) publishCircular(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req circularRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "title and body are required")
		return
	}
	if req.Kind == "" {
		req.Kind = "circular"
	}
	if req.AudienceRole == "" {
		req.AudienceRole = "all"
	}
	/* Checked here rather than left to the column.

	   A value outside the list fails a CHECK constraint deep in the insert,
	   which surfaces as a 500 and a database error nobody can act on. This
	   says which audiences exist, which is what the caller needs. */
	switch req.AudienceRole {
	case "all", "parents", "students", "staff", "everyone":
	default:
		httpx.BadRequest(w, r,
			"send to one of: all (parents and students), parents, students, staff, everyone")
		return
	}

	var annID uuid.UUID
	var recipients, unreachable int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO announcements (institution_id, title, body, kind, audience_role,
			                           requires_ack, publish_at, created_by,
			                           attachment_file_id)
			VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8::uuid)
			RETURNING id`,
			id.InstitutionID, req.Title, req.Body, req.Kind, req.AudienceRole,
			req.RequiresAck, id.UserID,
			nullString(req.AttachmentFileID)).Scan(&annID); err != nil {
			return err
		}
		for _, raw := range req.SectionIDs {
			sid, err := uuid.Parse(raw)
			if err != nil {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO announcement_sections (announcement_id, section_id, institution_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, annID, sid, id.InstitutionID); err != nil {
				return err
			}
		}
		/* Who it reaches, and who it cannot.

		   The count was honest and read as a lie. A school with sixty children
		   published to "all parents" and was told "12 recipients", because
		   twelve is how many people have an account — the other forty-nine
		   families have never been issued a login, so there is nowhere to
		   deliver a portal notice to. Reporting only the reachable number
		   invites the reader to conclude the audience is wrong, when the truth
		   is that most of the school cannot be reached at all.

		   So both numbers travel together. A principal who sees "12 reached,
		   49 children have no family login" can act on it; one who sees "12"
		   can only be puzzled by it. */
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*) FROM (`+circularRecipients+`) AS t`,
			uuidArray(req.SectionIDs), req.AudienceRole).Scan(&recipients); err != nil {
			return err
		}
		if req.AudienceRole == "staff" {
			return nil
		}
		return tx.QueryRow(r.Context(), `
			SELECT count(*)::int
			  FROM students st
			  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
			 WHERE st.status = 'active'
			   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))
			   AND st.user_id IS NULL
			   AND NOT EXISTS (
			         SELECT 1 FROM student_guardians sg
			           JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
			          WHERE sg.student_id = st.id)`,
			uuidArray(req.SectionIDs)).Scan(&unreachable)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// One task per recipient per channel: a rejection for one number or one
	// address must not lose the rest of the circular.
	channels := make([]string, 0, 3)
	if req.SendSMS {
		channels = append(channels, "sms")
	}
	if req.SendEmail {
		channels = append(channels, "email")
	}
	if req.SendWhatsApp {
		channels = append(channels, "whatsapp")
	}

	/* The attachment named in the body of the message that leaves.

	   A parent reading this in their inbox has no portal open, so a file they
	   cannot see is a file they do not know exists. The link is the same one
	   the portal serves and refuses the same people. */
	body := req.Body
	if strings.TrimSpace(req.AttachmentFileID) != "" {
		// Absolute, from the request that is publishing it: a relative path is
		// fine on the page that produced it and useless in a mail client.
		scheme := "https"
		if r.TLS == nil && !strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			scheme = "http"
		}
		body += "\n\nAttached: " + scheme + "://" + r.Host +
			"/api/v1/files/" + strings.TrimSpace(req.AttachmentFileID)
	}

	queued := map[string]int{"sms": 0, "email": 0, "whatsapp": 0}
	if len(channels) > 0 {
		_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), circularRecipients,
				uuidArray(req.SectionIDs), req.AudienceRole)
			if err != nil {
				return err
			}
			var to []uuid.UUID
			for rows.Next() {
				var uid uuid.UUID
				if err := rows.Scan(&uid); err != nil {
					rows.Close()
					return err
				}
				to = append(to, uid)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}

			// Collected before enqueueing rather than enqueued inside the row
			// loop: the queue write and the cursor were sharing one connection,
			// and a slow enqueue held the cursor open for the whole fan-out.
			/* The template this asks for has to be one that exists.

			   It asked for "circular.published" and no such template was ever
			   written: the built-in is "announcement.published", and
			   message_templates is empty in a school that has not authored its
			   own. So every circular queued a row that failed template
			   resolution on the way out. The screen reported how many it had
			   queued, which was true and read like delivery. */
			for _, uid := range to {
				for _, ch := range channels {
					if _, err := s.Queue.Enqueue(r.Context(), queue.TypeMessageSend,
						queue.MessageSendPayload{
							Envelope: queue.Envelope{
								InstitutionID: id.InstitutionID, ActorUserID: id.UserID,
								RequestID: httpx.RequestIDFrom(r.Context()), JobID: uuid.New(),
							},
							Channel: ch, TemplateKey: "announcement.published", ToUserID: uid,
							Vars: map[string]any{"title": req.Title, "body": body},
						}, queue.HeavyOptions()...); err == nil {
						queued[ch]++
					}
				}
			}
			return nil
		})
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": annID.String(), "recipients": recipients,
		// Children nobody can be told about, because their family has no
		// login. Not an error — a thing to go and fix.
		"unreachable_children": unreachable,
		"sms_queued":           queued["sms"], "email_queued": queued["email"],
		"whatsapp_queued": queued["whatsapp"],
	})
}

type circularRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	Audience    string `json:"audience_role"`
	RequiresAck bool   `json:"requires_ack"`
	PublishedAt string `json:"published_at"`
	/* The notice itself, and who signed it.

	   A parent could see that the school had said something, and not what, or
	   who said it. The date alone is the half that does not help on a notice
	   about this afternoon. */
	PublishedAtFull string `json:"published_at_full"`
	PublishedBy     string `json:"published_by,omitempty"`
	Acks            int    `json:"acknowledgements"`
	Sections        int    `json:"sections"`
	// Whether the caller has signed this one. The total count answers the
	// office's question ("how many parents have read it"); this answers the
	// parent's ("is there anything still waiting on me"), and a screen built
	// for a family needs the second.
	Mine bool   `json:"acknowledged_by_me"`
	Body string `json:"body,omitempty"`
}

// listCirculars is the notice board, and it is read by two different kinds of
// person through the same endpoint.
//
// The office and the staff room read it as a register: every notice the school
// has issued, including the one scheduled for next Monday and the one that only
// concerns staff. That is the job, and it is left alone.
//
// A family reads it as their own post. Unfiltered, it was neither: the query
// selected every row in the institution, so a parent saw staff-only circulars,
// notices scheduled for a future date, notices that expired last year, and
// notices addressed to a section their child is not in or to somebody else's
// child by name. RLS did not catch it because all of those rows legitimately
// belong to the same tenant — exactly the failure scope.Resolved exists to
// prevent.
//
// So the family side is narrowed here, and only the family side. A caller
// counts as family when their entire reach is their own record or their
// children: no taught sections, no department, and none of the institution-wide
// capabilities. Anyone with a staff signal keeps the register view they have
// today, and a teacher who is also a parent at the school stays on the staff
// side rather than losing notices.
func (s *Server) listCirculars(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	args := []any{httpx.IdentityFrom(r.Context()).UserID}
	// Default is the unchanged register view; the predicate only tightens.
	where := "TRUE"

	family := !res.PlatformAdmin && !res.AllStudents && !res.AllAttendance &&
		!res.AnySection && len(res.SectionIDs) == 0 &&
		len(res.DepartmentIDs) == 0 && len(res.StudentIDs) > 0
	if family {
		args = append(args, res.StudentIDs)
		// Three independent gates, all of which must hold:
		//
		//   window    published already and not yet expired — a scheduled
		//             notice is not news until its date.
		//   audience  'all', plus 'students' for a child's own account and
		//             'parents' for a guardian's. 'staff' and 'faculty' are
		//             reachable by neither.
		//   targeting an untargeted notice is for the whole audience; a
		//             targeted one has to name a section this family sits in
		//             or the child themselves.
		where = `a.publish_at <= now()
		     AND (a.expires_at IS NULL OR a.expires_at > now())
		     AND (a.audience_role = 'all'
		          OR (a.audience_role = 'students'
		              AND EXISTS (SELECT 1 FROM students me WHERE me.user_id = $1))
		          OR (a.audience_role = 'parents'
		              AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = $1)))
		     AND (
		          (NOT EXISTS (SELECT 1 FROM announcement_sections x
		                        WHERE x.announcement_id = a.id)
		           AND NOT EXISTS (SELECT 1 FROM announcement_students x
		                            WHERE x.announcement_id = a.id))
		          OR EXISTS (SELECT 1 FROM announcement_sections x
		                       JOIN enrollments e ON e.section_id = x.section_id
		                      WHERE x.announcement_id = a.id
		                        AND e.student_id = ANY($2)
		                        AND e.status = 'active')
		          OR EXISTS (SELECT 1 FROM announcement_students x
		                      WHERE x.announcement_id = a.id
		                        AND x.student_id = ANY($2)))`
	}

	items, err := collect(s, r, `
		/* The notice itself, not only that there is one.

		   The list carried a title and a date and no body and no author, so a
		   parent could see that the school had said something and not what, or
		   who said it. Opening a second endpoint per row to read a paragraph
		   the first query already had in hand is a round trip for nothing.

		   Time as well as date: "24 Aug" on a notice about this afternoon's
		   early closing is the half of the fact that does not help. */
		SELECT a.id::text, a.title, a.kind, a.audience_role, a.requires_ack,
		       to_char(a.publish_at,'YYYY-MM-DD'),
		       to_char(a.publish_at,'YYYY-MM-DD"T"HH24:MI'),
		       COALESCE(u.full_name, ''),
		       (SELECT count(*) FROM announcement_acks ak WHERE ak.announcement_id = a.id)::int,
		       (SELECT count(*) FROM announcement_sections s2 WHERE s2.announcement_id = a.id)::int,
		       EXISTS (SELECT 1 FROM announcement_acks ak
		                WHERE ak.announcement_id = a.id AND ak.user_id = $1),
		       a.body
		  FROM announcements a
		  LEFT JOIN users u ON u.id = a.created_by
		 WHERE `+where+`
		 ORDER BY a.publish_at DESC LIMIT 200`,
		args,
		func(rows pgx.Rows) (circularRow, error) {
			var v circularRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Kind, &v.Audience, &v.RequiresAck,
				&v.PublishedAt, &v.PublishedAtFull, &v.PublishedBy,
				&v.Acks, &v.Sections, &v.Mine, &v.Body)
		})
	respond(w, r, items, err)
}

// ackCircular records a parent's acknowledgement — the read receipt a school
// needs when a circular carries consent or a fee deadline.
//
// announcement_acks.student_id is NOT NULL: an acknowledgement is always on
// behalf of a particular child, because a guardian with two children may need
// to consent for one and not the other. The child is taken from the caller's
// resolved scope, so it cannot be forged.
func (s *Server) ackCircular(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	annID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid circular id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.BadRequest(w, r,
			"only a student or guardian can acknowledge a circular")
		return
	}
	target := res.StudentIDs[0]
	if q := r.URL.Query().Get("student_id"); q != "" {
		sid, perr := uuid.Parse(q)
		if perr != nil || !res.OwnsStudent(sid) {
			httpx.NotFound(w, r)
			return
		}
		target = sid
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO announcement_acks (announcement_id, user_id, institution_id, student_id, acked_at)
			VALUES ($1,$2,$3,$4, now())
			-- Conflict target must be the full primary key.
			ON CONFLICT (announcement_id, user_id, student_id)
			DO UPDATE SET acked_at = now()`,
			annID, id.UserID, id.InstitutionID, target)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"acknowledged": true})
}

// ---------------------------------------------------------------- timetable

type generateTimetableRequest struct {
	SectionID      string `json:"section_id"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	Replace        bool   `json:"replace"`
}

/*
generateTimetable is retired. It answers 410 and points at the draft path.

	It used to fill a section's grid greedily and write the result straight into
	timetable_entries. That is the exact behaviour the draft model in 00050
	exists to prevent: a generator that writes the live grid has replaced the
	arrangement a school is mid-term through, and the previous one existed only
	in those rows. There is no undo, and "replace: true" made it one request
	away.

	Its replacement is POST /timetable-optimizer/drafts, which runs the real
	solver (internal/timetable), stores a candidate plus a written account of
	every requirement it could not meet, and leaves the live timetable alone
	until a human publishes the draft deliberately.

	Kept as a 410 rather than deleted because the route is registered in api.go
	and this file must not be the one that changes it. Nothing calls it: no
	screen in web/src, no test, no other handler -- grepped before retiring it.
	The integrator should drop the r.Post("/generate", ...) line from the
	/timetable-admin group, and this function with it.
*/
func (s *Server) generateTimetable(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, r, http.StatusGone, "generator_retired",
		"this generator wrote straight into the live timetable and has been withdrawn; "+
			"generate a draft with POST /timetable-optimizer/drafts and publish it once you have read the report")
}

type substitutionRequest struct {
	TimetableEntryID string `json:"timetable_entry_id"`
	OnDate           string `json:"on_date"`
	SubstituteUserID string `json:"substitute_user_id"`
	Reason           string `json:"reason,omitempty"`
}

// createSubstitution assigns a proxy teacher for one day's period.
func (s *Server) createSubstitution(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req substitutionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	entryID, err := uuid.Parse(req.TimetableEntryID)
	if err != nil {
		httpx.BadRequest(w, r, "timetable_entry_id must be a uuid")
		return
	}
	subID, err := uuid.Parse(req.SubstituteUserID)
	if err != nil {
		httpx.BadRequest(w, r, "substitute_user_id must be a uuid")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The proxy must actually be free, or the substitution just moves the
		// problem to another class.
		var busy bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM timetable_entries te
			   WHERE te.teacher_user_id = $1
			     AND te.weekday = extract(isodow FROM $2::date)::int
			     AND te.period_id = (SELECT period_id FROM timetable_entries WHERE id = $3))`,
			subID, req.OnDate, entryID).Scan(&busy); err != nil {
			return err
		}
		if busy {
			return errProxyBusy
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO substitutions (institution_id, timetable_entry_id, on_date,
			                           substitute_user_id, reason, created_by)
			VALUES ($1,$2,$3::date,$4,$5,$6)
			-- Changing one's mind about a proxy is ordinary. The first choice
			-- goes absent too, or is needed for an invigilation, and the
			-- office picks somebody else — which failed outright on the unique
			-- index and surfaced as "something went wrong" on the one screen
			-- that is worked at eight in the morning.
			ON CONFLICT (timetable_entry_id, on_date) DO UPDATE
			   SET substitute_user_id = EXCLUDED.substitute_user_id,
			       reason = EXCLUDED.reason, created_by = EXCLUDED.created_by`,
			id.InstitutionID, entryID, req.OnDate, subID, nullString(req.Reason), id.UserID)
		return err
	})
	if errors.Is(err, errProxyBusy) {
		httpx.Error(w, r, http.StatusConflict, "proxy_busy",
			"that teacher already has a class in this period")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"substituted": true})
}

var errProxyBusy = errors.New("substitute teacher is not free")

// ---------------------------------------------------------------- compliance

type udiseRow struct {
	AdmissionNo string  `json:"admission_no"`
	Name        string  `json:"name"`
	APAARID     *string `json:"apaar_id,omitempty"`
	DateOfBirth *string `json:"date_of_birth,omitempty"`
	Gender      *string `json:"gender,omitempty"`
	Category    *string `json:"category,omitempty"`
	ClassName   *string `json:"class_name,omitempty"`
	IsRTE       bool    `json:"is_rte"`
	Aadhaar     bool    `json:"aadhaar_consent"`
	Issues      string  `json:"issues"`
}

// getUDISEExport builds the annual return and flags rows that will be rejected.
//
// The validation is the point. UDISE+ rejects the whole file on field errors,
// so the useful output is not the data but the list of children whose records
// are incomplete, produced early enough to fix before the deadline.
func (s *Server) getUDISEExport(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.apaar_id, to_char(st.date_of_birth,'YYYY-MM-DD'),
		       st.gender, st.category, c.name, st.is_rte, st.aadhaar_consent,
		       trim(both ', ' FROM concat_ws(', ',
		         CASE WHEN st.date_of_birth IS NULL THEN 'date of birth missing' END,
		         CASE WHEN st.gender   IS NULL THEN 'gender missing' END,
		         CASE WHEN st.category IS NULL THEN 'social category missing' END,
		         CASE WHEN st.apaar_id IS NULL THEN 'APAAR ID not issued' END,
		         CASE WHEN NOT st.aadhaar_consent THEN 'Aadhaar consent not recorded' END,
		         CASE WHEN c.name IS NULL THEN 'not enrolled in a class' END))
		  FROM students st
		  LEFT JOIN LATERAL (
		      SELECT e.class_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status='active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		 WHERE st.status = 'active'
		 ORDER BY st.admission_no`, nil,
		func(rows pgx.Rows) (udiseRow, error) {
			var v udiseRow
			return v, rows.Scan(&v.AdmissionNo, &v.Name, &v.APAARID, &v.DateOfBirth,
				&v.Gender, &v.Category, &v.ClassName, &v.IsRTE, &v.Aadhaar, &v.Issues)
		})
	respond(w, r, items, err)
}

type apaarUpdateRequest struct {
	StudentID      string `json:"student_id"`
	APAARID        string `json:"apaar_id"`
	AadhaarConsent bool   `json:"aadhaar_consent"`
}

// setAPAARID records a student's APAAR (One Nation One Student) identifier.
func (s *Server) setAPAARID(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req apaarUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sid, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	// APAAR is a 12-digit identifier; a typo here fails the whole return.
	apaar := strings.TrimSpace(req.APAARID)
	if apaar != "" && len(apaar) != 12 {
		httpx.BadRequest(w, r, "apaar_id must be 12 digits")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE students SET apaar_id = $2, aadhaar_consent = $3, updated_at = now()
			 WHERE id = $1`, sid, nullString(apaar), req.AadhaarConsent)
		return err
	})
	if err != nil {
		// APAAR is one identifier per student nationally. A duplicate is a data
		// error the clerk must resolve, not an internal fault — telling them
		// "something went wrong" would send them to IT instead of to the record
		// that already holds the number.
		if strings.Contains(err.Error(), "students_apaar_id") {
			httpx.Error(w, r, http.StatusConflict, "apaar_already_used",
				"that APAAR ID is already assigned to another student")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"student_id": sid.String(), "apaar_id": apaar})
}

// ------------------------------------------------------------------- payroll

type payrollRunRequest struct {
	Month int `json:"month"`
	Year  int `json:"year"`
	/* Somebody has read the warning and still wants the run.

	   Loss of pay is derived from the staff register, so a month nobody
	   marked pays everybody in full — silently, and identically to a month
	   where everybody genuinely attended. The two are indistinguishable on the
	   payslip and the second is the common case, which is how a school
	   discovers in March that loss of pay has never once deducted.

	   Not blocked, because a school that keeps its register on paper still has
	   to pay people on the 30th. Acknowledged instead: the run stops, says how
	   many days nobody marked, and goes ahead only when a person says they
	   know. A warning that can be clicked past without a second act is a
	   warning nobody reads twice. */
	Acknowledged bool `json:"acknowledge_unmarked_attendance"`
}

// unmarkedAttendance counts what the register does not know about a month:
// how many staff have no marks at all, and how many working days are missing
// across everybody. Both, because "45 staff" and "3 days" are different sizes
// of problem and the person deciding needs to tell them apart.
type unmarkedAttendance struct {
	Staff int `json:"staff_with_no_marks"`
	Days  int `json:"unmarked_days"`
}

// daysInMonth is the calendar length, which is as precise as the warning needs
// to be: it says how big the gap is, not what anybody is owed.
func daysInMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// runPayroll computes a month's salaries from each employee's structure.
//
// Loss of pay is derived from staff attendance rather than entered by hand:
// paid days are the month's days minus recorded absences, and every earning is
// pro-rated on that. A locked run is never recomputed — a payslip already
// issued must keep its numbers.
func (s *Server) runPayroll(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req payrollRunRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Month < 1 || req.Month > 12 || req.Year < 2000 {
		httpx.BadRequest(w, r, "month must be 1-12 and year must be valid")
		return
	}

	/* Ask before paying a month nobody marked.

	   Checked before any payslip is written, so the answer is "not yet" rather
	   than "here are twelve payslips, by the way". */
	if !req.Acknowledged {
		var gap unmarkedAttendance
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT count(*)::int,
				       COALESCE(sum(GREATEST(0, $3::int - marked))::int, 0)
				  FROM (
				    SELECT e.id,
				           (SELECT count(*) FROM staff_attendance sa
				             WHERE sa.user_id = e.user_id
				               AND extract(month FROM sa.on_date) = $1
				               AND extract(year  FROM sa.on_date) = $2) AS marked
				      FROM employees e
				     WHERE e.status = 'active' AND e.user_id IS NOT NULL
				  ) t
				 WHERE marked = 0`,
				req.Month, req.Year,
				// Working days, approximated as the month's length. The exact
				// figure is the school calendar's business; this number only
				// has to be honest about the size of the gap.
				daysInMonth(req.Year, req.Month)).Scan(&gap.Staff, &gap.Days)
		}); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if gap.Staff > 0 {
			httpx.JSON(w, http.StatusConflict, map[string]any{
				"error": map[string]any{
					"code": "attendance_unmarked",
					"message": fmt.Sprintf(
						"%d staff have no attendance marked for this month. Their days will be paid in full, and loss of pay will deduct nothing. Acknowledge to run anyway.",
						gap.Staff),
					"request_id": httpx.RequestIDFrom(r.Context()),
				},
				"unmarked": gap,
			})
			return
		}
	}

	var runID uuid.UUID
	var employees int
	var gross, deduction, net int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		err := tx.QueryRow(r.Context(), `
			INSERT INTO payroll_runs (institution_id, period_month, period_year, status, run_by)
			VALUES ($1,$2,$3,'draft',$4)
			ON CONFLICT (institution_id, period_year, period_month) DO UPDATE
			   SET run_by = EXCLUDED.run_by
			RETURNING id, status`, id.InstitutionID, req.Month, req.Year, id.UserID).
			Scan(&runID, &status)
		if err != nil {
			return err
		}
		if status == "locked" || status == "paid" {
			return errPayrollLocked
		}

		// Recompute from scratch: a re-run must amend, never accumulate.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM payslips WHERE payroll_run_id = $1`, runID); err != nil {
			return err
		}

		daysInMonth := time.Date(req.Year, time.Month(req.Month)+1, 0, 0, 0, 0, 0, time.UTC).Day()

		/* Statutory rates, read once for the whole run.

		   PF and professional tax used to be fixed amounts somebody typed into
		   a salary component. That is fine until a salary changes, at which
		   point the deduction silently does not, and every return filed against
		   it is wrong for the rest of the year. */
		set, err := loadPayrollSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}

		/* THE SCHOOL'S OWN RULE, not this function's.

		   Loss of pay was a fraction with the calendar month underneath it:
		   days absent over days in the month, the same for a teacher, a driver
		   and the office, whatever the school's policy actually was. February
		   therefore cost more per day than January, Sundays counted as payable
		   days for everyone, and a school that deducts nothing for permanent
		   staff had no way to say so.

		   The pattern says how this school cuts: on the days it actually
		   expected the person, and by its own divisor. Every part of it falls
		   back to what this code did before, so a school that has set nothing
		   is paid exactly as it was yesterday. */
		rows, err := tx.Query(r.Context(), `
			SELECT e.id, ss.id, ss.ctc_paise,
			       -- staff_attendance keys on user_id, not employee_id, so loss
			       -- of pay is counted through the employee's linked account.
			       COALESCE((SELECT count(*) FROM staff_attendance sa
			                  WHERE sa.user_id = e.user_id
			                    AND sa.status = 'absent'
			                    AND extract(month FROM sa.on_date) = $1
			                    AND extract(year  FROM sa.on_date) = $2), 0)::int,
			       COALESCE(p.lop_basis, 'salary'),
			       COALESCE(p.salary_divisor, 0),
			       /* The days this person was actually expected: their pattern's
			          working days, less the school's holidays. Zero where no
			          pattern applies, and the caller then keeps the calendar
			          month it has always used. */
			       COALESCE((
			         SELECT count(*)::int
			           FROM generate_series(make_date($2,$1,1),
			                                (make_date($2,$1,1) + INTERVAL '1 month - 1 day')::date,
			                                INTERVAL '1 day') AS g(day)
			          WHERE p.id IS NOT NULL
			            AND EXTRACT(ISODOW FROM g.day)::int = ANY(p.working_days)
			            AND NOT EXISTS (SELECT 1 FROM holidays h
                             WHERE h.institution_id = e.institution_id
                               AND h.kind IN ('holiday','vacation')
                               AND h.applies_to IN ('all','staff')
                               AND g.day::date BETWEEN h.on_date
                                          AND COALESCE(h.to_date, h.on_date))), 0)
			  FROM employees e
			  JOIN salary_structures ss ON ss.employee_id = e.id
			   AND ss.effective_from <= make_date($2,$1,1)
			   AND (ss.effective_to IS NULL OR ss.effective_to >= make_date($2,$1,1))
			  LEFT JOIN departments   d ON d.id = e.department_id
			  LEFT JOIN work_patterns p ON p.id = COALESCE(e.work_pattern_id,
			                                               d.work_pattern_id,
			                                               (SELECT dp.id FROM work_patterns dp
			                                                 WHERE dp.institution_id = e.institution_id
			                                                   AND dp.is_default LIMIT 1))
			 WHERE e.status = 'active' AND e.user_id IS NOT NULL`, req.Month, req.Year)
		if err != nil {
			return err
		}
		type emp struct {
			id, structure uuid.UUID
			ctc           int64
			lopBasis      string
			divisor       int
			expectedDays  int
			absent        int
		}
		var emps []emp
		for rows.Next() {
			var e emp
			if err := rows.Scan(&e.id, &e.structure, &e.ctc, &e.absent,
				&e.lopBasis, &e.divisor, &e.expectedDays); err != nil {
				rows.Close()
				return err
			}
			emps = append(emps, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, e := range emps {
			/* What the month is divided by, in the school's terms.

			   Its own divisor where it set one -- thirty is what most Indian
			   contracts say. Zero means divide by the days actually expected,
			   which is the fairer rule and the one a short month makes
			   obvious. Neither set: the calendar month, as before. */
			base := daysInMonth
			switch {
			case e.divisor > 0:
				base = e.divisor
			case e.expectedDays > 0:
				base = e.expectedDays
			}

			paidDays := float64(base - e.absent)
			if paidDays < 0 {
				paidDays = 0
			}
			ratio := paidDays / float64(base)

			/* A school that has said it does not deduct, does not deduct.
			   Absence is still recorded and still reported; it simply does not
			   reach the payslip, which for permanent staff is what most
			   schools actually do. */
			if e.lopBasis == "none" {
				ratio = 1
			}

			var earn, deduct int64
			breakup := map[string]int64{}
			crows, err := tx.Query(r.Context(), `
				SELECT sc.code, sc.kind, ssi.amount_paise
				  FROM salary_structure_items ssi
				  JOIN salary_components sc ON sc.id = ssi.component_id
				 WHERE ssi.salary_structure_id = $1
				 ORDER BY sc.sequence`, e.structure)
			if err != nil {
				return err
			}
			var basicDA int64
			for crows.Next() {
				var code, kind string
				var amt int64
				if err := crows.Scan(&code, &kind, &amt); err != nil {
					crows.Close()
					return err
				}
				switch kind {
				case "earning":
					// Earnings pro-rate on paid days; deductions do not.
					v := int64(float64(amt) * ratio)
					earn += v
					breakup[code] = v
					if code == "BASIC" || code == "DA" {
						basicDA += v
					}
				case "deduction":
					// PF, ESI and PT are computed below from the wage. A school
					// that also carries them as fixed components would otherwise
					// be deducting each of them twice.
					if code == "PF" || code == "ESI" || code == "PT" {
						continue
					}
					deduct += amt
					breakup[code] = -amt
				}
			}
			crows.Close()

			/* Proxy periods taken this month.

			   Paid as an allowance rather than folded into salary, because a
			   teacher covering nine periods in November and none in December
			   has earned different amounts, and a fixed component cannot say
			   so. substitutions keys on the user, which is how a teacher is
			   identified in the timetable. */
			if set.SubstitutionPaise > 0 {
				var proxies int
				if err := tx.QueryRow(r.Context(), `
					SELECT count(*)::int FROM substitutions sub
					 WHERE sub.substitute_user_id = (SELECT user_id FROM employees WHERE id = $1)
					   AND extract(month FROM sub.on_date) = $2
					   AND extract(year  FROM sub.on_date) = $3`,
					e.id, req.Month, req.Year).Scan(&proxies); err != nil {
					return err
				}
				if proxies > 0 {
					v := int64(proxies) * set.SubstitutionPaise
					earn += v
					breakup["SUBST"] = v
				}
			}

			st := computeStatutory(set, basicDA, earn, req.Month)
			for code, amt := range map[string]int64{
				"PF": st.PFEmployee, "ESI": st.ESIEmployee, "PT": st.PT,
			} {
				if amt > 0 {
					deduct += amt
					breakup[code] = -amt
				}
			}
			// The employer's own contributions, recorded on the payslip so the
			// ECR file and the CTC statement read from the same numbers the
			// employee was shown.
			for code, amt := range map[string]int64{
				"PF_EMPLOYER": st.PFEmployer, "EPS": st.EPS,
				"ESI_EMPLOYER": st.ESIEmployer,
			} {
				if amt > 0 {
					breakup[code] = amt
				}
			}

			/* Any advance being recovered this month.

			   Recorded as its own row rather than only as a payslip line, so
			   the outstanding balance stays derivable from what was actually
			   taken. The instalment is capped at what is still owed, because
			   the last one is nearly always smaller than the rest. */
			lrows, err := tx.Query(r.Context(), `
				SELECT l.id, l.instalment_paise,
				       GREATEST(0, l.principal_paise - COALESCE((
				           SELECT sum(ld.amount_paise) FROM loan_deductions ld
				            WHERE ld.loan_id = l.id), 0))
				  FROM staff_loans l
				 WHERE l.employee_id = $1 AND l.status = 'active'
				   AND make_date($3, $2, 1) >= make_date(l.start_year, l.start_month, 1)`,
				e.id, req.Month, req.Year)
			if err != nil {
				return err
			}
			type due struct {
				id            uuid.UUID
				instal, owing int64
			}
			var dues []due
			for lrows.Next() {
				var d due
				if err := lrows.Scan(&d.id, &d.instal, &d.owing); err != nil {
					lrows.Close()
					return err
				}
				dues = append(dues, d)
			}
			lrows.Close()
			if err := lrows.Err(); err != nil {
				return err
			}
			var loanCut int64
			for _, d := range dues {
				if d.owing <= 0 {
					continue
				}
				take := d.instal
				if take > d.owing {
					take = d.owing
				}
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO loan_deductions
					    (institution_id, loan_id, payroll_run_id, period_year,
					     period_month, amount_paise)
					VALUES ($1,$2,$3,$4,$5,$6)
					ON CONFLICT (loan_id, period_year, period_month)
					DO UPDATE SET amount_paise = EXCLUDED.amount_paise,
					              payroll_run_id = EXCLUDED.payroll_run_id`,
					id.InstitutionID, d.id, runID, req.Year, req.Month, take); err != nil {
					return err
				}
				loanCut += take
				// Close it the moment the last instalment is taken, rather than
				// leaving a settled advance sitting in the active list.
				if take >= d.owing {
					if _, err := tx.Exec(r.Context(),
						`UPDATE staff_loans SET status='closed', closed_on=current_date
						  WHERE id = $1`, d.id); err != nil {
						return err
					}
				}
			}
			if loanCut > 0 {
				deduct += loanCut
				breakup["ADVANCE"] = -loanCut
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO payslips (institution_id, payroll_run_id, employee_id, paid_days,
				                      lop_days, gross_paise, deduction_paise, net_paise, breakup)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				id.InstitutionID, runID, e.id, paidDays, e.absent,
				earn, deduct, earn-deduct, breakup); err != nil {
				return err
			}
			employees++
			gross += earn
			deduction += deduct
			net += earn - deduct
		}

		_, err = tx.Exec(r.Context(), `
			UPDATE payroll_runs SET status='processed', employees=$2,
			       gross_paise=$3, deduction_paise=$4, net_paise=$5
			 WHERE id = $1`, runID, employees, gross, deduction, net)
		return err
	})
	if errors.Is(err, errPayrollLocked) {
		httpx.Error(w, r, http.StatusConflict, "payroll_locked",
			"this month's payroll is locked; payslips already issued cannot be recomputed")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"payroll_run_id": runID.String(), "employees": employees,
		"gross_paise": gross, "deduction_paise": deduction, "net_paise": net,
	})
}

var errPayrollLocked = errors.New("payroll run is locked")

type payslipRow struct {
	EmployeeCode string `json:"employee_code"`
	FullName     string `json:"full_name"`
	PaidDays     string `json:"paid_days"`
	LOPDays      string `json:"lop_days"`
	Gross        int64  `json:"gross_paise"`
	Deduction    int64  `json:"deduction_paise"`
	Net          int64  `json:"net_paise"`
	Breakup      any    `json:"breakup"`
	RunStatus    string `json:"run_status"`
	// Whether the staff have been told, which "paid" does not say. Without it
	// the screen offered "Publish payslips" on a month already published, and
	// twelve people get notified twice.
	Published bool `json:"published"`
	/* Whether this person is still on the staff.

	   A payslip is a record of money that moved, so it survives the person
	   leaving — which is right, and made two screens disagree without either
	   being wrong. HR's headcount said 11 and the payroll run said 12, because
	   August genuinely paid twelve people and one has since been relieved.
	   Neither number wanted changing; the row simply never said so. */
	LeftService bool `json:"left_service"`
}

func (s *Server) listPayslips(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		       ps.paid_days::text, ps.lop_days::text,
		       ps.gross_paise, ps.deduction_paise, ps.net_paise, ps.breakup,
		       -- The month's state travels with the rows so the screen can
		       -- offer the right next step rather than every step at once.
		       pr.status, pr.published_at IS NOT NULL,
		       e.status <> 'active'
		  FROM payslips ps
		  JOIN employees e ON e.id = ps.employee_id
		  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
		 WHERE ($1::int IS NULL OR pr.period_month = $1)
		   AND ($2::int IS NULL OR pr.period_year = $2)
		 ORDER BY e.employee_code`,
		[]any{nullInt(r.URL.Query().Get("month")), nullInt(r.URL.Query().Get("year"))},
		func(rows pgx.Rows) (payslipRow, error) {
			var v payslipRow
			return v, rows.Scan(&v.EmployeeCode, &v.FullName, &v.PaidDays, &v.LOPDays,
				&v.Gross, &v.Deduction, &v.Net, &v.Breakup, &v.RunStatus, &v.Published, &v.LeftService)
		})
	respond(w, r, items, err)
}

// ---------------------------------------------------------------- operations

type issueBookRequest struct {
	CopyID    string `json:"copy_id"`
	StudentID string `json:"student_id,omitempty"`
	DueInDays int    `json:"due_in_days,omitempty"`
}

// issueBook lends a copy, refusing if it is already out.
func (s *Server) issueBook(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req issueBookRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	copyID, err := uuid.Parse(req.CopyID)
	if err != nil {
		httpx.BadRequest(w, r, "copy_id must be a uuid")
		return
	}
	if req.DueInDays <= 0 {
		req.DueInDays = 14
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var out bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM library_loans WHERE copy_id=$1 AND returned_on IS NULL)`,
			copyID).Scan(&out); err != nil {
			return err
		}
		if out {
			return errCopyOnLoan
		}
		/* A copy held for somebody goes to that somebody.

		   Without this the counter would cheerfully hand a reserved book to
		   the next person through the door, and the reader who was told it was
		   waiting would arrive to find it gone — which is worse than never
		   having been told. */
		var heldFor *string
		if err := tx.QueryRow(r.Context(), `
			SELECT res.student_id::text
			  FROM library_reservations res
			 WHERE res.ready_copy_id = $1 AND res.status = 'ready'
			 LIMIT 1`, copyID).Scan(&heldFor); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if heldFor != nil && *heldFor != req.StudentID {
			return errCopyHeld
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO library_loans (institution_id, copy_id, student_id, issued_on, due_on, issued_by)
			VALUES ($1,$2,$3::uuid, CURRENT_DATE, CURRENT_DATE + $4::int, $5)`,
			id.InstitutionID, copyID, nullString(req.StudentID), req.DueInDays, id.UserID); err != nil {
			return err
		}
		// Issuing closes the hold it satisfies, and the copy is on loan now.
		if _, err := tx.Exec(r.Context(), `
			UPDATE library_reservations SET status='collected'
			 WHERE ready_copy_id = $1 AND status = 'ready'`, copyID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE library_copies SET status='issued' WHERE id=$1`, copyID)
		return err
	})
	if errors.Is(err, errCopyOnLoan) {
		httpx.Error(w, r, http.StatusConflict, "already_issued", "that copy is already on loan")
		return
	}
	if errors.Is(err, errCopyHeld) {
		httpx.Error(w, r, http.StatusConflict, "held_for_another",
			"that copy is behind the counter for a reader who reserved it. Issue a different copy")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"issued": true, "due_in_days": req.DueInDays})
}

var (
	errCopyOnLoan = errors.New("copy already on loan")
	errCopyHeld   = errors.New("copy is being held for another reader")
)

type returnBookRequest struct {
	FinePerDayPaise int64 `json:"fine_per_day_paise,omitempty"`
}

// returnBook closes a loan and computes the overdue fine.
func (s *Server) returnBook(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	loanID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid loan id")
		return
	}
	var req returnBookRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	if req.FinePerDayPaise <= 0 {
		req.FinePerDayPaise = 100 // ₹1/day is the common default
	}

	var fine int64
	var promoted bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var copyID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			UPDATE library_loans
			   SET returned_on = CURRENT_DATE,
			       fine_paise = GREATEST(0, (CURRENT_DATE - due_on)) * $2
			 WHERE id = $1 AND returned_on IS NULL
			 RETURNING fine_paise, copy_id`, loanID, req.FinePerDayPaise).Scan(&fine, &copyID); err != nil {
			return err
		}
		// The copy is back on the shelf unless somebody is waiting for it, in
		// which case it goes behind the counter with their name on it.
		if _, err := tx.Exec(r.Context(),
			`UPDATE library_copies SET status = 'available' WHERE id = $1`, copyID); err != nil {
			return err
		}
		/* Promoting the next reader happens here, inside the return, and not
		   in a nightly job. A copy that came back this morning and a queue
		   that has not moved by this afternoon is precisely the failure a hold
		   queue exists to prevent, and a reader standing at the counter is the
		   only person who will ever notice. */
		if err := promoteNextHold(r, tx, copyID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM library_reservations
			                WHERE ready_copy_id = $1 AND status = 'ready')`,
			copyID).Scan(&promoted)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no open loan with that id")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"returned": true, "fine_paise": fine, "held_for_next_reader": promoted})
}

type allocateHostelRequest struct {
	RoomID    string `json:"room_id"`
	StudentID string `json:"student_id"`
	BedNo     int    `json:"bed_no"`
}

// allocateHostelBed puts a boarder in a bed, refusing an occupied one.
func (s *Server) allocateHostelBed(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req allocateHostelRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	roomID, err := uuid.Parse(req.RoomID)
	if err != nil {
		httpx.BadRequest(w, r, "room_id must be a uuid")
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.BedNo <= 0 {
		req.BedNo = 1
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var beds int
		if err := tx.QueryRow(r.Context(),
			`SELECT beds FROM hostel_rooms WHERE id = $1`, roomID).Scan(&beds); err != nil {
			return err
		}
		if req.BedNo > beds {
			return fmt.Errorf("room has only %d beds", beds)
		}
		// The partial unique indexes enforce one live allocation per bed and per
		// student; this insert simply surfaces the violation as a clean error.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO hostel_allocations (institution_id, room_id, student_id, bed_no)
			VALUES ($1,$2,$3,$4)`, id.InstitutionID, roomID, studentID, req.BedNo)
		return err
	})
	if err != nil {
		if strings.Contains(err.Error(), "hostel_allocations_bed") {
			httpx.Error(w, r, http.StatusConflict, "bed_occupied", "that bed is already allocated")
			return
		}
		if strings.Contains(err.Error(), "hostel_allocations_student") {
			httpx.Error(w, r, http.StatusConflict, "already_allocated",
				"that student already occupies a bed; vacate it first")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"allocated": true})
}

type hostelRow struct {
	// RoomID was missing, which made the occupancy list unusable for the one
	// thing a warden does with it: put a child in a free bed. Every row named
	// a room the client could not then refer to.
	RoomID   string  `json:"room_id"`
	Block    string  `json:"block"`
	RoomNo   string  `json:"room_no"`
	Floor    *int    `json:"floor,omitempty"`
	Beds     int     `json:"beds"`
	Occupied int     `json:"occupied"`
	Free     int     `json:"free"`
	Gender   *string `json:"gender,omitempty"`
}

func (s *Server) listHostelOccupancy(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT hr.id::text, hb.name, hr.room_no, hr.floor, hr.beds,
		       (SELECT count(*) FROM hostel_allocations ha
		         WHERE ha.room_id = hr.id AND ha.vacated_on IS NULL)::int,
		       (hr.beds - (SELECT count(*) FROM hostel_allocations ha
		                    WHERE ha.room_id = hr.id AND ha.vacated_on IS NULL))::int,
		       hb.gender
		  FROM hostel_rooms hr
		  JOIN hostel_blocks hb ON hb.id = hr.block_id
		 ORDER BY hb.name, hr.room_no`, nil,
		func(rows pgx.Rows) (hostelRow, error) {
			var v hostelRow
			return v, rows.Scan(&v.RoomID, &v.Block, &v.RoomNo, &v.Floor, &v.Beds,
				&v.Occupied, &v.Free, &v.Gender)
		})
	respond(w, r, items, err)
}

type stockMoveRequest struct {
	ItemID    string `json:"item_id"`
	Kind      string `json:"kind"`
	Quantity  int    `json:"quantity"`
	Reference string `json:"reference,omitempty"`
	Remarks   string `json:"remarks,omitempty"`
}

// moveStock records a receipt, issue, return or adjustment. The running
// balance is maintained by a trigger, so on_hand can never disagree with the
// movement history.
func (s *Server) moveStock(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req stockMoveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	itemID, err := uuid.Parse(req.ItemID)
	if err != nil {
		httpx.BadRequest(w, r, "item_id must be a uuid")
		return
	}
	valid := map[string]bool{"receipt": true, "issue": true, "adjustment": true, "return": true}
	if !valid[req.Kind] {
		httpx.BadRequest(w, r, "kind must be receipt, issue, adjustment or return")
		return
	}
	if req.Quantity == 0 {
		httpx.BadRequest(w, r, "quantity must not be zero")
		return
	}

	var onHand int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Kind == "issue" {
			var available int
			if err := tx.QueryRow(r.Context(),
				`SELECT on_hand FROM inventory_items WHERE id = $1 FOR UPDATE`,
				itemID).Scan(&available); err != nil {
				return err
			}
			// Refuse to issue stock that is not there. A negative balance is
			// never a real state, and it corrupts every subsequent count.
			if req.Quantity > available {
				return fmt.Errorf("only %d in stock", available)
			}
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
			                                 reference, remarks, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			id.InstitutionID, itemID, req.Kind, req.Quantity,
			nullString(req.Reference), nullString(req.Remarks), id.UserID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT on_hand FROM inventory_items WHERE id = $1`, itemID).Scan(&onHand)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"on_hand": onHand})
}

type stockRow struct {
	ID       string  `json:"id"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Category *string `json:"category,omitempty"`
	Unit     string  `json:"unit"`
	OnHand   int     `json:"on_hand"`
	Reorder  int     `json:"reorder_level"`
	Low      bool    `json:"below_reorder"`
}

func (s *Server) listStock(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, code, name, category, unit, on_hand, reorder_level,
		       on_hand <= reorder_level
		  FROM inventory_items ORDER BY name`, nil,
		func(rows pgx.Rows) (stockRow, error) {
			var v stockRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Category, &v.Unit,
				&v.OnHand, &v.Reorder, &v.Low)
		})
	respond(w, r, items, err)
}

func nullInt(s string) any {
	if s == "" {
		return nil
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return nil
	}
	return n
}

// --- library catalogue --------------------------------------------------------

type titleRow struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Author    *string `json:"author,omitempty"`
	ISBN      *string `json:"isbn,omitempty"`
	Category  *string `json:"category,omitempty"`
	Copies    int     `json:"copies"`
	Available int     `json:"available"`
}

/*
listLibraryTitles is the catalogue: what the library holds and how much of it
is on the shelf right now.

	The circulation screen could issue and return, and nothing could answer
	"do we have this book" — which is the question actually asked at the
	counter, usually by a child holding a slip. Availability is computed from
	open loans rather than read off library_copies.status, because the status
	column drifts the moment anything writes a loan without updating it, and
	the loan table is the record that decides.
*/
func (s *Server) listLibraryTitles(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	items, err := collect(s, r, `
		SELECT t.id::text, t.title, t.author, t.isbn, t.category,
		       count(cp.id)::int,
		       count(cp.id) FILTER (
		         WHERE NOT EXISTS (
		           SELECT 1 FROM library_loans l
		            WHERE l.copy_id = cp.id AND l.returned_on IS NULL))::int
		  FROM library_titles t
		  LEFT JOIN library_copies cp ON cp.title_id = t.id
		 WHERE ($1 = '' OR t.title ILIKE '%' || $1 || '%'
		                OR COALESCE(t.author,'') ILIKE '%' || $1 || '%'
		                OR COALESCE(t.isbn,'')   ILIKE '%' || $1 || '%')
		 GROUP BY t.id, t.title, t.author, t.isbn, t.category
		 ORDER BY t.title
		 LIMIT 300`, []any{q},
		func(rows pgx.Rows) (titleRow, error) {
			var v titleRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Author, &v.ISBN, &v.Category,
				&v.Copies, &v.Available)
		})
	respond(w, r, items, err)
}

type copyRow struct {
	ID          string  `json:"id"`
	AccessionNo string  `json:"accession_no"`
	Barcode     *string `json:"barcode,omitempty"`
	Rack        *string `json:"rack,omitempty"`
	OnLoanTo    *string `json:"on_loan_to,omitempty"`
	DueOn       *string `json:"due_on,omitempty"`
	// available | issued | reserved | lost | damaged | withdrawn. A copy held
	// behind the counter for a reader looked identical to one on the shelf,
	// which is exactly the copy a librarian must not hand to a walk-in.
	Status  string  `json:"status"`
	HeldFor *string `json:"held_for,omitempty"`
}

// listTitleCopies lists the physical copies of one title, and who holds each.
func (s *Server) listTitleCopies(w http.ResponseWriter, r *http.Request) {
	titleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid title id")
		return
	}
	items, err := collect(s, r, `
		SELECT cp.id::text, cp.accession_no, cp.barcode, cp.rack,
		       COALESCE(concat_ws(' ', st.first_name, st.last_name),
		                concat_ws(' ', e.first_name,  e.last_name)),
		       to_char(l.due_on,'YYYY-MM-DD'),
		       cp.status,
		       NULLIF(concat_ws(' ', hs.first_name, hs.last_name), '')
		  FROM library_copies cp
		  LEFT JOIN library_loans l ON l.copy_id = cp.id AND l.returned_on IS NULL
		  LEFT JOIN students  st ON st.id = l.student_id
		  LEFT JOIN employees e  ON e.id = l.employee_id
		  LEFT JOIN library_reservations res
		         ON res.ready_copy_id = cp.id AND res.status = 'ready'
		  LEFT JOIN students hs ON hs.id = res.student_id
		 WHERE cp.title_id = $1
		 ORDER BY cp.accession_no`, []any{titleID},
		func(rows pgx.Rows) (copyRow, error) {
			var v copyRow
			return v, rows.Scan(&v.ID, &v.AccessionNo, &v.Barcode, &v.Rack,
				&v.OnLoanTo, &v.DueOn, &v.Status, &v.HeldFor)
		})
	respond(w, r, items, err)
}

// --- hostel boarders ----------------------------------------------------------

type boarderRow struct {
	AllocationID string `json:"allocation_id"`
	StudentID    string `json:"student_id"`
	Name         string `json:"name"`
	AdmissionNo  string `json:"admission_no"`
	BedNo        int    `json:"bed_no"`
	AllocatedOn  string `json:"allocated_on"`
	Class        string `json:"class_name,omitempty"`
}

// listRoomBoarders names who is in a room. Occupancy counts tell a warden a
// bed is taken; roll call needs to know by whom.
func (s *Server) listRoomBoarders(w http.ResponseWriter, r *http.Request) {
	roomID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid room id")
		return
	}
	items, err := collect(s, r, `
		SELECT ha.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       ha.bed_no, to_char(ha.allocated_on,'YYYY-MM-DD'),
		       COALESCE(c.name || '-' || sec.name, '')
		  FROM hostel_allocations ha
		  JOIN students st ON st.id = ha.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ha.room_id = $1 AND ha.vacated_on IS NULL
		 ORDER BY ha.bed_no`, []any{roomID},
		func(rows pgx.Rows) (boarderRow, error) {
			var v boarderRow
			return v, rows.Scan(&v.AllocationID, &v.StudentID, &v.Name, &v.AdmissionNo,
				&v.BedNo, &v.AllocatedOn, &v.Class)
		})
	respond(w, r, items, err)
}

// --- infirmary ----------------------------------------------------------------

type healthRow struct {
	StudentID   string  `json:"student_id"`
	Name        string  `json:"name"`
	AdmissionNo string  `json:"admission_no"`
	Class       string  `json:"class_name,omitempty"`
	BloodGroup  *string `json:"blood_group,omitempty"`
	Allergies   *string `json:"allergies,omitempty"`
	Chronic     *string `json:"chronic_conditions,omitempty"`
	Doctor      *string `json:"doctor_name,omitempty"`
	DoctorPhone *string `json:"doctor_phone,omitempty"`
}

/*
listHealthRecords is the clinic's master file.

	Ordered so that the children with something recorded come first. A nurse
	opening this in an emergency is looking for the allergy or the chronic
	condition, and burying those under a hundred blank rows is the difference
	between finding it and not.
*/
func (s *Server) listHealthRecords(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	onlyFlagged := r.URL.Query().Get("flagged") == "true"
	items, err := collect(s, r, `
		SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, COALESCE(c.name || '-' || sec.name, ''),
		       st.blood_group, sh.allergies, sh.chronic_conditions,
		       sh.doctor_name, sh.doctor_phone
		  FROM students st
		  LEFT JOIN student_health sh ON sh.student_id = st.id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ($1 = '' OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $1 || '%'
		                OR st.admission_no ILIKE '%' || $1 || '%')
		   AND (NOT $2::bool
		        OR sh.allergies IS NOT NULL OR sh.chronic_conditions IS NOT NULL)
		 ORDER BY (sh.allergies IS NULL AND sh.chronic_conditions IS NULL),
		          st.admission_no
		 LIMIT 300`, []any{q, onlyFlagged},
		func(rows pgx.Rows) (healthRow, error) {
			var v healthRow
			return v, rows.Scan(&v.StudentID, &v.Name, &v.AdmissionNo, &v.Class,
				&v.BloodGroup, &v.Allergies, &v.Chronic, &v.Doctor, &v.DoctorPhone)
		})
	respond(w, r, items, err)
}

// --- transport routes ---------------------------------------------------------

type routeRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Code      *string `json:"code,omitempty"`
	Vehicle   *string `json:"vehicle,omitempty"`
	DistanceK *string `json:"distance_km,omitempty"`
	Stops     int     `json:"stops"`
	Riders    int     `json:"riders"`
	Active    bool    `json:"is_active"`
}

// listRoutes gives the transport office its routes with the two numbers that
// decide everything: how many stops, and how many children ride.
func (s *Server) listRoutes(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rt.id::text, rt.name, rt.code, v.registration_no,
		       rt.distance_km::text,
		       (SELECT count(*) FROM route_stops rs WHERE rs.route_id = rt.id)::int,
		       (SELECT count(*) FROM transport_allocations ta
		         WHERE ta.route_id = rt.id AND ta.valid_to IS NULL)::int,
		       rt.is_active
		  FROM routes rt
		  LEFT JOIN vehicles v ON v.id = rt.vehicle_id
		 ORDER BY rt.name`, nil,
		func(rows pgx.Rows) (routeRow, error) {
			var v routeRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Code, &v.Vehicle, &v.DistanceK,
				&v.Stops, &v.Riders, &v.Active)
		})
	respond(w, r, items, err)
}

type stopRow struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Sequence   int     `json:"sequence"`
	PickupTime *string `json:"pickup_time,omitempty"`
	DropTime   *string `json:"drop_time,omitempty"`
	FarePaise  int64   `json:"fare_paise"`
	GeofenceM  *int    `json:"geofence_m,omitempty"`
	Latitude   *string `json:"latitude,omitempty"`
	Longitude  *string `json:"longitude,omitempty"`
	Riders     int     `json:"riders"`
}

// listRouteStops is the run in order, with who boards where.
func (s *Server) listRouteStops(w http.ResponseWriter, r *http.Request) {
	routeID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid route id")
		return
	}
	items, err := collect(s, r, `
		SELECT rs.id::text, rs.name, rs.sequence,
		       to_char(rs.pickup_time,'HH24:MI'), to_char(rs.drop_time,'HH24:MI'),
		       COALESCE(rs.fare_paise,0), rs.geofence_m,
		       -- The coordinates, which nothing returned. Without them an edit
		       -- form silently drops the geofence it was meant to preserve,
		       -- and a stop stops being a place the bus can be said to have
		       -- reached.
		       rs.latitude::text, rs.longitude::text,
		       (SELECT count(*) FROM transport_allocations ta
		         WHERE ta.pickup_stop_id = rs.id AND ta.valid_to IS NULL)::int
		  FROM route_stops rs
		 WHERE rs.route_id = $1
		 ORDER BY rs.sequence`, []any{routeID},
		func(rows pgx.Rows) (stopRow, error) {
			var v stopRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Sequence, &v.PickupTime,
				&v.DropTime, &v.FarePaise, &v.GeofenceM, &v.Latitude, &v.Longitude, &v.Riders)
		})
	respond(w, r, items, err)
}
