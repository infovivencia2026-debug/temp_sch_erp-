package api

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/httpx"
)

/* The teachers' daily sign-in code, as the office and the staffroom see it.

   The mechanism is in auth/daycode.go. This is the two doors onto it: the
   principal's switch on Logins & access (on, off, "new code now"), and the
   line on a teacher's own profile that says what today's code is, so it
   reaches the staffroom through thirty phones rather than one noticeboard.

   The code itself is never written anywhere. Both handlers derive it from
   the secret at the moment of asking, for the school's own date. */

type dayCodeState struct {
	Enabled bool `json:"enabled"`
	// Today's code, present only while enabled.
	Code string `json:"code,omitempty"`
	// The school-local date the code is for, and when it stops working.
	Date      string `json:"date,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

func (s *Server) dayCodeState(secret []byte, tz string) dayCodeState {
	if len(secret) == 0 {
		return dayCodeState{}
	}
	day, end := auth.LocalDay(tz, time.Now())
	return dayCodeState{
		Enabled:   true,
		Code:      auth.DayCode(secret, day),
		Date:      day.Format("2006-01-02"),
		ExpiresAt: end.UTC().Format(time.RFC3339),
	}
}

func (s *Server) readDayCode(r *http.Request) (dayCodeState, error) {
	id := httpx.IdentityFrom(r.Context())
	var secret []byte
	var tz string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT teacher_day_code_secret, timezone FROM institutions WHERE id = $1`,
			id.InstitutionID).Scan(&secret, &tz)
	})
	return s.dayCodeState(secret, tz), err
}

// getDayCode powers the switch on institution_admin.staff.logins_access.
func (s *Server) getDayCode(w http.ResponseWriter, r *http.Request) {
	st, err := s.readDayCode(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

type dayCodeUpdate struct {
	Enabled bool `json:"enabled"`
	// Rotate replaces the secret while leaving the feature on: the button
	// for "somebody wrote today's code on the whiteboard". Today's code
	// changes at once; sessions already open are not touched, they end at
	// midnight like any other.
	Rotate bool `json:"rotate"`
}

// setDayCode switches the feature on or off for the school, or issues a new
// code for today.
func (s *Server) setDayCode(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req dayCodeUpdate
	if !httpx.Decode(w, r, &req) {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if !req.Enabled {
			_, err := tx.Exec(r.Context(), `
				UPDATE institutions SET teacher_day_code_secret = NULL, updated_at = now()
				 WHERE id = $1`, id.InstitutionID)
			return err
		}
		// Switching on keeps an existing secret unless asked to rotate, so
		// pressing "on" twice does not change a code the staffroom already
		// has.
		secret, err := auth.NewDayCodeSecret()
		if err != nil {
			return err
		}
		if req.Rotate {
			_, err = tx.Exec(r.Context(), `
				UPDATE institutions SET teacher_day_code_secret = $2, updated_at = now()
				 WHERE id = $1`, id.InstitutionID, secret)
		} else {
			_, err = tx.Exec(r.Context(), `
				UPDATE institutions
				   SET teacher_day_code_secret = COALESCE(teacher_day_code_secret, $2),
				       updated_at = now()
				 WHERE id = $1`, id.InstitutionID, secret)
		}
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.getDayCode(w, r)
}

// getMyDayCode is the teacher's own view: today's code, or "off", or 404 for
// somebody who holds no teaching role and has no business reading it. The
// route is not permission-gated because there is no permission for "is a
// teacher"; the role check here is the gate.
func (s *Server) getMyDayCode(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.PlatformAdmin {
		httpx.NotFound(w, r)
		return
	}
	var teacher bool
	var secret []byte
	var tz string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
			                WHERE ur.user_id = $1 AND r.key = ANY($3)),
			       i.teacher_day_code_secret, i.timezone
			  FROM institutions i WHERE i.id = $2`,
			id.UserID, id.InstitutionID, auth.DayCodeRoles).Scan(&teacher, &secret, &tz)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !teacher {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, s.dayCodeState(secret, tz))
}
