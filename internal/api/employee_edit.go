package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Staff details, after the day they were entered.

   Employees could be created and never edited. A phone number changes, a
   teacher marries and changes her name, somebody is promoted out of a
   department, the bank account for salary is keyed wrong once — and none of it
   could be corrected without a database session. Sixty-nine staff were
   imported into this deployment before anyone noticed there was no way back
   into the record.

   Status is here too, and it is the whole of what "somebody left" means in
   this product: nobody is deleted, an employee becomes resigned or terminated
   or retired and their service record, payroll history and the classes they
   taught all stay exactly where they are. That is why there is no delete on
   this endpoint and will not be one.
*/

type employeePatch struct {
	FirstName *string `json:"first_name,omitempty"`
	LastName  *string `json:"last_name,omitempty"`
	Phone     *string `json:"phone,omitempty"`
	Email     *string `json:"email,omitempty"`

	DepartmentID   *string `json:"department_id,omitempty"`
	DesignationID  *string `json:"designation_id,omitempty"`
	EmploymentType *string `json:"employment_type,omitempty"`
	Status         *string `json:"status,omitempty"`

	JoinedOn    *string `json:"joined_on,omitempty"`
	ConfirmedOn *string `json:"confirmed_on,omitempty"`
	RelievedOn  *string `json:"relieved_on,omitempty"`

	// The number the fingerprint reader knows them by. Defaults to
	// staff_number; set explicitly only for a school whose reader was already
	// enrolled with ids of its own.
	DeviceUserID *int `json:"device_user_id,omitempty"`

	Qualification   *string `json:"qualification,omitempty"`
	ExperienceYears *int    `json:"experience_years,omitempty"`
	Address         *string `json:"address,omitempty"`

	BankAccount *string `json:"bank_account,omitempty"`
	BankIFSC    *string `json:"bank_ifsc,omitempty"`

	EmergencyContactName  *string `json:"emergency_contact_name,omitempty"`
	EmergencyContactPhone *string `json:"emergency_contact_phone,omitempty"`
}

// The statuses an employee record may hold. Leaving is a status, never a
// deletion: the service record, the payroll history and the classes they
// taught all outlive the employment.
var employeeStatuses = []string{
	"active", "on_leave", "suspended", "resigned", "terminated", "retired",
}

var errEmployeeGone = errors.New("no such employee")

/*
updateEmployee corrects a staff record.

	Every field is a pointer, so omitting one leaves it alone and sending an
	empty string clears it. That distinction matters more here than elsewhere:
	a screen that edits four fields of a thirty-field record must not blank the
	other twenty-six by not mentioning them, which is exactly what a PUT would
	do to the first caller who forgot.
*/
func (s *Server) updateEmployee(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	empID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var req employeePatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	for _, f := range []**string{&req.FirstName} {
		if *f != nil {
			**f = strings.TrimSpace(**f)
			if **f == "" {
				httpx.BadRequest(w, r, "a staff record needs a first name")
				return
			}
		}
	}
	if req.Status != nil && !oneOfStr(*req.Status, employeeStatuses...) {
		httpx.BadRequest(w, r, "status must be one of "+strings.Join(employeeStatuses, ", "))
		return
	}
	if req.ExperienceYears != nil && (*req.ExperienceYears < 0 || *req.ExperienceYears > 70) {
		httpx.BadRequest(w, r, "experience must be between 0 and 70 years")
		return
	}

	var name, status string
	var accessEnded bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* A relieving date is what makes a leaver's record readable a year
		   later, so setting a leaving status without one stamps today rather
		   than leaving the question open. It is only ever filled in, never
		   overwritten: a school correcting the date sends it explicitly. */
		relieved := req.RelievedOn
		if relieved == nil && req.Status != nil &&
			oneOfStr(*req.Status, "resigned", "terminated", "retired") {
			today := nowInIndia().Format("2006-01-02")
			relieved = &today
		}

		err := tx.QueryRow(r.Context(), `
			UPDATE employees SET
			    first_name       = COALESCE($2, first_name),
			    last_name        = CASE WHEN $3::text IS NULL THEN last_name ELSE NULLIF($3,'') END,
			    phone            = CASE WHEN $4::text IS NULL THEN phone ELSE NULLIF($4,'') END,
			    email            = CASE WHEN $5::text IS NULL THEN email ELSE NULLIF($5,'')::citext END,
			    department_id    = CASE WHEN $6::text IS NULL THEN department_id ELSE NULLIF($6,'')::uuid END,
			    designation_id   = CASE WHEN $7::text IS NULL THEN designation_id ELSE NULLIF($7,'')::uuid END,
			    employment_type  = COALESCE(NULLIF($8,''), employment_type),
			    status           = COALESCE(NULLIF($9,''), status),
			    joined_on        = COALESCE($10::date, joined_on),
			    confirmed_on     = CASE WHEN $11::text IS NULL THEN confirmed_on ELSE NULLIF($11,'')::date END,
			    -- Filled in, never overwritten by the automatic stamp above.
			    relieved_on      = CASE WHEN $12::text IS NULL THEN relieved_on
			                            ELSE COALESCE(relieved_on, NULLIF($12,'')::date) END,
			    device_user_id   = COALESCE($20, device_user_id),
			    qualification    = CASE WHEN $13::text IS NULL THEN qualification ELSE NULLIF($13,'') END,
			    experience_years = COALESCE($14, experience_years),
			    address          = CASE WHEN $15::text IS NULL THEN address ELSE NULLIF($15,'') END,
			    bank_account     = CASE WHEN $16::text IS NULL THEN bank_account ELSE NULLIF($16,'') END,
			    bank_ifsc        = CASE WHEN $17::text IS NULL THEN bank_ifsc ELSE NULLIF($17,'') END,
			    emergency_contact_name  = CASE WHEN $18::text IS NULL THEN emergency_contact_name ELSE NULLIF($18,'') END,
			    emergency_contact_phone = CASE WHEN $19::text IS NULL THEN emergency_contact_phone ELSE NULLIF($19,'') END,
			    updated_at = now()
			 WHERE id = $1
			 RETURNING btrim(first_name || ' ' || COALESCE(last_name,'')), status`,
			empID, req.FirstName, req.LastName, req.Phone, req.Email,
			req.DepartmentID, req.DesignationID, req.EmploymentType, req.Status,
			req.JoinedOn, req.ConfirmedOn, relieved,
			req.Qualification, req.ExperienceYears, req.Address,
			req.BankAccount, req.BankIFSC,
			req.EmergencyContactName, req.EmergencyContactPhone,
			req.DeviceUserID).Scan(&name, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return errEmployeeGone
		}
		if err != nil {
			return err
		}

		/* SOMEBODY WHO HAS LEFT KEEPS THE RECORD AND LOSES THE KEY.

		   Nothing revoked access, so a teacher who resigned in August could
		   still sign in in December — read the register, open a child's
		   record, message a parent. The product carefully kept every fact
		   about a leaver, which is right, and just as carefully left them the
		   key to the building, which is not.

		   Both halves matter: the account is archived so no new sign-in
		   succeeds, and the live sessions are revoked so the one already open
		   on somebody's phone stops working. Archiving alone leaves them
		   signed in until the cookie expires, which here is a fortnight.

		   Suspension is deliberately NOT in this list. A suspended member of
		   staff is expected back and their access is a separate decision. */
		if req.Status != nil && oneOfStr(*req.Status, "resigned", "terminated", "retired") {
			var uid *uuid.UUID
			if err := tx.QueryRow(r.Context(),
				`SELECT user_id FROM employees WHERE id = $1`, empID).Scan(&uid); err != nil {
				return err
			}
			if uid != nil {
				if err := endAccess(r, tx, *uid); err != nil {
					return err
				}
				accessEnded = true
			}
		}

		/* Carry a new contact detail through to the login.

		   The staff record and the account are two rows, and the number a
		   teacher gives HR lands on the first one. Nothing copied it to the
		   second, so a teacher whose phone number was on file could still only
		   sign in with an employee code — and every role is meant to be
		   reachable by either an email or a number.

		   COALESCE, so this only fills a hole. An account whose email was
		   changed deliberately is not dragged back to whatever the staff
		   record says. A clash with somebody else's number is ignored rather
		   than failing the edit: the correction the office came here to make
		   is still valid, and the duplicate is a separate thing to fix. */
		if req.Phone != nil || req.Email != nil {
			if _, err := tx.Exec(r.Context(), `
				UPDATE users u
				   SET email = COALESCE(u.email, NULLIF($2,'')::citext),
				       phone = COALESCE(u.phone, NULLIF($3,''))
				  FROM employees e
				 WHERE e.id = $1 AND u.id = e.user_id`,
				empID, req.Email, req.Phone); err != nil && !isUniqueViolation(err) {
				return err
			}
		}
		return nil
	})

	switch {
	case errors.Is(err, errEmployeeGone):
		httpx.BadRequest(w, r, "no such staff record in this school")
		return
	case err != nil && strings.Contains(err.Error(), "employees_institution_id_employee_code"):
		httpx.BadRequest(w, r, "another staff record already uses that employee code")
		return
	case err != nil && strings.Contains(err.Error(), "employees_device_user_id"):
		httpx.BadRequest(w, r,
			"another member of staff is already enrolled on the reader under that id — "+
				"two people cannot be the same finger")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": empID.String(), "name": name, "status": status,
		// Said, not left to be noticed. An office that marks somebody resigned
		// should know their sign-in stopped at that moment.
		"login_ended": accessEnded,
	})
}
