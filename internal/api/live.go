package api

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Live, without anybody pressing reload.

   A teacher marks the register at 9:05 and the parent's screen still showed
   yesterday at 9:40, because the tab had been open since breakfast: react
   query holds what it fetched, refetchOnWindowFocus was off, and nothing on
   the page asked again. Every screen in the product had the same shape of bug,
   and the answer people were given was "reload it".

   WHY A REVISION AND NOT A SOCKET

   A WebSocket or an SSE stream means a connection per open tab held for the
   length of a school day, a pub/sub the writers all have to remember to
   publish to, and a reconnect story for every phone that walks out of Wi-Fi
   range. This is one small request on a timer that answers "has anything you
   can see changed?" with a single string. When it changes the client throws
   away its cache and every visible screen refetches itself; when it does not —
   which is most of the time — it costs one indexed max() per table and no
   traffic at all beyond the reply.

   WHY MAX() OVER A HANDFUL OF TABLES

   It needs no triggers, no counter to keep in step, and no write path to
   remember: a table that records when a row was written already knows when
   something changed. The tables chosen are the ones a person watches — the
   register, the marks, the money and the alerts — rather than everything,
   because a revision that ticks on a background job would refetch every open
   screen in the school for nothing.

   Scope matters: a parent's revision moves when THEIR child's register is
   marked, not when any child's is. Otherwise every family in the school
   refetches thirty times a morning.
*/

func (s *Server) getLiveRevision(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// A family is narrowed to their own children; staff see the school move.
	var children []string
	for _, sid := range res.StudentIDs {
		children = append(children, sid.String())
	}
	mine := len(children) > 0

	var rev string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT concat_ws('|',
			  -- The register. marked_at and corrected_at both, or a correction
			  -- made after the fact would not move the number and the family
			  -- would keep the wrong day on screen.
			  (SELECT to_char(greatest(max(a.marked_at), max(a.corrected_at)),
			                  'YYYYMMDDHH24MISS')
			     FROM student_attendance a
			    WHERE NOT $2 OR a.student_id = ANY($3::uuid[])),
			  (SELECT to_char(max(m.entered_at), 'YYYYMMDDHH24MISS')
			     FROM marks m
			    WHERE NOT $2 OR m.student_id = ANY($3::uuid[])),
			  (SELECT to_char(max(i.updated_at), 'YYYYMMDDHH24MISS')
			     FROM invoices i
			    WHERE NOT $2 OR i.student_id = ANY($3::uuid[])),
			  -- Alerts are already per person, so this one needs no narrowing.
			  (SELECT to_char(max(n.created_at), 'YYYYMMDDHH24MISS')
			     FROM notifications n WHERE n.user_id = $1),
			  (SELECT to_char(max(h.updated_at), 'YYYYMMDDHH24MISS')
			     FROM homework h),
			  -- Results appearing is the other thing a family waits for.
			  (SELECT to_char(max(rc.published_at), 'YYYYMMDDHH24MISS')
			     FROM report_cards rc
			    WHERE rc.is_published AND (NOT $2 OR rc.student_id = ANY($3::uuid[])))
			)`, id.UserID, mine, children).Scan(&rev)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Not cached anywhere between here and the tab.

	   A revision served from a proxy is a revision that never changes, which is
	   the one failure this endpoint cannot survive: the page would sit still
	   and nobody would know why. */
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"rev": rev,
		// The server's own clock, so a client can show "as of" honestly rather
		// than trusting a phone whose time is wrong.
		"at": time.Now().In(indiaTZ()).Format("15:04:05"),
	})
}
