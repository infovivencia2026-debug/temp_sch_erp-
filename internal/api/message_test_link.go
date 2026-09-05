package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE TEST PAGE, WITHOUT A LOGIN.

   The message test page needed a session, which is a nuisance for the thing it
   is for: somebody checking whether SMS works does not want to sign in first,
   and often wants to open it on the phone they are testing against rather than
   the machine they are signed in on.

   So it does not need one. What it needs instead is a key in the URL, and that
   distinction is the whole of this file.

   ---------------------------------------------------------------------------
   WHY NOT SIMPLY UNAUTHENTICATED

   An endpoint that sends messages and asks for nothing is an open relay. Not
   in the abstract: this one holds a school's Gmail credential, a WhatsApp
   Business number and an SMS gateway on a real SIM. Anyone who found the URL
   could send mail as the school, and repeated sends would take the WhatsApp
   number's quality rating down until Meta throttles it -- for every school on
   the installation, not just this one.

   Two things keep it safe, and both are needed:

     the key      an HMAC of the institution id under the server's own
                  SESSION_SECRET. Unguessable, needs no new storage, and
                  invalidates everywhere the moment that secret is rotated.

     the allowlist  unchanged and still in front. On a school in allowlist
                  mode the only reachable addresses are the ones an
                  administrator added, so even a leaked key sends to the
                  school's own test numbers and nowhere else.

   Plus a rate limit, because a key that leaks should cost a few messages
   rather than a month's quota.

   ---------------------------------------------------------------------------
   AND IT REFUSES TO EXIST WHERE IT SHOULD NOT

   Only for a school whose recipient guard is in allowlist mode. A school that
   has opened its guard to send to real families is a school in production, and
   a keyed send endpoint on production is not a convenience worth having. The
   endpoint answers 404 there -- not 403, which would confirm the URL is real.
*/

// messageTestKey derives the URL key for one institution.
//
// HMAC rather than a stored token: nothing to migrate, nothing to leak from a
// database dump that is not already derivable, and rotating SESSION_SECRET --
// which an operator does when anything is suspected -- invalidates every key
// at once without a query.
func messageTestKey(inst uuid.UUID) string {
	secret := os.Getenv("SESSION_SECRET")
	if strings.TrimSpace(secret) == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("message-test:" + inst.String()))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// errTestLinkClosed is the sentinel for a school whose guard has been opened.
// Mapped to 404 rather than 403: a 403 confirms the link is real to somebody
// who should not know that.
var errTestLinkClosed = errors.New("test link is closed on this school")

type publicTestSendRequest struct {
	Key     string `json:"key"`
	Channel string `json:"channel"`
	To      string `json:"to"`
	Body    string `json:"body"`
}

// sendPublicTestMessage sends one message on a keyed link, with no session.
func (s *Server) sendPublicTestMessage(w http.ResponseWriter, r *http.Request) {
	var req publicTestSendRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	key := strings.TrimSpace(req.Key)
	if key == "" {
		httpx.NotFound(w, r)
		return
	}

	/* Which institution this key belongs to.

	   Every one is checked rather than the id being carried in the URL: an id
	   in the URL plus a key would let somebody test whether a given id exists
	   by watching which combination 404s, and there is nothing to gain from
	   naming it when the key already identifies it. Installations here hold
	   ten schools, not ten thousand. */
	var inst uuid.UUID
	var found bool
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, qerr := tx.Query(r.Context(), `SELECT id FROM institutions`)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if serr := rows.Scan(&id); serr != nil {
				return serr
			}
			// Constant time: a byte-by-byte comparison here is a timing oracle
			// for the key, which is the one secret this endpoint has.
			if hmac.Equal([]byte(messageTestKey(id)), []byte(key)) {
				inst, found = id, true
			}
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	// Ten sends an hour per key, on the scopeMessageTestLink limiter. Enough
	// to test every channel several times; far too few to be worth stealing.
	if s.rateLimited(w, r, scopeMessageTestLink, messageTestLinkPolicy, key,
		"ten test messages an hour is the limit on this link") {
		return
	}

	channel := strings.TrimSpace(req.Channel)
	to := strings.TrimSpace(req.To)
	if channel == "" || to == "" {
		httpx.BadRequest(w, r, "a channel and an address are required")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		body = "This is a test message from the school office."
	}

	var guard string
	var result SendResult
	err = s.DB.InTenant(r.Context(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		/* The guard mode decides whether this endpoint exists at all. A school
		   that has opened its guard is live, and a keyed send endpoint on a
		   live school is not a convenience worth having. */
		if gerr := tx.QueryRow(r.Context(), `
			SELECT COALESCE(mode,'allowlist') FROM messaging_recipient_policy
			 WHERE institution_id = $1`, inst).Scan(&guard); gerr != nil &&
			gerr != pgx.ErrNoRows {
			return gerr
		}
		if guard != "" && guard != "allowlist" {
			return errTestLinkClosed
		}
		res, serr := s.QueueMessage(r.Context(), tx, inst, SendRequest{
			Channel:      channel,
			TemplateCode: "messaging.test",
			Vars:         map[string]any{"school_name": "your school", "body": body},
			Recipient:    to,
			SourceKind:   "test_link",
		})
		result = res
		return serr
	})
	if errors.Is(err, errTestLinkClosed) {
		// 404, not 403: a 403 confirms the link is real to somebody who should
		// not know that.
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"queued": true, "id": result.ID.String(), "duplicate": result.Duplicate,
		"note": "Queued. The recipient allowlist still applies, so an address " +
			"that is not on it is recorded and held rather than sent.",
	})
}

// getMessageTestLink hands an administrator the keyed URL to share.
func (s *Server) getMessageTestLink(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	key := messageTestKey(id.InstitutionID)
	if key == "" {
		httpx.Error(w, r, http.StatusConflict, "no_secret",
			"SESSION_SECRET is not set on this server, so a signed link cannot be made")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		/* The path the page already lives at, which schools have written down.
		   Served by nginx straight from the webroot, so it does not depend on
		   the SPA booting -- which matters for a page whose job is to test the
		   product when the product is what is suspected. */
		"url": strings.TrimSuffix(s.BaseURL, "/") + "/download/message-test.html?key=" + key,
		"note": "Anyone with this link can send test messages to the addresses on " +
			"your allowlist, ten an hour. It stops working the moment the guard " +
			"is taken off allowlist mode.",
	})
}
