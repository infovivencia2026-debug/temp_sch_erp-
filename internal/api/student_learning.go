package api

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The rest of being a child at this school.

   Fourteen catalogued screens across learning, campus life, the calendar, the
   academic file and life after leaving. They mount inside the /portal group,
   which requires self.profile.read — a permission every role in the product
   holds, so it admits the librarian and the driver as readily as the child.
   The permission is a floor, not a gate. What actually stands between a child
   and a classmate's record is the ownership check in each handler:
   s.whichChild or s.portalChild resolves the id against the caller's own
   resolved scope, and a miss is answered 404 rather than 403 so the endpoint
   cannot be used to confirm which admission numbers exist.

   Most of this is reuse. class_subjects and subjects are the course list,
   study_materials is the resource hub, enrollments and report_cards are the
   academic record, students.apaar_id is the APAAR, holidays and terms and
   exam_subjects are the calendar, and library_reservations is the book hold
   queue — which is joined by delegating to the librarian's own handler rather
   than by writing a second one. A second queue would be the one the counter
   disagrees with.

   Two exceptions to "student only". The gate scanning a club ticket and the
   office allotting a locker are staff acts, gated on their own permissions in
   the mount below, exactly as the pickup pass already is: a child must never be
   able to mark their own ticket as used, because that record is the evidence
   they were let in. */

// mountStudentLearning registers the learning, campus-life, calendar, record
// and alumni routes.
//
// Called from inside the existing /portal group, so the paths here are
// relative and the group's self.profile.read already applies.
func (s *Server) mountStudentLearning(r chi.Router) {
	// Learning.
	r.Get("/learning/courses", s.listMyCourses)
	r.Get("/learning/resources", s.listMyResources)
	r.Get("/learning/study-groups", s.listStudyGroups)
	r.Post("/learning/study-groups", s.createStudyGroup)
	// The roster is not on the list deliberately: who is in a group is visible
	// to the people in it, not to the whole section.
	r.Get("/learning/study-groups/{id}/members", s.listStudyGroupMembers)
	r.Post("/learning/study-groups/{id}/join", s.joinStudyGroup)
	r.Post("/learning/study-groups/{id}/leave", s.leaveStudyGroup)
	r.Get("/learning/portfolio", s.getPortfolio)
	r.Post("/learning/portfolio", s.addPortfolioItem)
	r.Post("/learning/portfolio/{id}", s.updatePortfolioItem)
	r.Delete("/learning/portfolio/{id}", s.deletePortfolioItem)
	r.Get("/learning/universities", s.listUniversityShortlist)
	r.Post("/learning/universities", s.addUniversityEntry)
	r.Post("/learning/universities/{id}", s.updateUniversityEntry)
	r.Delete("/learning/universities/{id}", s.deleteUniversityEntry)

	// Campus life.
	r.Get("/campus/lost-found", s.listLostFound)
	r.Post("/campus/lost-found", s.reportLostFound)
	r.Post("/campus/lost-found/{id}/resolve", s.resolveLostFound)
	r.Get("/campus/locker", s.getMyLocker)
	// A POST rather than a field on the GET: reading the combination is the
	// event the access log exists to record, and a GET that writes a row
	// would be replayed by every refresh and every prefetch.
	r.Post("/campus/locker/reveal", s.revealLockerCombination)
	r.Post("/campus/locker/access", s.logLockerAccess)
	r.Get("/campus/events", s.listClubEvents)
	r.Post("/campus/events/{id}/ticket", s.bookEventTicket)
	r.Post("/campus/tickets/{id}/cancel", s.cancelEventTicket)
	// The door, not the guest.
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Post("/campus/events/check-in", s.checkInEventTicket)
	r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).
		Post("/campus/events", s.createClubEvent)
	r.With(httpx.RequirePermission(rbac.StudentsWrite)).
		Post("/campus/lockers", s.assignLocker)

	// Notices and calendar.
	r.Get("/calendar", s.getStudentCalendar)
	r.Get("/library/titles", s.listLibraryCatalogue)
	r.Get("/library/holds", s.listMyHolds)
	r.Post("/library/holds", s.requestBookHold)
	r.Post("/library/holds/{id}/cancel", s.cancelBookHold)

	// Exams and results.
	r.Get("/academic-record", s.getAcademicRecord)
	r.Get("/abc", s.getAcademicBankOfCredits)
	r.With(httpx.RequirePermission(rbac.ExamsWrite)).
		Post("/abc/entries", s.depositAcademicCredits)

	// Alumni.
	r.Get("/alumni/profile", s.getAlumniProfile)
	r.Post("/alumni/profile", s.saveAlumniProfile)
	r.Get("/alumni/directory", s.listAlumniDirectory)
	r.Get("/alumni/jobs", s.listAlumniJobs)
	r.Post("/alumni/jobs/{id}/interest", s.registerJobInterest)
	r.Post("/alumni/jobs/{id}/withdraw", s.withdrawJobInterest)
	r.With(httpx.RequirePermission(rbac.StudentsWrite)).
		Post("/alumni/jobs", s.postAlumniJob)
}

// --- the caller's classroom --------------------------------------------------

// classroom is the enrolment a child is sitting in, which is what "my class"
// resolves to on every screen in this file.
type classroom struct {
	StudentID   uuid.UUID
	StudentName string
	CampusID    uuid.UUID
	ClassID     uuid.UUID
	SectionID   uuid.UUID
	YearID      uuid.UUID
	Level       int
	ClassName   string
	SectionName string
	AdmissionNo string
}

// errNotEnrolled is a child on the roll with no enrolment row — an admission
// half completed by the office. Every class-scoped screen has to say so rather
// than show an empty list, which would read as "your class has no subjects".
var errNotEnrolled = errors.New("no enrolment on record")

/*
classroomOf loads the class a child belongs to.

	The active enrolment wins; a leaver falls back to their most recent one so
	an alumnus can still read their own academic record after the row has been
	marked completed.
*/
func (s *Server) classroomOf(r *http.Request, student uuid.UUID) (classroom, error) {
	id := httpx.IdentityFrom(r.Context())
	c := classroom{StudentID: student}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT st.campus_id, e.class_id, e.section_id, e.academic_year_id,
			       cl.level, cl.name, sec.name, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name)
			  FROM students st
			  JOIN enrollments e  ON e.student_id = st.id
			  JOIN classes     cl ON cl.id = e.class_id
			  JOIN sections    sec ON sec.id = e.section_id
			 WHERE st.id = $1
			 ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC
			 LIMIT 1`, student).
			Scan(&c.CampusID, &c.ClassID, &c.SectionID, &c.YearID, &c.Level,
				&c.ClassName, &c.SectionName, &c.AdmissionNo, &c.StudentName)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return c, errNotEnrolled
	}
	return c, err
}

// myClassroom resolves the child a request is about and the class they sit in,
// writing the refusal itself when either fails.
func (s *Server) myClassroom(w http.ResponseWriter, r *http.Request) (classroom, bool) {
	student, ok := s.whichChild(w, r)
	if !ok {
		return classroom{}, false
	}
	room, err := s.classroomOf(r, student)
	if errors.Is(err, errNotEnrolled) {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"this student has no enrolment on record; ask the office to complete the admission")
		return classroom{}, false
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return classroom{}, false
	}
	return room, true
}

// --- courses and subjects ----------------------------------------------------

type myCourse struct {
	ClassSubjectID string  `json:"class_subject_id"`
	Subject        string  `json:"subject"`
	Code           string  `json:"code"`
	Scholastic     bool    `json:"is_scholastic"`
	Elective       bool    `json:"is_elective"`
	MaxMarks       int     `json:"max_marks"`
	Teacher        *string `json:"teacher,omitempty"`
	// Periods a week, counted from the timetable rather than stored: a subject
	// that lost a period to a substitution has still lost it.
	WeeklyPeriods int     `json:"weekly_periods"`
	Materials     int     `json:"resources"`
	NextExam      *string `json:"next_exam_on,omitempty"`
	Homework      int     `json:"homework_pending"`
}

// listMyCourses powers student.learning.courses_subjects — every subject the
// child's own class is taught, and who takes it for their own section.
func (s *Server) listMyCourses(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT cs.id::text, sub.name, sub.code, sub.is_scholastic,
		       cs.is_elective, cs.max_marks, u.full_name,
		       (SELECT count(*) FROM timetable_entries te
		         WHERE te.section_id = $2 AND te.class_subject_id = cs.id),
		       (SELECT count(*) FROM study_materials sm
		         WHERE sm.class_subject_id = cs.id AND sm.is_published),
		       (SELECT to_char(min(es.exam_date),'YYYY-MM-DD')
		          FROM exam_subjects es
		         WHERE es.class_subject_id = cs.id
		           AND es.exam_date >= CURRENT_DATE),
		       (SELECT count(*) FROM homework h
		         WHERE h.class_subject_id = cs.id AND h.section_id = $2
		           AND h.is_published
		           AND (h.due_on IS NULL OR h.due_on >= CURRENT_DATE)
		           AND NOT EXISTS (SELECT 1 FROM homework_submissions hs
		                            WHERE hs.homework_id = h.id AND hs.student_id = $3))
		  FROM class_subjects cs
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN section_subject_teachers sst
		         ON sst.class_subject_id = cs.id AND sst.section_id = $2
		  LEFT JOIN users u ON u.id = sst.teacher_user_id
		 WHERE cs.class_id = $1
		 ORDER BY sub.is_scholastic DESC, sub.name`,
		[]any{room.ClassID, room.SectionID, room.StudentID},
		func(rows pgx.Rows) (myCourse, error) {
			var v myCourse
			return v, rows.Scan(&v.ClassSubjectID, &v.Subject, &v.Code, &v.Scholastic,
				&v.Elective, &v.MaxMarks, &v.Teacher, &v.WeeklyPeriods, &v.Materials,
				&v.NextExam, &v.Homework)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": room.StudentID.String(),
		"class_name": room.ClassName, "section_name": room.SectionName,
		"items": items,
	})
}

// --- e-learning resource hub -------------------------------------------------

type myResource struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Kind        string  `json:"kind"`
	Subject     *string `json:"subject,omitempty"`
	URL         *string `json:"external_url,omitempty"`
	FileID      *string `json:"file_id,omitempty"`
	UploadedBy  *string `json:"uploaded_by,omitempty"`
	PostedOn    string  `json:"posted_on"`
}

/*
listMyResources powers student.learning.e_learning_resource_hub.

	Three widths of audience live in study_materials and all three are the
	child's: something posted to their own section, something posted against a
	subject their class is taught, and something posted to neither, which is the
	school-wide handbook. Reading only the first left the hub empty in a school
	whose teachers file by subject.
*/
func (s *Server) listMyResources(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	kind := nullString(strings.TrimSpace(r.URL.Query().Get("kind")))
	items, err := collect(s, r, `
		SELECT sm.id::text, sm.title, sm.description, sm.kind, sub.name,
		       sm.external_url, sm.file_id::text, u.full_name,
		       to_char(sm.created_at,'YYYY-MM-DD')
		  FROM study_materials sm
		  LEFT JOIN class_subjects cs ON cs.id = sm.class_subject_id
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN users           u ON u.id = sm.uploaded_by
		 WHERE sm.is_published
		   AND ($3::text IS NULL OR sm.kind = $3)
		   AND (sm.section_id = $1
		        OR (sm.section_id IS NULL
		            AND (cs.class_id = $2 OR sm.class_subject_id IS NULL)))
		 ORDER BY sm.created_at DESC
		 LIMIT 300`,
		[]any{room.SectionID, room.ClassID, kind},
		func(rows pgx.Rows) (myResource, error) {
			var v myResource
			return v, rows.Scan(&v.ID, &v.Title, &v.Description, &v.Kind, &v.Subject,
				&v.URL, &v.FileID, &v.UploadedBy, &v.PostedOn)
		})
	respond(w, r, items, err)
}

// --- peer tutoring and study groups ------------------------------------------

type studyGroup struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Topic     *string `json:"topic,omitempty"`
	Subject   *string `json:"subject,omitempty"`
	MeetsWhen *string `json:"meets_when,omitempty"`
	Venue     *string `json:"venue,omitempty"`
	Capacity  *int    `json:"capacity,omitempty"`
	Open      bool    `json:"is_open"`
	Organiser string  `json:"organiser"`
	// Whether the reader may act, worked out here so the screen does not offer
	// a Join button that will 409.
	Mine     bool   `json:"organised_by_me"`
	Members  int    `json:"members"`
	Joined   bool   `json:"joined"`
	MyRole   string `json:"my_role"`
	HasSpace bool   `json:"has_space"`
	Tutors   int    `json:"tutors"`
	Created  string `json:"created_on"`
}

/*
listStudyGroups powers student.learning.peer_tutoring_study_groups.

	Scoped to the child's own section, because a study group is a room at
	lunchtime and Grade 6-B's arrangement is not something 6-A can attend. The
	roster is deliberately not here: the board advertises the group, the
	organiser's name and how many have signed up, which is what a notice on the
	classroom wall carries. Who exactly is in it is for the people in it.
*/
func (s *Server) listStudyGroups(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT g.id::text, g.name, g.topic, sub.name, g.meets_when, g.venue,
		       g.capacity, g.is_open,
		       concat_ws(' ', o.first_name, o.last_name),
		       g.organiser_id = $1,
		       live.members, live.tutors,
		       me.student_id IS NOT NULL,
		       COALESCE(me.role, ''),
		       g.capacity IS NULL OR live.members < g.capacity,
		       to_char(g.created_at,'YYYY-MM-DD')
		  FROM study_groups g
		  JOIN students o ON o.id = g.organiser_id
		  LEFT JOIN class_subjects cs ON cs.id = g.class_subject_id
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS members,
		             count(*) FILTER (WHERE m.role = 'tutor')::int AS tutors
		        FROM study_group_members m
		       WHERE m.group_id = g.id AND m.left_at IS NULL
		  ) live ON true
		  LEFT JOIN study_group_members me
		         ON me.group_id = g.id AND me.student_id = $1 AND me.left_at IS NULL
		 WHERE g.section_id = $2
		 ORDER BY g.is_open DESC, g.created_at DESC
		 LIMIT 200`,
		[]any{room.StudentID, room.SectionID},
		func(rows pgx.Rows) (studyGroup, error) {
			var v studyGroup
			return v, rows.Scan(&v.ID, &v.Name, &v.Topic, &v.Subject, &v.MeetsWhen,
				&v.Venue, &v.Capacity, &v.Open, &v.Organiser, &v.Mine, &v.Members,
				&v.Tutors, &v.Joined, &v.MyRole, &v.HasSpace, &v.Created)
		})
	respond(w, r, items, err)
}

type studyGroupRequest struct {
	StudentID      string `json:"student_id,omitempty"`
	Name           string `json:"name"`
	Topic          string `json:"topic,omitempty"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	MeetsWhen      string `json:"meets_when,omitempty"`
	Venue          string `json:"venue,omitempty"`
	Capacity       int    `json:"capacity,omitempty"`
	// Offering to teach rather than to revise. It is the only difference
	// between peer tutoring and a study group, so it is one flag.
	Tutoring bool `json:"offering_tutoring,omitempty"`
}

// createStudyGroup opens a group in the caller's own section and puts them in
// it, because a group whose organiser is not a member is one nobody attends.
func (s *Server) createStudyGroup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req studyGroupRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	res, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	_ = res
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.Error(w, r, http.StatusConflict, "not_enrolled",
			"you need an enrolment before you can start a group")
		return
	}
	var subject *uuid.UUID
	if v := strings.TrimSpace(req.ClassSubjectID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "class_subject_id must be a uuid")
			return
		}
		subject = &parsed
	}
	var capacity *int
	if req.Capacity > 0 {
		capacity = &req.Capacity
	}
	role := "member"
	if req.Tutoring {
		role = "tutor"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The subject has to belong to the child's own class, or a group filed
		// under Grade 12 Physics would appear on a Grade 6 subject filter.
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO study_groups
			    (institution_id, section_id, class_subject_id, organiser_id,
			     name, topic, meets_when, venue, capacity)
			SELECT $1, $2,
			       (SELECT cs.id FROM class_subjects cs
			         WHERE cs.id = $3 AND cs.class_id = $10),
			       $4, btrim($5), $6, $7, $8, $9
			RETURNING id::text`,
			id.InstitutionID, room.SectionID, subject, student, req.Name,
			nullString(req.Topic), nullString(req.MeetsWhen), nullString(req.Venue),
			capacity, room.ClassID).Scan(&newID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO study_group_members (institution_id, group_id, student_id, role)
			VALUES ($1, $2, $3, $4)`, id.InstitutionID, newID, student, role)
		return err
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_exists",
			"your class already has an open group by that name")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "role": role})
}

type studyGroupMember struct {
	StudentID string `json:"student_id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	JoinedOn  string `json:"joined_on"`
}

/*
listStudyGroupMembers returns the roster of a group the caller is in.

	Membership is the authorisation. A child who has not joined gets 404 rather
	than an empty list, because "this group exists and here is nobody" and "you
	may not see who is in this group" are different answers and only one of them
	is true.
*/
func (s *Server) listStudyGroupMembers(w http.ResponseWriter, r *http.Request) {
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	groupID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	items, err := collect(s, r, `
		SELECT m.student_id::text, concat_ws(' ', st.first_name, st.last_name),
		       m.role, to_char(m.joined_at,'YYYY-MM-DD')
		  FROM study_group_members m
		  JOIN students st ON st.id = m.student_id
		 WHERE m.group_id = $1 AND m.left_at IS NULL
		   AND EXISTS (SELECT 1 FROM study_group_members mine
		                WHERE mine.group_id = $1 AND mine.student_id = $2
		                  AND mine.left_at IS NULL)
		 ORDER BY m.role, st.first_name`,
		[]any{groupID, student},
		func(rows pgx.Rows) (studyGroupMember, error) {
			var v studyGroupMember
			return v, rows.Scan(&v.StudentID, &v.Name, &v.Role, &v.JoinedOn)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(items) == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type joinRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Tutoring  bool   `json:"offering_tutoring,omitempty"`
}

/*
joinStudyGroup signs the caller up, if the group is open, in their own section
and not already full.

	All three conditions are in the INSERT rather than checked first: two
	children tapping Join on the last seat at the same moment would both pass a
	separate SELECT and both be admitted.
*/
func (s *Server) joinStudyGroup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req joinRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	groupID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	role := "member"
	if req.Tutoring {
		role = "tutor"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO study_group_members (institution_id, group_id, student_id, role)
			SELECT $1, g.id, $3, $5
			  FROM study_groups g
			 WHERE g.id = $2 AND g.section_id = $4 AND g.is_open
			   AND (g.capacity IS NULL
			        OR (SELECT count(*) FROM study_group_members m
			             WHERE m.group_id = g.id AND m.left_at IS NULL) < g.capacity)
			RETURNING id::text`,
			id.InstitutionID, groupID, student, room.SectionID, role).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_joined",
			"you are already in that group")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// Closed, full, or another section's. All three are the same answer to
		// the child: there is no seat here for you.
		httpx.Error(w, r, http.StatusConflict, "unavailable",
			"that group is closed, full, or not one your class can join")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "role": role})
}

// leaveStudyGroup marks the membership ended rather than deleting it, so the
// record that the tutoring happened survives the child changing their mind.
func (s *Server) leaveStudyGroup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req joinRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	groupID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var left string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE study_group_members
			   SET left_at = now()
			 WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL
			RETURNING to_char(left_at,'YYYY-MM-DD"T"HH24:MI')`,
			groupID, student).Scan(&left)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "not_a_member",
			"you are not in that group")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"left_at": left})
}

// --- portfolio ---------------------------------------------------------------

type portfolioItem struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Subject     *string `json:"subject,omitempty"`
	SubjectID   *string `json:"subject_id,omitempty"`
	HappenedOn  *string `json:"happened_on,omitempty"`
	URL         *string `json:"evidence_url,omitempty"`
	FileID      *string `json:"file_id,omitempty"`
	Shared      bool    `json:"is_shared"`
	AddedOn     string  `json:"added_on"`
}

// portfolioAward is what the school awarded, shown beside what the child
// entered and never merged with it: a university reading the portfolio is
// entitled to know which claims the school stands behind.
type portfolioAward struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Level     *string `json:"level,omitempty"`
	Position  *string `json:"position,omitempty"`
	AwardedOn *string `json:"awarded_on,omitempty"`
	Detail    *string `json:"description,omitempty"`
}

// getPortfolio powers student.learning.student_portfolio_management.
func (s *Server) getPortfolio(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	items := []portfolioItem{}
	awards := []portfolioAward{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT p.id::text, p.kind, p.title, p.description, sub.name,
			       p.subject_id::text, to_char(p.happened_on,'YYYY-MM-DD'),
			       p.evidence_url, p.file_id::text, p.is_shared,
			       to_char(p.created_at,'YYYY-MM-DD')
			  FROM student_portfolio_items p
			  LEFT JOIN subjects sub ON sub.id = p.subject_id
			 WHERE p.student_id = $1
			 ORDER BY p.happened_on DESC NULLS LAST, p.created_at DESC`, student)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v portfolioItem
			if err := rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Description, &v.Subject,
				&v.SubjectID, &v.HappenedOn, &v.URL, &v.FileID, &v.Shared,
				&v.AddedOn); err != nil {
				rows.Close()
				return err
			}
			items = append(items, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		rows, err = tx.Query(r.Context(), `
			SELECT a.id::text, a.kind, a.title, a.level, a.position,
			       to_char(a.awarded_on,'YYYY-MM-DD'), a.description
			  FROM student_achievements a
			 WHERE a.student_id = $1
			 ORDER BY a.awarded_on DESC NULLS LAST`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v portfolioAward
			if err := rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Level, &v.Position,
				&v.AwardedOn, &v.Detail); err != nil {
				return err
			}
			awards = append(awards, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(),
		"items":      items, "school_awards": awards,
	})
}

type portfolioRequest struct {
	StudentID   string `json:"student_id,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	SubjectID   string `json:"subject_id,omitempty"`
	HappenedOn  string `json:"happened_on,omitempty"`
	EvidenceURL string `json:"evidence_url,omitempty"`
	Shared      bool   `json:"is_shared,omitempty"`
}

func (s *Server) addPortfolioItem(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req portfolioRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "title is required")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = "project"
	}
	on, err := optionalDate(req.HappenedOn)
	if err != nil {
		httpx.BadRequest(w, r, "happened_on must be YYYY-MM-DD")
		return
	}
	subject, err := optionalUUID(req.SubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "subject_id must be a uuid")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_portfolio_items
			    (institution_id, student_id, kind, title, description, subject_id,
			     happened_on, evidence_url, is_shared)
			VALUES ($1, $2, $3, btrim($4), $5, $6, $7, $8, $9)
			RETURNING id::text`,
			id.InstitutionID, student, kind, req.Title, nullString(req.Description),
			subject, on, nullString(req.EvidenceURL), req.Shared).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_added",
			"that entry is already in your portfolio")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// updatePortfolioItem edits an entry, narrowed by student_id so the id in the
// path cannot reach another child's portfolio.
func (s *Server) updatePortfolioItem(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req portfolioRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	itemID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	on, err := optionalDate(req.HappenedOn)
	if err != nil {
		httpx.BadRequest(w, r, "happened_on must be YYYY-MM-DD")
		return
	}
	subject, err := optionalUUID(req.SubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "subject_id must be a uuid")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE student_portfolio_items
			   SET kind        = COALESCE(nullif(btrim($3), ''), kind),
			       title       = COALESCE(nullif(btrim($4), ''), title),
			       description = $5,
			       subject_id  = $6,
			       happened_on = $7,
			       evidence_url = $8,
			       is_shared   = $9,
			       updated_at  = now()
			 WHERE id = $1 AND student_id = $2
			RETURNING id::text`,
			itemID, student, req.Kind, req.Title, nullString(req.Description),
			subject, on, nullString(req.EvidenceURL), req.Shared).Scan(&out)
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

func (s *Server) deletePortfolioItem(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	itemID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var gone string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			DELETE FROM student_portfolio_items
			 WHERE id = $1 AND student_id = $2
			RETURNING id::text`, itemID, student).Scan(&gone)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": gone})
}

// --- global university guidance ----------------------------------------------

type universityEntry struct {
	ID             string  `json:"id"`
	University     string  `json:"university"`
	Country        string  `json:"country"`
	Course         *string `json:"course,omitempty"`
	Intake         *string `json:"intake,omitempty"`
	Deadline       *string `json:"application_deadline,omitempty"`
	EntranceExams  *string `json:"entrance_exams,omitempty"`
	AnnualFeePaise *int64  `json:"annual_fee_paise,omitempty"`
	Scholarship    bool    `json:"scholarship_sought"`
	Status         string  `json:"status"`
	Notes          *string `json:"notes,omitempty"`
	// Counted in the database rather than in the browser: a phone whose clock
	// is a week out would quietly move a deadline, and the deadline is the
	// entire point of the screen.
	DaysToDeadline *int   `json:"days_to_deadline,omitempty"`
	AddedOn        string `json:"added_on"`
}

/*
listUniversityShortlist powers student.learning.global_university_guidance_counselor.

	Ordered by what closes next rather than by name. Indian families lose places
	to the closing date far more often than to the essay, and a list that puts
	the nearest deadline at the top is most of the guidance a school can
	actually give.
*/
func (s *Server) listUniversityShortlist(w http.ResponseWriter, r *http.Request) {
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT u.id::text, u.university, u.country, u.course, u.intake,
		       to_char(u.application_deadline,'YYYY-MM-DD'), u.entrance_exams,
		       u.annual_fee_paise, u.scholarship_sought, u.status, u.notes,
		       (u.application_deadline - CURRENT_DATE)::int,
		       to_char(u.created_at,'YYYY-MM-DD')
		  FROM university_shortlist_entries u
		 WHERE u.student_id = $1
		 ORDER BY u.application_deadline ASC NULLS LAST, u.university`,
		[]any{student},
		func(rows pgx.Rows) (universityEntry, error) {
			var v universityEntry
			return v, rows.Scan(&v.ID, &v.University, &v.Country, &v.Course, &v.Intake,
				&v.Deadline, &v.EntranceExams, &v.AnnualFeePaise, &v.Scholarship,
				&v.Status, &v.Notes, &v.DaysToDeadline, &v.AddedOn)
		})
	respond(w, r, items, err)
}

type universityRequest struct {
	StudentID      string `json:"student_id,omitempty"`
	University     string `json:"university"`
	Country        string `json:"country"`
	Course         string `json:"course,omitempty"`
	Intake         string `json:"intake,omitempty"`
	Deadline       string `json:"application_deadline,omitempty"`
	EntranceExams  string `json:"entrance_exams,omitempty"`
	AnnualFeePaise int64  `json:"annual_fee_paise,omitempty"`
	Scholarship    bool   `json:"scholarship_sought,omitempty"`
	Status         string `json:"status,omitempty"`
	Notes          string `json:"notes,omitempty"`
}

func (s *Server) addUniversityEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req universityRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.University) == "" || strings.TrimSpace(req.Country) == "" {
		httpx.BadRequest(w, r, "university and country are required")
		return
	}
	deadline, err := optionalDate(req.Deadline)
	if err != nil {
		httpx.BadRequest(w, r, "application_deadline must be YYYY-MM-DD")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "researching"
	}
	var fee *int64
	if req.AnnualFeePaise > 0 {
		fee = &req.AnnualFeePaise
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO university_shortlist_entries
			    (institution_id, student_id, university, country, course, intake,
			     application_deadline, entrance_exams, annual_fee_paise,
			     scholarship_sought, status, notes)
			VALUES ($1, $2, btrim($3), btrim($4), $5, $6, $7, $8, $9, $10, $11, $12)
			RETURNING id::text`,
			id.InstitutionID, student, req.University, req.Country,
			nullString(req.Course), nullString(req.Intake), deadline,
			nullString(req.EntranceExams), fee, req.Scholarship, status,
			nullString(req.Notes)).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_shortlisted",
			"that university and course are already on your list")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// updateUniversityEntry moves an application along the pipeline. Every field is
// optional: the common edit is a status and nothing else, and requiring the
// whole row would have the screen post back stale values it never showed.
func (s *Server) updateUniversityEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req universityRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	entryID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	deadline, err := optionalDate(req.Deadline)
	if err != nil {
		httpx.BadRequest(w, r, "application_deadline must be YYYY-MM-DD")
		return
	}

	var out, status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE university_shortlist_entries
			   SET status = COALESCE(nullif(btrim($3), ''), status),
			       course = COALESCE(nullif(btrim($4), ''), course),
			       intake = COALESCE(nullif(btrim($5), ''), intake),
			       application_deadline = COALESCE($6, application_deadline),
			       entrance_exams = COALESCE(nullif(btrim($7), ''), entrance_exams),
			       annual_fee_paise = COALESCE(nullif($8, 0), annual_fee_paise),
			       scholarship_sought = $9,
			       notes = COALESCE(nullif(btrim($10), ''), notes),
			       updated_at = now()
			 WHERE id = $1 AND student_id = $2
			RETURNING id::text, status`,
			entryID, student, req.Status, req.Course, req.Intake, deadline,
			req.EntranceExams, req.AnnualFeePaise, req.Scholarship,
			req.Notes).Scan(&out, &status)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": status})
}

func (s *Server) deleteUniversityEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	entryID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var gone string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			DELETE FROM university_shortlist_entries
			 WHERE id = $1 AND student_id = $2
			RETURNING id::text`, entryID, student).Scan(&gone)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": gone})
}

// --- lost and found ----------------------------------------------------------

type lostFoundItem struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Category    *string `json:"category,omitempty"`
	Place       *string `json:"place,omitempty"`
	OnDate      string  `json:"on_date"`
	Reporter    string  `json:"reported_by"`
	// The reporter's class rather than their phone number. Enough to find them
	// at break, and nothing a stranger could use off campus.
	ReporterClass *string `json:"reporter_class,omitempty"`
	Status        string  `json:"status"`
	Mine          bool    `json:"reported_by_me"`
	ResolvedOn    *string `json:"resolved_on,omitempty"`
	Resolution    *string `json:"resolution_note,omitempty"`
}

/*
listLostFound powers student.campus_life.lost_found_item_board.

	Campus-wide, not class-wide. A bottle left in the hall is picked up by
	whoever walks past it, and a board only the owner's own section could read
	would never reunite anything with anyone.
*/
func (s *Server) listLostFound(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	kind := nullString(strings.TrimSpace(r.URL.Query().Get("kind")))
	// Open items are the working set; the rest is history the board keeps so
	// an owner can see their bag was already returned to someone.
	status := nullString(strings.TrimSpace(r.URL.Query().Get("status")))
	items, err := collect(s, r, `
		SELECT lf.id::text, lf.kind, lf.title, lf.description, lf.category,
		       lf.place, to_char(lf.on_date,'YYYY-MM-DD'), u.full_name,
		       CASE WHEN rs.id IS NOT NULL
		            THEN concat_ws('-', cl.name, sec.name) END,
		       lf.status, lf.reported_by = $2,
		       to_char(lf.resolved_at,'YYYY-MM-DD'), lf.resolution_note
		  FROM lost_found_items lf
		  JOIN users u ON u.id = lf.reported_by
		  LEFT JOIN students rs ON rs.id = lf.reporter_student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = rs.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  cl  ON cl.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE lf.campus_id = $1
		   AND ($3::text IS NULL OR lf.kind = $3)
		   AND ($4::text IS NULL OR lf.status = $4)
		 ORDER BY (lf.status = 'open') DESC, lf.on_date DESC, lf.created_at DESC
		 LIMIT 300`,
		[]any{room.CampusID, id.UserID, kind, status},
		func(rows pgx.Rows) (lostFoundItem, error) {
			var v lostFoundItem
			return v, rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Description, &v.Category,
				&v.Place, &v.OnDate, &v.Reporter, &v.ReporterClass, &v.Status,
				&v.Mine, &v.ResolvedOn, &v.Resolution)
		})
	respond(w, r, items, err)
}

type lostFoundRequest struct {
	StudentID   string `json:"student_id,omitempty"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Category    string `json:"category,omitempty"`
	Place       string `json:"place,omitempty"`
	OnDate      string `json:"on_date,omitempty"`
}

func (s *Server) reportLostFound(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req lostFoundRequest
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
			"you need an enrolment before you can post to the board")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind != "lost" && kind != "found" {
		httpx.BadRequest(w, r, "kind must be lost or found")
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "title is required")
		return
	}
	on, err := optionalDate(req.OnDate)
	if err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	if on == nil {
		today := nowInIndia().Format(time.DateOnly)
		on = &today
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO lost_found_items
			    (institution_id, campus_id, kind, title, description, category,
			     place, on_date, reported_by, reporter_student_id)
			VALUES ($1, $2, $3, btrim($4), $5, $6, $7, $8::date, $9, $10)
			RETURNING id::text`,
			id.InstitutionID, room.CampusID, kind, req.Title,
			nullString(req.Description), nullString(req.Category),
			nullString(req.Place), on, id.UserID, student).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

type resolveRequest struct {
	Status string `json:"status,omitempty"`
	Note   string `json:"note,omitempty"`
}

/*
resolveLostFound closes a notice.

	The person who posted it can close their own, and the front desk can close
	anyone's — the office is where the unclaimed umbrellas actually end up. A
	third child cannot, because marking someone else's notice returned is how a
	board stops being believed.
*/
func (s *Server) resolveLostFound(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req resolveRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	itemID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "returned"
	}
	if status != "returned" && status != "closed" && status != "claimed" {
		httpx.BadRequest(w, r, "status must be claimed, returned or closed")
		return
	}
	// 'claimed' is still an open state: someone has said the bag is theirs and
	// has not collected it yet, so the resolution columns stay empty.
	staff := id.Can(rbac.FrontDeskWrite)

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE lost_found_items
			   SET status = $3,
			       resolved_at = CASE WHEN $3 IN ('returned','closed') THEN now() END,
			       resolved_by = CASE WHEN $3 IN ('returned','closed') THEN $4::uuid END,
			       resolution_note = COALESCE(nullif(btrim($5), ''), resolution_note)
			 WHERE id = $1
			   AND status IN ('open','claimed')
			   AND (reported_by = $2 OR $6)
			RETURNING id::text`,
			itemID, id.UserID, status, id.UserID, req.Note, staff).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Not theirs, or already settled. Both are "there is nothing here for
		// you to close".
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": status})
}

// --- digital locker ----------------------------------------------------------

type lockerAccess struct {
	Action     string  `json:"action"`
	HappenedAt string  `json:"happened_at"`
	Actor      *string `json:"actor,omitempty"`
	Note       *string `json:"note,omitempty"`
}

/*
getMyLocker powers student.campus_life.digital_locker_combination_access_log.

	Deliberately never carries the combination. The child who has forgotten it
	asks for it explicitly through reveal, which writes the row that makes the
	lookup accountable; putting it in this response would mean the log recorded
	a view every time the screen was opened, and a log that fires on page load
	tells you nothing about who actually read the number.

	No locker allotted is answered 200 with assigned=false rather than 404: the
	screen has something true to say, and a bare GET that 404s reads as broken.
*/
func (s *Server) getMyLocker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	var (
		lockerID         *string
		number, location *string
		assignedOn       *string
		hasCombination   bool
	)
	log := []lockerAccess{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT l.id::text, l.locker_no, l.location,
			       to_char(l.assigned_on,'YYYY-MM-DD'),
			       l.combination IS NOT NULL
			  FROM student_lockers l
			 WHERE l.student_id = $1 AND l.released_on IS NULL`, student).
			Scan(&lockerID, &number, &location, &assignedOn, &hasCombination)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT ev.action, to_char(ev.happened_at,'YYYY-MM-DD"T"HH24:MI'),
			       u.full_name, ev.note
			  FROM locker_access_events ev
			  LEFT JOIN users u ON u.id = ev.actor_user_id
			 WHERE ev.locker_id = $1::uuid
			 ORDER BY ev.happened_at DESC
			 LIMIT 100`, lockerID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v lockerAccess
			if err := rows.Scan(&v.Action, &v.HappenedAt, &v.Actor, &v.Note); err != nil {
				return err
			}
			log = append(log, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(),
		"assigned":   lockerID != nil,
		"locker_id":  lockerID, "locker_no": number, "location": location,
		"assigned_on": assignedOn, "has_combination": hasCombination,
		"access_log": log,
	})
}

/*
revealLockerCombination hands the number back and records that it was asked for.

	The write is the point. A locker forced open is discovered eventually; a
	combination quietly looked up by somebody who should not have it leaves no
	trace at all unless the lookup itself is an event. The insert therefore runs
	in the same transaction as the read, so there is no path that returns the
	number without logging it.
*/
func (s *Server) revealLockerCombination(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req joinRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}

	var lockerID, number string
	var combination *string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT id::text, locker_no, combination
			  FROM student_lockers
			 WHERE student_id = $1 AND released_on IS NULL`, student).
			Scan(&lockerID, &number, &combination); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO locker_access_events
			    (institution_id, locker_id, student_id, actor_user_id, action)
			VALUES ($1, $2, $3, $4, 'combination_viewed')`,
			id.InstitutionID, lockerID, student, id.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"locker_no": number, "combination": combination,
	})
}

type lockerAccessRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Action    string `json:"action"`
	Note      string `json:"note,omitempty"`
}

// logLockerAccess records the child opening, shutting or reporting their locker.
//
// combination_viewed is not accepted here: that row is written by reveal and
// nowhere else, so it cannot be forged by a client that wants the log to look
// tidier than it was.
func (s *Server) logLockerAccess(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req lockerAccessRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	action := strings.TrimSpace(req.Action)
	switch action {
	case "opened", "closed", "reported_jammed", "reported_tampered":
	default:
		httpx.BadRequest(w, r,
			"action must be opened, closed, reported_jammed or reported_tampered")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO locker_access_events
			    (institution_id, locker_id, student_id, actor_user_id, action, note)
			SELECT $1, l.id, $2, $3, $4, $5
			  FROM student_lockers l
			 WHERE l.student_id = $2 AND l.released_on IS NULL
			RETURNING id::text`,
			id.InstitutionID, student, id.UserID, action,
			nullString(req.Note)).Scan(&newID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "action": action})
}

type assignLockerRequest struct {
	StudentID   string `json:"student_id"`
	LockerNo    string `json:"locker_no"`
	Location    string `json:"location,omitempty"`
	Combination string `json:"combination,omitempty"`
}

// assignLocker allots a locker. The office's act, not the child's: a student
// who could allot their own would take the one next to their friend, and the
// combination they set would be one the school never issued.
func (s *Server) assignLocker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req assignLockerRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.LockerNo) == "" {
		httpx.BadRequest(w, r, "locker_no is required")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_lockers
			    (institution_id, campus_id, locker_no, location, student_id,
			     combination, assigned_on)
			SELECT $1, st.campus_id, btrim($3), $4, st.id, $5, CURRENT_DATE
			  FROM students st WHERE st.id = $2
			ON CONFLICT (institution_id, campus_id, lower(btrim(locker_no)))
			DO UPDATE SET student_id  = EXCLUDED.student_id,
			              location    = COALESCE(EXCLUDED.location, student_lockers.location),
			              combination = COALESCE(EXCLUDED.combination, student_lockers.combination),
			              assigned_on = CURRENT_DATE,
			              released_on = NULL
			RETURNING id::text`,
			id.InstitutionID, student, req.LockerNo, nullString(req.Location),
			nullString(req.Combination)).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_allotted",
			"that student already holds a locker; release it first")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- club events and ticketing -----------------------------------------------

type clubEvent struct {
	ID          string  `json:"id"`
	Club        string  `json:"club_name"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Venue       *string `json:"venue,omitempty"`
	StartsAt    string  `json:"starts_at"`
	EndsAt      *string `json:"ends_at,omitempty"`
	Capacity    *int    `json:"capacity,omitempty"`
	PricePaise  int64   `json:"ticket_price_paise"`
	ClosesAt    *string `json:"booking_closes_at,omitempty"`
	Status      string  `json:"status"`
	Booked      int     `json:"tickets_booked"`
	SeatsLeft   *int    `json:"seats_left,omitempty"`
	// The caller's own ticket, if they have one. The code travels with it
	// because the screen is the pass.
	TicketID     *string `json:"ticket_id,omitempty"`
	TicketCode   *string `json:"ticket_code,omitempty"`
	TicketStatus *string `json:"ticket_status,omitempty"`
	CheckedInAt  *string `json:"checked_in_at,omitempty"`
	CanBook      bool    `json:"can_book"`
}

/*
listClubEvents powers student.campus_life.student_club_event_ticketing_qr_check_in.

	Narrowed to the child's own class level rather than to their section: a club
	is a school-wide thing and relisting every section each year is how the
	targeting stops being maintained. A senior debate does not appear on a
	Grade 6 screen because the levels do not overlap, not because somebody
	remembered to exclude them.
*/
func (s *Server) listClubEvents(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT ev.id::text, ev.club_name, ev.title, ev.description, ev.venue,
		       to_char(ev.starts_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(ev.ends_at,'YYYY-MM-DD"T"HH24:MI'),
		       ev.capacity, ev.ticket_price_paise,
		       to_char(ev.booking_closes_at,'YYYY-MM-DD"T"HH24:MI'),
		       ev.status, live.booked,
		       CASE WHEN ev.capacity IS NOT NULL
		            THEN greatest(ev.capacity - live.booked, 0) END,
		       t.id::text, t.code, t.status,
		       to_char(t.checked_in_at,'YYYY-MM-DD"T"HH24:MI'),
		       ev.status = 'open'
		         AND (ev.booking_closes_at IS NULL OR ev.booking_closes_at > now())
		         AND ev.starts_at > now()
		         AND (ev.capacity IS NULL OR live.booked < ev.capacity)
		         AND t.id IS NULL
		  FROM club_events ev
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS booked FROM club_event_tickets ct
		       WHERE ct.event_id = ev.id AND ct.status <> 'cancelled'
		  ) live ON true
		  LEFT JOIN club_event_tickets t
		         ON t.event_id = ev.id AND t.student_id = $2 AND t.status <> 'cancelled'
		 WHERE ev.campus_id = $1
		   AND ev.status <> 'draft'
		   AND (ev.min_class_level IS NULL OR ev.min_class_level <= $3)
		   AND (ev.max_class_level IS NULL OR ev.max_class_level >= $3)
		 ORDER BY ev.starts_at
		 LIMIT 200`,
		[]any{room.CampusID, room.StudentID, room.Level},
		func(rows pgx.Rows) (clubEvent, error) {
			var v clubEvent
			return v, rows.Scan(&v.ID, &v.Club, &v.Title, &v.Description, &v.Venue,
				&v.StartsAt, &v.EndsAt, &v.Capacity, &v.PricePaise, &v.ClosesAt,
				&v.Status, &v.Booked, &v.SeatsLeft, &v.TicketID, &v.TicketCode,
				&v.TicketStatus, &v.CheckedInAt, &v.CanBook)
		})
	respond(w, r, items, err)
}

/*
ticketCode returns the eight characters the door reads.

	crypto/rand and not math/rand, for the same reason the pickup pass uses it:
	the thing being controlled is physical entry to a room, and a predictable
	sequence would let anyone who saw one ticket produce the next.

	The alphabet excludes I, O, 0 and 1. A child reads this off a screen to a
	prefect holding a clipboard when the scanner will not focus, and those four
	are the characters that get read back wrong.
*/
func ticketCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, 8)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}

/*
bookEventTicket claims a seat.

	Eligibility, capacity and the booking window are all conditions on the
	INSERT rather than a SELECT followed by a write: two children tapping Book
	on the last seat would each pass their own check and the hall would be
	oversold by one.
*/
func (s *Server) bookEventTicket(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req joinRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	eventID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	code, err := ticketCode()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO club_event_tickets
			    (institution_id, event_id, student_id, code)
			SELECT $1, ev.id, $3, $4
			  FROM club_events ev
			 WHERE ev.id = $2
			   AND ev.campus_id = $5
			   AND ev.status = 'open'
			   AND ev.starts_at > now()
			   AND (ev.booking_closes_at IS NULL OR ev.booking_closes_at > now())
			   AND (ev.min_class_level IS NULL OR ev.min_class_level <= $6)
			   AND (ev.max_class_level IS NULL OR ev.max_class_level >= $6)
			   AND (ev.capacity IS NULL
			        OR (SELECT count(*) FROM club_event_tickets ct
			             WHERE ct.event_id = ev.id AND ct.status <> 'cancelled')
			            < ev.capacity)
			RETURNING id::text`,
			id.InstitutionID, eventID, student, code, room.CampusID,
			room.Level).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_booked",
			"you already have a ticket for that event")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "unavailable",
			"that event is full, closed, or not open to your class")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "code": code})
}

// cancelEventTicket gives the seat back, and only before it has been used: a
// checked-in ticket is the record that the child was in the room, and letting
// them erase it would leave the hall's own headcount unaccounted for.
func (s *Server) cancelEventTicket(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req joinRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	res, _, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	ticketID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE club_event_tickets
			   SET status = 'cancelled', cancelled_at = now()
			 WHERE id = $1 AND student_id = ANY($2) AND status = 'booked'
			RETURNING id::text`, ticketID, res.StudentIDs).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "not_cancellable",
			"that ticket is not yours, or has already been used or cancelled")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": "cancelled"})
}

type checkInRequest struct {
	Code string `json:"code"`
}

/*
checkInEventTicket is the scan at the door.

	Staff only, and gated on the front desk permission rather than on the
	child's own scope: a guest who could mark their own ticket used is a guest
	who can let a friend in on the same code. The same reasoning as the pickup
	pass, and enforced the same way.

	Marking an already-used ticket is a conflict rather than a no-op, because
	the prefect on the door needs to be told this code has already walked
	through.
*/
func (s *Server) checkInEventTicket(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req checkInRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	if code == "" {
		httpx.BadRequest(w, r, "code is required")
		return
	}

	var student, event, title string
	var already bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.last_name), ev.club_name, ev.title,
			       ct.status <> 'booked'
			  FROM club_event_tickets ct
			  JOIN students    st ON st.id = ct.student_id
			  JOIN club_events ev ON ev.id = ct.event_id
			 WHERE ct.code = $1`, code).Scan(&student, &event, &title, &already); err != nil {
			return err
		}
		if already {
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE club_event_tickets
			   SET status = 'checked_in', checked_in_at = now(), checked_in_by = $2
			 WHERE code = $1 AND status = 'booked'`, code, id.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if already {
		httpx.Error(w, r, http.StatusConflict, "already_used",
			fmt.Sprintf("that code has already been used or cancelled (%s)", student))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_name": student, "club_name": event, "title": title,
		"status": "checked_in",
	})
}

type clubEventRequest struct {
	ClubName        string `json:"club_name"`
	Title           string `json:"title"`
	Description     string `json:"description,omitempty"`
	Venue           string `json:"venue,omitempty"`
	StartsAt        string `json:"starts_at"`
	EndsAt          string `json:"ends_at,omitempty"`
	Capacity        int    `json:"capacity,omitempty"`
	PricePaise      int64  `json:"ticket_price_paise,omitempty"`
	BookingClosesAt string `json:"booking_closes_at,omitempty"`
	MinClassLevel   int    `json:"min_class_level,omitempty"`
	MaxClassLevel   int    `json:"max_class_level,omitempty"`
	CampusID        string `json:"campus_id,omitempty"`
}

// createClubEvent puts a club night on the board. A staff act: a child who
// could create events could create one with a capacity of one and take the
// hall out of circulation.
func (s *Server) createClubEvent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req clubEventRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ClubName) == "" || strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "club_name and title are required")
		return
	}
	starts, err := time.Parse(time.RFC3339, strings.TrimSpace(req.StartsAt))
	if err != nil {
		httpx.BadRequest(w, r, "starts_at must be RFC3339, for example 2026-09-01T16:00:00+05:30")
		return
	}
	var ends, closes *time.Time
	if v := strings.TrimSpace(req.EndsAt); v != "" {
		parsed, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.BadRequest(w, r, "ends_at must be RFC3339")
			return
		}
		ends = &parsed
	}
	if v := strings.TrimSpace(req.BookingClosesAt); v != "" {
		parsed, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.BadRequest(w, r, "booking_closes_at must be RFC3339")
			return
		}
		closes = &parsed
	}
	campus, err := optionalUUID(req.CampusID)
	if err != nil {
		httpx.BadRequest(w, r, "campus_id must be a uuid")
		return
	}
	var capacity, minLevel, maxLevel *int
	if req.Capacity > 0 {
		capacity = &req.Capacity
	}
	if req.MinClassLevel > 0 {
		minLevel = &req.MinClassLevel
	}
	if req.MaxClassLevel > 0 {
		maxLevel = &req.MaxClassLevel
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO club_events
			    (institution_id, campus_id, club_name, title, description, venue,
			     starts_at, ends_at, capacity, ticket_price_paise,
			     booking_closes_at, min_class_level, max_class_level, created_by)
			SELECT $1,
			       -- A single-campus school should not have to name its campus
			       -- on every form, so an omitted one resolves to the only one.
			       COALESCE($2, (SELECT c.id FROM campuses c
			                      WHERE c.institution_id = $1
			                      ORDER BY c.created_at LIMIT 1)),
			       btrim($3), btrim($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
			RETURNING id::text`,
			id.InstitutionID, campus, req.ClubName, req.Title,
			nullString(req.Description), nullString(req.Venue), starts, ends,
			capacity, req.PricePaise, closes, minLevel, maxLevel,
			id.UserID).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_listed",
			"that club already has an event by that name at that time")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- the class calendar ------------------------------------------------------

type calendarEntry struct {
	Date     string  `json:"on_date"`
	ToDate   *string `json:"to_date,omitempty"`
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	Detail   *string `json:"detail,omitempty"`
	Source   string  `json:"source"`
	AllDay   bool    `json:"all_day"`
	StartsAt *string `json:"starts_at,omitempty"`
}

/*
getStudentCalendar powers student.notices_calendar.calendar.

	One dated list assembled from the four tables that already hold the school's
	year, narrowed to this child's class: terms are the academic frame, holidays
	carry closures and school events alike, exam_subjects carries the papers
	their own class sits, and club_events carries what their year group may
	attend. Nothing here is stored twice — a calendar table would be the copy
	that disagreed with the exam timetable the day it moved.

	The exam papers are the reason this cannot be a school-wide feed. Grade 6-A
	sitting Grade 9's mathematics paper on their calendar is not a cosmetic
	problem: children revise from it.

	The default window is the child's own academic year, so a bare GET answers
	"what does my year look like" rather than 400.
*/
func (s *Server) getStudentCalendar(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	from := nullString(strings.TrimSpace(r.URL.Query().Get("from")))
	to := nullString(strings.TrimSpace(r.URL.Query().Get("to")))

	items, err := collect(s, r, `
		WITH bounds AS (
		    SELECT COALESCE($4::date, ay.starts_on) AS from_date,
		           COALESCE($5::date, ay.ends_on)   AS to_date
		      FROM academic_years ay WHERE ay.id = $3
		)
		SELECT * FROM (
		    -- The academic frame.
		    SELECT to_char(t.starts_on,'YYYY-MM-DD') AS on_date,
		           to_char(t.ends_on,'YYYY-MM-DD')   AS to_date,
		           'term'::text AS kind, t.name AS title,
		           NULL::text AS detail, 'terms'::text AS source,
		           true AS all_day, NULL::text AS starts_at
		      FROM terms t, bounds b
		     WHERE t.academic_year_id = $3
		       AND t.starts_on <= b.to_date AND t.ends_on >= b.from_date

		    UNION ALL

		    -- Closures, vacations, parent evenings and whole-school events.
		    -- applies_to 'staff' is excluded: a staff development day the
		    -- children still attend is not their holiday.
		    SELECT to_char(h.on_date,'YYYY-MM-DD'),
		           to_char(h.to_date,'YYYY-MM-DD'),
		           h.kind, h.name, h.description, 'holidays', true, NULL
		      FROM holidays h, bounds b
		     WHERE h.on_date BETWEEN b.from_date AND b.to_date
		       AND h.applies_to IN ('all','students')
		       AND (h.campus_id IS NULL OR h.campus_id = $2)
		       AND (h.academic_year_id IS NULL OR h.academic_year_id = $3)

		    UNION ALL

		    -- The papers this child's own class sits, and only those.
		    SELECT to_char(es.exam_date,'YYYY-MM-DD'), NULL,
		           'exam', ex.name || ' — ' || sub.name,
		           concat_ws(' · ',
		                     nullif(to_char(es.starts_at,'HH24:MI'), ''),
		                     CASE WHEN es.duration_minutes IS NOT NULL
		                          THEN es.duration_minutes || ' min' END,
		                     'max ' || es.max_marks),
		           'exams', true, to_char(es.starts_at,'HH24:MI')
		      FROM exam_subjects es
		      JOIN exams          ex ON ex.id = es.exam_id
		      JOIN class_subjects cs ON cs.id = es.class_subject_id
		      JOIN subjects      sub ON sub.id = cs.subject_id, bounds b
		     WHERE cs.class_id = $1
		       AND es.exam_date BETWEEN b.from_date AND b.to_date

		    UNION ALL

		    -- Club nights this year group may attend.
		    SELECT to_char(ev.starts_at,'YYYY-MM-DD'), NULL,
		           'club_event', ev.club_name || ' — ' || ev.title,
		           ev.venue, 'club_events', false,
		           to_char(ev.starts_at,'HH24:MI')
		      FROM club_events ev, bounds b
		     WHERE ev.campus_id = $2
		       AND ev.status IN ('open','closed','done')
		       AND ev.starts_at::date BETWEEN b.from_date AND b.to_date
		       AND (ev.min_class_level IS NULL OR ev.min_class_level <= $6)
		       AND (ev.max_class_level IS NULL OR ev.max_class_level >= $6)
		) cal
		 ORDER BY on_date, starts_at NULLS FIRST, title`,
		[]any{room.ClassID, room.CampusID, room.YearID, from, to, room.Level},
		func(rows pgx.Rows) (calendarEntry, error) {
			var v calendarEntry
			return v, rows.Scan(&v.Date, &v.ToDate, &v.Kind, &v.Title, &v.Detail,
				&v.Source, &v.AllDay, &v.StartsAt)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": room.StudentID.String(),
		"class_name": room.ClassName, "section_name": room.SectionName,
		"items": items,
	})
}

// --- library book holds ------------------------------------------------------

type libraryTitle struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Author    *string `json:"author,omitempty"`
	Publisher *string `json:"publisher,omitempty"`
	Category  *string `json:"category,omitempty"`
	ISBN      *string `json:"isbn,omitempty"`
	Copies    int     `json:"copies"`
	OnShelf   int     `json:"copies_on_shelf"`
	Waiting   int     `json:"holds_waiting"`
	MyHold    *string `json:"my_hold_status,omitempty"`
}

// listLibraryCatalogue is the search behind the hold button. Availability is
// counted live because "2 on the shelf" is the whole reason a child decides
// whether to queue.
func (s *Server) listLibraryCatalogue(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	q := nullString(strings.TrimSpace(r.URL.Query().Get("q")))
	items, err := collect(s, r, `
		SELECT t.id::text, t.title, t.author, t.publisher, t.category, t.isbn,
		       (SELECT count(*)::int FROM library_copies c WHERE c.title_id = t.id),
		       (SELECT count(*)::int FROM library_copies c
		         WHERE c.title_id = t.id AND c.status = 'available'),
		       (SELECT count(*)::int FROM library_reservations res
		         WHERE res.title_id = t.id AND res.status = 'waiting'),
		       (SELECT res.status FROM library_reservations res
		         WHERE res.title_id = t.id AND res.student_id = $2
		           AND res.status IN ('waiting','ready') LIMIT 1)
		  FROM library_titles t
		 WHERE t.campus_id = $1
		   AND ($3::text IS NULL
		        OR t.title ILIKE '%' || $3 || '%'
		        OR t.author ILIKE '%' || $3 || '%'
		        OR t.isbn = $3)
		 ORDER BY t.title
		 LIMIT 200`,
		[]any{room.CampusID, room.StudentID, q},
		func(rows pgx.Rows) (libraryTitle, error) {
			var v libraryTitle
			return v, rows.Scan(&v.ID, &v.Title, &v.Author, &v.Publisher, &v.Category,
				&v.ISBN, &v.Copies, &v.OnShelf, &v.Waiting, &v.MyHold)
		})
	respond(w, r, items, err)
}

type myHold struct {
	ID        string  `json:"id"`
	TitleID   string  `json:"title_id"`
	Title     string  `json:"title"`
	Author    *string `json:"author,omitempty"`
	Status    string  `json:"status"`
	PlacedAt  string  `json:"placed_at"`
	Position  int     `json:"position"`
	Accession *string `json:"ready_accession_no,omitempty"`
	CollectBy *string `json:"collect_by,omitempty"`
	// Whether the child may still withdraw it, so the screen does not offer a
	// button that will 409.
	Cancellable bool `json:"cancellable"`
}

// listMyHolds reads the librarian's queue from the reader's side. The position
// is counted at read time for the same reason it is on the counter's screen: a
// stored one is wrong the moment somebody ahead cancels.
func (s *Server) listMyHolds(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []myHold{}})
		return
	}
	items, err := collect(s, r, `
		SELECT res.id::text, res.title_id::text, t.title, t.author, res.status,
		       to_char(res.placed_at,'YYYY-MM-DD"T"HH24:MI'),
		       CASE WHEN res.status = 'waiting' THEN (
		           SELECT count(*)::int + 1 FROM library_reservations q
		            WHERE q.title_id = res.title_id AND q.status = 'waiting'
		              AND q.placed_at < res.placed_at)
		            ELSE 0 END,
		       c.accession_no, to_char(res.collect_by,'YYYY-MM-DD'),
		       res.status IN ('waiting','ready')
		  FROM library_reservations res
		  JOIN library_titles t ON t.id = res.title_id
		  LEFT JOIN library_copies c ON c.id = res.ready_copy_id
		 WHERE res.student_id = ANY($1)
		 ORDER BY (res.status = 'ready') DESC, res.placed_at DESC
		 LIMIT 100`,
		[]any{res.StudentIDs},
		func(rows pgx.Rows) (myHold, error) {
			var v myHold
			return v, rows.Scan(&v.ID, &v.TitleID, &v.Title, &v.Author, &v.Status,
				&v.PlacedAt, &v.Position, &v.Accession, &v.CollectBy, &v.Cancellable)
		})
	respond(w, r, items, err)
}

type holdRequest struct {
	StudentID string `json:"student_id,omitempty"`
	TitleID   string `json:"title_id"`
}

/*
requestBookHold joins the library's existing queue.

	It does not write to library_reservations itself. placeReservation already
	claims a free copy under FOR UPDATE SKIP LOCKED, marks it reserved so the
	counter cannot issue it to a walk-in, and decides between 'ready' and
	'waiting'. A second implementation of that would be the one the counter
	disagrees with, and the disagreement would be two readers sent for the same
	physical book.

	What this adds is the only thing the librarian's endpoint cannot know: which
	reader is allowed to be named. The student id is overwritten with the
	caller's own resolved id rather than trusted from the body, so a child
	cannot queue a classmate for a book — or, worse, work out from the response
	which admission ids are real.
*/
func (s *Server) requestBookHold(w http.ResponseWriter, r *http.Request) {
	var req holdRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.TitleID) == "" {
		httpx.BadRequest(w, r, "title_id is required")
		return
	}
	body, err := json.Marshal(reservationRequest{
		TitleID: strings.TrimSpace(req.TitleID), StudentID: student.String(),
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.placeReservation(w, withJSONBody(r, body))
}

/*
cancelBookHold withdraws a hold the caller placed.

	Ownership is checked here and the state machine is left to decideReservation,
	which frees a ready copy back to the shelf and promotes whoever has waited
	longest. Doing the cancel locally would skip the promotion, and the next
	reader would sit in a queue behind a book that was already back on the rack.
*/
func (s *Server) cancelBookHold(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	holdID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	var mine bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT true FROM library_reservations
			 WHERE id = $1 AND student_id = ANY($2)`, holdID, res.StudentIDs).Scan(&mine)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	body, err := json.Marshal(reservationDecision{
		Action: "cancel", Reason: "withdrawn by the reader",
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.decideReservation(w, withJSONBody(r, body))
}

// withJSONBody returns a copy of r carrying a body this server wrote.
//
// Used where a portal handler has established who the caller may act as and
// then hands the work to the office-facing handler that owns the state machine.
// The chi routing context travels with the clone, so a {id} in the path is
// still readable by the handler being delegated to.
func withJSONBody(r *http.Request, body []byte) *http.Request {
	out := r.Clone(r.Context())
	out.Body = io.NopCloser(bytes.NewReader(body))
	out.ContentLength = int64(len(body))
	out.Header.Set("Content-Type", "application/json")
	return out
}

// --- academic record ---------------------------------------------------------

type recordYear struct {
	Year        string   `json:"academic_year"`
	ClassName   string   `json:"class_name"`
	SectionName string   `json:"section_name"`
	RollNo      *int     `json:"roll_no,omitempty"`
	Status      string   `json:"status"`
	EnrolledOn  string   `json:"enrolled_on"`
	Percentage  *float64 `json:"percentage,omitempty"`
	Grade       *string  `json:"grade,omitempty"`
	RankSection *int     `json:"rank_in_section,omitempty"`
	Attendance  *float64 `json:"attendance_percent,omitempty"`
	Remarks     *string  `json:"class_teacher_remarks,omitempty"`
	Published   bool     `json:"is_published"`
}

/*
getAcademicRecord powers student.exams_results.academic_record.

	Not this term's marks — student.exams_results.exams_grades already answers
	that, and duplicating it here would give a family two screens to disagree
	about. This is the file: which class the child sat in each year, whether
	they were promoted, what the year came to, and how much of it they attended.
	It is what a transfer certificate is copied from and what the next school
	asks for.

	Unpublished report cards contribute nothing but the enrolment row. A family
	must not read a result back before the school has released it, and the year
	still belongs in the history either way.
*/
func (s *Server) getAcademicRecord(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	years := []recordYear{}
	var (
		name, admissionNo string
		apaar             *string
		attendancePct     *float64
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, st.apaar_id,
			       (SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
			                     / nullif(count(*), 0), 1)
			          FROM student_attendance sa WHERE sa.student_id = st.id)
			  FROM students st WHERE st.id = $1`, student).
			Scan(&name, &admissionNo, &apaar, &attendancePct); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT ay.name, cl.name, sec.name, e.roll_no, e.status,
			       to_char(e.enrolled_on,'YYYY-MM-DD'),
			       rc.percentage, rc.grade, rc.rank_in_section,
			       rc.attendance_percent, rc.class_teacher_remarks,
			       COALESCE(rc.is_published, false)
			  FROM enrollments e
			  JOIN academic_years ay ON ay.id = e.academic_year_id
			  JOIN classes        cl ON cl.id = e.class_id
			  JOIN sections      sec ON sec.id = e.section_id
			  -- The annual card, not a mid-term one: term_id IS NULL is what
			  -- makes a report card the year's summary.
			  LEFT JOIN report_cards rc
			         ON rc.student_id = e.student_id
			        AND rc.academic_year_id = e.academic_year_id
			        AND rc.term_id IS NULL
			        AND rc.is_published
			 WHERE e.student_id = $1
			 ORDER BY ay.starts_on DESC`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v recordYear
			if err := rows.Scan(&v.Year, &v.ClassName, &v.SectionName, &v.RollNo,
				&v.Status, &v.EnrolledOn, &v.Percentage, &v.Grade, &v.RankSection,
				&v.Attendance, &v.Remarks, &v.Published); err != nil {
				return err
			}
			years = append(years, v)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(), "student_name": name,
		"admission_no": admissionNo, "apaar_id": apaar,
		"lifetime_attendance_percent": attendancePct,
		"years":                       years,
	})
}

// --- APAAR and the Academic Bank of Credits ----------------------------------

type creditEntry struct {
	ID          string  `json:"id"`
	Course      string  `json:"course_title"`
	Subject     *string `json:"subject,omitempty"`
	Year        *string `json:"academic_year,omitempty"`
	Session     *string `json:"session,omitempty"`
	Credits     float64 `json:"credits"`
	Level       *string `json:"level,omitempty"`
	Grade       *string `json:"grade,omitempty"`
	Status      string  `json:"status"`
	DepositedOn *string `json:"deposited_on,omitempty"`
	APAAR       *string `json:"apaar_id,omitempty"`
}

/*
getAcademicBankOfCredits powers student.exams_results.apaar_id_academic_bank_of_credits.

	The APAAR itself is read from students.apaar_id rather than copied: it is
	the child's identity, the office maintains it, and a second copy here would
	be the one that stayed wrong after a correction.

	Withdrawn credits are returned rather than filtered out. A statement that
	silently drops a reversed deposit is not a statement, and the child whose
	credits went down is the one entitled to see why.
*/
func (s *Server) getAcademicBankOfCredits(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	var (
		name  string
		apaar *string
	)
	entries := []creditEntry{}
	var total, banked float64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.apaar_id
			  FROM students st WHERE st.id = $1`, student).Scan(&name, &apaar); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.course_title, sub.name, ay.name, e.session_label,
			       e.credits, e.level, e.grade, e.status,
			       to_char(e.deposited_on,'YYYY-MM-DD'), e.apaar_id
			  FROM abc_credit_entries e
			  LEFT JOIN subjects       sub ON sub.id = e.subject_id
			  LEFT JOIN academic_years ay  ON ay.id = e.academic_year_id
			 WHERE e.student_id = $1
			 ORDER BY e.deposited_on DESC NULLS LAST, e.course_title`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v creditEntry
			if err := rows.Scan(&v.ID, &v.Course, &v.Subject, &v.Year, &v.Session,
				&v.Credits, &v.Level, &v.Grade, &v.Status, &v.DepositedOn,
				&v.APAAR); err != nil {
				return err
			}
			entries = append(entries, v)
			if v.Status != "withdrawn" {
				total += v.Credits
			}
			if v.Status == "deposited" {
				banked += v.Credits
			}
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(), "student_name": name,
		"apaar_id": apaar,
		// Said plainly rather than inferred from an empty string: a school that
		// has not started issuing APAARs and a child whose APAAR is missing are
		// the same screen but not the same problem.
		"has_apaar":      apaar != nil && *apaar != "",
		"total_credits":  total,
		"credits_banked": banked,
		"entries":        entries,
	})
}

type creditRequest struct {
	StudentID   string  `json:"student_id"`
	CourseTitle string  `json:"course_title"`
	Credits     float64 `json:"credits"`
	SubjectID   string  `json:"subject_id,omitempty"`
	YearID      string  `json:"academic_year_id,omitempty"`
	Session     string  `json:"session_label,omitempty"`
	Level       string  `json:"level,omitempty"`
	Grade       string  `json:"grade,omitempty"`
	Status      string  `json:"status,omitempty"`
	DepositedOn string  `json:"deposited_on,omitempty"`
}

// depositAcademicCredits banks credits against a child's APAAR. The school's
// act: credits a child could award themselves are not credits.
func (s *Server) depositAcademicCredits(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req creditRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.CourseTitle) == "" || req.Credits <= 0 {
		httpx.BadRequest(w, r, "course_title and a positive credits value are required")
		return
	}
	subject, err := optionalUUID(req.SubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "subject_id must be a uuid")
		return
	}
	year, err := optionalUUID(req.YearID)
	if err != nil {
		httpx.BadRequest(w, r, "academic_year_id must be a uuid")
		return
	}
	on, err := optionalDate(req.DepositedOn)
	if err != nil {
		httpx.BadRequest(w, r, "deposited_on must be YYYY-MM-DD")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "earned"
	}
	if status == "deposited" && on == nil {
		today := nowInIndia().Format(time.DateOnly)
		on = &today
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The APAAR is copied as it reads today, which is what makes this a
		// receipt rather than a view.
		return tx.QueryRow(r.Context(), `
			INSERT INTO abc_credit_entries
			    (institution_id, student_id, academic_year_id, apaar_id, course_title,
			     subject_id, credits, level, session_label, grade, status, deposited_on)
			SELECT $1, st.id, $3, st.apaar_id, btrim($4), $5, $6, $7, $8, $9, $10, $11
			  FROM students st WHERE st.id = $2
			RETURNING id::text`,
			id.InstitutionID, student, year, req.CourseTitle, subject, req.Credits,
			nullString(req.Level), nullString(req.Session), nullString(req.Grade),
			status, on).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_deposited",
			"those credits are already banked for that course and session")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": status})
}

// --- alumni ------------------------------------------------------------------

type alumniProfile struct {
	ID           string  `json:"id"`
	StudentID    string  `json:"student_id"`
	Name         string  `json:"name"`
	BatchYear    int     `json:"batch_year"`
	Status       string  `json:"current_status"`
	Institution  *string `json:"institution_name,omitempty"`
	Employer     *string `json:"employer,omitempty"`
	Designation  *string `json:"designation,omitempty"`
	City         *string `json:"city,omitempty"`
	Country      *string `json:"country,omitempty"`
	Email        *string `json:"contact_email,omitempty"`
	Phone        *string `json:"contact_phone,omitempty"`
	ProfileURL   *string `json:"profile_url,omitempty"`
	Mentor       bool    `json:"willing_to_mentor"`
	PostsJobs    bool    `json:"willing_to_post_jobs"`
	Listed       bool    `json:"is_listed"`
	ShowContact  bool    `json:"show_contact"`
	Bio          *string `json:"bio,omitempty"`
	Verified     bool    `json:"is_verified"`
	RegisteredOn string  `json:"registered_on"`
}

/*
getAlumniProfile powers student.alumni.alumni_network_registration.

	Answers 200 with registered=false rather than 404 when the child has not
	signed up. The screen's whole job in that state is to offer the form, and a
	404 would have it render an error instead.
*/
func (s *Server) getAlumniProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	var p alumniProfile
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT a.id::text, a.student_id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       a.batch_year, a.current_status, a.institution_name, a.employer,
			       a.designation, a.city, a.country, a.contact_email,
			       a.contact_phone, a.profile_url, a.willing_to_mentor,
			       a.willing_to_post_jobs, a.is_listed, a.show_contact, a.bio,
			       a.verified_at IS NOT NULL, to_char(a.created_at,'YYYY-MM-DD')
			  FROM alumni_profiles a
			  JOIN students st ON st.id = a.student_id
			 WHERE a.student_id = $1`, student).
			Scan(&p.ID, &p.StudentID, &p.Name, &p.BatchYear, &p.Status,
				&p.Institution, &p.Employer, &p.Designation, &p.City, &p.Country,
				&p.Email, &p.Phone, &p.ProfileURL, &p.Mentor, &p.PostsJobs,
				&p.Listed, &p.ShowContact, &p.Bio, &p.Verified, &p.RegisteredOn)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"student_id": student.String(), "registered": false, "profile": nil,
		})
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(), "registered": true, "profile": p,
	})
}

type alumniRequest struct {
	StudentID   string `json:"student_id,omitempty"`
	BatchYear   int    `json:"batch_year,omitempty"`
	Status      string `json:"current_status,omitempty"`
	Institution string `json:"institution_name,omitempty"`
	Employer    string `json:"employer,omitempty"`
	Designation string `json:"designation,omitempty"`
	City        string `json:"city,omitempty"`
	Country     string `json:"country,omitempty"`
	Email       string `json:"contact_email,omitempty"`
	Phone       string `json:"contact_phone,omitempty"`
	ProfileURL  string `json:"profile_url,omitempty"`
	Mentor      bool   `json:"willing_to_mentor,omitempty"`
	PostsJobs   bool   `json:"willing_to_post_jobs,omitempty"`
	Listed      *bool  `json:"is_listed,omitempty"`
	ShowContact bool   `json:"show_contact,omitempty"`
	Bio         string `json:"bio,omitempty"`
}

/*
saveAlumniProfile registers the caller, or edits what they registered.

	One endpoint rather than a create and an update: a leaver filling this in on
	their phone should not have to know whether they got as far as saving last
	time, and the two forms would be the same form.

	Verification is deliberately not settable here. The school vouching for a
	leaver is the school's statement, and a self-verified profile would make the
	tick mean nothing.
*/
func (s *Server) saveAlumniProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req alumniRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	batch := req.BatchYear
	if batch == 0 {
		// The year they are due to finish is a better default than nothing, and
		// the leaver correcting it is one keystroke.
		batch = nowInIndia().Year()
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "school"
	}
	listed := true
	if req.Listed != nil {
		listed = *req.Listed
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_profiles
			    (institution_id, student_id, registered_by, batch_year, current_status,
			     institution_name, employer, designation, city, country,
			     contact_email, contact_phone, profile_url, willing_to_mentor,
			     willing_to_post_jobs, is_listed, show_contact, bio)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
			        $15, $16, $17, $18)
			ON CONFLICT (institution_id, student_id) DO UPDATE SET
			    batch_year        = EXCLUDED.batch_year,
			    current_status    = EXCLUDED.current_status,
			    institution_name  = EXCLUDED.institution_name,
			    employer          = EXCLUDED.employer,
			    designation       = EXCLUDED.designation,
			    city              = EXCLUDED.city,
			    country           = EXCLUDED.country,
			    contact_email     = EXCLUDED.contact_email,
			    contact_phone     = EXCLUDED.contact_phone,
			    profile_url       = EXCLUDED.profile_url,
			    willing_to_mentor = EXCLUDED.willing_to_mentor,
			    willing_to_post_jobs = EXCLUDED.willing_to_post_jobs,
			    is_listed         = EXCLUDED.is_listed,
			    show_contact      = EXCLUDED.show_contact,
			    bio               = EXCLUDED.bio,
			    updated_at        = now()
			RETURNING id::text`,
			id.InstitutionID, student, id.UserID, batch, status,
			nullString(req.Institution), nullString(req.Employer),
			nullString(req.Designation), nullString(req.City),
			nullString(req.Country), nullString(req.Email), nullString(req.Phone),
			nullString(req.ProfileURL), req.Mentor, req.PostsJobs, listed,
			req.ShowContact, nullString(req.Bio)).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "registered": true})
}

/*
listAlumniDirectory is the network a registration joins.

	Two consents govern it and they are separate columns because they answer
	separate questions. is_listed decides whether a person appears at all;
	show_contact decides whether their email and telephone travel with them.
	Collapsing the two is how a directory becomes a mailing list, so the contact
	columns are nulled in SQL rather than filtered in the browser — a field
	stripped after it has been serialised has already left the building.
*/
func (s *Server) listAlumniDirectory(w http.ResponseWriter, r *http.Request) {
	// A bare GET is the whole directory rather than a 400, so the screen has
	// something to show before anyone types.
	q := nullString(strings.TrimSpace(r.URL.Query().Get("q")))
	items, err := collect(s, r, `
		SELECT a.id::text, a.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       a.batch_year, a.current_status, a.institution_name, a.employer,
		       a.designation, a.city, a.country,
		       CASE WHEN a.show_contact THEN a.contact_email END,
		       CASE WHEN a.show_contact THEN a.contact_phone END,
		       a.profile_url, a.willing_to_mentor, a.willing_to_post_jobs,
		       a.is_listed, a.show_contact, a.bio,
		       a.verified_at IS NOT NULL, to_char(a.created_at,'YYYY-MM-DD')
		  FROM alumni_profiles a
		  JOIN students st ON st.id = a.student_id
		 WHERE a.is_listed
		   AND ($1::text IS NULL
		        OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $1 || '%'
		        OR a.employer ILIKE '%' || $1 || '%'
		        OR a.institution_name ILIKE '%' || $1 || '%')
		 ORDER BY a.batch_year DESC, st.first_name
		 LIMIT 200`, []any{q},
		func(rows pgx.Rows) (alumniProfile, error) {
			var v alumniProfile
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Name, &v.BatchYear, &v.Status,
				&v.Institution, &v.Employer, &v.Designation, &v.City, &v.Country,
				&v.Email, &v.Phone, &v.ProfileURL, &v.Mentor, &v.PostsJobs,
				&v.Listed, &v.ShowContact, &v.Bio, &v.Verified, &v.RegisteredOn)
		})
	respond(w, r, items, err)
}

type alumniJob struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Title        string  `json:"title"`
	Organisation string  `json:"organisation"`
	Location     *string `json:"location,omitempty"`
	Remote       bool    `json:"is_remote"`
	Description  *string `json:"description,omitempty"`
	Eligibility  *string `json:"eligibility,omitempty"`
	StipendPaise *int64  `json:"stipend_paise,omitempty"`
	ApplyURL     *string `json:"apply_url,omitempty"`
	ApplyEmail   *string `json:"apply_email,omitempty"`
	ClosesOn     *string `json:"closes_on,omitempty"`
	Status       string  `json:"status"`
	PostedBy     string  `json:"posted_by"`
	// Set when the poster is a former pupil rather than the office, which is
	// what makes this an alumni board.
	PosterBatch *int   `json:"poster_batch_year,omitempty"`
	Interested  int    `json:"interested"`
	MyInterest  bool   `json:"registered_interest"`
	PostedOn    string `json:"posted_on"`
}

/*
listAlumniJobs powers student.alumni.alumni_job_internship_board.

	min_class_level gates each post by the child's own class level, for the same
	reason the club events are gated: a graduate role advertised to a Grade 6
	child is noise the school published under its own name.
*/
func (s *Server) listAlumniJobs(w http.ResponseWriter, r *http.Request) {
	room, ok := s.myClassroom(w, r)
	if !ok {
		return
	}
	kind := nullString(strings.TrimSpace(r.URL.Query().Get("kind")))
	items, err := collect(s, r, `
		SELECT p.id::text, p.kind, p.title, p.organisation, p.location, p.is_remote,
		       p.description, p.eligibility, p.stipend_paise, p.apply_url,
		       p.apply_email, to_char(p.closes_on,'YYYY-MM-DD'), p.status,
		       COALESCE(concat_ws(' ', ast.first_name, ast.last_name), u.full_name),
		       al.batch_year,
		       (SELECT count(*)::int FROM alumni_job_interests i
		         WHERE i.post_id = p.id AND i.withdrawn_at IS NULL),
		       EXISTS (SELECT 1 FROM alumni_job_interests i
		                WHERE i.post_id = p.id AND i.student_id = $1
		                  AND i.withdrawn_at IS NULL),
		       to_char(p.created_at,'YYYY-MM-DD')
		  FROM alumni_job_posts p
		  JOIN users u ON u.id = p.posted_by
		  LEFT JOIN alumni_profiles al  ON al.id = p.alumni_id
		  LEFT JOIN students        ast ON ast.id = al.student_id
		 WHERE p.status = 'open'
		   AND (p.closes_on IS NULL OR p.closes_on >= CURRENT_DATE)
		   AND (p.min_class_level IS NULL OR p.min_class_level <= $2)
		   AND ($3::text IS NULL OR p.kind = $3)
		 ORDER BY p.closes_on ASC NULLS LAST, p.created_at DESC
		 LIMIT 200`,
		[]any{room.StudentID, room.Level, kind},
		func(rows pgx.Rows) (alumniJob, error) {
			var v alumniJob
			return v, rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Organisation, &v.Location,
				&v.Remote, &v.Description, &v.Eligibility, &v.StipendPaise, &v.ApplyURL,
				&v.ApplyEmail, &v.ClosesOn, &v.Status, &v.PostedBy, &v.PosterBatch,
				&v.Interested, &v.MyInterest, &v.PostedOn)
		})
	respond(w, r, items, err)
}

type interestRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Note      string `json:"note,omitempty"`
}

/*
registerJobInterest puts the child's hand up.

	Interest, not an application. The school does not run the hiring, and a
	status column here would leave children refreshing a screen for a decision
	this system will never learn about.
*/
func (s *Server) registerJobInterest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req interestRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	postID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	room, err := s.classroomOf(r, student)
	if err != nil {
		httpx.NotFound(w, r)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_job_interests (institution_id, post_id, student_id, note)
			SELECT $1, p.id, $3, $4
			  FROM alumni_job_posts p
			 WHERE p.id = $2 AND p.status = 'open'
			   AND (p.closes_on IS NULL OR p.closes_on >= CURRENT_DATE)
			   AND (p.min_class_level IS NULL OR p.min_class_level <= $5)
			RETURNING id::text`,
			id.InstitutionID, postID, student, nullString(req.Note),
			room.Level).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_registered",
			"you have already registered interest in that post")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "unavailable",
			"that post is closed or not open to your year group")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

func (s *Server) withdrawJobInterest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req interestRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	_, student, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	postID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE alumni_job_interests
			   SET withdrawn_at = now()
			 WHERE post_id = $1 AND student_id = $2 AND withdrawn_at IS NULL
			RETURNING id::text`, postID, student).Scan(&out)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "withdrawn": true})
}

type jobPostRequest struct {
	Kind          string `json:"kind,omitempty"`
	Title         string `json:"title"`
	Organisation  string `json:"organisation"`
	Location      string `json:"location,omitempty"`
	Remote        bool   `json:"is_remote,omitempty"`
	Description   string `json:"description,omitempty"`
	Eligibility   string `json:"eligibility,omitempty"`
	StipendPaise  int64  `json:"stipend_paise,omitempty"`
	MinClassLevel int    `json:"min_class_level,omitempty"`
	ApplyURL      string `json:"apply_url,omitempty"`
	ApplyEmail    string `json:"apply_email,omitempty"`
	ClosesOn      string `json:"closes_on,omitempty"`
	AlumniID      string `json:"alumni_id,omitempty"`
}

// postAlumniJob puts an opening on the board. Staff-gated: the school's name is
// on anything a child reads here, and an unvetted board is how a school ends up
// advertising somebody's recruitment scam to its own leavers.
func (s *Server) postAlumniJob(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req jobPostRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Organisation) == "" {
		httpx.BadRequest(w, r, "title and organisation are required")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = "internship"
	}
	closes, err := optionalDate(req.ClosesOn)
	if err != nil {
		httpx.BadRequest(w, r, "closes_on must be YYYY-MM-DD")
		return
	}
	alumni, err := optionalUUID(req.AlumniID)
	if err != nil {
		httpx.BadRequest(w, r, "alumni_id must be a uuid")
		return
	}
	var stipend *int64
	if req.StipendPaise > 0 {
		stipend = &req.StipendPaise
	}
	var minLevel *int
	if req.MinClassLevel > 0 {
		minLevel = &req.MinClassLevel
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_job_posts
			    (institution_id, posted_by, alumni_id, kind, title, organisation,
			     location, is_remote, description, eligibility, stipend_paise,
			     min_class_level, apply_url, apply_email, closes_on)
			VALUES ($1, $2, $3, $4, btrim($5), btrim($6), $7, $8, $9, $10, $11,
			        $12, $13, $14, $15)
			RETURNING id::text`,
			id.InstitutionID, id.UserID, alumni, kind, req.Title, req.Organisation,
			nullString(req.Location), req.Remote, nullString(req.Description),
			nullString(req.Eligibility), stipend, minLevel, nullString(req.ApplyURL),
			nullString(req.ApplyEmail), closes).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_posted",
			"that organisation already has an open post by that title")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- small shared parsers ----------------------------------------------------

// optionalDate parses a YYYY-MM-DD that the caller was allowed to omit.
//
// Returned as a *string rather than a *time.Time because every consumer here
// binds it straight into a date column, and a round trip through time.Time only
// creates somewhere for a timezone to be applied to a date that has none.
func optionalDate(raw string) (*string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return nil, nil
	}
	if _, err := time.Parse(time.DateOnly, v); err != nil {
		return nil, err
	}
	return &v, nil
}

// optionalUUID is declared in infirmary.go and reused deliberately: "absent is
// fine, malformed is not" is one rule, and a second copy of it would eventually
// be the copy that widened a query instead of refusing it.
