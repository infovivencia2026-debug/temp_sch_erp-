package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
AN API THAT A MACHINE CAN CALL.

	Everything under /api/v1 authenticated from the erp_session cookie and
	nothing else. There was no header path at all, which meant every
	integration a school actually wants -- the accountant's Tally bridge, the
	board's attendance pull, a script that reconciles the roll against the fee
	ledger -- had to drive the login form with a real member of staff's
	password. That credential can do everything the person can do, cannot be
	revoked without locking the person out, and stops working the week they
	leave.

	An API key is the same authentication decided by a different credential.
	The important design choice is that it produces an httpx.Identity of
	exactly the shape the session middleware produces: same institution, same
	permission set, same context key. Nothing downstream is aware a key
	exists. Every RequirePermission gate, every tenantScope, every RLS policy
	therefore applies to a key with no change and, more to the point, with no
	opportunity for somebody to forget to apply it to a key. The alternative
	-- a parallel "machine" path with its own authorisation checks, which is
	what the bus tracker and the SMS gateway have -- is right for those
	because a handset is not a member of staff and reaches four endpoints. It
	would be badly wrong here, where a key reaches the whole API.

	WHAT A KEY CANNOT BE.

	  - It is never platform staff. PlatformAdmin is false unconditionally,
	    so the "belongs to no institution, therefore reaches every tenant"
	    branch in auth/session.go cannot be entered by a key. There is no
	    request body, header or column that can turn it on.
	  - It never carries a platform.* permission, so super_admin's and
	    seller_admin's distinguishing rights cannot be packed into a key even
	    by somebody who has them.
	  - It holds a frozen subset of its own school's grants, intersected
	    again on every request with what that school's roles grant today. A
	    permission withdrawn from the school stops working for its keys in
	    the same instant, without anybody having to remember the keys exist.

	The token is shown once, at creation, and is unrecoverable afterwards:
	only the SHA-256 of its secret half is stored. That is a deliberate
	departure from vehicle_trackers, which seals its device token reversibly
	so a re-pairing can redisplay it. See the migration for why the two want
	opposite properties.
*/

// The token is "erpk.<key id>.<secret>". Three parts for the same reason the
// bus tracker's is: the row has to be findable before its hash can be
// compared, and searching a table by hash means either an index on the hash
// or a scan. The id is not a secret and carrying it costs nothing. The erpk
// prefix lets a leaked-credential scanner recognise one of ours in a git
// repository, which is worth more than the eight bytes it takes.
const apiKeyTokenPrefix = "erpk"

// apiKeySecretBytes is 32, matching auth.newToken. 256 bits of entropy from
// crypto/rand is far past anything guessable, so the stored SHA-256 needs no
// stretching: there is no low-entropy password here to grind.
const apiKeySecretBytes = 32

func newAPIKeyToken(id uuid.UUID) (token, secret string, err error) {
	b := make([]byte, apiKeySecretBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("read random: %w", err)
	}
	secret = base64.RawURLEncoding.EncodeToString(b)
	return apiKeyTokenPrefix + "." + id.String() + "." + secret, secret, nil
}

func splitAPIKeyToken(token string) (uuid.UUID, string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != apiKeyTokenPrefix {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || parts[2] == "" {
		return uuid.Nil, "", false
	}
	return id, parts[2], true
}

func hashAPIKeySecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// apiKeyHint is what a screen prints beside the name so somebody can tell two
// keys apart without holding either. Short enough to be useless on its own:
// eight characters of a 43-character base64 secret leaves 208 bits to guess.
func apiKeyHint(token string) string {
	if len(token) > len(apiKeyTokenPrefix)+1+36+1+8 {
		return token[:len(apiKeyTokenPrefix)+1+36+1+8] + "..."
	}
	return token
}

/*
apiKeyPermissionForbidden decides which keys can never be put in a key.

	Read from rbac.All by module rather than listed by hand, so a platform
	permission added later is excluded the day it is added instead of the day
	somebody notices. The listing-by-hand version of this is the one that
	fails: it is correct when written and silently wrong six months later.

	"platform" is the module that carries the rights only the vendor holds --
	creating tenants, editing plans. A school's key must not reach them under
	any circumstance, including the circumstance where the key was issued by
	a vendor operator acting inside that school.
*/
func apiKeyPermissionForbidden(key string) bool {
	for _, p := range rbac.All {
		if p.Key == key {
			return p.Module == "platform"
		}
	}
	// A key that is not in the vocabulary at all is refused rather than
	// stored. Storing it would be harmless today, because Can() consults a
	// map that nothing else writes, and would be a trapdoor the day somebody
	// seeds a permission with that name for another purpose.
	return true
}

// --- the limiter -------------------------------------------------------------

/*
apiKeyLimiter is an in-process fixed-window counter, and it is honest about it.

	Stated plainly: this counts requests per key per minute inside ONE server
	process. Two app processes behind the load balancer means a key gets up to
	twice its limit, and a restart forgets every window. A distributed limiter
	in Redis would fix both, and is deliberately not built here: this
	installation runs a single web process, the queue's Redis is not on the
	request path today, and putting it there would make every API call depend
	on a second service being up.

	What this is for is the accident, not the attacker: an integration stuck
	in a retry loop, a nightly job that forgot its pagination, a script
	hammering the roll every 50ms. Those are what actually take a school's
	server down, and they are all stopped by a counter in a map. A determined
	attacker holding a valid key is not the threat this addresses; revoking
	the key is.

	Fixed window rather than a token bucket because the failure mode of a
	fixed window -- up to twice the rate across a window boundary -- does not
	matter for a limit whose purpose is "stop a runaway loop", and a bucket is
	more moving parts to be wrong about.
*/
type apiKeyLimiter struct {
	mu      sync.Mutex
	windows map[uuid.UUID]*apiKeyWindow
	// Cleared wholesale when the map grows past this, rather than with a
	// timer or a sweeping goroutine. The map holds one small struct per key
	// seen this minute; a school has a handful of keys, and a process serving
	// thousands would rather drop the counters than run a reaper.
	maxEntries int
}

type apiKeyWindow struct {
	started time.Time
	count   int
}

var apiKeyRequests = &apiKeyLimiter{
	windows:    map[uuid.UUID]*apiKeyWindow{},
	maxEntries: 10000,
}

// allow reports whether this request is within the key's limit, and how long
// the caller should wait if it is not.
func (l *apiKeyLimiter) allow(id uuid.UUID, perMinute int, now time.Time) (bool, time.Duration) {
	if perMinute <= 0 {
		perMinute = 1
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.windows) > l.maxEntries {
		l.windows = map[uuid.UUID]*apiKeyWindow{}
	}
	w := l.windows[id]
	if w == nil || now.Sub(w.started) >= time.Minute {
		l.windows[id] = &apiKeyWindow{started: now, count: 1}
		return true, 0
	}
	if w.count >= perMinute {
		return false, time.Minute - now.Sub(w.started)
	}
	w.count++
	return true, 0
}

// --- authentication ----------------------------------------------------------

type apiKeyRow struct {
	ID            uuid.UUID
	InstitutionID uuid.UUID
	UserID        uuid.UUID
	FullName      string
	Permissions   []string
	RatePerMinute int
	LastUsed      *time.Time
}

/*
APIKeyAuth resolves an Authorization: Bearer key into an identity.

	Mounted in cmd/web/main.go beside the session middleware rather than
	inside Server.Routes, and that placement is load bearing: AuditMiddleware
	wraps the /api/v1 subtree from outside and reads the identity from the
	request IT holds after the handler returns. A middleware that attached the
	identity further in would leave every write made by a key unattributed in
	audit_log, which is exactly the record somebody will go looking for.

	Transparent when there is no bearer token, so the cookie path is
	untouched. A request carrying both a cookie and a key is answered as the
	key: the explicit credential wins over the ambient one, which is the only
	reading that does not let a stray browser cookie silently upgrade a
	machine call.
*/
func (s *Server) APIKeyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Keys are for the JSON API. The server-rendered pages carry CSRF
		// assumptions that belong to a cookie, and a bearer credential that
		// worked on /login would be a way to drive those forms.
		if !strings.HasPrefix(r.URL.Path, "/api/v1") {
			next.ServeHTTP(w, r)
			return
		}
		raw := r.Header.Get("Authorization")
		if !strings.HasPrefix(raw, "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(raw, "Bearer "))
		keyID, secret, ok := splitAPIKeyToken(token)
		if !ok {
			/* Not one of ours. Passed through rather than refused, because
			   the bus tracker and the SMS gateway also send bearer tokens to
			   paths under /api/v1 and they authenticate themselves further
			   in. Refusing here would break both. */
			next.ServeHTTP(w, r)
			return
		}

		id, err := s.resolveAPIKey(r.Context(), keyID, secret)
		switch {
		case errors.Is(err, errAPIKeyUnusable):
			// One message for every reason: unknown id, wrong secret,
			// revoked, expired, owner gone. Distinguishing them tells
			// somebody holding a guessed id which half they got right.
			httpx.Error(w, r, http.StatusUnauthorized, "unauthorized",
				"this API key is not valid; it may have been revoked or it may have expired")
			return
		case err != nil:
			// A database fault is not a bad credential and must not be
			// reported as one: an integration told 401 will helpfully rotate
			// a key that was fine.
			httpx.Internal(w, r, err)
			return
		}

		if ok, retry := apiKeyRequests.allow(id.APIKeyID, id.rate, time.Now()); !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retry.Seconds())+1))
			httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited",
				"this API key has made too many requests; wait a moment and retry")
			return
		}

		s.touchAPIKey(r.Context(), id.APIKeyID, id.lastUsed)
		next.ServeHTTP(w, r.WithContext(httpx.WithIdentity(r.Context(), id.Identity)))
	})
}

var errAPIKeyUnusable = errors.New("api key unusable")

// resolvedAPIKey is the identity plus the two facts the middleware needs and
// the rest of the application must not see.
type resolvedAPIKey struct {
	*httpx.Identity
	rate     int
	lastUsed *time.Time
}

/*
resolveAPIKey validates the token and builds the identity.

	AsPlatform, for the same reason the session resolver uses it: there is no
	tenant GUC to set until the row has been read, and the row is where the
	tenant comes from. The institution is taken from the key's own column and
	from nowhere else -- no header, no body, no query parameter feeds it --
	which is what makes "a key cannot act outside its institution" a property
	of the code rather than a hope about the handlers.

	Every check is here and none of it is cached. A revoked key stops working
	on the next request, not at the end of some cache lifetime, because there
	is nothing to expire: the row is read every time. That costs one indexed
	primary-key lookup per call, which is the same cost the session path
	already pays, and it is the difference between revocation being a promise
	and revocation being a fact.
*/
func (s *Server) resolveAPIKey(ctx context.Context, keyID uuid.UUID, secret string) (*resolvedAPIKey, error) {
	var (
		row       apiKeyRow
		hash      []byte
		revoked   *time.Time
		expires   *time.Time
		userInst  *uuid.UUID
		granted   []string
		userState string
	)
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT k.id, k.institution_id, k.token_hash, k.permissions,
			       k.rate_per_minute, k.last_used_at, k.revoked_at, k.expires_at,
			       u.id, u.full_name, u.status, u.institution_id,
			       COALESCE(array_agg(DISTINCT rp.permission_key)
			                FILTER (WHERE rp.permission_key IS NOT NULL), '{}')
			  FROM api_keys k
			  JOIN users u ON u.id = k.created_by
			  LEFT JOIN roles ro            ON ro.institution_id = k.institution_id
			  LEFT JOIN role_permissions rp ON rp.role_id = ro.id
			 WHERE k.id = $1
			 GROUP BY k.id, u.id`, keyID).
			Scan(&row.ID, &row.InstitutionID, &hash, &row.Permissions,
				&row.RatePerMinute, &row.LastUsed, &revoked, &expires,
				&row.UserID, &row.FullName, &userState, &userInst, &granted)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAPIKeyUnusable
	}
	if err != nil {
		return nil, fmt.Errorf("resolve api key: %w", err)
	}

	/* Constant time, and unconditional.

	   The comparison happens even for a key already known to be revoked, so
	   the time this function takes does not answer "does this id exist and
	   is it live" to somebody feeding it guesses. subtle.ConstantTimeCompare
	   over the hashes rather than == over the secrets: a byte-by-byte
	   comparison that stops at the first difference leaks the prefix of a
	   valid secret to anybody who can measure it. */
	match := subtle.ConstantTimeCompare(hash, hashAPIKeySecret(secret)) == 1
	if !match {
		return nil, errAPIKeyUnusable
	}
	if revoked != nil {
		return nil, errAPIKeyUnusable
	}
	if expires != nil && expires.Before(time.Now()) {
		return nil, errAPIKeyUnusable
	}
	/* The key dies with the person who issued it.

	   A key runs as its creator for scope resolution and for the audit
	   trail, so a key outliving that account would be an actor nobody is
	   answerable for -- exactly the leaver-keeps-the-keys problem the staff
	   offboarding work was about. Suspended counts as gone: the school has
	   said this person may not act, and a script they left behind is still
	   them acting. */
	if userState != "active" {
		return nil, errAPIKeyUnusable
	}
	/* And it dies if the creator was moved to another school, or is platform
	   staff. A key issued by a vendor operator acting inside a tenant would
	   otherwise be a school-scoped credential owned by an account with no
	   school, which is the one shape that could be talked into reaching
	   across tenants. */
	if userInst == nil || *userInst != row.InstitutionID {
		return nil, errAPIKeyUnusable
	}

	id := &httpx.Identity{
		UserID:        row.UserID,
		InstitutionID: row.InstitutionID,
		FullName:      row.FullName,
		// Never, under any condition. The absence of an institution is what
		// makes an account platform staff, and a key always has one.
		PlatformAdmin: false,
		// Nothing to change: a key has no password. Left false explicitly so
		// requirePasswordChanged does not lock out an integration because a
		// human colleague was issued a temporary password.
		MustChangePassword: false,
		APIKey:             true,
		APIKeyID:           row.ID,
		Permissions:        apiKeyEffectivePermissions(row.Permissions, granted),
	}
	return &resolvedAPIKey{Identity: id, rate: row.RatePerMinute, lastUsed: row.LastUsed}, nil
}

/*
apiKeyEffectivePermissions intersects the frozen grant with today's reality.

	Three filters, and each one exists because leaving it out has a specific
	failure:

	  - platform keys are dropped, so no key ever carries a right that only
	    the vendor holds, whatever is in the column;
	  - the key's list is intersected with what the institution's roles grant
	    now, so a permission the school withdraws stops working for its keys
	    without anybody having to remember which keys mentioned it;
	  - the result is a subset of the stored list, never a superset, so a
	    school gaining a permission does not widen a key that was issued
	    before it.

	The second filter is the one that looks redundant and is not. The issue
	endpoint already refuses a permission the school does not hold, so the
	stored list is a subset at the moment it is written. Roles change
	afterwards.
*/
func apiKeyEffectivePermissions(stored, granted []string) map[string]struct{} {
	have := make(map[string]struct{}, len(granted))
	for _, g := range granted {
		have[g] = struct{}{}
	}
	out := make(map[string]struct{}, len(stored))
	for _, p := range stored {
		if apiKeyPermissionForbidden(p) {
			continue
		}
		if _, ok := have[p]; !ok {
			continue
		}
		out[p] = struct{}{}
	}
	return out
}

/*
touchAPIKey records use, at most once a minute.

	Throttled exactly as the session's last_seen_at is, and for the same
	reason: an integration polling every second would otherwise turn a
	read-only API into one write per request against a row every one of its
	requests already reads.

	Best effort. This column answers "is anything still using this key", which
	is what an owner needs before revoking one; it is not part of any security
	decision, so a failed write must never fail the request that carried it.
*/
func (s *Server) touchAPIKey(ctx context.Context, id uuid.UUID, last *time.Time) {
	if last != nil && time.Since(*last) < time.Minute {
		return
	}
	_ = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE id = $1`, id)
		return err
	})
}

// --- the owner's endpoints ---------------------------------------------------

/*
mountAPIKeys hangs the management endpoints inside the authenticated group.

	Gated on access.users.write, which institution_admin holds and no
	classroom or office role does. The argument for that key rather than a
	new one: issuing an API key is issuing a credential that acts as a member
	of staff, and "invite, edit and suspend users" is already the permission
	that means "may hand out and take away the ability to act here". Inventing
	an access.apikeys.write would be more precise and would also be a
	permission nobody has, so on the day a principal tried to connect their
	accounting software the screen would refuse them and there would be no
	role to fix it without a migration. Listing is gated one step lower, on
	access.users.read: a list of names, hints and last-used dates carries no
	credential, and an IT coordinator investigating what is calling the API
	should not need the right to issue one.
*/
func (s *Server) mountAPIKeys(r chi.Router) {
	r.Route("/api-keys", func(r chi.Router) {
		/* No key may manage keys.

		   A key holding access.users.write could otherwise mint further keys
		   and revoke the one an administrator uses. That is not a widening of
		   privilege -- the child would be bounded by the same institution and
		   the same subset -- but it removes the human from the loop of who
		   holds a credential, and it lets a leaked key entrench itself. The
		   owner's console is a place a person signs in to. */
		r.Use(refuseAPIKeyCaller)
		r.With(httpx.RequirePermission(rbac.UsersRead)).Get("/", s.listAPIKeys)
		r.With(httpx.RequirePermission(rbac.UsersWrite)).Post("/", s.issueAPIKey)
		r.With(httpx.RequirePermission(rbac.UsersWrite)).Post("/{id}/revoke", s.revokeAPIKey)
	})
}

func refuseAPIKeyCaller(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := httpx.IdentityFrom(r.Context()); id != nil && id.APIKey {
			httpx.Error(w, r, http.StatusForbidden, "forbidden",
				"API keys cannot issue or revoke API keys; sign in to manage them")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type apiKeyView struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Hint        string     `json:"hint"`
	Permissions []string   `json:"permissions"`
	RateLimit   int        `json:"rate_per_minute"`
	CreatedBy   string     `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
}

// listAPIKeys returns this school's keys, live and revoked.
//
// Revoked ones stay in the list rather than disappearing: "this key was
// revoked in March" is a different fact from "this key never existed", and
// the second is what an empty list says to somebody investigating an
// integration that stopped.
func (s *Server) listAPIKeys(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []apiKeyView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT k.id, k.name, k.token_hint, k.permissions, k.rate_per_minute,
			       COALESCE(u.full_name, ''), k.created_at, k.last_used_at,
			       k.expires_at, k.revoked_at
			  FROM api_keys k
			  LEFT JOIN users u ON u.id = k.created_by
			 WHERE k.institution_id = $1
			 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v apiKeyView
			var kid uuid.UUID
			if err := rows.Scan(&kid, &v.Name, &v.Hint, &v.Permissions, &v.RateLimit,
				&v.CreatedBy, &v.CreatedAt, &v.LastUsedAt, &v.ExpiresAt, &v.RevokedAt); err != nil {
				return err
			}
			v.ID = kid.String()
			sort.Strings(v.Permissions)
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"api_keys": out})
}

type issueAPIKeyRequest struct {
	Name          string     `json:"name"`
	Permissions   []string   `json:"permissions"`
	RatePerMinute *int       `json:"rate_per_minute"`
	ExpiresAt     *time.Time `json:"expires_at"`
}

/*
issueAPIKey mints a key and shows it once.

	The permission list is checked against the institution's own grants
	inside the same transaction that writes the row, so there is no window in
	which a role change between the check and the insert leaves a key holding
	something the school does not have. Refused rather than silently trimmed:
	an integration that asked for finance.invoices.read and quietly got a key
	without it fails later, in production, with a 403 nobody can explain.
*/
func (s *Server) issueAPIKey(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req issueAPIKeyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		httpx.BadRequest(w, r, "body must be json")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "name is required; it is the only thing that says what the key is for")
		return
	}
	if len(req.Permissions) == 0 {
		httpx.BadRequest(w, r, "permissions is required; a key with no permissions can do nothing")
		return
	}
	rate := 120
	if req.RatePerMinute != nil {
		rate = *req.RatePerMinute
		if rate < 1 || rate > 6000 {
			httpx.BadRequest(w, r, "rate_per_minute must be between 1 and 6000")
			return
		}
	}
	if req.ExpiresAt != nil && req.ExpiresAt.Before(time.Now()) {
		httpx.BadRequest(w, r, "expires_at is in the past")
		return
	}

	// Deduplicated before the check so a list naming the same key twice does
	// not produce a key whose stored array repeats it.
	wanted := map[string]struct{}{}
	for _, p := range req.Permissions {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if apiKeyPermissionForbidden(p) {
			httpx.BadRequest(w, r, fmt.Sprintf(
				"%q cannot be given to an API key: it is either not a permission at all "+
					"or one only the platform operator holds", p))
			return
		}
		wanted[p] = struct{}{}
	}
	perms := make([]string, 0, len(wanted))
	for p := range wanted {
		perms = append(perms, p)
	}
	sort.Strings(perms)

	var (
		token  string
		newID  uuid.UUID
		refuse string
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var granted []string
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(array_agg(DISTINCT rp.permission_key), '{}')
			  FROM roles ro
			  JOIN role_permissions rp ON rp.role_id = ro.id
			 WHERE ro.institution_id = $1`, id.InstitutionID).Scan(&granted); err != nil {
			return err
		}
		have := map[string]struct{}{}
		for _, g := range granted {
			have[g] = struct{}{}
		}
		for _, p := range perms {
			if _, ok := have[p]; !ok {
				refuse = p
				return nil
			}
		}

		/* The row first, then the token.

		   The token carries the row id, so it cannot be minted before the
		   row exists -- the same ordering vehicle_trackers uses, and for the
		   same reason. token_hash is written in the second statement of one
		   transaction: either the key has a real credential or it was never
		   created. */
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO api_keys (institution_id, name, token_hash, permissions,
			                      rate_per_minute, created_by, expires_at)
			VALUES ($1,$2,'\x00'::bytea,$3,$4,$5,$6)
			RETURNING id`,
			id.InstitutionID, req.Name, perms, rate, id.UserID, req.ExpiresAt).
			Scan(&newID); err != nil {
			return err
		}
		var secret string
		var err error
		token, secret, err = newAPIKeyToken(newID)
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE api_keys SET token_hash = $2, token_hint = $3 WHERE id = $1`,
			newID, hashAPIKeySecret(secret), apiKeyHint(token))
		return err
	})
	if refuse != "" {
		httpx.Error(w, r, http.StatusBadRequest, "invalid",
			fmt.Sprintf("this school does not grant %q to any role, so a key cannot carry it", refuse))
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "api_keys_one_live_name") {
			httpx.Error(w, r, http.StatusConflict, "conflict",
				"a live key of that name already exists; revoke it or choose another name")
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	/* The one and only time the token is readable.

	   Named "token" and not "api_key" or "secret" in the response body on
	   purpose: audit.go redacts by key name, and all three of those names are
	   in its list. The name here is one of them so that this response, the
	   only place in the product where a usable key appears in a payload,
	   cannot reach audit_log. */
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":              newID.String(),
		"name":            req.Name,
		"token":           token,
		"permissions":     perms,
		"rate_per_minute": rate,
		"note": "This is the only time this key is shown. Store it now; " +
			"if it is lost, revoke it and issue another.",
	})
}

// revokeAPIKey takes a key out of service immediately.
//
// An UPDATE rather than a DELETE, so the list can still say the key existed
// and when it stopped. Immediate in the literal sense: the resolver reads
// revoked_at on every request and holds no cache, so the next call made with
// this token is refused.
func (s *Server) revokeAPIKey(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	keyID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* institution_id in the WHERE clause as well as RLS.

		   RLS already makes another school's row invisible here. The clause
		   is written anyway because this handler must keep working if it is
		   ever called under a platform scope, where the policy admits every
		   row, and because a reader should be able to see the tenancy without
		   having to go and read the migration. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE api_keys SET revoked_at = now(), revoked_by = $3
			 WHERE id = $1 AND institution_id = $2 AND revoked_at IS NULL`,
			keyID, id.InstitutionID, id.UserID)
		if err != nil {
			return err
		}
		found = tag.RowsAffected() > 0
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		/* 404 for "not this school's key" and for "already revoked" alike.

		   Another school's key id must be indistinguishable from one that
		   does not exist, or this endpoint becomes a way to test whether a
		   given uuid is a key somewhere on the installation. */
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true})
}
