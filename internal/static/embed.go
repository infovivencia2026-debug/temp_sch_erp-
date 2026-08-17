// Package static embeds the assets used by the server-rendered pages — the
// sign-in screen and its stylesheet. The React SPA ships its own bundle and is
// served by nginx, not from here.
//
// Inter is embedded rather than linked because sign-in is the one page served
// before the SPA exists. It used to name Inter in a font stack with nothing to
// load, so the first screen anyone saw was set in whatever the system happened
// to supply — a different typeface from every screen after it.
package static

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
)

//go:embed *.css fonts/*.woff2
var FS embed.FS

/*
A version stamp for the stylesheet.

	nginx serves /static with a seven-day expiry, which is right for fonts and
	was wrong for the stylesheet: the URL never changed, so a browser that had
	fetched app.css once kept it for a week. Rewriting the sign-in page and
	adding the pricing page therefore shipped to nobody — existing visitors held
	a cached file with none of the new rules, and /buy rendered unstyled.

	The content hash goes on the URL as a query string, so each change is a new
	URL and the long expiry becomes correct rather than harmful. Computed once
	at start-up from the embedded bytes; there is no build step to forget.
*/
var cssVersion = func() string {
	b, err := FS.ReadFile("app.css")
	if err != nil {
		// Unreachable: the file is embedded at compile time. A constant is
		// still better than a panic in a webserver's init.
		return "0"
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:10]
}()

// Version identifies the current stylesheet. Templates append it to the href.
func Version() string { return cssVersion }
