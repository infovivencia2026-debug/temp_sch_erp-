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
A school on the top pack, with no balance set, sends exactly as it always did.

	This is the property that made the meter deployable, and the pack ladder
	narrowed it rather than removing it. If an absent row read as a zero balance
	everywhere, deploying this would have stopped every message for every school
	already configured, with nothing on any screen to say why.

	It still holds where it matters — the schools that link their own vendor and
	pay their own bill. Everywhere the messages leave on OUR account, an absent
	row now means zero, because "unlimited by default" there is a school
	spending money nobody is counting. That is asserted separately, below, and
	it covers the top pack too whenever it chooses our account.
*/
func TestTheTopPackWithoutABalanceIsNotMetered(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	// Paying its own vendor is what removes the ceiling, not the pack alone:
	// a Complete school that has linked nothing is on OUR account, and that is
	// metered like any other.
	linkOwnProvider(t, sc, "sms")
	sc.tx(t, func(tx pgx.Tx) error {
		bal, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if isMetered {
			t.Errorf("metered at %d; a school paying its own vendor should have no ceiling here", bal)
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

func setPlan(t *testing.T, sc *classroomSchool, code string) {
	t.Helper()
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `
			INSERT INTO subscriptions (institution_id, plan_code, status, started_on)
			VALUES ($1, $2, 'active', now())`, sc.inst, code)
		return err
	})
}

/*
A lower pack sends on the SELLER's account, so an absent meter means zero.

	This is the opposite of the rule for an unmetered school, and it has to be:
	on Starter or Standard the messages leave through the seller's vendor
	account and land on the seller's bill. "No row" meaning "unlimited" there
	would be a school spending somebody else's money with nothing counting it.
	Recharge to send.
*/
func TestALowerPackIsMeteredEvenWithNoRow(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "starter")
	sc.tx(t, func(tx pgx.Tx) error {
		bal, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if !isMetered || bal != 0 {
			t.Errorf("starter: metered=%v balance=%d; want metered at 0 so it must recharge",
				isMetered, bal)
		}
		return nil
	})
}

/*
The top pack gets BOTH routes, and defaults to ours until it links a vendor.

	This is what "both available" means in practice. Complete may link its own
	MSG91 or Meta account and pay that vendor, or it may send on ours and pay
	with credits, per channel. Until it has linked anything there is nothing to
	send by except ours — so it is metered, exactly like a lower pack, because
	the money is ours in both cases.

	The pack is what grants the CHOICE. It is not what decides who pays, and
	metering follows who pays.
*/
func TestTheTopPackDefaultsToOurAccountUntilItLinksOne(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	sc.tx(t, func(tx pgx.Tx) error {
		route, err := routeFor(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if route != RouteEduCloud {
			t.Errorf("route %q with nothing linked, want edu_cloud", route)
		}
		_, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if !isMetered {
			t.Error("unmetered while sending on our account: our bill, uncounted")
		}
		return nil
	})
}

// A school with no subscription at all is metered, which is the safe
// direction: it is not on the pack that permits its own vendor, and a meter
// with no credits holds messages rather than spending anything.
func TestNoSubscriptionIsTreatedAsALowerPack(t *testing.T) {
	sc := newClassroomSchool(t)
	sc.tx(t, func(tx pgx.Tx) error {
		_, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if !isMetered {
			t.Error("a school with no subscription is unmetered")
		}
		return nil
	})
}

// An explicit balance still wins on any pack: the meter is a cap the seller
// may put on a school that has its own vendor, not only a prepayment.
func TestAnExplicitBalanceAppliesOnTheTopPackToo(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := addCredits(t.Context(), tx, sc.inst, "sms", 40, "topup", "", uuid.Nil)
		return err
	})
	sc.tx(t, func(tx pgx.Tx) error {
		bal, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if !isMetered || bal != 40 {
			t.Errorf("metered=%v balance=%d, want metered at 40", isMetered, bal)
		}
		return nil
	})
}

func linkOwnProvider(t *testing.T, sc *classroomSchool, channel string) {
	t.Helper()
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `
			INSERT INTO integrations (institution_id, kind, provider, config, enabled)
			VALUES ($1, 'messaging', $2, '{}'::jsonb, true)`, sc.inst, channel)
		return err
	})
}

/*
A school that already linked a vendor keeps sending by it, unasked.

	This is the regression the inference exists to prevent. A blanket default of
	'edu_cloud' would silently re-route every school that had linked its own
	account — and meter it, because our route always is — leaving it unable to
	send on an account it pays for itself, with a credits error to explain it.
*/
func TestALinkedVendorIsStillUsedWithoutBeingAsked(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	linkOwnProvider(t, sc, "sms")
	sc.tx(t, func(tx pgx.Tx) error {
		route, err := routeFor(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if route != RouteOwn {
			t.Errorf("route %q, want own: a configured vendor was re-routed through us", route)
		}
		return nil
	})
}

// The top pack may sit on OUR account instead, and then it is metered exactly
// like a lower pack: the money is ours either way.
func TestTheTopPackOnOurAccountIsMetered(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(),
			`INSERT INTO message_routing (institution_id, channel, route)
			 VALUES ($1, 'sms', 'edu_cloud')`, sc.inst)
		return err
	})
	sc.tx(t, func(tx pgx.Tx) error {
		_, isMetered, err := creditBalance(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if !isMetered {
			t.Error("Complete on our account is unmetered; that is our bill going uncounted")
		}
		return nil
	})
}

// And the two channels are independent: a school may hold its own SMS
// contract — the one needing DLT paperwork — while WhatsApp goes through us.
func TestTheTwoChannelsRouteIndependently(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete")
	linkOwnProvider(t, sc, "sms")
	sc.tx(t, func(tx pgx.Tx) error {
		sms, err := routeFor(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		wa, err := routeFor(t.Context(), tx, sc.inst, "whatsapp")
		if err != nil {
			return err
		}
		if sms != RouteOwn || wa != RouteEduCloud {
			t.Errorf("sms=%q whatsapp=%q, want own and edu_cloud", sms, wa)
		}
		return nil
	})
}

// A lower pack is on our account whatever is stored — including a choice it
// made on a higher pack, which is kept rather than erased so that moving back
// up restores it.
func TestALowerPackIsOnOurAccountWhateverIsStored(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "starter")
	linkOwnProvider(t, sc, "sms")
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(),
			`INSERT INTO message_routing (institution_id, channel, route)
			 VALUES ($1, 'sms', 'own')`, sc.inst)
		return err
	})
	sc.tx(t, func(tx pgx.Tx) error {
		route, err := routeFor(t.Context(), tx, sc.inst, "sms")
		if err != nil {
			return err
		}
		if route != RouteEduCloud {
			t.Errorf("route %q on starter, want edu_cloud", route)
		}
		return nil
	})
}

/*
The screen and the dispatcher must not disagree about who is metered.

	Found live: the credits list reported "not metered" for any channel with no
	row, while the dispatcher meters anything sending on our account whether a
	row exists or not. A school was told it had no limit and then found its
	messages held. Two readings of one fact is the bug; this pins them together.
*/
func TestTheScreenAgreesWithTheDispatcherAboutMetering(t *testing.T) {
	sc := newClassroomSchool(t)
	setPlan(t, sc, "complete") // may choose, has linked nothing, so: our account
	sc.tx(t, func(tx pgx.Tx) error {
		for _, ch := range []string{"sms", "whatsapp"} {
			route, err := routeFor(t.Context(), tx, sc.inst, ch)
			if err != nil {
				return err
			}
			_, isMetered, err := creditBalance(t.Context(), tx, sc.inst, ch)
			if err != nil {
				return err
			}
			if (route == RouteEduCloud) != isMetered {
				t.Errorf("%s: route=%q but metered=%v; the screen would contradict the sender",
					ch, route, isMetered)
			}
		}
		return nil
	})
}
