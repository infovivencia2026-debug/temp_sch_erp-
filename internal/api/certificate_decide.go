package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Answering a family that asked for a document.

   The request half of this has worked for a long time: a parent opens
   Documents → Certificate requests, picks from what the school actually
   issues, and the office is notified with a serial number. issued_certificates
   even models the states — requested, approved, issued, cancelled.

   Nothing ever moved a row out of 'requested'. The office's own certificate
   button INSERTS, so a clerk acting on a parent's request created a second row
   with a second serial and left the first sitting in the family's list for
   ever. The parent saw "requested" a fortnight after collecting the document
   from the counter, and the office saw a queue that only grew.

   So: one endpoint that answers the request that was actually made. It carries
   a note, because the answer a school gives at a counter is a sentence — "gave
   it to your son on Tuesday" — and a status alone makes the family ring to ask
   what the status meant.
*/

type certificateDecision struct {
	// approved | issued | cancelled. Two steps rather than one because a
	// school that requires a principal's approval separates deciding from
	// handing over, and a school that does not can go straight to issued.
	Status string `json:"status"`
	// What the office wants the family to read. This is the whole point: the
	// parent gets the sentence, not a state machine.
	Note string `json:"note,omitempty"`
}

var certificateDecisions = map[string]string{
	"approved":  "approved",
	"issued":    "ready",
	"cancelled": "declined",
}

func (s *Server) decideCertificate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid certificate id")
		return
	}
	var req certificateDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	status := strings.ToLower(strings.TrimSpace(req.Status))
	if _, ok := certificateDecisions[status]; !ok {
		httpx.BadRequest(w, r, "status must be approved, issued or cancelled")
		return
	}
	note := strings.TrimSpace(req.Note)
	if len(note) > 1000 {
		httpx.BadRequest(w, r, "keep the note under 1000 characters")
		return
	}
	if status == "cancelled" && note == "" {
		/* A refusal with no reason is the one a family rings about, and the
		   person who answers the telephone was not the person who refused. */
		httpx.BadRequest(w, r, "say why it was declined — the family will be told")
		return
	}

	var (
		serial, typeName, child string
		studentID               uuid.UUID
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			UPDATE issued_certificates ic
			   SET status = $2,
			       approved_by = $3,
			       -- Kept on the row rather than in a side table: the note is
			       -- part of the answer, and the snapshot is already where
			       -- this record's own facts live.
			       snapshot = ic.snapshot || jsonb_build_object(
			           'office_note', $4::text,
			           'decided_at', now()
			       )
			 WHERE ic.id = $1
			   -- Only a live request. Re-deciding one already issued would let
			   -- a second clerk overwrite the first one's answer, and the
			   -- family would be told twice with different words.
			   AND ic.status IN ('requested','approved')
			RETURNING ic.serial_no, ic.student_id`,
			cid, status, id.UserID, nullString(note)).Scan(&serial, &studentID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT ct.name, concat_ws(' ', st.first_name, st.last_name)
			  FROM issued_certificates ic
			  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
			  JOIN students st ON st.id = ic.student_id
			 WHERE ic.id = $1`, cid).Scan(&typeName, &child); err != nil {
			return err
		}

		/* Everyone in the household, and the child.

		   A document is collected by whoever is free that afternoon, so
		   telling only the parent who happened to ask means the other one
		   turns up at the counter for something already handed over. */
		body := typeName + " for " + child + " — " + certificateDecisions[status] +
			". Serial " + serial + "."
		if note != "" {
			body += " " + note
		}
		rows, err := tx.Query(r.Context(), `
			SELECT g.user_id FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL
			UNION
			SELECT u.id FROM students st JOIN users u ON u.id = st.user_id
			 WHERE st.id = $1`, studentID)
		if err != nil {
			return err
		}
		var people []uuid.UUID
		for rows.Next() {
			var u uuid.UUID
			if err := rows.Scan(&u); err != nil {
				rows.Close()
				return err
			}
			people = append(people, u)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, u := range people {
			sid := studentID
			if err := notify(r, tx, id.InstitutionID, u, &sid, "certificate",
				typeName+" "+certificateDecisions[status], body,
				"/portal/requests", "certificate", &cid); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "already_decided",
			"somebody has already answered this request")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": status, "serial_no": serial,
	})
}
