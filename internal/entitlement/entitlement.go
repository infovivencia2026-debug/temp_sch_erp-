// Package entitlement answers one question: what has this school paid for?
//
// Three things were already in the database and never joined up. plans.modules
// says what a tier includes. subscriptions says whether the school is paying.
// module_settings says which modules are switched on, with a comment promising
// it exists so the client can "hide what the school has not bought" — and
// nothing ever wrote to it from a plan, so every tenant saw every module and
// the tiers were priced fiction.
//
// This is the join. It is deliberately a separate concern from RBAC:
//
//	permissions answer "may this person do it?"
//	entitlement answers "has this school bought it?"
//
// A principal holds fees.write on the cheapest plan and still must not reach
// the fee counter, because the school did not buy that module. Conflating the
// two would mean revoking a principal's permissions to express a billing fact,
// and restoring them on upgrade — which is how schools end up with a principal
// who quietly lost the ability to approve leave.
package entitlement

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Module names, matching plans.modules and the labels on the pricing page.
const (
	Students      = "students"
	Academics     = "academics"
	Attendance    = "attendance"
	Fees          = "fees"
	Communication = "communication"
	Exams         = "exams"
	HR            = "hr"
	Transport     = "transport"
	Library       = "library"
	Hostel        = "hostel"
	Inventory     = "inventory"
)

// All is every sellable module, in the order the pricing page lists them.
var All = []string{
	Students, Academics, Attendance, Fees, Communication,
	Exams, HR, Transport, Library, Hostel, Inventory,
}

/* Known reports whether a name is one of the modules a school can buy.

   The vendor types module names when writing a plan, and a name that is not a
   module would switch nothing on while reading as though it had. Checked
   against the same list Allows enforces, so the price list and the gate cannot
   drift into disagreeing about what a module is called. */
func Known(module string) bool {
	for _, m := range All {
		if m == module {
			return true
		}
	}
	return false
}

// sectionModule maps a catalog section to the module a school buys it in.
//
// Sections absent from this map are core: the school's own identity, the
// dashboard, approvals, a user's own profile, and the statutory returns every
// Indian school owes whatever it paid. Locking those behind a tier would mean
// selling a school a system it cannot log in to and use, which is not a tier,
// it is a hostage.
//
// Keyed by section slug rather than by feature key because a section is the
// unit a school recognises — "we did not buy the hostel module" — and because
// 490 feature keys would rot the first time somebody added a feature.
var sectionModule = map[string]string{
	// Students and the pipeline that creates them.
	"students":     Students,
	"admissions":   Students,
	"enquiries":    Students,
	"applications": Students,

	// Teaching and learning.
	"academics":                    Academics,
	"my_classes":                   Academics,
	"teaching":                     Academics,
	"timetable":                    Academics,
	"learning":                     Academics,
	"homework":                     Academics,
	"department":                   Academics,
	"assessment_schemes":           Academics,
	"question_papers_online_tests": Academics,

	"attendance": Attendance,

	// Money in.
	"fees":                Fees,
	"collections":         Fees,
	"student_dues":        Fees,
	"fee_structure":       Fees,
	"concessions_refunds": Fees,
	"reconciliation":      Fees,
	"ledgers":             Fees,
	"payables":            Fees,
	"assets_budget":       Fees,

	"communication":    Communication,
	"messaging":        Communication,
	"messages":         Communication,
	"notices_calendar": Communication,

	"examinations":       Exams,
	"exams_results":      Exams,
	"marks_report_cards": Exams,
	"evaluation":         Exams,

	"directory_workload": HR,
	"onboarding_exit":    HR,
	"verification":       HR,
	"leave":              HR,
	"payroll":            HR,
	"statutory":          HR,
	"hiring_growth":      HR,
	"welfare":            HR,

	"transport":     Transport,
	"my_childs_bus": Transport,

	"library": Library,
	"hostel":  Hostel,
	"stores":  Inventory,
}

// ModuleFor returns the module a section belongs to, and whether it is
// sellable at all. Core sections return ("", false).
func ModuleFor(sectionSlug string) (string, bool) {
	m, ok := sectionModule[sectionSlug]
	return m, ok
}

// State is one school's commercial standing, resolved once per request.
type State struct {
	// Active is false when the school cannot use the system: no subscription
	// was ever created, the trial ran out, or the seller suspended it. The
	// account still signs in — being locked out of your own data because an
	// invoice is late is how a school loses a term's attendance — but every
	// tenant endpoint refuses until it is settled.
	Active bool
	// Reason is shown to the user, so it is written for a head teacher rather
	// than for a log.
	Reason string
	// Code is for the client to branch on: none, expired, suspended, past_due.
	Code string

	PlanCode    string
	PlanName    string
	Status      string
	TrialEndsOn *time.Time

	/* Whether this pack may link the school's OWN messaging vendor.
	 *
	 * The two arrangements are commercially opposite. Without it the school
	 * sends through the seller's account and buys credits to do so, and the
	 * meter is what makes that safe. With it the school pays its own vendor
	 * and the seller is not in the middle.
	 *
	 * Not a module, deliberately: every value in that array is a catalogue
	 * section somebody can navigate to, and a capability hiding among them
	 * would show up as a module nobody can open. */
	CustomIntegration bool

	// modules is what the plan includes. Empty means every module — the top
	// tier stores an empty array rather than listing all eleven, so that
	// adding a twelfth module does not silently exclude it from the plan that
	// is meant to contain everything.
	modules map[string]bool
	all     bool
}

// Allows reports whether a section is included in what the school bought.
func (s State) Allows(sectionSlug string) bool {
	mod, sellable := ModuleFor(sectionSlug)
	if !sellable {
		return true // core
	}
	if s.all {
		return true
	}
	return s.modules[mod]
}

// Modules lists the included module names, for the session payload.
func (s State) Modules() []string {
	if s.all {
		return append([]string(nil), All...)
	}
	out := make([]string, 0, len(s.modules))
	for _, m := range All {
		if s.modules[m] {
			out = append(out, m)
		}
	}
	return out
}

// Platform is the standing of a user who belongs to no school. The vendor's
// own staff are not customers and have nothing to buy.
func Platform() State {
	return State{Active: true, all: true, PlanCode: "platform", Status: "platform",
		CustomIntegration: true}
}

// Resolve reads the school's subscription and the plan behind it.
//
// A missing subscription is not an error. A school provisioned before billing
// existed, or one the vendor runs for free, has no row — and the honest answer
// is "no plan", not a 500.
func Resolve(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (State, error) {
	var (
		st        State
		planCode  *string
		planName  *string
		status    *string
		trialEnds *time.Time
		mods      []string
		custom    *bool
	)
	err := tx.QueryRow(ctx, `
		SELECT s.plan_code, p.name, s.status, s.trial_ends_on, p.modules,
		       p.custom_integration
		  FROM subscriptions s
		  LEFT JOIN plans p ON p.code = s.plan_code
		 WHERE s.institution_id = $1
		 ORDER BY s.started_on DESC NULLS LAST
		 LIMIT 1`, inst).Scan(&planCode, &planName, &status, &trialEnds, &mods, &custom)
	if err != nil && err != pgx.ErrNoRows {
		return st, err
	}

	if err == pgx.ErrNoRows || status == nil {
		return State{
			Active: false, Code: "none",
			Reason: "This school does not have a subscription yet. " +
				"Choose a plan to switch the system on.",
		}, nil
	}

	st.Status = *status
	if planCode != nil {
		st.PlanCode = *planCode
	}
	if planName != nil {
		st.PlanName = *planName
	}
	st.TrialEndsOn = trialEnds
	st.CustomIntegration = custom != nil && *custom

	st.modules = make(map[string]bool, len(mods))
	for _, m := range mods {
		st.modules[m] = true
	}
	st.all = len(mods) == 0

	switch st.Status {
	case "active":
		st.Active = true
	case "trial":
		// A trial that ended is not a subscription. Checked here rather than
		// by a nightly job so that the lock happens on the day it should,
		// whether or not the job ran.
		if trialEnds != nil && trialEnds.Before(time.Now()) {
			st.Active, st.Code = false, "expired"
			st.Reason = "Your trial ended on " + trialEnds.Format("2 January 2006") +
				". Subscribe to carry on where you left off — your data is all still here."
			return st, nil
		}
		st.Active = true
	case "past_due":
		st.Active, st.Code = false, "past_due"
		st.Reason = "We have not been able to collect this year's subscription. " +
			"Settle the invoice and the system switches straight back on."
	case "suspended":
		st.Active, st.Code = false, "suspended"
		st.Reason = "This school's account is suspended. Please contact us."
	case "cancelled":
		st.Active, st.Code = false, "cancelled"
		st.Reason = "This subscription was cancelled. Your data is retained — " +
			"subscribe again to reopen the school."
	default:
		st.Active, st.Code = false, "none"
		st.Reason = "This school does not have an active subscription."
	}
	return st, nil
}

// ApplyPlan switches on exactly the modules a plan includes, and switches off
// the rest.
//
// Written on purchase and on any plan change, so module_settings is a
// consequence of what was bought rather than a thing somebody remembers to
// tick. Off rows are written explicitly rather than left absent: a school that
// downgrades must lose the module, and an absent row is indistinguishable from
// one that was never considered.
func ApplyPlan(ctx context.Context, tx pgx.Tx, inst uuid.UUID, planCode string) error {
	var mods []string
	if err := tx.QueryRow(ctx,
		`SELECT modules FROM plans WHERE code = $1`, planCode).Scan(&mods); err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	included := make(map[string]bool, len(mods))
	for _, m := range mods {
		included[m] = true
	}
	everything := len(mods) == 0

	for _, m := range All {
		on := everything || included[m]
		if _, err := tx.Exec(ctx, `
			INSERT INTO module_settings (institution_id, module, enabled)
			VALUES ($1,$2,$3)
			ON CONFLICT (institution_id, module)
			DO UPDATE SET enabled = EXCLUDED.enabled`, inst, m, on); err != nil {
			return err
		}
	}
	return nil
}
