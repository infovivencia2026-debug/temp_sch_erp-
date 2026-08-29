package api

/*
Reminder plans: the two automations a school asks for by name.

	finance.student_dues.automated_fee_reminders
	faculty.attendance.absence_alert_to_guardian

Both were blocked on delivery and are not any more -- the dispatcher runs on a
five-minute cron, TypeMessageSend was fixed, and there are now three providers
that can actually put a message on a wire. What was still missing was not a
sender. It was a rule an administrator could write, and a way to find out what
that rule would do before switching it on.

--------------------------------------------------------------------------
What this file is, and what it deliberately is not

It is NOT a second rule engine. Every rule here is a row in
message_trigger_rules, evaluated by applyRule, queued by queueWith, keyed by
the one-per-occurrence index, guarded by the recipient allowlist and drained by
DispatchMessages -- all of which exist in messaging.go and none of which is
reimplemented. What this file adds is the one piece that genuinely was not
there: the finder that knows how an operating policy turns into occurrences.

That is a real gap rather than a stylistic one. knownEvents()' finders answer
"which invoices are overdue" and "who was marked absent". A policy answers
different questions:

  - This invoice is 23 days overdue and we chase weekly from day 7. Is this
    the third chase or the second, and have we already sent the third?
  - This child is absent in six periods today. That is one message.
  - The family reported the absence at 08:40. Say nothing, and withdraw the
    alert if one is already queued.
  - The invoice was paid yesterday. Withdraw Wednesday's reminder.

None of those fit in message_trigger_rules.condition, which is a flat map of
constraints over facts and is deliberately not an expression language. They fit
in a finder, which is exactly where they are.

--------------------------------------------------------------------------
How repetition stays idempotent

The scheduler may run a plan twice; the operator may press "Run now" beside it
while the cron is mid-sweep. A duplicate fee reminder is worse than a late one,
so repetition is derived, never counted:

	attempt = (days_overdue - first_chase_after) / repeat_days

and the occurrence key is invoice_id + "#" + attempt. The one-per-occurrence
index then does the whole job. Running the sweep three hundred times on day 23
produces the same key three hundred times and one message. It also self-heals:
a week the worker was down does not restart the sequence at chase one, because
nothing was counting -- day 23 is the third chase whether or not the first two
went out.

Absence alerts key on student_id + ":" + date, not on the attendance row id,
which is what collapses a child absent in eight periods into one message. The
period-level rows are still eight; the occurrence is one day.
*/

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

// planKinds is the closed set, matching the CHECK in 00103. Closed on purpose,
// unlike message_trigger_rules.event: a plan kind is a finder in this file, so
// a kind nothing implements is a rule that silently never fires.
const (
	planFeeReminder  = "fee_reminder"
	planAbsenceAlert = "absence_alert"
)

// planDefaults describes one kind to the screen, so the client does not carry
// its own copy of which event and template a fee reminder uses.
type planDefaults struct {
	Kind         string `json:"kind"`
	Label        string `json:"label"`
	Event        string `json:"event"`
	TemplateCode string `json:"template_code"`
	Audience     string `json:"audience"`
	Description  string `json:"description"`
}

func planCatalogue() []planDefaults {
	return []planDefaults{
		{
			Kind: planFeeReminder, Label: "Fee reminder", Event: "invoice.overdue",
			TemplateCode: "fees.overdue", Audience: "guardians",
			Description: "Chase an overdue invoice, and stop the moment it is settled.",
		},
		{
			Kind: planAbsenceAlert, Label: "Absence alert", Event: "student.absent",
			TemplateCode: "attendance.absent", Audience: "guardians",
			Description: "Tell a guardian their child is marked absent today, once, after the register is taken.",
		},
	}
}

func planEventFor(kind string) string {
	for _, d := range planCatalogue() {
		if d.Kind == kind {
			return d.Event
		}
	}
	return ""
}

/*
reminderPlan is one message_trigger_rules row read as an operating policy.

	It embeds triggerRule rather than restating it because everything below the
	finder -- audience, channel, template, quiet hours -- is the same fields
	applyRule already reads, and a parallel struct would be two things to keep
	in step.
*/
type reminderPlan struct {
	triggerRule
	Kind          string
	RepeatDays    int
	MaxAttempts   int
	SendAtTime    *string
	SkipExplained bool
	Active        bool
}

/*
firstAfterDays is when the first chase goes out, read from the rule's own
condition rather than stored twice.

	min_days_overdue is already the constraint applyRule filters occurrences
	on. Storing "start after 7 days" a second time in its own column would mean
	a rule whose filter and whose arithmetic could disagree -- and the way that
	disagreement presents is a chase numbered three going out to a family who
	has had one, which is precisely the failure this file exists to prevent.
*/
func (p reminderPlan) firstAfterDays() int {
	key := "min_days_overdue"
	if p.Kind == planAbsenceAlert {
		return 0
	}
	if v, ok := p.Condition[key]; ok {
		return int(toNum(v))
	}
	return 0
}

// gateOpen reports whether the time of day has reached send_at_time. A plan
// with no time set is always open.
//
// Returns the gate as text as well, because "this plan is waiting until 11:30"
// is the answer to "why has nothing gone out this morning" and the screen has
// to be able to say it.
func (p reminderPlan) gateOpen(now time.Time) (bool, string) {
	if p.SendAtTime == nil || strings.TrimSpace(*p.SendAtTime) == "" {
		return true, ""
	}
	mins, ok := parseClock(*p.SendAtTime)
	if !ok {
		return true, ""
	}
	if now.Hour()*60+now.Minute() >= mins {
		return true, ""
	}
	return false, fmt.Sprintf("waiting until %02d:%02d", mins/60, mins%60)
}

// loadPlans reads the plan rules for one school, optionally one kind or one id.
//
// Unlike loadRules it does not filter on is_active: the screen has to list a
// paused plan, and previewing one before switching it on is the whole point of
// the preview. Callers that are actually sending filter on Active themselves.
func (s *Server) loadPlans(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	kind string, only *uuid.UUID) ([]reminderPlan, error) {

	rows, err := tx.Query(ctx, `
		SELECT id, name, event, condition, audience, channel, template_code,
		       lead_minutes, quiet_from::text, quiet_to::text,
		       plan_kind, repeat_days, max_attempts, send_at_time::text,
		       skip_explained, is_active
		  FROM message_trigger_rules
		 WHERE institution_id = $1 AND plan_kind IS NOT NULL
		   AND ($2::text IS NULL OR plan_kind = $2)
		   AND ($3::uuid IS NULL OR id = $3)
		 ORDER BY name`, inst, nullIfEmpty(kind), only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []reminderPlan{}
	for rows.Next() {
		var p reminderPlan
		var cond []byte
		if err := rows.Scan(&p.ID, &p.Name, &p.Event, &cond, &p.Audience, &p.Channel,
			&p.TemplateCode, &p.LeadMinutes, &p.QuietFrom, &p.QuietTo,
			&p.Kind, &p.RepeatDays, &p.MaxAttempts, &p.SendAtTime,
			&p.SkipExplained, &p.Active); err != nil {
			return nil, err
		}
		p.Condition = map[string]any{}
		if len(cond) > 0 {
			_ = json.Unmarshal(cond, &p.Condition)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- the finders -------------------------------------------------------------

/*
planSubjects is the occurrence set for one plan, right now.

	The one piece of machinery this feature genuinely needed and did not have.
	Everything it returns is an ordinary MessageSubject, so applyRule,
	audienceFor, queueWith and the one-per-occurrence index handle it exactly
	as they handle a PTM reminder.
*/
func (s *Server) planSubjects(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	p reminderPlan) ([]MessageSubject, error) {

	switch p.Kind {
	case planFeeReminder:
		return s.feeReminderSubjects(ctx, tx, inst, p)
	case planAbsenceAlert:
		return s.absenceAlertSubjects(ctx, tx, inst, p)
	}
	return nil, fmt.Errorf("unknown plan kind %q", p.Kind)
}

/*
feeReminderSubjects is every unsettled overdue invoice, numbered by which chase
it is due for.

	The stop-when-paid rule is expressed twice, and both halves are needed. The
	WHERE clause here stops a settled invoice ever becoming an occurrence
	again, so no new reminder is created. cancelSettled, below, withdraws the
	reminder that was already queued before the payment landed. Only the first
	would still text a parent who paid yesterday, because a message queued on
	Monday sits in message_log until the dispatcher reaches it -- and the
	dispatcher does not re-ask whether the reason for sending is still true.

	'draft' is excluded as well as 'paid' and 'cancelled'. A draft invoice is
	one the office has not issued; chasing it is chasing a bill nobody has been
	given.
*/
func (s *Server) feeReminderSubjects(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	p reminderPlan) ([]MessageSubject, error) {

	rows, err := tx.Query(ctx, `
		SELECT inv.id, inv.student_id, inv.invoice_no, inv.due_on,
		       (CURRENT_DATE - inv.due_on) AS days_overdue,
		       (inv.net_paise - inv.paid_paise) AS due_paise,
		       concat_ws(' ', st.first_name, st.last_name)
		  FROM invoices inv
		  JOIN students st ON st.id = inv.student_id
		 WHERE inv.institution_id = $1
		   AND inv.status NOT IN ('cancelled','draft','paid')
		   AND inv.due_on IS NOT NULL AND inv.due_on < CURRENT_DATE
		   AND inv.net_paise > inv.paid_paise
		 ORDER BY inv.due_on
		 LIMIT 5000`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	first := p.firstAfterDays()
	out := []MessageSubject{}
	for rows.Next() {
		var id, student uuid.UUID
		var no string
		var due time.Time
		var days int
		var paise int64
		var name string
		if err := rows.Scan(&id, &student, &no, &due, &days, &paise, &name); err != nil {
			return nil, err
		}
		attempt, ok := chaseNumber(days, first, p.RepeatDays, p.MaxAttempts)
		if !ok {
			// Either not due for a first chase yet -- applyRule's condition
			// would drop it anyway, but producing it would inflate the
			// preview's occurrence count with families nobody is chasing --
			// or the cap has been reached and this family is left alone.
			continue
		}
		sid := student
		out = append(out, MessageSubject{
			StudentID: &sid,
			// The attempt is part of the key, which is the whole idempotency
			// story: chase two and chase three are different occurrences of
			// the same invoice, and re-running either sends nothing.
			OccurrenceKey: id.String() + "#" + strconv.Itoa(attempt),
			At:            nowInIndia(),
			Facts: map[string]any{
				"days_overdue":     days,
				"amount_due_paise": paise,
				"chase_no":         attempt + 1,
			},
			Vars: map[string]any{
				"student_name": name,
				"invoice_no":   no,
				"due_on":       due.Format("02 Jan 2006"),
				"days_overdue": days,
				"chase_no":     attempt + 1,
				// Paise to rupees at the edge, never in the ledger.
				"amount_due": fmt.Sprintf("₹%.2f", float64(paise)/100),
			},
		})
	}
	return out, rows.Err()
}

/*
chaseNumber works out which chase an invoice is due for, from nothing but its
age and the policy.

	Derived rather than counted, which is what makes the sweep safe to run
	twice, safe to run three hundred times a day, and safe to miss a week. It
	returns false when the invoice is too young for the first chase or has had
	all the chases the policy allows.

	Integer division is deliberate and the window matters: with first=7 and
	repeat=7, days 7 through 13 are all chase 0 and day 14 is chase 1. So the
	message goes out on the first sweep on or after day 7 -- not only if a
	sweep happens to run on day 7 exactly, which is the version that silently
	skips a family whenever the worker restarts.
*/
func chaseNumber(daysOverdue, first, repeat, max int) (int, bool) {
	if daysOverdue < first {
		return 0, false
	}
	attempt := 0
	if repeat > 0 {
		attempt = (daysOverdue - first) / repeat
	}
	if max < 1 {
		max = 1
	}
	if attempt >= max {
		return 0, false
	}
	return attempt, true
}

/*
absenceAlertSubjects is one occurrence per child per day, not per register.

	Three things it does that the generic student.absent finder does not, each
	of which is the difference between a usable feature and a school switching
	it off in week one:

	  One message, not eight. A secondary school marks a register every
	  period, so a child away all day is eight 'absent' rows. Grouping by
	  (student, date) and keying the occurrence on that pair means the
	  one-per-occurrence index collapses them, whatever order the periods are
	  marked in and however many times the sweep runs.

	  Explained absences are left alone. The portal's one-tap report writes a
	  leave_requests row; so does an ordinary leave application. Either counts,
	  pending or approved -- a school that waits for approval before staying
	  quiet has texted the parent long before anybody in the office opened the
	  queue.

	  Today only, by default. days_ago is carried as a fact so the rule's
	  condition can widen it, but the default max_days_ago of 0 is what stops a
	  Monday-morning sweep telling forty families about Friday.
*/
func (s *Server) absenceAlertSubjects(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	p reminderPlan) ([]MessageSubject, error) {

	rows, err := tx.Query(ctx, `
		SELECT sa.student_id, sa.on_date,
		       (CURRENT_DATE - sa.on_date) AS days_ago,
		       count(*) AS periods,
		       concat_ws(' ', st.first_name, st.last_name),
		       EXISTS (SELECT 1
		                 FROM leave_requests lr
		                WHERE lr.institution_id = $1
		                  AND lr.subject_kind = 'student'
		                  AND lr.student_id = sa.student_id
		                  AND lr.status IN ('pending','approved')
		                  AND sa.on_date BETWEEN lr.from_date AND lr.to_date) AS explained
		  FROM student_attendance sa
		  JOIN students st ON st.id = sa.student_id
		 WHERE sa.institution_id = $1 AND sa.status = 'absent'
		   AND sa.on_date >= CURRENT_DATE - 2
		 GROUP BY sa.student_id, sa.on_date, st.first_name, st.last_name
		 ORDER BY sa.on_date DESC, st.first_name
		 LIMIT 5000`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MessageSubject{}
	for rows.Next() {
		var student uuid.UUID
		var on time.Time
		var daysAgo, periods int
		var name string
		var explained bool
		if err := rows.Scan(&student, &on, &daysAgo, &periods, &name, &explained); err != nil {
			return nil, err
		}
		if explained && p.SkipExplained {
			continue
		}
		sid := student
		out = append(out, MessageSubject{
			StudentID:     &sid,
			OccurrenceKey: student.String() + ":" + on.Format(time.DateOnly),
			At:            nowInIndia(),
			Facts: map[string]any{
				"days_ago":       daysAgo,
				"periods_absent": periods,
			},
			Vars: map[string]any{
				"student_name":   name,
				"on_date":        on.Format("02 Jan 2006"),
				"periods_absent": periods,
			},
		})
	}
	return out, rows.Err()
}

// --- withdrawal --------------------------------------------------------------

/*
cancelSettled withdraws messages this plan queued whose reason has stopped
being true.

	The half of "stop the moment the invoice is paid" that the finder cannot
	do. A reminder queued on Monday sits in message_log until the dispatcher
	reaches it; the dispatcher does not re-ask why it was queued. Without this
	pass, a parent who paid on Tuesday is chased on Wednesday, which is the
	single most embarrassing thing this feature could do.

	Modelled on stopEnrolment in admissions_growth.go, which cancels a nurture
	sequence's pending touches when the lead converts, and for the same reason:
	the row is marked and kept, never deleted, so the school can see that it
	stopped chasing rather than that a message vanished.

	The occurrence key is parsed in SQL, which needs care -- split_part on a
	key that is not a uuid would raise and take the whole sweep with it. The
	CTE is MATERIALIZED to fence the shape test ahead of the cast rather than
	trusting AND to be evaluated left to right, which it is not obliged to be.
*/
func (s *Server) cancelSettled(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	p reminderPlan) (int, error) {

	switch p.Kind {
	case planFeeReminder:
		tag, err := tx.Exec(ctx, `
			WITH pending AS MATERIALIZED (
			    SELECT id, occurrence_key
			      FROM message_log
			     WHERE institution_id = $1 AND source_kind = 'trigger_rule'
			       AND source_id = $2 AND status = 'queued'
			       AND occurrence_key ~ '^[0-9a-fA-F-]{36}#[0-9]+$'
			)
			UPDATE message_log ml
			   SET status = 'cancelled', send_after = NULL, error = $3
			  FROM pending p
			  JOIN invoices inv ON inv.id = split_part(p.occurrence_key, '#', 1)::uuid
			 WHERE ml.id = p.id
			   AND (inv.paid_paise >= inv.net_paise OR inv.status IN ('paid','cancelled'))`,
			inst, p.ID, "withdrawn: the invoice was settled before this reminder went out")
		if err != nil {
			return 0, err
		}
		return int(tag.RowsAffected()), nil

	case planAbsenceAlert:
		if !p.SkipExplained {
			return 0, nil
		}
		tag, err := tx.Exec(ctx, `
			WITH pending AS MATERIALIZED (
			    SELECT id, occurrence_key
			      FROM message_log
			     WHERE institution_id = $1 AND source_kind = 'trigger_rule'
			       AND source_id = $2 AND status = 'queued'
			       AND occurrence_key ~ '^[0-9a-fA-F-]{36}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
			)
			UPDATE message_log ml
			   SET status = 'cancelled', send_after = NULL, error = $3
			  FROM pending p
			 WHERE ml.id = p.id
			   AND EXISTS (SELECT 1
			                 FROM leave_requests lr
			                WHERE lr.institution_id = $1
			                  AND lr.subject_kind = 'student'
			                  AND lr.student_id = split_part(p.occurrence_key, ':', 1)::uuid
			                  AND lr.status IN ('pending','approved')
			                  AND split_part(p.occurrence_key, ':', 2)::date
			                      BETWEEN lr.from_date AND lr.to_date)`,
			inst, p.ID, "withdrawn: the parent explained this absence before the alert went out")
		if err != nil {
			return 0, err
		}
		return int(tag.RowsAffected()), nil
	}
	return 0, nil
}

// --- running -----------------------------------------------------------------

// planRun is what one plan did on one pass, as the screen reads it.
type planRun struct {
	RuleID     string `json:"rule_id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Matched    int    `json:"occurrences"`
	Queued     int    `json:"queued"`
	Duplicates int    `json:"already_sent"`
	Withdrawn  int    `json:"withdrawn"`
	Skipped    string `json:"skipped,omitempty"`
	Error      string `json:"error,omitempty"`
}

/*
runPlans evaluates every live plan for one school.

	Withdrawal happens before sending and happens even when the plan is gated
	or paused. A school that pauses its fee chase still wants Monday's queued
	reminder withdrawn when Tuesday's payment lands -- "paused" means stop
	starting new ones, not keep the ones already in flight.

	A plan whose channel has no provider does not abort the pass. applyRule
	writes the reason onto the rule row via recordRuleRun, and the screen shows
	it beside the plan; the school's other plan on a channel that does work
	still goes out today.
*/
func (s *Server) runPlans(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	only *uuid.UUID, force bool) ([]planRun, error) {

	plans, err := s.loadPlans(ctx, tx, inst, "", only)
	if err != nil {
		return nil, err
	}
	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return nil, err
	}
	now := nowInIndia()

	out := []planRun{}
	for _, p := range plans {
		run := planRun{RuleID: p.ID.String(), Name: p.Name, Kind: p.Kind}

		withdrawn, err := s.cancelSettled(ctx, tx, inst, p)
		if err != nil {
			return out, err
		}
		run.Withdrawn = withdrawn

		if !p.Active {
			run.Skipped = "paused"
			out = append(out, run)
			continue
		}
		// force is the operator pressing "Run now": they are standing at the
		// screen and have decided the register is taken, which is the fact the
		// gate was standing in for.
		if open, why := p.gateOpen(now); !open && !force {
			run.Skipped = why
			out = append(out, run)
			continue
		}

		subjects, err := s.planSubjects(ctx, tx, inst, p)
		if err != nil {
			run.Error = truncate(err.Error(), 300)
			out = append(out, run)
			continue
		}
		run.Matched = len(subjects)

		outcome, err := s.applyRule(ctx, tx, inst, set, p.triggerRule, subjects)
		if err != nil {
			return out, err
		}
		run.Queued, run.Duplicates, run.Error = outcome.Queued, outcome.Duplicates, outcome.Blocked
		if err := s.recordRuleRun(ctx, tx, p.ID, outcome); err != nil {
			return out, err
		}
		out = append(out, run)
	}
	return out, nil
}

/*
RunMessagePlans is the worker's way in.

	Exported and taking only an institution because internal/queue declares the
	interface it needs and internal/api satisfies it structurally -- the same
	inversion QueueOutbound and DispatchMessages already use, for the same
	reason: queue must not import api.

	It opens its own transaction. Unlike EmitMessageEvent, which runs inside
	the register being marked, nothing surrounds a cron tick.
*/
func (s *Server) RunMessagePlans(ctx context.Context, inst uuid.UUID) error {
	return s.DB.InTenant(ctx, tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		_, err := s.runPlans(ctx, tx, inst, nil, false)
		return err
	})
}

// --- the dry run -------------------------------------------------------------

/*
previewRecipient is one person this plan would message, named.

	Named, because "this rule would have messaged 14 guardians" is what stops a
	school switching on something that fires 400 times, and a school that
	cannot see whose 14 does not believe the number.

	Address is masked to its last four characters. The bursar authoring the
	rule can already see a guardian's phone number on the student record, so
	this is not a secret being kept -- it is a preview screen that does not
	become a way to export the school's contact list one rule at a time.
*/
type previewRecipient struct {
	Name    string `json:"name"`
	Student string `json:"student,omitempty"`
	Address string `json:"address"`
	Detail  string `json:"detail,omitempty"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

/*
planPreview is what a plan would do if it ran now, without doing any of it.

	The counts are deliberately five and not one. "Would send 14" alone is the
	number that gets a school to switch a feature on and then conclude it is
	broken, because the fourteen it was promised turn into nothing at the
	allowlist and it has no way to see why. Each of these is a different
	conversation:

	  WouldSend    messages that would actually leave the building today
	  AlreadySent  occurrences this plan has already covered -- the system
	               working, not a fault, and the reason a second preview five
	               minutes later shows a smaller number
	  Suppressed   held by the recipient allowlist, which fails closed: a
	               school with no policy row sends to nobody
	  NoAddress    guardians with no phone or no email on file
	  Collapsed    two guardians of one child, neither with a portal login,
	               who share an occurrence key and therefore one message
*/
type planPreview struct {
	RuleID        string             `json:"rule_id"`
	Name          string             `json:"name"`
	Kind          string             `json:"kind"`
	Channel       string             `json:"channel"`
	ChannelReady  bool               `json:"channel_ready"`
	ChannelReason string             `json:"channel_reason,omitempty"`
	Gate          string             `json:"gate,omitempty"`
	Occurrences   int                `json:"occurrences"`
	Matched       int                `json:"matched"`
	Students      int                `json:"students"`
	WouldSend     int                `json:"would_send"`
	AlreadySent   int                `json:"already_sent"`
	Suppressed    int                `json:"suppressed"`
	NoAddress     int                `json:"no_address"`
	Collapsed     int                `json:"collapsed"`
	GuardMode     string             `json:"guard_mode"`
	GuardNote     string             `json:"guard_note,omitempty"`
	Sample        []previewRecipient `json:"sample"`
	Truncated     int                `json:"truncated"`
}

// sampleLimit caps how many named people a preview returns. Enough to
// recognise the shape of the list; not a bulk export of the parent body.
const sampleLimit = 40

/*
previewPlan runs the whole pipeline and writes nothing.

	It reuses the same finder, the same matchesCondition, the same audienceFor
	and the same recipientGuard the live pass uses -- not a re-description of
	them. A preview built from a second, simpler model of what would happen is
	a preview that is wrong exactly when it matters, which is when somebody
	changed one of the two.

	The one thing it cannot reuse is queueWith, because queueWith writes. So
	the two things queueWith would have decided are decided here explicitly:
	whether the occurrence is already in message_log for this person, and
	whether an address exists at all. Both are read from the same columns the
	one-per-occurrence index keys on.
*/
func (s *Server) previewPlan(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	p reminderPlan) (planPreview, error) {

	view := planPreview{
		RuleID: p.ID.String(), Name: p.Name, Kind: p.Kind, Channel: p.Channel,
		Sample: []previewRecipient{},
	}

	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return view, err
	}
	if prov, ok := set[p.Channel]; ok {
		view.ChannelReady, view.ChannelReason = prov.Configured(), prov.Why()
	} else {
		view.ChannelReason = "unknown channel " + p.Channel
	}

	guard, err := s.loadRecipientGuard(ctx, tx, inst)
	if err != nil {
		return view, err
	}
	view.GuardMode = guard.Mode
	if guard.Mode != "everyone" {
		view.GuardNote = "This school is in allowlist mode: only recipients on the messaging allowlist are sent to, and everything else is logged as suppressed."
	}

	if _, why := p.gateOpen(nowInIndia()); why != "" {
		view.Gate = why
	}

	subjects, err := s.planSubjects(ctx, tx, inst, p)
	if err != nil {
		return view, err
	}
	view.Occurrences = len(subjects)

	// The set of (occurrence, person) pairs this plan has already covered,
	// read once rather than once per recipient. The COALESCEd columns are the
	// ones in message_log_one_per_occurrence, so this answers the same
	// question the index would answer at INSERT time.
	sent := map[string]bool{}
	rows, err := tx.Query(ctx, `
		SELECT occurrence_key,
		       COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
		       COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid)
		  FROM message_log
		 WHERE institution_id = $1 AND source_kind = 'trigger_rule'
		   AND source_id = $2 AND channel = $3
		   AND status <> 'cancelled'`, inst, p.ID, p.Channel)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var key string
		var u, st uuid.UUID
		if err := rows.Scan(&key, &u, &st); err != nil {
			rows.Close()
			return view, err
		}
		sent[key+"|"+u.String()+"|"+st.String()] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return view, err
	}

	students := map[uuid.UUID]bool{}
	seen := map[string]bool{}

	for _, sub := range subjects {
		if !matchesCondition(p.Condition, sub.Facts) {
			continue
		}
		view.Matched++
		if sub.StudentID != nil {
			students[*sub.StudentID] = true
		}
		people, err := s.audienceFor(ctx, tx, inst, p.triggerRule, sub)
		if err != nil {
			return view, err
		}
		for _, person := range people {
			row := previewRecipient{
				Name:    person.Name,
				Student: fmt.Sprint(sub.Vars["student_name"]),
				Address: maskAddress(person.Address),
				Detail:  previewDetail(p.Kind, sub.Vars),
			}
			address := person.Address
			if address == "" && person.UserID != nil {
				// Same fallback queueWith performs: an address on the account
				// where the guardian record carries none.
				addr, err := s.addressFor(ctx, tx, *person.UserID, p.Channel)
				if err != nil {
					return view, err
				}
				address = addr
				row.Address = maskAddress(address)
			}

			key := dedupeKey(sub, person)
			switch {
			case sent[key]:
				view.AlreadySent++
				row.Outcome = "already sent"
				row.Reason = "this plan has already covered this occurrence for this person"
			case seen[key]:
				/* Two guardians of one child, neither with a portal login.

				   The one-per-occurrence index keys on user_id and student_id,
				   both COALESCEd -- so two guardians with no account collapse
				   onto one key and the second insert is refused. That is the
				   index working as designed, but it means "14 guardians" is
				   not 14 messages, and a preview that did not say so would
				   over-promise by exactly the number of families where both
				   parents are on file and neither has signed in. */
				view.Collapsed++
				row.Outcome = "covered"
				row.Reason = "shares a message with another guardian of the same child. Neither has a portal login, so the send is keyed on the child"
			case strings.TrimSpace(address) == "":
				view.NoAddress++
				row.Outcome = "no address"
				row.Reason = "no " + addressWord(p.Channel) + " on file for this guardian"
			default:
				seen[key] = true
				if ok, why := guard.permits(p.Channel, address); !ok {
					view.Suppressed++
					row.Outcome = "suppressed"
					row.Reason = why
				} else {
					view.WouldSend++
					row.Outcome = "would send"
				}
			}
			if len(view.Sample) < sampleLimit {
				view.Sample = append(view.Sample, row)
			} else {
				view.Truncated++
			}
		}
	}
	view.Students = len(students)

	// Would-sends first: the list is read to answer "who is about to be
	// messaged", and burying those under three hundred already-sents is how a
	// preview stops being read at all.
	sort.SliceStable(view.Sample, func(i, j int) bool {
		return outcomeRank(view.Sample[i].Outcome) < outcomeRank(view.Sample[j].Outcome)
	})
	return view, nil
}

func outcomeRank(o string) int {
	switch o {
	case "would send":
		return 0
	case "suppressed":
		return 1
	case "no address":
		return 2
	case "covered":
		return 3
	}
	return 4
}

// dedupeKey reproduces the one-per-occurrence index's key for one prospective
// send. Kept beside the preview rather than shared with queueWith because
// queueWith does not compute it -- Postgres does, from the index -- and a
// helper that looked authoritative would invite somebody to key an INSERT on
// it instead.
func dedupeKey(sub MessageSubject, person recipient) string {
	nil36 := "00000000-0000-0000-0000-000000000000"
	u, st := nil36, nil36
	if person.UserID != nil {
		u = person.UserID.String()
	}
	if sub.StudentID != nil {
		st = sub.StudentID.String()
	}
	return sub.OccurrenceKey + "|" + u + "|" + st
}

func addressWord(channel string) string {
	if channel == "email" {
		return "email address"
	}
	return "mobile number"
}

// previewDetail is the one line that makes a preview row about a real family
// rather than a row in a table: which invoice, which day.
func previewDetail(kind string, vars map[string]any) string {
	switch kind {
	case planFeeReminder:
		return fmt.Sprintf("%v overdue since %v (chase %v)",
			vars["amount_due"], vars["due_on"], vars["chase_no"])
	case planAbsenceAlert:
		return fmt.Sprintf("absent %v", vars["on_date"])
	}
	return ""
}

/*
maskAddress keeps the last four characters and the domain shape.

	Enough for a bursar to recognise a number they know, not enough for the
	preview endpoint to become a contact-list export. An address too short to
	mask is returned as dots rather than in full: the short ones are the
	malformed ones, and a malformed number is exactly what somebody would want
	to read in full for the wrong reason.
*/
func maskAddress(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if at := strings.LastIndex(v, "@"); at > 0 {
		local := v[:at]
		if len(local) <= 2 {
			return "••" + v[at:]
		}
		return local[:1] + strings.Repeat("•", len(local)-1) + v[at:]
	}
	if len(v) <= 4 {
		return strings.Repeat("•", len(v))
	}
	return strings.Repeat("•", len(v)-4) + v[len(v)-4:]
}

// --- HTTP --------------------------------------------------------------------

/*
mountMessageRules registers the two reminder-plan screens.

	Splice point: internal/api/api.go, inside the existing r.Route("/admin")
	group beside s.mountMessaging(r) -- paths here are relative and land under
	/api/v1/admin/messaging/plans. That group carries no group-level
	permission, so every route below names its own.

	Every permission is already in internal/rbac/rbac.go; none was invented,
	and all three are institution-scoped rather than platform:

	  institution.read            see how the plans are configured
	  institution.settings.write  decide who gets chased, how often, and when
	  comms.messages.send         actually cause messages to leave now

	The preview needs more than institution.read, because it names guardians
	and shows a masked contact for each. It is allowed to either the person
	authoring the rule (settings.write) or the person who runs communications
	(messages.send) -- authoring a rule you cannot preview is how a school
	switches on something that fires four hundred times.
*/
func (s *Server) mountMessageRules(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	config := httpx.RequirePermission(rbac.SettingsWrite)
	send := httpx.RequirePermission(rbac.MessagesSend)
	preview := httpx.RequireAnyPermission(rbac.SettingsWrite, rbac.MessagesSend)

	r.With(read).Get("/messaging/plans", s.listReminderPlans)
	r.With(config).Post("/messaging/plans", s.saveReminderPlan)
	r.With(config).Delete("/messaging/plans/{id}", s.deleteReminderPlan)
	r.With(preview).Post("/messaging/plans/{id}/preview", s.previewReminderPlan)
	r.With(send).Post("/messaging/plans/{id}/run", s.runReminderPlan)
}

// planView is one plan as the screen reads it: the policy, plus the four
// things that answer "is this working" -- whether the channel can send, when
// it last ran, how many it sent, and why it is not sending if it is not.
type planView struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Name          string `json:"name"`
	Channel       string `json:"channel"`
	TemplateCode  string `json:"template_code"`
	Audience      string `json:"audience"`
	Active        bool   `json:"is_active"`
	FirstAfter    int    `json:"first_after_days"`
	MinAmountPais int64  `json:"min_amount_paise"`
	RepeatDays    int    `json:"repeat_days"`
	MaxAttempts   int    `json:"max_attempts"`
	SendAtTime    string `json:"send_at_time"`
	SkipExplained bool   `json:"skip_explained"`
	QuietFrom     string `json:"quiet_from"`
	QuietTo       string `json:"quiet_to"`

	ChannelReady  bool    `json:"channel_ready"`
	ChannelReason string  `json:"channel_reason,omitempty"`
	LastRunAt     *string `json:"last_run_at,omitempty"`
	LastQueued    int     `json:"last_queued"`
	LastError     *string `json:"last_error,omitempty"`
	Gate          string  `json:"gate,omitempty"`
	// Withdrawn counts reminders this plan pulled back because the invoice
	// was paid or the absence was explained. The number a school wants when
	// deciding whether to trust the automation with real families.
	Withdrawn int `json:"withdrawn"`
	SentTotal int `json:"sent_total"`
	Waiting   int `json:"waiting"`
}

/*
listReminderPlans is both screens in one call.

	kind= narrows it to one plan family, which is what the two catalogue
	features do: the fee screen must not show a bursar the absence plans, and
	a teacher looking at absence alerts has no business seeing the fee chase.
	The narrowing is a filter and not a permission -- both screens require the
	same institution-scoped rungs, and the split is about what is useful to
	look at, which is stated here rather than pretended to be security.
*/
func (s *Server) listReminderPlans(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind != "" && planEventFor(kind) == "" {
		httpx.BadRequest(w, r, "unknown plan kind")
		return
	}

	items := []planView{}
	codes := []string{}
	guardMode := "allowlist"
	now := nowInIndia()

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := s.loadProviders(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		guard, err := s.loadRecipientGuard(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		guardMode = guard.Mode

		plans, err := s.loadPlans(r.Context(), tx, id.InstitutionID, kind, nil)
		if err != nil {
			return err
		}
		for _, p := range plans {
			v := planView{
				ID: p.ID.String(), Kind: p.Kind, Name: p.Name, Channel: p.Channel,
				TemplateCode: p.TemplateCode, Audience: p.Audience, Active: p.Active,
				FirstAfter: p.firstAfterDays(), RepeatDays: p.RepeatDays,
				MaxAttempts: p.MaxAttempts, SkipExplained: p.SkipExplained,
				QuietFrom: strVal(p.QuietFrom), QuietTo: strVal(p.QuietTo),
				SendAtTime: clockOnly(p.SendAtTime),
			}
			if a, ok := p.Condition["min_amount_due_paise"]; ok {
				v.MinAmountPais = int64(toNum(a))
			}
			if prov, ok := set[p.Channel]; ok {
				v.ChannelReady, v.ChannelReason = prov.Configured(), prov.Why()
			} else {
				v.ChannelReason = "unknown channel " + p.Channel
			}
			if _, why := p.gateOpen(now); why != "" {
				v.Gate = why
			}
			if err := tx.QueryRow(r.Context(), `
				SELECT to_char(last_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', last_queued, last_error
				  FROM message_trigger_rules WHERE id = $1`, p.ID).
				Scan(&v.LastRunAt, &v.LastQueued, &v.LastError); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*) FILTER (WHERE status IN ('sent','delivered','read')),
				       count(*) FILTER (WHERE status = 'queued'),
				       count(*) FILTER (WHERE status = 'cancelled')
				  FROM message_log
				 WHERE institution_id = $1 AND source_kind = 'trigger_rule' AND source_id = $2`,
				id.InstitutionID, p.ID).Scan(&v.SentTotal, &v.Waiting, &v.Withdrawn); err != nil {
				return err
			}
			items = append(items, v)
		}

		rows, err := tx.Query(r.Context(), `
			SELECT DISTINCT code FROM message_templates
			 WHERE institution_id = $1 AND is_active ORDER BY code`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err != nil {
				return err
			}
			codes = append(codes, c)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Built-in codes are offered alongside the school's own, because a school
	// that has written no template still has a working reminder -- the sender
	// falls back. Offering only the school's own would make an empty
	// message_templates look like a prerequisite it is not.
	for _, d := range planCatalogue() {
		if !contains(codes, d.TemplateCode) {
			codes = append(codes, d.TemplateCode)
		}
	}
	sort.Strings(codes)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"kinds":      planCatalogue(),
		"channels":   messagingChannels,
		"templates":  codes,
		"guard_mode": guardMode,
	})
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// clockOnly trims a Postgres time to HH:MM, which is what an <input type=time>
// round-trips. '11:30:00' posted back unchanged would still be valid, but the
// control renders it with a seconds box nobody wants to fill in.
func clockOnly(v *string) string {
	if v == nil {
		return ""
	}
	s := strings.TrimSpace(*v)
	if len(s) >= 5 {
		return s[:5]
	}
	return s
}

type planSaveRequest struct {
	ID            string `json:"id,omitempty"`
	Kind          string `json:"kind"`
	Name          string `json:"name"`
	Channel       string `json:"channel"`
	TemplateCode  string `json:"template_code"`
	Active        bool   `json:"is_active"`
	FirstAfter    int    `json:"first_after_days"`
	MinAmountPais int64  `json:"min_amount_paise"`
	RepeatDays    int    `json:"repeat_days"`
	MaxAttempts   int    `json:"max_attempts"`
	SendAtTime    string `json:"send_at_time"`
	SkipExplained bool   `json:"skip_explained"`
	QuietFrom     string `json:"quiet_from"`
	QuietTo       string `json:"quiet_to"`
}

/*
saveReminderPlan writes the policy as a message_trigger_rules row.

	The event, the audience and the condition are derived here rather than
	asked for. A bursar does not know what 'invoice.overdue' is or that
	{"min_days_overdue": 7} is how a week is expressed, and a screen that asked
	would be the JSON payload this feature exists to remove. The derivation is
	one-way on purpose: the friendly fields are the truth, and the condition is
	rebuilt from them on every save, so the two cannot drift.
*/
func (s *Server) saveReminderPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req planSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	event := planEventFor(req.Kind)
	if event == "" {
		httpx.BadRequest(w, r, "unknown plan kind")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "give the plan a name. It is what appears beside every message it sends")
		return
	}
	if !knownChannel(req.Channel) {
		httpx.BadRequest(w, r, "unknown channel")
		return
	}
	req.TemplateCode = strings.TrimSpace(req.TemplateCode)
	if req.TemplateCode == "" {
		httpx.BadRequest(w, r, "name a template")
		return
	}
	if req.MaxAttempts < 1 {
		req.MaxAttempts = 1
	}
	if req.MaxAttempts > 12 {
		httpx.BadRequest(w, r, "twelve chases is the most this will send. Beyond that it is not a reminder")
		return
	}
	if req.RepeatDays < 0 || req.RepeatDays > 365 {
		httpx.BadRequest(w, r, "repeat must be between 0 and 365 days")
		return
	}
	// The CHECK in 00103 refuses this pair; catching it here turns a 500 into
	// a sentence the person filling in the form can act on.
	if req.RepeatDays > 0 && req.MaxAttempts < 2 {
		httpx.BadRequest(w, r,
			"a repeat with one attempt only ever sends once. Either raise the cap or set the repeat to 0")
		return
	}
	if req.FirstAfter < 0 || req.FirstAfter > 365 {
		httpx.BadRequest(w, r, "the first reminder must be between 0 and 365 days")
		return
	}
	if req.MinAmountPais < 0 {
		httpx.BadRequest(w, r, "the minimum amount cannot be negative")
		return
	}
	if (req.QuietFrom == "") != (req.QuietTo == "") {
		httpx.BadRequest(w, r, "set both ends of the quiet window, or neither")
		return
	}
	if req.SendAtTime != "" {
		if _, ok := parseClock(req.SendAtTime); !ok {
			httpx.BadRequest(w, r, "send-after time must be HH:MM")
			return
		}
	}

	condition := map[string]any{}
	switch req.Kind {
	case planFeeReminder:
		if req.FirstAfter > 0 {
			condition["min_days_overdue"] = req.FirstAfter
		}
		if req.MinAmountPais > 0 {
			condition["min_amount_due_paise"] = req.MinAmountPais
		}
		// A fee chase has no time-of-day gate: an invoice is overdue all day,
		// and quiet hours already keep the message out of the night.
		req.SendAtTime = ""
	case planAbsenceAlert:
		// Today only. The finder carries days_ago as a fact so a school that
		// wants yesterday's absences too can widen this from the generic
		// trigger screen; the default is what stops a Monday sweep telling
		// forty families about Friday.
		condition["max_days_ago"] = 0
		req.RepeatDays, req.MaxAttempts = 0, 1
	}
	condJSON, err := json.Marshal(condition)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID == "" {
			return tx.QueryRow(r.Context(), `
				INSERT INTO message_trigger_rules
				    (institution_id, name, event, condition, audience, channel,
				     template_code, lead_minutes, quiet_from, quiet_to, is_active,
				     plan_kind, repeat_days, max_attempts, send_at_time, skip_explained)
				VALUES ($1,$2,$3,$4,'guardians',$5,$6,0,
				        NULLIF($7,'')::time, NULLIF($8,'')::time, $9,
				        $10,$11,$12, NULLIF($13,'')::time, $14)
				RETURNING id::text`,
				id.InstitutionID, req.Name, event, condJSON, req.Channel, req.TemplateCode,
				req.QuietFrom, req.QuietTo, req.Active,
				req.Kind, req.RepeatDays, req.MaxAttempts, req.SendAtTime, req.SkipExplained).
				Scan(&newID)
		}
		ruleID, perr := uuid.Parse(req.ID)
		if perr != nil {
			return errBadPlanID
		}
		// plan_kind is in the WHERE and never in the SET. A row authored on
		// the generic trigger screen must not become a plan by being posted
		// here, and a fee plan must not become an absence plan -- either would
		// leave live message_log rows whose occurrence keys the new finder
		// cannot parse.
		tag, err := tx.Exec(r.Context(), `
			UPDATE message_trigger_rules
			   SET name = $3, condition = $4, channel = $5, template_code = $6,
			       quiet_from = NULLIF($7,'')::time, quiet_to = NULLIF($8,'')::time,
			       is_active = $9, repeat_days = $10, max_attempts = $11,
			       send_at_time = NULLIF($12,'')::time, skip_explained = $13,
			       updated_at = now()
			 WHERE id = $1 AND institution_id = $2 AND plan_kind = $14`,
			ruleID, id.InstitutionID, req.Name, condJSON, req.Channel, req.TemplateCode,
			req.QuietFrom, req.QuietTo, req.Active,
			req.RepeatDays, req.MaxAttempts, req.SendAtTime, req.SkipExplained, req.Kind)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNoSuchPlan
		}
		newID = req.ID
		return nil
	})
	switch {
	case errors.Is(err, errBadPlanID), errors.Is(err, errNoSuchPlan):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

var (
	errBadPlanID  = errors.New("not a plan id")
	errNoSuchPlan = errors.New("no such plan")
)

/*
deleteReminderPlan removes the policy and leaves the history.

	message_log rows this plan produced are not touched. They are the record
	of what a family was actually told, which outlives the rule that told them
	-- and a school answering "why did I get this text in August" after the
	plan was deleted in September still has to be able to answer it.

	Queued rows are withdrawn rather than left, because nothing will ever run
	the plan again to withdraw them and a message with no rule behind it is one
	nobody can explain.
*/
func (s *Server) deleteReminderPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ruleID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var withdrawn int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE message_log
			   SET status = 'cancelled', send_after = NULL,
			       error = 'withdrawn: the reminder plan behind it was deleted'
			 WHERE institution_id = $1 AND source_kind = 'trigger_rule'
			   AND source_id = $2 AND status = 'queued'`, id.InstitutionID, ruleID)
		if err != nil {
			return err
		}
		withdrawn = tag.RowsAffected()
		tag, err = tx.Exec(r.Context(), `
			DELETE FROM message_trigger_rules
			 WHERE id = $1 AND institution_id = $2 AND plan_kind IS NOT NULL`,
			ruleID, id.InstitutionID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNoSuchPlan
		}
		return nil
	})
	if errors.Is(err, errNoSuchPlan) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true, "withdrawn": withdrawn})
}

// previewReminderPlan is the dry run. It opens a read-only pass over the same
// pipeline the live run uses and writes nothing.
func (s *Server) previewReminderPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ruleID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var view planPreview
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		plans, err := s.loadPlans(r.Context(), tx, id.InstitutionID, "", &ruleID)
		if err != nil {
			return err
		}
		if len(plans) == 0 {
			return errNoSuchPlan
		}
		view, err = s.previewPlan(r.Context(), tx, id.InstitutionID, plans[0])
		return err
	})
	if errors.Is(err, errNoSuchPlan) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, view)
}

/*
runReminderPlan is the operator pressing "Run now".

	force is true: the person is standing at the screen, and the send-after
	gate exists to guess at what they have just decided -- that the register is
	taken. Overriding a guess with the fact is the right way round.

	It queues; it does not send. Draining message_log is DispatchMessages'
	job, on its five-minute cron, so that one road out of the building keeps
	the recipient allowlist in front of every message.
*/
func (s *Server) runReminderPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ruleID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var runs []planRun
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		plans, err := s.loadPlans(r.Context(), tx, id.InstitutionID, "", &ruleID)
		if err != nil {
			return err
		}
		if len(plans) == 0 {
			return errNoSuchPlan
		}
		runs, err = s.runPlans(r.Context(), tx, id.InstitutionID, &ruleID, true)
		return err
	})
	if errors.Is(err, errNoSuchPlan) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"runs": runs})
}
