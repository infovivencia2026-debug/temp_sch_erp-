package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/ttlcache"
)

const CookieName = "erp_session"

var ErrNoSession = errors.New("no session")

// Store issues and validates sessions.
//
// Only the SHA-256 of the token is persisted. The cookie holds the raw value,
// so a leaked database gives an attacker nothing they can replay -- the same
// reason the sessions table column is named token_hash and typed bytea.
type Store struct {
	db      *database.DB
	ttl     time.Duration
	idleTTL time.Duration
	secure  bool

	/* Resolved sessions, keyed by token hash, kept for resolveTTL.

	   "Who is this cookie" was asked on every authenticated request and it
	   was, once the query was fixed, still a round trip to Neon in another
	   region before the handler could start. The answer changes when the
	   session is revoked, the password is reset, the account is suspended or
	   a role is granted or taken away -- all of them writes this process
	   makes and can therefore forget the entry on, through Forget and
	   ForgetUser. A write made by ANOTHER instance is seen at most one
	   resolveTTL late, which is why that is a minute and not an hour.

	   The idle rule is still enforced on a cached hit: the entry carries the
	   last_seen_at the database had, moved forward whenever this process
	   touches it, so a tab left open still signs itself out on time. */
	cache *ttlcache.Cache[string, *cachedSession]
	// load is the database lookup. A field so a test can count how often the
	// cache reaches past itself without standing up Postgres.
	load func(ctx context.Context, tokenHash []byte) (*sessionRecord, error)
	// revoke ends a session. A field for the same reason as load: the idle
	// path calls it, and a test of the idle path should not need Postgres.
	revoke func(ctx context.Context, sessionID uuid.UUID) error
	// now is time.Now unless a test moves the clock.
	now func() time.Time
}

const (
	// resolveTTL is how long a resolved identity is trusted without asking
	// the database again.
	resolveTTL = time.Minute
	// resolveCap bounds the cache. Ten thousand concurrent cookies is more
	// than one instance of this service will see; beyond it the oldest are
	// simply reloaded.
	resolveCap = 10_000
	// touchEvery is how often last_seen_at is written back. It feeds the
	// idle timeout and the sessions screen, neither of which needs the
	// minute, and every write is a round trip a poll should not pay.
	touchEvery = 5 * time.Minute
)

// sessionRecord is one row of the resolve query, before the identity is
// assembled from it.
type sessionRecord struct {
	sessionID          uuid.UUID
	userID             uuid.UUID
	instID             *uuid.UUID
	lastSeen           time.Time
	fullName           string
	mustChangePassword bool
	perms              []string
	roleKeys           []string
}

// cachedSession is what the cache holds: the identity as resolved, plus the
// last-seen time the idle check and the touch throttle both work from.
//
// lastSeen is atomic because one entry is shared by every concurrent request
// carrying the same cookie, and each of them moves it forward when it writes
// the row back. Unix nanoseconds rather than a time.Time so a plain atomic
// will hold it.
type cachedSession struct {
	id       httpx.Identity
	lastSeen atomic.Int64
}

/*
The process's session store, for code that must forget a user without

	holding one.

	A user's access is ended in places that are handed a transaction and
	nothing else -- a leaver archived mid-import, roles rewritten inside a
	larger write -- and threading the store through every one of them would
	mean changing signatures that have nothing else to do with sessions. There
	is exactly one Store in a running process; this is a pointer to it, set
	when it is built. Nil in a test that never builds one, and ForgetUser is a
	no-op then, which is correct: there is no cache to be wrong.
*/
var process atomic.Pointer[Store]

// ForgetUser drops every cached identity for one user, wherever in the
// process the write that invalidated them happened. See Store.ForgetUser.
func ForgetUser(userID uuid.UUID) {
	if s := process.Load(); s != nil {
		s.ForgetUser(userID)
	}
}

func NewStore(db *database.DB, ttl, idleTTL time.Duration, secure bool) *Store {
	s := &Store{db: db, ttl: ttl, idleTTL: idleTTL, secure: secure,
		cache: ttlCacheFor(),
		now:   time.Now}
	s.load = s.loadSession
	s.revoke = s.Revoke
	process.Store(s)
	return s
}

// ttlCacheFor builds the resolve cache. A function so a test can construct a
// Store without a database and still get the real cache behind it.
func ttlCacheFor() *ttlcache.Cache[string, *cachedSession] {
	return ttlcache.New[string, *cachedSession](resolveTTL, resolveCap)
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(tok string) []byte {
	sum := sha256.Sum256([]byte(tok))
	return sum[:]
}

func (s *Store) Issue(ctx context.Context, w http.ResponseWriter, r *http.Request, userID, instID uuid.UUID) error {
	tok, err := newToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(s.ttl)

	var ip *string
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = &host
	} else if r.RemoteAddr != "" {
		h := r.RemoteAddr
		ip = &h
	}

	err = s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO sessions (institution_id, user_id, token_hash, ip, user_agent, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			nullUUID(instID), userID, hashToken(tok), ip, r.UserAgent(), expires)
		return err
	})
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    tok,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// Resolve validates the cookie and loads the caller's identity and effective
// permissions in one round trip.
//
// The idle check is enforced here rather than by an expires_at bump on write,
// because a user who leaves a tab open should not stay signed in forever.
func (s *Store) Resolve(ctx context.Context, r *http.Request) (*httpx.Identity, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, ErrNoSession
	}
	hash := hashToken(c.Value)
	key := string(hash)

	cs, hit := s.cache.Get(key)
	if !hit {
		rec, err := s.load(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNoSession
		}
		if err != nil {
			return nil, fmt.Errorf("resolve session: %w", err)
		}
		cs = &cachedSession{id: identityFrom(rec)}
		cs.lastSeen.Store(rec.lastSeen.UnixNano())
		s.cache.Set(key, cs)
	}

	now := s.now()
	lastSeen := time.Unix(0, cs.lastSeen.Load())
	if now.Sub(lastSeen) > s.idleTTL {
		s.cache.Delete(key)
		_ = s.revoke(ctx, cs.id.SessionID)
		return nil, ErrNoSession
	}

	// Throttled so a chatty SPA does not turn every poll into a write. The
	// cached last-seen moves forward with the write, so the idle clock keeps
	// counting from the last request this process actually recorded.
	//
	// CompareAndSwap rather than a plain store: if two requests arrive
	// together only one should pay for the UPDATE, and the loser should not
	// push the idle clock forward on the strength of a write it never made.
	if now.Sub(lastSeen) > touchEvery &&
		cs.lastSeen.CompareAndSwap(lastSeen.UnixNano(), now.UnixNano()) {
		_ = s.touch(ctx, cs.id.SessionID)
	}

	/* A copy per request, never the cached pointer.

	   ActingInstitution amends id.InstitutionID in place so that the audit
	   middleware, which holds the same pointer, records the school the
	   operator entered. That is only safe because nothing else holds the
	   pointer -- which stops being true the moment the resolver hands the
	   same Identity to the next request. Handed the cached one, an operator
	   who picked a school in one tab would still be "inside" it on their
	   next unrelated request. The permissions map is shared read-only. */
	id := cs.id
	return &id, nil
}

// loadSession is the one round trip that answers "who is this cookie".
func (s *Store) loadSession(ctx context.Context, tokenHash []byte) (*sessionRecord, error) {
	rec := &sessionRecord{}
	err := s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* THE ROLES COME BACK AS SUBQUERIES, NOT AS JOINS.

		   This ran on every authenticated request and it was the single most
		   expensive thing the server did: 620-1280ms warm and 306,065 shared
		   buffers -- 2.4GB read -- to answer "who is this cookie".

		   The cause was the join order, and the planner was not being stupid.
		   Every RLS policy on these tables reads
		   `app_is_platform_admin() OR institution_id = ...`, which Postgres
		   cannot estimate, so it guessed one row from users, from user_roles
		   and from roles alike. On those estimates the cheapest-looking plan
		   drives from a sequential scan of users and joins sessions LAST
		   through a materialise, which meant user_roles was scanned once per
		   user and `roles` -- a 46-row table -- was scanned 47,040 times per
		   request. Measured across two minutes of live traffic: 2.87 MILLION
		   sequential scans of roles for 77 requests served. Lifetime, that
		   table had read 3.3 billion tuples.

		   Correlating on s.user_id instead takes users, user_roles and roles
		   out of the driving join altogether, so there is no order left for
		   the planner to get wrong: the unique index on sessions.token_hash
		   finds the one row and each subquery answers from an index on the
		   user id it already has. The GROUP BY goes with the joins.

		   Verified against production, same output, same 131 permissions:
		   620-1280ms and 306,065 buffers becomes 0.28-0.84ms and 30.

		   The lesson is the one this codebase keeps re-learning: a query that
		   reads correctly can still be unable to run well, and only EXPLAIN
		   on real data says which. */
		row := tx.QueryRow(ctx, `
			SELECT s.id, s.user_id, s.institution_id, s.last_seen_at, u.full_name,
			       u.must_change_password,
			       COALESCE((SELECT array_agg(DISTINCT rp.permission_key)
			                   FROM user_roles ur
			                   JOIN role_permissions rp ON rp.role_id = ur.role_id
			                  WHERE ur.user_id = s.user_id), '{}'),
			       COALESCE((SELECT array_agg(DISTINCT ro.key)
			                   FROM user_roles ur
			                   JOIN roles ro ON ro.id = ur.role_id
			                  WHERE ur.user_id = s.user_id), '{}')
			  FROM sessions s
			  JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = $1
			   AND s.revoked_at IS NULL
			   AND s.expires_at > now()
			   AND u.status = 'active'`,
			tokenHash)
		return row.Scan(&rec.sessionID, &rec.userID, &rec.instID, &rec.lastSeen, &rec.fullName,
			&rec.mustChangePassword, &rec.perms, &rec.roleKeys)
	})
	if err != nil {
		return nil, err
	}
	return rec, nil
}

// identityFrom assembles the caller's identity from the row.
func identityFrom(rec *sessionRecord) httpx.Identity {
	id := httpx.Identity{
		SessionID:          rec.sessionID,
		UserID:             rec.userID,
		FullName:           rec.fullName,
		MustChangePassword: rec.mustChangePassword,
	}
	if rec.instID != nil {
		id.InstitutionID = *rec.instID
	} else {
		// A user with no institution is platform staff; RLS gives them nothing
		// unless app.is_platform_admin is also set.
		id.PlatformAdmin = true
		/* ...but platform staff are not all the same. A vendor's billing
		   administrator reaches across tenants and must still be held to the
		   permissions they were granted, or they would inherit every school's
		   records by virtue of belonging to none. Restricted says "wide reach,
		   narrow rights".

		   Restriction is decided by role, not inferred from which permissions
		   the account happens to hold. The inference it replaces — restricted
		   if you can sell, unrestricted again if you can also write settings —
		   answered "is this a full operator?" by proxy, and the proxy failed
		   open: support_admin holds neither key, so a support engineer would
		   have been read as a full operator and handed every school's records.
		   super_admin is the only role that operates the installation, so
		   holding super_admin is the whole test. */
		id.Restricted = true
		for _, k := range rec.roleKeys {
			if k == rbac.PlatformOperatorRole {
				id.Restricted = false
			}
		}
	}
	id.Permissions = make(map[string]struct{}, len(rec.perms))
	for _, p := range rec.perms {
		id.Permissions[p] = struct{}{}
	}
	return id
}

/*
Forget drops the cached identity for one session, by id.

	Called by Revoke, and by any handler that ends a single session with its
	own UPDATE. Without it a "sign this login out" would be honoured by the
	database and ignored by this process for up to a minute, which is exactly
	the outcome the sessions screen exists to rule out.
*/
func (s *Store) Forget(sessionID uuid.UUID) {
	s.cache.DeleteFunc(func(_ string, cs *cachedSession) bool {
		return cs.id.SessionID == sessionID
	})
}

/*
ForgetUser drops every cached identity belonging to one user.

	For the writes that change what a cookie means without naming a session:
	a password reset that revokes every session, a suspension, a role granted
	or removed, must_change_password cleared. Anything that would make the
	next request's identity different from the last one's belongs here.
*/
func (s *Store) ForgetUser(userID uuid.UUID) {
	s.cache.DeleteFunc(func(_ string, cs *cachedSession) bool {
		return cs.id.UserID == userID
	})
}

func (s *Store) touch(ctx context.Context, sessionID uuid.UUID) error {
	return s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, sessionID)
		return err
	})
}

// ForgetPushTokens withdraws every phone registered to a user. Called at
// sign-out: the next person to sign in on this phone must not receive this
// person's alerts, and a second phone re-registers itself the next time it
// is opened, so nothing is lost that is not recovered.
func (s *Store) ForgetPushTokens(ctx context.Context, userID uuid.UUID) error {
	return s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM push_tokens WHERE user_id = $1`, userID)
		return err
	})
}

func (s *Store) Revoke(ctx context.Context, sessionID uuid.UUID) error {
	s.Forget(sessionID)
	return s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID)
		return err
	})
}

func (s *Store) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// Middleware attaches the identity when a valid cookie is present and is
// otherwise transparent, so public routes still work.
func (s *Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id, err := s.Resolve(r.Context(), r); err == nil {
			r = r.WithContext(httpx.WithIdentity(r.Context(), id))
		}
		next.ServeHTTP(w, r)
	})
}

func nullUUID(u uuid.UUID) *uuid.UUID {
	if u == uuid.Nil {
		return nil
	}
	return &u
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
