package fees

import (
	"regexp"

	qrcode "github.com/skip2/go-qrcode"
	"strconv"
	"strings"
)

/* The UPI payment intent, and why it is built by hand.

   A `upi://pay?...` URI is what every UPI app decodes when it scans a QR: the
   payee address, the payee name, the amount and a note. It looks like a query
   string and it is not one. UPI apps parse it as an RFC 3986 URI, so a space
   must be %20 and never "+" -- url.Values.Encode writes "+" and PhonePe, BHIM
   and Paytm then show "Fee+Payment" to the parent, literally. The address is
   left unescaped: the specification's own examples write name@bank, and at
   least one app refuses %40 in pa.

   So this encodes the two free-text fields with a strict percent-encoder that
   keeps only RFC 3986 unreserved characters, and writes the amount as a plain
   two-decimal rupee figure. The SPA carries the same rule in web/src/lib/upi.ts
   for codes it draws itself; the two must agree, and the tests on each side
   pin the same example. */

// vpaRe is the NPCI virtual payment address: handle@psp. The same shape as the
// CHECK constraint on institutions.upi_vpa, so a value that passes here saves.
var vpaRe = regexp.MustCompile(`^[A-Za-z0-9._-]{3,}@[A-Za-z0-9]{2,}$`)

// ValidVPA reports whether s is shaped like a UPI address. It says nothing
// about whether the address exists; only the bank knows that.
func ValidVPA(s string) bool {
	return vpaRe.MatchString(s)
}

// Field limits from the NPCI linking specification. An app that receives more
// truncates silently or refuses the code, and neither is something a parent
// can diagnose at a counter.
const (
	upiPayeeNameMax = 99
	upiNoteMax      = 50
)

// UPIIntent builds the upi://pay URI for a fixed-amount payment to vpa. The
// note is what the payer's app shows and what tends to reach the bank
// narration, so callers put the admission number in it. An empty note is
// omitted rather than sent blank.
func UPIIntent(vpa, payeeName string, amountPaise int64, note string) string {
	var b strings.Builder
	b.WriteString("upi://pay?pa=")
	b.WriteString(vpa)
	b.WriteString("&pn=")
	b.WriteString(percentEncode(clipRunes(strings.TrimSpace(payeeName), upiPayeeNameMax)))
	b.WriteString("&am=")
	b.WriteString(Rupees(amountPaise))
	b.WriteString("&cu=INR")
	if n := clipRunes(strings.TrimSpace(note), upiNoteMax); n != "" {
		b.WriteString("&tn=")
		b.WriteString(percentEncode(n))
	}
	return b.String()
}

// Rupees renders paise as the plain decimal a UPI intent wants: "1234.50",
// no grouping, no symbol, always two places.
func Rupees(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	s := strconv.FormatInt(paise/100, 10) + "." + pad2(paise%100)
	if neg {
		return "-" + s
	}
	return s
}

func pad2(n int64) string {
	if n < 10 {
		return "0" + strconv.FormatInt(n, 10)
	}
	return strconv.FormatInt(n, 10)
}

// percentEncode escapes everything but RFC 3986 unreserved characters, byte by
// byte over the UTF-8 encoding. Stricter than url.QueryEscape (which writes
// "+" for a space) and url.PathEscape (which leaves "&" and "=" alone, and
// either would split the query).
func percentEncode(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

// clipRunes cuts s to at most n characters, not bytes, so a Telugu school
// name is not sliced through the middle of a code point.
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n]))
}

/* The code itself, drawn here rather than in the browser.

   The SPA used to draw the QR on a canvas from the intent string. That is one
   round trip fewer, and it is also one more thing an old phone browser can
   fail at silently: no canvas, a stalled bundle, a WebView with JS half
   disabled. A parent then sees an empty white square at the gate. A PNG the
   server drew displays in anything that shows an <img>, so it is drawn once
   here and the page only shows it.

   Error correction M: this is a screen or a printout at arm's length, not a
   windscreen sticker, and H would make a fixed-amount intent with a note
   dense enough that an older phone camera struggles. */

// UPIQRPNG renders intent as a QR code PNG, size pixels square. Drawn at a
// fixed pixel size and shown at half that, so it is crisp on a phone screen.
func UPIQRPNG(intent string, size int) ([]byte, error) {
	if size < 120 {
		size = 120
	}
	if size > 1024 {
		size = 1024
	}
	q, err := qrcode.New(intent, qrcode.Medium)
	if err != nil {
		return nil, err
	}
	q.DisableBorder = false
	return q.PNG(size)
}

// noteDropRe is the ASCII punctuation a UPI app may choke on in a note. A
// blacklist rather than a letters-only rule, so a Telugu name survives. The
// marks an admission or invoice number is written with (dot, slash, hyphen)
// stay.
var noteDropRe = regexp.MustCompile(`[!"#$%&'()*+,:;<=>?@\[\\\]^_{|}~` + "`]")

// UPINote cleans a caller-supplied note the way the intent wants it: one
// space between words, risky punctuation dropped, clipped to the 50 the
// specification allows.
func UPINote(s string) string {
	s = noteDropRe.ReplaceAllString(s, "")
	s = strings.Join(strings.Fields(s), " ")
	return clipRunes(s, upiNoteMax)
}
