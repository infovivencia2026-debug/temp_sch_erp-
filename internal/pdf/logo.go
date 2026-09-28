package pdf

import (
	"bytes"
	"encoding/base64"
	"html/template"
	"net/http"
	"strings"
)

// MaxLogoBytes bounds the logo embedded in a document. A school logo is tens
// of kilobytes; a phone photograph uploaded as one is several megabytes and
// would make every receipt that size.
const MaxLogoBytes = 1_500_000

// LogoDataURI turns uploaded logo bytes into a data: URI the templates can
// embed, or "" when they are not an image this can vouch for.
//
// The renderer is not allowed to fetch anything (service-pdf.yaml), so the
// logo travels inside the page. The type is decided from the bytes, not from
// what the upload claimed, for the raster formats; SVG cannot be sniffed and
// is accepted only when it is declared as SVG and looks like one. An SVG in
// an <img> cannot run script, and the renderer has JavaScript off besides.
func LogoDataURI(b []byte, declared string) template.URL {
	if len(b) == 0 || len(b) > MaxLogoBytes {
		return ""
	}
	ct := http.DetectContentType(b)
	switch ct {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		d := strings.ToLower(strings.TrimSpace(declared))
		if !strings.HasPrefix(d, "image/svg+xml") || !bytes.Contains(bytes.ToLower(b[:min(len(b), 4096)]), []byte("<svg")) {
			return ""
		}
		ct = "image/svg+xml"
	}
	//nolint:gosec // bytes checked above; a data: URI of an image, not markup.
	return template.URL("data:" + ct + ";base64," + base64.StdEncoding.EncodeToString(b))
}
