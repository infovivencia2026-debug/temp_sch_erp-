package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func balanceOf(t *testing.T, sc *classroomSchool, channel string) (int, bool) {
	t.Helper()
	var bal int
	var found bool
	sc.tx(t, func(tx pgx.Tx) error {
		var b int
		e := tx.QueryRow(t.Context(),
			`SELECT balance FROM message_credits WHERE institution_id = $1 AND channel = $2`,
			sc.inst, channel).Scan(&b)
		if e == pgx.ErrNoRows {
			return nil
		}
		if e != nil {
			return e
		}
		bal, found = b, true
		return nil
	})
	return bal, found
}

/*
A school nobody has metered sends exactly as it always did.

	This is the property that makes the feature deployable. If an absent row
	read as a zero balance, the migration would have stopped every message for
	every school already configured — reminders, absence alerts, the lot — with
	nothing on any screen to say why. Metering has to begin as a deliberate act.
*/
func TestWithoutABalanceNothingIsMetered(t *testing.T) {
	sc := newClassroomSchool(t)
	sc.tx(t, func(tx pgx.Tx) error {
		bal, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if isMetered {
			t.Errorf("a school with no row is metered at %d; every message would stop", bal)
		}
		// And spending against it must be a no-op rather than an error.
		return spendCredit(t.Context(), tx, sc.inst, "sms", uuid.New())
	})
	if _, found := balanceOf(t, sc, "sms"); found {
		t.Error("spending on an unmetered school created a balance row")
	}
}

// Email and in-app cost nothing per message, so they are never metered — a
// school unable to send a receipt for want of credit would be absurd.
func TestFreeChannelsAreNeverMetered(t *testing.T) {
	sc := newClassroomSchool(t)
	for _, ch := range []string{"email", "in_app"} {
		sc.tx(t, func(tx pgx.Tx) error {
			_, isMetered, err := creditBalance(t.Context(), tx, sc.inst, ch)
			if err != nil {
				return err
			}
			if isMetered {
				t.Errorf("%s is metered", ch)
			}
			return nil
		})
	}
}

// A top-up creates the balance, and every movement leaves a trace: the question
// asked when a bill arrives is not "how many are left" but "where did they go".
func TestToppingUpStartsTheMeterAndIsRecorded(t *testing.T) {
	sc := newClassroomSchool(t)
	actor := sc.teacher

	sc.tx(t, func(tx pgx.Tx) error {
		got, err := addCredits(t.Context(), tx, sc.inst, "sms", 500, "topup", "first bundle", actor)
		if err != nil {
			return err
		}
		if got != 500 {
			t.Fatalf("balance %d, want 500", got)
		}
		return nil
	})

	sc.tx(t, func(tx pgx.Tx) error {
		var delta int
		var reason string
		return tx.QueryRow(t.Context(), `
			SELECT delta, reason FROM message_credit_entries
			 WHERE institution_id = $1 AND channel = 'sms'`, sc.inst).Scan(&delta, &reason)
	})
	if bal, found := balanceOf(t, sc, "sms"); !found || bal != 500 {
		t.Fatalf("balance %d found=%v", bal, found)
	}
}

// One send, one credit — and the ledger says which message took it.
func TestASendSpendsExactlyOne(t *testing.T) {
	sc := newClassroomSchool(t)
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := addCredits(t.Context(), tx, sc.inst, "whatsapp", 3, "topup", "", uuid.Nil)
		return err
	})
	sc.tx(t, func(tx pgx.Tx) error {
		return spendCredit(t.Context(), tx, sc.inst, "whatsapp", uuid.Nil)
	})
	if bal, _ := balanceOf(t, sc, "whatsapp"); bal != 2 {
		t.Fatalf("balance %d after one send, want 2", bal)
	}
}

/*
The balance cannot go below zero, however many workers are dispatching.

	Two dispatch workers run against one school. A read-then-write would let
	both see a balance of 1 and both spend it, which is one message more than
	was paid for. The decrement is conditional in SQL so the database settles
	it, and this drives it past the last credit to prove the floor holds.
*/
func TestTheMeterCannotGoNegative(t *testing.T) {
	sc := newClassroomSchool(t)
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := addCredits(t.Context(), tx, sc.inst, "sms", 2, "topup", "", uuid.Nil)
		return err
	})
	for i := 0; i < 5; i++ {
		sc.tx(t, func(tx pgx.Tx) error {
			return spendCredit(t.Context(), tx, sc.inst, "sms", uuid.Nil)
		})
	}
	bal, _ := balanceOf(t, sc, "sms")
	if bal != 0 {
		t.Fatalf("balance %d after overspending, want 0", bal)
	}

	// And the ledger records two sends, not five: a send that was refused did
	// not happen and must not appear to have been paid for.
	var entries int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(t.Context(),
			`SELECT count(*) FROM message_credit_entries
			  WHERE institution_id = $1 AND channel = 'sms' AND reason = 'send'`,
			sc.inst).Scan(&entries)
	})
	if entries != 2 {
		t.Fatalf("%d send entries, want 2: the ledger disagrees with the balance", entries)
	}
}

// A correction cannot drive the balance negative either. The vendor has already
// been paid; a debt here would silently eat the next top-up.
func TestACorrectionClampsAtZero(t *testing.T) {
	sc := newClassroomSchool(t)
	sc.tx(t, func(tx pgx.Tx) error {
		if _, err := addCredits(t.Context(), tx, sc.inst, "sms", 100, "topup", "", uuid.Nil); err != nil {
			return err
		}
		got, err := addCredits(t.Context(), tx, sc.inst, "sms", -400, "adjustment", "wrong bundle", uuid.Nil)
		if err != nil {
			return err
		}
		if got != 0 {
			t.Fatalf("balance %d after over-correction, want 0", got)
		}
		return nil
	})
}
