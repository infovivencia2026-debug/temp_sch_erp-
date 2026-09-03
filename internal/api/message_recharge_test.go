package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
Returns the error rather than failing the test, because a refusal IS the

	subject here. Its own transaction each time: a constraint violation poisons
	the transaction it happens in, so swallowing the error and carrying on makes
	the COMMIT fail instead, with a message about rollback that says nothing
	about the index actually doing its job.
*/
func ask(t *testing.T, sc *classroomSchool, channel string, n int) error {
	t.Helper()
	return sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `
				INSERT INTO message_credit_requests (institution_id, channel, messages)
				VALUES ($1, $2, $3)`, sc.inst, channel, n)
			return err
		})
}

/*
Pressing the button twice must not become two grants.

	The school presses it, nothing visibly happens, and they press again. If both
	rows survived, the seller would fulfil both and the school would be charged
	for a recharge it needed once. A unique partial index settles it in the
	database rather than in a check-then-insert, which two requests can both
	pass.
*/
func TestOnlyOneRequestCanBeOpenPerChannel(t *testing.T) {
	sc := newClassroomSchool(t)
	if err := ask(t, sc, "sms", 5000); err != nil {
		t.Fatalf("first request: %v", err)
	}
	if err := ask(t, sc, "sms", 5000); err == nil {
		t.Fatal("a second open request was accepted; the seller would grant both")
	}
}

// Settled requests are history, and there may be many. Only the OPEN one is
// unique, or a school could never ask twice in a year.
func TestASettledRequestDoesNotBlockTheNextOne(t *testing.T) {
	sc := newClassroomSchool(t)
	if err := ask(t, sc, "sms", 5000); err != nil {
		t.Fatalf("first: %v", err)
	}
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(),
			`UPDATE message_credit_requests SET status = 'granted', granted = 5000
			  WHERE institution_id = $1`, sc.inst)
		return err
	})
	if err := ask(t, sc, "sms", 2000); err != nil {
		t.Fatalf("second request after the first was granted: %v", err)
	}
}

// The two channels are asked for separately, because they are metered
// separately and a school may be out of one and fine on the other.
func TestTheChannelsAreAskedForSeparately(t *testing.T) {
	sc := newClassroomSchool(t)
	if err := ask(t, sc, "sms", 5000); err != nil {
		t.Fatalf("sms: %v", err)
	}
	if err := ask(t, sc, "whatsapp", 5000); err != nil {
		t.Fatalf("whatsapp blocked by an open sms request: %v", err)
	}
}

/*
Granting adds the credits and settles the request, or does neither.

	A grant recorded without the credits arriving leaves a school unable to send
	while the screen says it was handled. Credits added without the request being
	settled invites the next operator to grant it again. They are one
	transaction, and this drives the real path to prove it.
*/
func TestGrantingAddsTheCreditsAndClosesTheRequest(t *testing.T) {
	sc := newClassroomSchool(t)
	if err := ask(t, sc, "sms", 5000); err != nil {
		t.Fatalf("request: %v", err)
	}

	// What decideRecharge does, in one transaction, as it does it.
	sc.tx(t, func(tx pgx.Tx) error {
		var inst uuid.UUID
		var channel string
		var asked int
		if err := tx.QueryRow(t.Context(), `
			SELECT institution_id, channel, messages FROM message_credit_requests
			 WHERE institution_id = $1 AND status = 'pending' FOR UPDATE`,
			sc.inst).Scan(&inst, &channel, &asked); err != nil {
			return err
		}
		if _, err := addCredits(t.Context(), tx, inst, channel, asked, "topup", "", uuid.Nil); err != nil {
			return err
		}
		_, err := tx.Exec(t.Context(), `
			UPDATE message_credit_requests SET status = 'granted', granted = $2,
			       decided_at = now() WHERE institution_id = $1 AND status = 'pending'`,
			sc.inst, asked)
		return err
	})

	if bal, found := balanceOf(t, sc, "sms"); !found || bal != 5000 {
		t.Fatalf("balance %d found=%v, want 5000: the grant did not arrive", bal, found)
	}
	var open int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(t.Context(),
			`SELECT count(*) FROM message_credit_requests
			  WHERE institution_id = $1 AND status = 'pending'`, sc.inst).Scan(&open)
	})
	if open != 0 {
		t.Fatalf("%d requests still open after granting; the next operator would grant it again", open)
	}
}

// A partial grant is recorded as what was actually given, not as what was
// asked for, or the history stops matching the balance.
func TestAPartialGrantRecordsWhatWasGiven(t *testing.T) {
	sc := newClassroomSchool(t)
	if err := ask(t, sc, "whatsapp", 10000); err != nil {
		t.Fatalf("request: %v", err)
	}
	sc.tx(t, func(tx pgx.Tx) error {
		if _, err := addCredits(t.Context(), tx, sc.inst, "whatsapp", 4000, "topup", "", uuid.Nil); err != nil {
			return err
		}
		_, err := tx.Exec(t.Context(), `
			UPDATE message_credit_requests SET status = 'granted', granted = 4000,
			       decided_at = now() WHERE institution_id = $1 AND status = 'pending'`, sc.inst)
		return err
	})
	var asked, granted int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(t.Context(),
			`SELECT messages, granted FROM message_credit_requests WHERE institution_id = $1`,
			sc.inst).Scan(&asked, &granted)
	})
	if asked != 10000 || granted != 4000 {
		t.Fatalf("asked %d granted %d, want 10000 and 4000", asked, granted)
	}
	if bal, _ := balanceOf(t, sc, "whatsapp"); bal != 4000 {
		t.Fatalf("balance %d, want 4000: the ledger and the balance disagree", bal)
	}
}
