package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"time"
)

/* The teachers' daily sign-in code.

   Six digits, the same for every teacher of a school, different every day,
   accepted in place of the password by accounts that hold a teaching role.
   It exists for the classroom board: a teacher signing in on the panel with
   the class watching should be giving away something that expires at
   midnight, not the password that reaches her payslip.

   Derived rather than stored -- HMAC-SHA256 of the school's local date under
   a per-school secret, reduced to six digits -- so there is nothing to write
   each morning and nothing that can fail to be written. The secret lives on
   the institution row; NULL is "off", and replacing it changes today's code
   at once, which is the "somebody wrote it on the whiteboard" button.

   Six digits against the login throttle (eight tries, then five minutes per
   identifier) is a one-in-125,000 chance per locked-out window per known
   username, and the window is a day. Short enough to type on a board without
   a keyboard, long enough for that. */

// DayCodeRoles are the role keys the day code signs in. Heads of department
// teach too.
var DayCodeRoles = []string{"faculty", "hod"}

// NewDayCodeSecret mints a secret for a school switching the feature on, or
// rotating out one that leaked.
func NewDayCodeSecret() ([]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

// DayCode is the code for one calendar day under one secret.
func DayCode(secret []byte, day time.Time) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(day.Format("2006-01-02")))
	sum := mac.Sum(nil)
	n := binary.BigEndian.Uint32(sum[:4]) % 1_000_000
	return fmt.Sprintf("%06d", n)
}

// LocalDay is "today" and "when today ends" in the school's own timezone. A
// school in Kolkata and a server in Mumbai agree; a school in Kolkata and a
// server in Iowa would not, and the code has to turn over at the school's
// midnight, not the server's.
func LocalDay(tz string, now time.Time) (day time.Time, end time.Time) {
	loc, err := time.LoadLocation(tz)
	if err != nil || tz == "" {
		loc, _ = time.LoadLocation("Asia/Kolkata")
	}
	t := now.In(loc)
	day = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	return day, day.AddDate(0, 0, 1)
}

// DayCodeMatches says whether a typed value is today's code. Constant-time on
// the comparison; the length check leaks nothing a person does not already
// know about six-digit codes.
func DayCodeMatches(secret []byte, tz string, typed string, now time.Time) bool {
	if len(secret) == 0 || len(typed) != 6 {
		return false
	}
	day, _ := LocalDay(tz, now)
	return hmac.Equal([]byte(DayCode(secret, day)), []byte(typed))
}
