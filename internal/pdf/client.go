// Package pdf prints the product's documents -- fee receipts first -- as PDF
// files.
//
// A document is an HTML template filled on the server (templates.go) and
// printed by headless Chromium in the private temperp-pdf service
// (deploy/cloudrun/service-pdf.yaml, Gotenberg). What reaches a person is
// the PDF and only the PDF: no page of the app, no browser header or footer,
// the same file on a counter printer, a phone and a WhatsApp forward.
//
// ONE PAGE, STRICTLY. A receipt that spills onto a second sheet is two
// pieces of paper a parent has to keep together. RenderOnePage prints, counts
// the pages, and prints again with tighter type until the document fits; if it
// does not fit at the tightest legible layout it refuses rather than cut
// anything off. A clipped receipt is worse than no receipt.
package pdf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrNotConfigured is returned when no renderer URL is set. The handlers turn
// it into a 503 with a sentence rather than a stack trace.
var ErrNotConfigured = errors.New("pdf: no renderer configured")

// ErrTooLong is returned when a document does not fit on one page even at the
// tightest layout RenderOnePage will print.
var ErrTooLong = errors.New("pdf: document does not fit on one page")

// Paper is a sheet size in millimetres, portrait as given.
type Paper struct {
	WidthMM, HeightMM float64
}

var (
	A4          = Paper{210, 297}
	A5Landscape = Paper{210, 148}
)

// Client talks to the renderer.
type Client struct {
	// URL is the renderer's base URL, e.g. https://temperp-pdf-….run.app.
	URL  string
	HTTP *http.Client
	// Token returns the bearer token for a request, or "" for none. Nil means
	// "Google identity token from the metadata server when running on Cloud
	// Run, none otherwise" -- see identityToken.
	Token func(ctx context.Context, audience string) (string, error)
}

// New returns a client for the renderer at baseURL (empty: not configured).
func New(baseURL string) *Client {
	return &Client{
		URL:  strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTP: &http.Client{Timeout: 45 * time.Second},
	}
}

// Configured reports whether a renderer URL is set.
func (c *Client) Configured() bool { return c != nil && c.URL != "" }

// Densities is how many layouts a template offers, from roomiest (0) to
// tightest. Every template renders each one at full page width -- smaller
// type and tighter rows, never a shrunken page with a blank strip beside it.
const Densities = 4

// RenderOnePage prints the first density that fits on one sheet of paper.
// build returns the HTML for a density level. Nothing is ever clipped: the
// templates let content grow, so a document too long for the page shows up
// here as a second page and the next, tighter, level is tried. When even the
// tightest does not fit, ErrTooLong -- the caller says so to the person.
func (c *Client) RenderOnePage(ctx context.Context, paper Paper,
	build func(density int) ([]byte, error)) ([]byte, error) {
	for d := 0; d < Densities; d++ {
		html, err := build(d)
		if err != nil {
			return nil, err
		}
		out, err := c.render(ctx, html, paper)
		if err != nil {
			return nil, err
		}
		switch n := PageCount(out); {
		case n == 1:
			return out, nil
		case n == 0:
			return nil, errors.New("pdf: renderer returned something that is not a PDF")
		}
	}
	return nil, ErrTooLong
}

func mmToInches(mm float64) string {
	return strconv.FormatFloat(mm/25.4, 'f', 4, 64)
}

func (c *Client) render(ctx context.Context, html []byte, paper Paper) ([]byte, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("files", "index.html")
	if err != nil {
		return nil, err
	}
	if _, err := fw.Write(html); err != nil {
		return nil, err
	}
	fields := map[string]string{
		"paperWidth":  mmToInches(paper.WidthMM),
		"paperHeight": mmToInches(paper.HeightMM),
		// The templates own their margins; Chromium's defaults would add a
		// second border inside the one the page is designed with.
		"marginTop": "0", "marginBottom": "0", "marginLeft": "0", "marginRight": "0",
		"printBackground":   "true",
		"preferCssPageSize": "false",
		// No header, no footer, no date and URL across the top: a document,
		// not a printed web page.
		"generateDocumentOutline": "false",
	}
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.URL+"/forms/chromium/convert/html", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	tok, err := c.token(ctx)
	if err != nil {
		return nil, fmt.Errorf("pdf: identity token: %w", err)
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("pdf: render: %w", err)
	}
	defer res.Body.Close() //nolint:errcheck
	// A receipt is tens of kilobytes; 20 MB is a generous ceiling that still
	// stops a misbehaving renderer from filling memory.
	out, err := io.ReadAll(io.LimitReader(res.Body, 20<<20))
	if err != nil {
		return nil, fmt.Errorf("pdf: read: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("pdf: renderer answered %d: %s", res.StatusCode, msg)
	}
	return out, nil
}

func (c *Client) token(ctx context.Context) (string, error) {
	if c.Token != nil {
		return c.Token(ctx, c.URL)
	}
	return identityToken(ctx, c.URL)
}

// The renderer is private: Cloud Run lets a request through only with a
// Google identity token for an account holding run.invoker on it, which is
// temperp-run and nobody else. On Cloud Run that token comes from the
// metadata server for the service's own account. Anywhere else (a laptop
// running the renderer on localhost) there is no metadata server and no
// token is sent. Tokens last an hour; one is reused for fifty minutes.
var (
	tokMu      sync.Mutex
	tokCache   = map[string]cachedToken{}
	metadataOK = os.Getenv("K_SERVICE") != "" // set by Cloud Run
)

type cachedToken struct {
	value   string
	expires time.Time
}

func identityToken(ctx context.Context, audience string) (string, error) {
	if !metadataOK {
		return "", nil
	}
	tokMu.Lock()
	if t, ok := tokCache[audience]; ok && time.Now().Before(t.expires) {
		tokMu.Unlock()
		return t.value, nil
	}
	tokMu.Unlock()

	u := "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
		url.QueryEscape(audience)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close() //nolint:errcheck
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<10))
	if err != nil {
		return "", err
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata server answered %d", res.StatusCode)
	}
	tok := strings.TrimSpace(string(b))
	tokMu.Lock()
	tokCache[audience] = cachedToken{value: tok, expires: time.Now().Add(50 * time.Minute)}
	tokMu.Unlock()
	return tok, nil
}
