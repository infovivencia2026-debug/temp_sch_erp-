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
	e := entryFor(t, TypeMessagePlans)
	if e.Spec != "*/15 * * * *" {
		t.Errorf("plan sweep cron spec = %q, want every 15 minutes", e.Spec)
	}
	if !e.PerInstitution {
		t.Error("plan sweep must be per institution")
	}
	p, ok := e.Payload(Envelope{InstitutionID: inst}).(MessagePlansPayload)
	if !ok {
		t.Fatalf("plan sweep payload is %T, want MessagePlansPayload", e.Payload(Envelope{}))
	}
	// Without the institution the handler runs with no tenant scope, sees
	// no rules, and reports success — the exact shape of a feature that is
	// "on" and never fires.
	if p.InstitutionID != inst {
		t.Errorf("plan sweep institution = %v, want %v", p.InstitutionID, inst)
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
// an error would put the tick on the retry schedule to fail identically
// three more times.
func TestPlanSweepWithoutMessagingIsQuietlySkipped(t *testing.T) {
	h := &Handlers{}
	if err := h.messagePlans(context.Background(),
		task(t, TypeMessagePlans, MessagePlansPayload{Envelope: Envelope{InstitutionID: uuid.New()}})); err != nil {
		t.Fatalf("messagePlans with no messaging wired: %v, want nil", err)
	}
}
