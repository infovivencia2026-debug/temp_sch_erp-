package pdf

import (
	"bytes"
	"regexp"
)

var (
	pagesCount = regexp.MustCompile(`/Type\s*/Pages\b[^>]*?/Count\s+(\d+)|/Count\s+(\d+)[^>]*?/Type\s*/Pages\b`)
	pageObj    = regexp.MustCompile(`/Type\s*/Page\b`)
)

// PageCount counts the pages in a PDF, or 0 if b is not one.
//
// Chromium's PDF writer (Skia) writes every page as its own object with a
// plain "/Type /Page" dictionary, and the page tree as "/Type /Pages" with a
// "/Count". The count on the root page tree is the authoritative number, so
// that is read first; counting page objects is the fallback. Both are
// checked by tests against the shapes Skia writes.
//
// Enough for the one question asked of it -- "did this fit on one sheet" --
// and deliberately not a PDF parser.
func PageCount(b []byte) int {
	if !bytes.HasPrefix(b, []byte("%PDF-")) {
		return 0
	}
	// The largest /Count on any /Pages node is the root's: children count
	// their own subtrees, never more than the whole document.
	best := 0
	for _, m := range pagesCount.FindAllSubmatch(b, -1) {
		d := m[1]
		if len(d) == 0 {
			d = m[2]
		}
		n := atoi(d)
		if n > best {
			best = n
		}
	}
	if best > 0 {
		return best
	}
	return len(pageObj.FindAll(b, -1))
}

func atoi(b []byte) int {
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
		if n > 1_000_000 {
			return n
		}
	}
	return n
}
