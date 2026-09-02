package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Erasing a child's record, as against taking them off the roll.

	Almost every departure is a leaver: they transfer, they graduate, they are
	withdrawn, and the record has to survive because a transfer certificate, a
	fee ledger and a bonafide letter are all questions asked about children who
	have gone. "Record that they have left" is that, and is what the office
	wants ninety-nine times in a hundred.

	This is the hundredth. A duplicate created by an import run twice, a test
	child somebody made while learning the system, an application entered
	against the wrong family — records that were never a person and that a
	school cannot explain to an auditor either. Withdrawing those leaves a
	fictional child on the roll forever, counted in every headcount.

	MONEY IS THE LINE. A child with a payment against them has a financial
	history, and deleting that is destroying an accounting record — so this
	refuses, names what it found, and points at withdrawal instead. Invoices
	with nothing paid are cancelled paperwork rather than history, and go with
	the child.

	It is a hard delete. Every dependent row goes with it through the schema's
	own cascades: enrolments, guardian links, attendance, transport allocation.
	A soft-deleted "gone but still here" record would be exactly the fictional
	child this exists to remove.
*/
var (
	errStudentHasMoney = errors.New("this child has payments recorded")
	errNameMismatch    = errors.New("the typed name does not match")
)

type deleteStudentRequest struct {
	/* The child's name, typed. Not a checkbox: this is the one irreversible
	   act on the record, and a confirmation somebody clicks through without
	   reading is not a confirmation. Typing the name is also what catches the
	   commonest way this goes wrong -- the wrong child open on the screen. */
	ConfirmName string `json:"confirm_name"`
	Reason      string `json:"reason,omitempty"`
}

func (s *Server) deleteStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req deleteStudentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var name string
	var paid int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT trim(concat_ws(' ', first_name, middle_name, last_name))
			  FROM students WHERE id = $1`, sid).Scan(&name); err != nil {
			return err
		}
		// Case and inner spacing forgiven; the point is that somebody read the
		// name off the screen, not that they typed it character-perfect.
		if !sameName(req.ConfirmName, name) {
			return errNameMismatch
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FROM payments p
			  JOIN invoices i ON i.id = p.invoice_id
			 WHERE i.student_id = $1`, sid).Scan(&paid); err != nil {
			return err
		}
		if paid > 0 {
			return errStudentHasMoney
		}

		tag, err := tx.Exec(r.Context(), `DELETE FROM students WHERE id = $1`, sid)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})

	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNameMismatch):
		httpx.BadRequest(w, r,
			"that is not this child's name. Type it exactly as it appears on the record")
		return
	case errors.Is(err, errStudentHasMoney):
		httpx.Error(w, r, http.StatusConflict, "student_has_payments",
			"this child has money recorded against them, which is an accounting record "+
				"and cannot be erased. Use \"Record that they have left\" instead")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"deleted": true,
		"name":    name,
		"note": "The record and everything attached to it is gone. This cannot be " +
			"undone from the app.",
	})
}

// sameName compares what was typed with what is on file, forgiving case and
// the double spaces that an imported name is full of.
func sameName(typed, actual string) bool {
	norm := func(v string) string {
		return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(v))), " ")
	}
	t := norm(typed)
	return t != "" && t == norm(actual)
}
