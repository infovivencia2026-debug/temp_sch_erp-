package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* SENDING THE SAME WRITE TWICE MUST NOT DO IT TWICE.

   This is the half of offline support that lives on the server. The client
   holds writes it could not send and sends them when the signal returns, and
   that is only safe because of what happens here.

   The problem it solves is not "the request failed". It is that a client
   cannot tell a request that never arrived from one that arrived, was
   executed, and whose answer was lost on the way back. Those are the same
   event from where the client is standing: no response. Retrying is wrong in
   the second case and required in the first, and the client has no way to
   know which it is in.

   So the client names the attempt instead. `Idempotency-Key` is minted once,
   when somebody presses the button, and every retry of that press carries the
   same value. The first request to arrive under a key does the work and its
   answer is stored; every later arrival is answered from the store and the
   handler never runs. A dropped response now costs a duplicate REQUEST, which
   is free, instead of a duplicate WRITE, which is a family charged twice.

   Deliberately opt-in per request rather than applied to every mutation. A key
   the client did not mint is a key the client cannot resend, and inventing one
   here from the method and path would make two genuinely separate presses of
   "add payment" -- same route, same body, two real payments -- collapse into
   one. Only the caller knows whether two identical requests are one intent or
   two, so only the caller may say so. */

// Requests that carry no key, and reads, pass through untouched.
func (s *Server) Idempotent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		switch {
		case key == "",
			len(key) > 200,
			r.Method == http.MethodGet, r.Method == http.MethodHead, r.Method == http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}

		/* JSON only, and that is a safety rule rather than a convenience.
		   The body has to be read to hash it, and reading a multipart upload
		   into memory to hash it would cap every file the product accepts at
		   whatever limit this middleware picked -- a bulk-import sheet or a
		   student photograph would start failing for a reason nobody could
		   see from the screen. File uploads are also not the case this
		   exists for: nobody re-sends a photograph from a queue on a bus. */
		if ct := r.Header.Get("Content-Type"); ct != "" &&
			!strings.HasPrefix(strings.ToLower(ct), "application/json") {
			next.ServeHTTP(w, r)
			return
		}

		id := httpx.IdentityFrom(r.Context())
		/* A platform operator not working inside a school has no tenant to
		   scope the receipt to, and the table is keyed by one. They are also
		   not the caller this exists for -- nobody administers the platform
		   from a bus -- so the honest thing is to let the request through
		   unprotected rather than store a row under a zero institution that
		   every other operator would then collide with. */
		if id == nil || id.InstitutionID == uuid.Nil {
			next.ServeHTTP(w, r)
			return
		}

		/* The body has to be read to hash it, and reading it consumes it.
		   Put it back before anything downstream looks. */
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
		if err != nil {
			httpx.BadRequest(w, r, "could not read the request body")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		sum := sha256.Sum256(body)
		hash := hex.EncodeToString(sum[:])

		scope := tenantScope(id)
		var (
			claimed bool
			prevSt  *int
			prevBod []byte
			prevM   string
			prevP   string
			prevH   string
		)
		err = s.DB.InTenant(r.Context(), scope, func(tx pgx.Tx) error {
			/* Claim and read in one statement. ON CONFLICT DO NOTHING returns
			   no row when the key is already there, which is exactly the
			   signal needed -- and it is atomic, so two requests racing under
			   one key cannot both believe they are the first. */
			err := tx.QueryRow(r.Context(), `
                INSERT INTO idempotency_keys
                       (institution_id, key, user_id, method, path, request_hash)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (institution_id, key) DO NOTHING
                RETURNING true`,
				id.InstitutionID, key, id.UserID, r.Method, r.URL.Path, hash,
			).Scan(&claimed)
			if err == nil {
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			return tx.QueryRow(r.Context(), `
                SELECT status_code, response_body, method, path, request_hash
                  FROM idempotency_keys
                 WHERE institution_id = $1 AND key = $2 AND user_id = $3`,
				id.InstitutionID, key, id.UserID,
			).Scan(&prevSt, &prevBod, &prevM, &prevP, &prevH)
		})
		switch {
		case err == nil:
		case errors.Is(err, pgx.ErrNoRows):
			/* The key exists for somebody else. Two people share the
			   staffroom laptop; answering this one from the other one's
			   receipt would hand over their data. */
			httpx.Error(w, r, http.StatusConflict, "idempotency_key_reused",
				"That request reference belongs to a different sign-in. Try the action again.")
			return
		default:
			httpx.Error(w, r, http.StatusInternalServerError, "idempotency_failed",
				"Could not check whether this request had already been sent.")
			return
		}

		if !claimed {
			// A key reused for a different request is a client bug, and
			// answering it from the wrong receipt would hide it.
			if prevM != r.Method || prevP != r.URL.Path || prevH != hash {
				httpx.Error(w, r, http.StatusConflict, "idempotency_key_conflict",
					"That request reference was already used for a different request.")
				return
			}
			if prevSt == nil {
				/* Claimed, not finished. The first copy is still running;
				   starting the work again beside it is the duplicate this
				   whole file exists to prevent. 409 rather than 425 because
				   the client outbox already treats 4xx as "stop and show me",
				   and this is genuinely a conflict with a request in flight. */
				httpx.Error(w, r, http.StatusConflict, "idempotency_in_flight",
					"That request is still being processed. It will not be sent twice.")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(*prevSt)
			_, _ = w.Write(prevBod)
			return
		}

		rec := &recorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		/* Only a settled answer is worth keeping. A 5xx is the server saying
		   it does not know what happened, and storing that would turn one bad
		   minute into a permanent answer: every retry of a write that might
		   yet have succeeded would be told "500" forever, and the row could
		   never be re-attempted. Releasing the claim lets the next retry try
		   for real. 4xx IS settled -- the request was wrong and will be wrong
		   again -- so it is stored like any other outcome. */
		if rec.status >= 500 {
			_ = s.DB.InTenant(r.Context(), scope, func(tx pgx.Tx) error {
				_, err := tx.Exec(r.Context(),
					`DELETE FROM idempotency_keys WHERE institution_id = $1 AND key = $2`,
					id.InstitutionID, key)
				return err
			})
			return
		}
		_ = s.DB.InTenant(r.Context(), scope, func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
                UPDATE idempotency_keys
                   SET status_code = $3, response_body = $4, completed_at = now()
                 WHERE institution_id = $1 AND key = $2`,
				id.InstitutionID, key, rec.status, rec.buf.Bytes())
			return err
		})
	})
}

/*
Keeps a copy of what the handler said.

	Writes straight through as well as buffering, so a slow handler still
	streams and nothing about the live response changes shape. The buffer is
	only read afterwards, to be stored.
*/
type recorder struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
	wrote  bool
}

func (rec *recorder) WriteHeader(code int) {
	if rec.wrote {
		return
	}
	rec.wrote = true
	rec.status = code
	rec.ResponseWriter.WriteHeader(code)
}

func (rec *recorder) Write(p []byte) (int, error) {
	if !rec.wrote {
		rec.WriteHeader(http.StatusOK)
	}
	rec.buf.Write(p)
	return rec.ResponseWriter.Write(p)
}
