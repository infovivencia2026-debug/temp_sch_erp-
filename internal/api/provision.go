package api

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/rbac"
)

/* Making a school exist.

   Two doors lead here and they must arrive at the same place. The seller
   provisions from the console after a telephone call; a school that would
   rather not wait for the telephone subscribes on the website and provisions
   itself the moment the payment clears. If those two paths built the tenant
   differently, one of them would eventually build it wrong — a missing role
   seed, a campus that never got created, an administrator holding a role that
   does not exist in their own institution — and it would be the self-service
   path, because nobody watches it happen.

   So both call provisionSchool. The only thing the caller decides is who is
   paying and what to do with the credentials afterwards. */

// provisionParams is one school's worth of facts, gathered by whichever door
// the customer came through.
type provisionParams struct {
	SchoolName string
	ShortName  string
	District   string
	State      string
	Board      string
	PlanCode   string

	AdminName     string
	AdminEmail    string
	AdminPhone    string
	AdminUsername string

	// TrialDays is honoured only when the subscription starts as a trial.
	// A school that has paid does not get a trial; it gets a year.
	TrialDays int
	// Paid marks a subscription that money has already cleared for, which is
	// what separates a website subscription from a salesperson's handshake.
	Paid bool
}

// provisionResult is the handover: the identifiers the caller needs, and the
// one-time password, which exists in readable form here and nowhere else.
type provisionResult struct {
	InstitutionID uuid.UUID
	UserID        uuid.UUID
	Slug          string
	SignInAs      string
	Password      string
}

var errNoAdminContact = errors.New(
	"give the administrator an email, a phone number or a username — " +
		"without one of the three they cannot sign in")

// validate checks what the database cannot. A NOT NULL constraint will catch a
// missing school name, but it will not catch an administrator nobody can
// identify at the sign-in box, and that failure surfaces days later when the
// credentials do not work.
func (p *provisionParams) validate() error {
	if p.SchoolName == "" {
		return errors.New("the school needs a name")
	}
	if p.AdminName == "" {
		return errNoAdminName
	}
	if p.AdminEmail == "" && p.AdminPhone == "" && p.AdminUsername == "" {
		return errNoAdminContact
	}
	return nil
}

// provisionSchool creates the institution, its first campus, its first
// administrator and its subscription, and seeds the tenant's whole role set.
//
// Runs inside the caller's transaction so that a failure anywhere leaves no
// half-built school behind: a tenant with no administrator is worse than no
// tenant, because it looks like a customer in every report and cannot be
// signed in to.
func provisionSchool(ctx context.Context, tx pgx.Tx, hasher *auth.Hasher, p provisionParams) (provisionResult, error) {
	var out provisionResult
	if err := p.validate(); err != nil {
		return out, err
	}

	short := p.ShortName
	if short == "" {
		short = deriveShortName(p.SchoolName)
	}

	password, err := temporaryPassword()
	if err != nil {
		return out, err
	}
	hash, err := hasher.Hash(password)
	if err != nil {
		return out, err
	}
	out.Password = password

	if p.PlanCode != "" {
		var ok bool
		if err := tx.QueryRow(ctx,
			`SELECT true FROM plans WHERE code = $1`, p.PlanCode).Scan(&ok); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return out, errNoPlan
			}
			return out, err
		}
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO institutions (name, short_name, slug, district, state,
		                          affiliation_board, status)
		VALUES ($1,$2,$3::citext,$4,$5,$6,'active')
		RETURNING id, slug::text`,
		p.SchoolName, short, slugify(p.SchoolName), nullString(p.District),
		nullString(p.State), nullString(p.Board)).
		Scan(&out.InstitutionID, &out.Slug); err != nil {
		if isUniqueViolation(err) {
			return out, errNameTaken
		}
		return out, err
	}

	// A campus, because every scoped table needs one and asking the principal
	// to invent one before they can do anything is a poor first instruction.
	// They rename it in the setup wizard.
	if _, err := tx.Exec(ctx, `
		INSERT INTO campuses (institution_id, name, code)
		VALUES ($1, 'Main Campus', 'MAIN')`, out.InstitutionID); err != nil {
		return out, err
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO users (institution_id, email, phone, username, full_name,
		                   password_hash, status)
		VALUES ($1, $2::citext, $3, $4::citext, $5, $6, 'active')
		RETURNING id`,
		out.InstitutionID, nullString(p.AdminEmail), nullString(p.AdminPhone),
		nullString(p.AdminUsername), p.AdminName, hash).Scan(&out.UserID); err != nil {
		if isUniqueViolation(err) {
			return out, errContactTaken
		}
		return out, err
	}

	// The whole institution_admin bundle, seeded per tenant by the same path a
	// normal school uses, so the first account is not a special case.
	if err := rbac.SeedInstitution(ctx, tx, out.InstitutionID); err != nil {
		return out, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id, institution_id)
		SELECT $1, r.id, $2 FROM roles r
		 WHERE r.key = 'institution_admin' AND r.institution_id = $2
		ON CONFLICT DO NOTHING`, out.UserID, out.InstitutionID); err != nil {
		return out, err
	}

	if p.PlanCode != "" {
		if err := startSubscription(ctx, tx, out.InstitutionID, p); err != nil {
			return out, err
		}
	}

	out.SignInAs = firstNonEmpty(p.AdminUsername, p.AdminEmail, p.AdminPhone)
	return out, nil
}

// startSubscription opens the school's subscription.
//
// A school that has paid starts active with a year on the clock. A school the
// seller is courting starts on trial, and the trial length is the seller's to
// choose. Conflating the two would either bill a prospect or give a paying
// customer a countdown they already settled.
func startSubscription(ctx context.Context, tx pgx.Tx, inst uuid.UUID, p provisionParams) error {
	var cap *int
	_ = tx.QueryRow(ctx,
		`SELECT max_students FROM plans WHERE code = $1`, p.PlanCode).Scan(&cap)

	if p.Paid {
		_, err := tx.Exec(ctx, `
			INSERT INTO subscriptions (institution_id, plan_code, status,
			                           started_on, renews_on, licensed_students)
			VALUES ($1, $2, 'active', CURRENT_DATE,
			        CURRENT_DATE + interval '1 year', $3)`,
			inst, p.PlanCode, cap)
		return err
	}

	trial := p.TrialDays
	if trial <= 0 {
		trial = 30
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO subscriptions (institution_id, plan_code, status,
		                           started_on, trial_ends_on, renews_on,
		                           licensed_students)
		VALUES ($1, $2, 'trial', CURRENT_DATE,
		        CURRENT_DATE + make_interval(days => $3::int),
		        CURRENT_DATE + interval '1 year', $4)`,
		inst, p.PlanCode, trial, cap)
	return err
}

var errContactTaken = errors.New("that email, phone or username is already in use")

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
