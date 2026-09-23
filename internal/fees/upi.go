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

/* WHICH UPI APP, CHOSEN BY THE PARENT RATHER THAN BY ANDROID.

   `upi://pay?...` names a payment and not an app. Android resolves the scheme
   against whatever holds the default handler, and once a parent has tapped
   "Always" on any UPI-capable app -- WhatsApp, on a great many phones --
   every later tap goes straight there with no chooser. A parent whose money
   is in Google Pay taps "pay" and lands in a WhatsApp account they have never
   funded, and nothing on screen explains it.

   The fix is not a cleverer generic link; the OS default is the OS's to keep.
   It is to ask the question on the page, the way every payment page in the
   country does: one button per app, each addressing that app directly.

     Android  intent://pay?...#Intent;scheme=upi;package=<pkg>;end
              The package makes it unambiguous, so the default never applies.
              An app that is not installed falls through to the chooser
              instead of failing, which is the behaviour we want anyway.

     iOS      <scheme>://... -- the app's own registered scheme. Nothing
              opens if it is not installed, which is why the generic entry
              and the QR both stay on the page.

   Generic stays last, and keeps the old behaviour for anyone whose app is
   not listed. The QR above it needs none of this: a scan happens inside the
   app the parent has already chosen to open. */

// UPIApp is one payment app, and how to reach it on each phone.
type UPIApp struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// Android is an intent: URI naming the package, so the OS default handler
	// is bypassed. Empty for the generic entry, which uses Intent.
	Android string `json:"android,omitempty"`
	// IOS is the app's own URL scheme. Empty where it has none.
	IOS string `json:"ios,omitempty"`
}

/*
The apps an Indian school's families actually hold, by share.

	Package names and schemes are the published, long-stable ones. They are a
	list rather than a switch so a school that meets a sixth app is a line
	here, and so a name that changes is one edit and a test, not a hunt
	through string concatenation.

	WhatsApp is deliberately absent as a BUTTON while remaining perfectly able
	to serve the generic link: it is a messenger that also does UPI, it is the
	default that caused this bug, and a parent who wants it will find it under
	"Another UPI app". Nothing here blocks it.
*/
var upiApps = []struct {
	key, label, androidPkg, iosScheme string
}{
	{"gpay", "Google Pay", "com.google.android.apps.nbu.paisa.user", "tez://upi/pay"},
	{"phonepe", "PhonePe", "com.phonepe.app", "phonepe://pay"},
	{"paytm", "Paytm", "net.one97.paytm", "paytmmp://pay"},
	{"bhim", "BHIM", "in.org.npci.upiapp", "bhim://pay"},
}

// UPIAppLinks returns one entry per app the parent can be sent to directly,
// and a generic last entry for everything else. Same payment in every one:
// the query is built once by UPIIntent and reused, so an app cannot be sent a
// different amount from the one in the QR.
func UPIAppLinks(vpa, payeeName string, amountPaise int64, note string) []UPIApp {
	intent := UPIIntent(vpa, payeeName, amountPaise, note)
	// Everything after "upi://pay?" -- the query the other forms reuse.
	query := strings.TrimPrefix(intent, "upi://pay?")

	out := make([]UPIApp, 0, len(upiApps)+1)
	for _, a := range upiApps {
		out = append(out, UPIApp{
			Key:   a.key,
			Label: a.label,
			Android: "intent://pay?" + query +
				"#Intent;scheme=upi;action=android.intent.action.VIEW;package=" + a.androidPkg + ";end",
			IOS: a.iosScheme + "?" + query,
		})
	}
	// The generic one: no package, so Android asks -- or honours a default
	// the parent set deliberately, which is their right.
	out = append(out, UPIApp{Key: "other", Label: "Another UPI app"})
	return out
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
