package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The rest of what the school knows about one child.

   Split from getStudentProfile rather than folded into it. That endpoint
   answers the questions asked with a parent on the telephone — who are they,
   which class, who do we ring, are they present, what do they owe — and it has
   to be instant. What follows is the depth behind each tab: every mark by
   subject, the fee ledger broken down by head, the receipts and how they were
   paid, the documents on file, the leave asked for, and every year the child
   has been here.

   Nobody opens all seven tabs, so this is fetched once when the record opens
   and shared by all of them, rather than seven queries fired as somebody
   clicks around or one enormous payload paid for on every open.

   The child is checked against the caller's scope HERE and not taken on trust
   from the profile call this accompanies: an endpoint that assumes another was
   called first is one somebody can call on its own.
*/

func (s *Server) getStudentDetail(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	subjectMarks := []map[string]any{}
	feeHeads := []map[string]any{}
	payments := []map[string]any{}
	documents := []map[string]any{}
	leave := []map[string]any{}
	history := []map[string]any{}
	crew := []map[string]any{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var ok bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&ok); err != nil {
			return err
		}

		/* MARK BY MARK, per exam and subject.

		   Approved marks only. A teacher's entry that nobody has signed off is
		   a working figure, and putting it on the child's record is how a
		   parent comes to learn a mark that later changes. */
		if err := scanInto(r.Context(), tx, `
			SELECT e.name, sub.name, m.marks_obtained::text,
			       es.max_marks::text, m.grade, m.is_absent,
			       to_char(e.starts_on,'YYYY-MM-DD')
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN exams e ON e.id = es.exam_id
			  -- exam_subjects names a CLASS SUBJECT, not a subject: the paper
			  -- belongs to a class's instance of it, which is what carries the
			  -- syllabus and the teacher. The subject's name is one hop further.
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			 WHERE m.student_id = $1 AND m.approved_at IS NOT NULL
			 ORDER BY e.starts_on DESC, sub.name`,
			func(rows pgx.Rows) error {
				var exam, subject string
				var got, max, grade, on *string
				var absent bool
				if err := rows.Scan(&exam, &subject, &got, &max, &grade, &absent, &on); err != nil {
					return err
				}
				subjectMarks = append(subjectMarks, map[string]any{
					"exam": exam, "subject": subject, "marks": got,
					"max": max, "grade": grade, "absent": absent, "on": on,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		/* THE LEDGER BY FEE HEAD, which is how a family reads a bill.

		   Invoices are how the school raises money; "tuition, transport, exam"
		   is how a parent understands it, and the two are not the same shape.

		   Paid is apportioned across an invoice's heads in proportion to what
		   each is worth, because a payment lands on an INVOICE and not on a
		   head. There is no honest way to say which head a part-payment
		   settled, and picking one would print "Transport: unpaid" against a
		   family that has paid most of the bill. */
		if err := scanInto(r.Context(), tx, `
			SELECT COALESCE(fh.name, il.description, 'Other') AS head,
			       SUM(il.amount_paise - il.discount_paise)::text,
			       SUM(round((il.amount_paise - il.discount_paise)
			           * CASE WHEN inv.net_paise > 0
			                  THEN inv.paid_paise::numeric / inv.net_paise
			                  ELSE 0 END))::text
			  FROM invoice_lines il
			  JOIN invoices inv ON inv.id = il.invoice_id
			  LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
			 WHERE inv.student_id = $1 AND inv.status <> 'cancelled'
			 GROUP BY head
			 ORDER BY head`,
			func(rows pgx.Rows) error {
				var head string
				var charged, paid *string
				if err := rows.Scan(&head, &charged, &paid); err != nil {
					return err
				}
				feeHeads = append(feeHeads, map[string]any{
					"head": head, "charged_paise": charged, "paid_paise": paid,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		// How the money actually arrived. The mode and the reference are what
		// a family quotes when they say they have already paid.
		if err := scanInto(r.Context(), tx, `
			SELECT COALESCE(pm.receipt_no,''), to_char(pm.paid_on,'YYYY-MM-DD'),
			       pm.amount_paise::text, pm.mode,
			       COALESCE(pm.gateway_txn_id, pm.reference_no, ''), pm.status
			  FROM payments pm
			 WHERE pm.student_id = $1
			 ORDER BY pm.paid_on DESC, pm.created_at DESC
			 LIMIT 100`,
			func(rows pgx.Rows) error {
				var receipt, on, amount, mode, ref, status string
				if err := rows.Scan(&receipt, &on, &amount, &mode, &ref, &status); err != nil {
					return err
				}
				payments = append(payments, map[string]any{
					"receipt_no": receipt, "paid_on": on, "amount_paise": amount,
					"mode": mode, "reference": ref, "status": status,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		/* WHAT THE FAMILY HANDED IN, as opposed to what the school issued.

		   The Documents tab listed issued_certificates alone — things the
		   school gave out. The birth certificate and the Aadhaar scan the
		   office took at admission live in student_documents and were on no
		   screen anywhere, so the question that tab is actually opened for,
		   "have we got their birth certificate", could not be answered. */
		if err := scanInto(r.Context(), tx, `
			SELECT sd.id::text, sd.doc_type, sd.file_id::text,
			       to_char(sd.created_at,'YYYY-MM-DD'),
			       sd.verified_at IS NOT NULL, COALESCE(u.full_name,''),
			       COALESCE(sd.notes,''), COALESCE(f.original_name,''),
			       COALESCE(f.content_type,'')
			  FROM student_documents sd
			  LEFT JOIN users u ON u.id = sd.verified_by
			  LEFT JOIN files f ON f.id = sd.file_id
			 WHERE sd.student_id = $1
			 ORDER BY sd.created_at DESC`,
			func(rows pgx.Rows) error {
				var did, kind, file, on, by, notes, name, mime string
				var verified bool
				if err := rows.Scan(&did, &kind, &file, &on, &verified, &by,
					&notes, &name, &mime); err != nil {
					return err
				}
				documents = append(documents, map[string]any{
					"id": did, "doc_type": kind, "file_id": file, "uploaded_on": on,
					"verified": verified, "verified_by": by, "notes": notes,
					"filename": name, "content_type": mime,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		// Leave the family asked for, and what the school said back.
		if err := scanInto(r.Context(), tx, `
			SELECT to_char(lr.from_date,'YYYY-MM-DD'), to_char(lr.to_date,'YYYY-MM-DD'),
			       COALESCE(lt.name,''), COALESCE(lr.reason,''), lr.status,
			       COALESCE(u.full_name,''), COALESCE(lr.decision_note,''),
			       lr.days::text
			  FROM leave_requests lr
			  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
			  LEFT JOIN users u ON u.id = lr.applied_by
			 WHERE lr.student_id = $1
			 ORDER BY lr.from_date DESC LIMIT 50`,
			func(rows pgx.Rows) error {
				var from, to, kind, reason, status, by, note, days string
				if err := rows.Scan(&from, &to, &kind, &reason, &status, &by,
					&note, &days); err != nil {
					return err
				}
				leave = append(leave, map[string]any{
					"from": from, "to": to, "type": kind, "reason": reason,
					"status": status, "applied_by": by, "decision_note": note,
					"days": days,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		/* EVERY YEAR THE CHILD HAS BEEN HERE.

		   promoted_from_id has been on the row since the baseline, so the
		   chain from Grade 5-A to Grade 6-B was already recorded and simply
		   never read by anything. */
		if err := scanInto(r.Context(), tx, `
			SELECT COALESCE(ay.name,''), COALESCE(c.name,''), COALESCE(sec.name,''),
			       en.roll_no::text, en.status,
			       to_char(en.enrolled_on,'YYYY-MM-DD'), COALESCE(en.remarks,''),
			       en.promoted_from_id IS NOT NULL
			  FROM enrollments en
			  LEFT JOIN academic_years ay ON ay.id = en.academic_year_id
			  LEFT JOIN classes c ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE en.student_id = $1
			 ORDER BY en.enrolled_on DESC`,
			func(rows pgx.Rows) error {
				var year, class, section, status, on, remarks string
				var roll *string
				var promoted bool
				if err := rows.Scan(&year, &class, &section, &roll, &status,
					&on, &remarks, &promoted); err != nil {
					return err
				}
				history = append(history, map[string]any{
					"year": year, "class": class, "section": section,
					"roll_no": roll, "status": status, "from": on,
					"remarks": remarks, "promoted": promoted,
				})
				return nil
			}, sid); err != nil {
			return err
		}

		/* WHO IS DRIVING — the question at four o'clock when a bus is late and
		   nobody can find the child. The names were one employees join away
		   from a table this record already read. */
		if err := scanInto(r.Context(), tx, `
			SELECT COALESCE(rt.name,''), COALESCE(v.registration_no,''),
			       COALESCE(concat_ws(' ', de.first_name, de.last_name),''),
			       COALESCE(de.phone,''),
			       COALESCE(concat_ws(' ', ae.first_name, ae.last_name),''),
			       COALESCE(ae.phone,'')
			  FROM transport_allocations ta
			  LEFT JOIN routes rt ON rt.id = ta.route_id
			  LEFT JOIN vehicles v ON v.id = rt.vehicle_id
			  LEFT JOIN employees de ON de.id = v.driver_employee_id
			  LEFT JOIN employees ae ON ae.id = v.attendant_employee_id
			 WHERE ta.student_id = $1
			   AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)`,
			func(rows pgx.Rows) error {
				var route, reg, driver, dphone, att, aphone string
				if err := rows.Scan(&route, &reg, &driver, &dphone, &att, &aphone); err != nil {
					return err
				}
				crew = append(crew, map[string]any{
					"route": route, "vehicle": reg,
					"driver": driver, "driver_phone": dphone,
					"attendant": att, "attendant_phone": aphone,
				})
				return nil
			}, sid); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"subject_marks":     subjectMarks,
		"fee_heads":         feeHeads,
		"payments":          payments,
		"documents":         documents,
		"leave":             leave,
		"enrolment_history": history,
		"transport_crew":    crew,
	})
}
