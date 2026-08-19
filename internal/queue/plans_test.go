package queue

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

/*
The reminder plans have to be on the schedule, or they are a screen with a
button.

	This is the same class of bug the dispatch entry was added for: everything
	below worked, nothing above ran it, and the symptom was a feature that
	looked configured and silently did nothing. An absent cron entry is
	invisible until something enumerates the list, so this enumerates it.
*/
func TestSchedulerRegistersTheReminderPlanSweep(t *testing.T) {
	inst := uuid.New()

	var found bool
	for _, e := range schedulerEntries(Envelope{InstitutionID: inst}) {
		if e.typ != TypeMessagePlans {
			continue
		}
		found = true
		if e.spec != "*/15 * * * *" {
			t.Errorf("plan sweep cron spec = %q, want every 15 minutes", e.spec)
		}
		p, ok := e.payload.(MessagePlansPayload)
		if !ok {
			t.Fatalf("plan sweep payload is %T, want MessagePlansPayload", e.payload)
		}
		// Without the institution the handler runs with no tenant scope, sees
		// no rules, and reports success — the exact shape of a feature that is
		// "on" and never fires.
		if p.InstitutionID != inst {
			t.Errorf("plan sweep institution = %v, want %v", p.InstitutionID, inst)
		}
	}
	if !found {
		t.Fatal("no cron entry for TypeMessagePlans: fee reminders and absence alerts " +
			"would only ever go out when somebody pressed Run now")
	}
}

// The type must have a handler. A scheduled type with none is a "handler not
// found" in production rather than a compile error here.
func TestPlanSweepTypeIsRouted(t *testing.T) {
	h := &Handlers{}
	if _, ok := h.routes()[TypeMessagePlans]; !ok {
		t.Fatal("TypeMessagePlans is scheduled but not routed")
	}
}

func TestPlanSweepRunsForTheInstitutionOnThePayload(t *testing.T) {
	inst := uuid.New()
	f := &fakeMessaging{}
	h := &Handlers{Messaging: f}

	if err := h.messagePlans(context.Background(),
		task(t, TypeMessagePlans, MessagePlansPayload{Envelope: Envelope{InstitutionID: inst}})); err != nil {
		t.Fatalf("messagePlans: %v", err)
	}
	if len(f.plansFor) != 1 || f.plansFor[0] != inst {
		t.Fatalf("plans run for %v, want exactly [%v]", f.plansFor, inst)
	}
}

// A worker built without the messaging feature says so and moves on. Returning
// an error would put the tick on asynq's retry schedule to fail identically
// three more times.
func TestPlanSweepWithoutMessagingIsQuietlySkipped(t *testing.T) {
	h := &Handlers{}
	if err := h.messagePlans(context.Background(),
		task(t, TypeMessagePlans, MessagePlansPayload{Envelope: Envelope{InstitutionID: uuid.New()}})); err != nil {
		t.Fatalf("messagePlans with no messaging wired: %v, want nil", err)
	}
}
