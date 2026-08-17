package sis

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

type guardianRepository struct{}

const guardianSelect = `
	SELECT g.id, g.school_id, g.full_name, g.phone, g.email::text, g.occupation,
	       g.employer, g.address, (g.user_id IS NOT NULL)
	FROM   guardians g`

func scanGuardian(row interface{ Scan(...any) error }) (Guardian, error) {
	var g Guardian
	var address []byte
	err := row.Scan(&g.ID, &g.SchoolID, &g.FullName, &g.Phone, &g.Email,
		&g.Occupation, &g.Employer, &address, &g.HasLogin)
	if err != nil {
		return Guardian{}, err
	}
	if len(address) > 0 {
		if err := json.Unmarshal(address, &g.Address); err != nil {
			return Guardian{}, err
		}
	}
	return g, nil
}

func (r guardianRepository) get(ctx context.Context, tx database.Tx, id uuid.UUID) (Guardian, error) {
	return scanGuardian(tx.QueryRow(ctx,
		guardianSelect+` WHERE g.id = $1 AND g.archived_at IS NULL`, id))
}

// listForStudent returns the guardians of one student, with the relationship
// flags and a count of how many children each has at the school — which is what
// tells a front-office clerk they are looking at a sibling family.
func (r guardianRepository) listForStudent(ctx context.Context, tx database.Tx, studentID uuid.UUID) ([]Guardian, error) {
	rows, err := tx.Query(ctx, `
		SELECT g.id, g.school_id, g.full_name, g.phone, g.email::text, g.occupation,
		       g.employer, g.address, (g.user_id IS NOT NULL),
		       sg.relation, sg.is_primary, sg.is_emergency_contact,
		       sg.financial_responsibility, sg.pickup_authorised,
		       (SELECT count(*) FROM student_guardians x
		         WHERE x.guardian_id = g.id AND x.status = 'active')
		FROM   student_guardians sg
		JOIN   guardians g ON g.id = sg.guardian_id
		WHERE  sg.student_id = $1 AND sg.status = 'active' AND g.archived_at IS NULL
		ORDER  BY sg.is_primary DESC, sg.relation`, studentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Guardian{}
	for rows.Next() {
		var g Guardian
		var address []byte
		if err := rows.Scan(&g.ID, &g.SchoolID, &g.FullName, &g.Phone, &g.Email,
			&g.Occupation, &g.Employer, &address, &g.HasLogin,
			&g.Relation, &g.IsPrimary, &g.IsEmergency,
			&g.PaysFees, &g.CanCollect, &g.ChildrenCount); err != nil {
			return nil, err
		}
		if len(address) > 0 {
			if err := json.Unmarshal(address, &g.Address); err != nil {
				return nil, err
			}
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r guardianRepository) insert(ctx context.Context, tx database.Tx,
	orgID uuid.UUID, in CreateGuardianInput) (Guardian, error) {

	address, err := json.Marshal(in.Address)
	if err != nil {
		return Guardian{}, err
	}
	return scanGuardian(tx.QueryRow(ctx, `
		INSERT INTO guardians (organization_id, school_id, full_name, phone, email,
		                       occupation, employer, address)
		VALUES ($1, $2, $3, nullif($4, ''), nullif($5, ''), nullif($6, ''),
		        nullif($7, ''), $8)
		RETURNING id, school_id, full_name, phone, email::text, occupation,
		          employer, address, (user_id IS NOT NULL)`,
		orgID, in.SchoolID, in.FullName, in.Phone, in.Email,
		in.Occupation, in.Employer, address))
}

func (r guardianRepository) clearPrimary(ctx context.Context, tx database.Tx, studentID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		UPDATE student_guardians SET is_primary = false
		WHERE  student_id = $1 AND is_primary AND status = 'active'`, studentID)
	return err
}

func (r guardianRepository) link(ctx context.Context, tx database.Tx,
	orgID, studentID uuid.UUID, in LinkGuardianInput) error {

	_, err := tx.Exec(ctx, `
		INSERT INTO student_guardians (student_id, guardian_id, organization_id, relation,
		                               is_primary, is_emergency_contact,
		                               financial_responsibility, pickup_authorised)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		studentID, in.GuardianID, orgID, in.Relation,
		in.IsPrimary, in.IsEmergency, in.PaysFees, in.CanCollect)
	return err
}

// linkUserAccount connects a guardian record to a login. Called when a parent
// account is provisioned; it is what turns the guardian links into data access.
func (r guardianRepository) linkUserAccount(ctx context.Context, tx database.Tx, guardianID, userID uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE guardians SET user_id = $2, updated_at = now() WHERE id = $1`,
		guardianID, userID)
	return err
}
