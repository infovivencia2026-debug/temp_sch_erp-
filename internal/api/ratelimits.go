package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/ratelimit"
)

/*
The four rate limiters, named in one place.

	Each used to be a type of its own with a map behind a mutex, declared
	honestly as per-process. They are now scopes on one store -- see
	internal/ratelimit -- so that a deployment running more than one instance
	can point RATE_LIMIT_STORE at Postgres and have every instance count the
	same attempts. The budgets are unchanged; the comments explaining each
	budget stay beside the handler that spends it.

	The scope strings are the table's partition key when the store is Postgres,
	so they are stable identifiers, not display names: renaming one forgets
	every count under the old name.
*/
const (
	// The public admission form, per caller address.
	scopePublicForm = "public_form"
	// The SMS gateway's pair-code claim and both device enrolments, per caller
	// address. One scope for the three because it is one thing being
	// protected: an unauthenticated endpoint that turns input into a
	// credential.
	scopeSMSGatewayPair = "sms_gateway_pair"
	// The bus tracker's pair-code claim, per caller address. Its own scope,
	// the same budget: a school pairing a driver's phone and a gateway on the
	// same afternoon from the same office should not be spending one budget.
	scopeBusTrackerPair = "bus_tracker_pair"
	// The keyed test-message link, per link key.
	scopeMessageTestLink = "message_test_link"
	// API keys, per key id, with the burst on the key itself.
	scopeAPIKey = "api_key"
)

var (
	publicFormPolicy      = ratelimit.Policy{Window: formSubmitWindow, Burst: formSubmitBurst}
	pairCodePolicy        = ratelimit.Policy{Window: smsGatewayClaimWindow, Burst: smsGatewayClaimBurst}
	messageTestLinkPolicy = ratelimit.Policy{Window: time.Hour, Burst: 10}
	apiKeyPerMinutePolicy = ratelimit.Policy{Window: time.Minute, Fixed: true}
)

// limits is the store this Server counts in. Nil in RateLimits -- every test
// that writes &Server{} -- means a private in-memory store, made once, so a
// test's limiter state lives with its Server and is not inherited by the
// next test the way a package variable's would be.
func (s *Server) limits() ratelimit.Store {
	s.limitsOnce.Do(func() {
		if s.RateLimits == nil {
			s.RateLimits = ratelimit.NewMemory()
		}
	})
	return s.RateLimits
}

// limiter binds a scope and a policy to this Server's store. Cheap: a value
// over the shared store, holding no state of its own.
func (s *Server) limiter(scope string, p ratelimit.Policy) ratelimit.Scoped {
	return ratelimit.New(s.limits(), scope, p, s.Clock)
}

/*
rateLimited spends one attempt on key and, if the budget is gone, answers
429 and reports true so the handler returns.

	A store that cannot answer -- the Postgres store with the database away --
	is logged and the request is let through. Every endpoint behind these
	limiters needs the same database for the thing it is about to do, so a
	closed door here would only change which error the caller reads, and the
	memory store, which is what most deployments run, never errors at all.
*/
func (s *Server) rateLimited(w http.ResponseWriter, r *http.Request, scope string, p ratelimit.Policy, key, msg string) bool {
	ok, _, err := s.limiter(scope, p).Allow(r.Context(), key)
	if err != nil {
		slog.Error("rate limiter unavailable; allowing", "scope", scope, "error", err)
		return false
	}
	if ok {
		return false
	}
	httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited", msg)
	return true
}
