package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A teacher's own to-do list.

   The faculty Dashboard has two entries. "Today's classes" answers what is
   happening now; "My work" was catalogued and never built, so the second item
   of the first section of the first screen a teacher sees was a dead link —
   the most prominent placeholder in the product.

   It answers the question a teacher actually has at 8am and again at 4pm:
   what is outstanding on me. Five things, in the order they become urgent:

     submissions waiting to be marked
     papers where marks are still missing
     classes I have been asked to cover
     leave I have applied for and not heard about
     notices I have not acknowledged

   Everything is scoped to the caller by the same resolver the rest of the
   teaching workspace uses, so a teacher sees their own sections and nobody
   else's. */

type workItem struct {
	Kind string `json:"kind"`
	// Title is the thing; Detail is why it matters now.
	Title  string  `json:"title"`
	Detail string  `json:"detail"`
	Count  int     `json:"count"`
	Due    *string `json:"due,omitempty"`
	// Overdue drives the only colour on the screen. A list where everything is
	// red is a list nobody reads.
	Overdue bool    `json:"overdue"`
	Link    *string `json:"link,omitempty"`
}

// getMyWork powers faculty.dashboard.my_work.
func (s *Server) getMyWork(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// A teacher with no sections has no work of this kind — and an empty
	// section list must not become "every section", which is what an omitted
	// predicate would do.
	sections := res.SectionIDs
	items := []workItem{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// 1. Homework handed in and not yet marked.
		if len(sections) > 0 {
			var pending, overdue int
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int,
				       count(*) FILTER (
				         WHERE hs.submitted_at < now() - interval '3 days')::int
				  FROM homework_submissions hs
				  JOIN homework h ON h.id = hs.homework_id
				 WHERE h.section_id = ANY($1)
				   AND hs.status = 'submitted'
				   AND hs.graded_at IS NULL`, sections).Scan(&pending, &overdue); err != nil {
				return err
			}
			if pending > 0 {
				items = append(items, workItem{
					Kind: "submissions", Count: pending,
					Title: plural(pending, "submission", "submissions") + " to mark",
					Detail: func() string {
						if overdue > 0 {
							return itoa(overdue) + " handed in more than three days ago"
						}
						return "All handed in within the last three days"
					}(),
					Overdue: overdue > 0,
				})
			}
		}

		// 2. Papers this teacher is responsible for where marks are missing.
		//
		// Counted per paper rather than per student: "Class 8 English, 12 of 34
		// entered" is a task, "408 marks missing" is a wall.
		rows, err := tx.Query(r.Context(), `
			SELECT ex.name, sub.name, c.name,
			       count(DISTINCT e.student_id)::int AS expected,
			       count(DISTINCT m.student_id)::int AS entered,
			       to_char(ex.ends_on, 'YYYY-MM-DD'),
			       ex.ends_on IS NOT NULL AND ex.ends_on < CURRENT_DATE
			  FROM exam_subjects es
			  JOIN exams          ex ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects      sub ON sub.id = cs.subject_id
			  JOIN classes         c ON c.id = cs.class_id
			  JOIN sections      sec ON sec.class_id = c.id
			  JOIN enrollments     e ON e.section_id = sec.id AND e.status = 'active'
			  LEFT JOIN marks      m ON m.exam_subject_id = es.id
			                        AND m.student_id = e.student_id
			 WHERE sec.id = ANY($1)
			   AND EXISTS (SELECT 1 FROM section_subject_teachers t
			                WHERE t.section_id = sec.id
			                  AND t.class_subject_id = cs.id
			                  AND t.teacher_user_id = $2)
			 GROUP BY ex.name, sub.name, c.name, ex.ends_on
			HAVING count(DISTINCT m.student_id) < count(DISTINCT e.student_id)
			 ORDER BY ex.ends_on NULLS LAST
			 LIMIT 10`, sections, id.UserID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var exam, subject, class string
			var dueP *string
			var expected, entered int
			var late bool
			if err := rows.Scan(&exam, &subject, &class, &expected, &entered,
				&dueP, &late); err != nil {
				rows.Close()
				return err
			}
			items = append(items, workItem{
				Kind: "marks", Count: expected - entered,
				Title:  class + " " + subject + " — " + exam,
				Detail: itoa(entered) + " of " + itoa(expected) + " marks entered",
				Due:    dueP, Overdue: late,
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// 3. Cover this teacher has been given.
		rows, err = tx.Query(r.Context(), `
			SELECT to_char(sb.on_date, 'YYYY-MM-DD'), c.name, sec.name, p.name,
			       COALESCE(sb.reason, ''), sb.on_date = CURRENT_DATE
			  FROM substitutions sb
			  JOIN timetable_entries te ON te.id = sb.timetable_entry_id
			  JOIN sections sec ON sec.id = te.section_id
			  JOIN classes    c ON c.id = sec.class_id
			  JOIN periods    p ON p.id = te.period_id
			 WHERE sb.substitute_user_id = $1
			   AND sb.on_date >= CURRENT_DATE
			 ORDER BY sb.on_date, p.sequence
			 LIMIT 10`, id.UserID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var on, class, section, period, reason string
			var today bool
			if err := rows.Scan(&on, &class, &section, &period, &reason, &today); err != nil {
				rows.Close()
				return err
			}
			detail := period + ", " + class + "-" + section
			if reason != "" {
				detail += " · " + reason
			}
			items = append(items, workItem{
				Kind: "substitution", Count: 1,
				Title:  "Covering " + class + "-" + section,
				Detail: detail, Due: &on, Overdue: today,
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		/* 4. Leave this teacher has applied for.

		   Every pending application, because an unanswered request is the
		   thing they came to look for — and only the single most recent
		   decision, because five "approved" rows from last term push the
		   actual work off the screen. This list is a to-do list, and a
		   decision already made is not a to-do. */
		rows, err = tx.Query(r.Context(), `
			(SELECT lr.status,
			        to_char(lr.from_date,'DD Mon') || ' to ' || to_char(lr.to_date,'DD Mon'),
			        lr.days::text, lr.reason, lr.created_at
			   FROM leave_requests lr
			   JOIN employees e ON e.id = lr.employee_id
			  WHERE e.user_id = $1 AND lr.status = 'pending')
			UNION ALL
			(SELECT lr.status,
			        to_char(lr.from_date,'DD Mon') || ' to ' || to_char(lr.to_date,'DD Mon'),
			        lr.days::text, lr.reason, lr.created_at
			   FROM leave_requests lr
			   JOIN employees e ON e.id = lr.employee_id
			  WHERE e.user_id = $1 AND lr.status <> 'pending'
			    AND lr.decided_at >= now() - interval '14 days'
			  ORDER BY lr.decided_at DESC
			  LIMIT 1)
			ORDER BY created_at DESC`, id.UserID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var status, span, days, reason string
			var raised any
			if err := rows.Scan(&status, &span, &days, &reason, &raised); err != nil {
				rows.Close()
				return err
			}
			items = append(items, workItem{
				Kind: "leave", Count: 1,
				Title:  "Leave " + status + " — " + span,
				Detail: days + " day(s). " + reason,
				// Only a decision still outstanding is urgent.
				Overdue: status == "pending",
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// 5. Notices requiring an acknowledgement this teacher has not given.
		var notices int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int
			  FROM announcements a
			 WHERE a.requires_ack
			   -- publish_at, not published_at: the column is the moment it goes
			   -- out, which may be in the future for a scheduled notice.
			   AND a.publish_at <= now()
			   AND (a.expires_at IS NULL OR a.expires_at > now())
			   AND NOT EXISTS (SELECT 1 FROM announcement_acks ack
			                    WHERE ack.announcement_id = a.id
			                      AND ack.user_id = $1)`, id.UserID).Scan(&notices); err != nil {
			return err
		}
		if notices > 0 {
			items = append(items, workItem{
				Kind: "announcement", Count: notices,
				Title:  plural(notices, "notice", "notices") + " to acknowledge",
				Detail: "The office is waiting on your confirmation",
			})
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	outstanding := 0
	for _, it := range items {
		if it.Kind != "leave" || it.Overdue {
			outstanding += it.Count
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "outstanding": outstanding,
		"sections": len(sections),
	})
}

func plural(n int, one, many string) string {
	if n == 1 {
		return itoa(n) + " " + one
	}
	return itoa(n) + " " + many
}
