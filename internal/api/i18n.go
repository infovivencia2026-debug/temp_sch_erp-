package api

// Server-side half of the interface-language contract.
//
// There are no routes in this file, and that is deliberate. The account
// already has exactly one display-preference endpoint --
// GET/PUT /api/v1/portal/preferences/display, mounted in student_life.go --
// and locale is a display preference. A second endpoint would mean two writes
// on one Save, an ordering question when one of them fails, and a settings
// screen that can disagree with itself. So the locale and high-contrast
// fields ride on the existing request and response, and this file holds only
// what is specific to language: the closed list of locales and its validator.
//
// There is therefore no mountI18n to splice into api.go. If a later feature
// does need i18n routes of its own, add them here as
// func (s *Server) mountI18n(r chi.Router) and mount under the portal group.

// localeChoices is the set of locales a client may store.
//
// It is closed, and it is the same list the frontend ships catalogues for
// (web/src/locales, registered in web/src/lib/i18n.tsx). The reason is not
// tidiness: a stored locale with no catalogue renders every screen as a
// column of raw message keys, and the user who did it has no way back except
// to guess which of those keys is the language selector. Validating here
// means the worst a malicious or stale client achieves is a 400.
//
// The database CHECK constraint in migrations/00088_i18n.sql carries the same
// list. Both must be widened to add a language; see that file's closing note.
var localeChoices = []string{"en"}

// defaultLocale is English, and must stay English until a school opts out.
// A user who has never opened the language selector has to see exactly the
// words the product shows today.
const defaultLocale = "en"

// isAllowedLocale reports whether v is a locale this build can actually
// render. Reuses isAllowedChoice (student_life.go) rather than a second
// membership helper.
func isAllowedLocale(v string) bool { return isAllowedChoice(v, localeChoices) }
