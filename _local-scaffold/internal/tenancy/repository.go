package tenancy

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

// repository holds the SQL. No transactions are opened here — the service owns
// them, which is what allows the audit write to share one.
//
// Note that none of these queries filter on organization_id. They do not need
// to: RLS does it on the connection, and a query that forgets is not a leak but
// an empty result. The scope filter (which schools this actor may see) is a
// different question and is passed in explicitly.
type repository struct{}

const schoolColumns = `id, organization_id, name, code, board, address,
	timezone, locale, currency, created_at, updated_at, archived_at`

func scanSchool(row interface{ Scan(...any) error }) (School, error) {
	var s School
	var address []byte
	err := row.Scan(&s.ID, &s.OrganizationID, &s.Name, &s.Code, &s.Board, &address,
		&s.Timezone, &s.Locale, &s.Currency, &s.CreatedAt, &s.UpdatedAt, &s.ArchivedAt)
	if err != nil {
		return School{}, err
	}
	if len(address) > 0 {
		if err := json.Unmarshal(address, &s.Address); err != nil {
			return School{}, err
		}
	}
	if s.Address == nil {
		s.Address = map[string]any{}
	}
	return s, nil
}

func (r repository) list(ctx context.Context, tx database.Tx, scope []uuid.UUID, in ListInput) ([]School, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+schoolColumns+`
		FROM   schools
		WHERE  ($1::uuid[] IS NULL OR id = ANY($1))
		  AND  ($2 OR archived_at IS NULL)
		  AND  ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')
		ORDER  BY name
		LIMIT  $4`,
		scopeArg(scope), in.IncludeArchived, nullifEmpty(in.Search), in.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []School{}
	for rows.Next() {
		s, err := scanSchool(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r repository) count(ctx context.Context, tx database.Tx, scope []uuid.UUID, in ListInput) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM   schools
		WHERE  ($1::uuid[] IS NULL OR id = ANY($1))
		  AND  ($2 OR archived_at IS NULL)
		  AND  ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')`,
		scopeArg(scope), in.IncludeArchived, nullifEmpty(in.Search)).Scan(&total)
	return total, err
}

func (r repository) get(ctx context.Context, tx database.Tx, id uuid.UUID) (School, error) {
	return scanSchool(tx.QueryRow(ctx,
		`SELECT `+schoolColumns+` FROM schools WHERE id = $1`, id))
}

// getForUpdate takes a row lock so a concurrent update cannot slip between the
// read and the write inside the same transaction.
func (r repository) getForUpdate(ctx context.Context, tx database.Tx, id uuid.UUID) (School, error) {
	return scanSchool(tx.QueryRow(ctx,
		`SELECT `+schoolColumns+` FROM schools WHERE id = $1 FOR UPDATE`, id))
}

func (r repository) insert(ctx context.Context, tx database.Tx, orgID, actorID uuid.UUID, in CreateInput) (School, error) {
	address, err := json.Marshal(in.Address)
	if err != nil {
		return School{}, err
	}
	return scanSchool(tx.QueryRow(ctx, `
		INSERT INTO schools (organization_id, name, code, board, address,
		                     timezone, locale, created_by, updated_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
		RETURNING `+schoolColumns,
		orgID, in.Name, in.Code, in.Board, address, in.Timezone, in.Locale, actorID))
}

func (r repository) update(ctx context.Context, tx database.Tx, actorID uuid.UUID, s School) (School, error) {
	address, err := json.Marshal(s.Address)
	if err != nil {
		return School{}, err
	}
	return scanSchool(tx.QueryRow(ctx, `
		UPDATE schools
		SET    name = $2, board = $3, address = $4, timezone = $5, locale = $6,
		       updated_at = now(), updated_by = $7
		WHERE  id = $1
		RETURNING `+schoolColumns,
		s.ID, s.Name, s.Board, address, s.Timezone, s.Locale, actorID))
}

func (r repository) archive(ctx context.Context, tx database.Tx, actorID, id uuid.UUID) (School, error) {
	return scanSchool(tx.QueryRow(ctx, `
		UPDATE schools
		SET    archived_at = now(), updated_at = now(), updated_by = $2
		WHERE  id = $1
		RETURNING `+schoolColumns, id, actorID))
}

// scopeArg turns an empty scope into SQL NULL, which the queries read as
// "organisation-wide" rather than "no schools".
func scopeArg(scope []uuid.UUID) any {
	if len(scope) == 0 {
		return nil
	}
	return scope
}

func nullifEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
