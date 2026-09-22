package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

/* Time-based one-time passwords, RFC 6238, by hand.

   Thirty lines rather than a dependency: the algorithm is HMAC-SHA1 over a
   30-second counter, truncated to six digits, and every authenticator app
   (Google, Microsoft, Aegis, the phone's own) speaks exactly this. The
   secret is a base32 string in users.mfa_secret; the setup screen shows it
   as a QR the app scans and as text to type in. */

const (
	totpPeriod = 30
	totpDigits = 6
	// One step either side, for a phone whose clock drifts a little.
	totpSkew = 1
)

// NewTOTPSecret makes a 20-byte secret, base32 without padding: what an
// authenticator app expects to be typed or scanned.
func NewTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// TOTPURI is the otpauth:// URI the setup QR carries.
func TOTPURI(secret, account, issuer string) string {
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + url.PathEscape(issuer+":"+account) + "?" + q.Encode()
}

// TOTPCode is the code for one counter step.
func TOTPCode(secret string, step int64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000), nil
}

// VerifyTOTP checks a typed code against the secret, allowing one step of
// clock drift each way. Constant-time on the comparison.
func VerifyTOTP(secret, code string, now time.Time) bool {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return false
	}
	step := now.Unix() / totpPeriod
	for d := int64(-totpSkew); d <= totpSkew; d++ {
		want, err := TOTPCode(secret, step+d)
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return true
		}
	}
	return false
}
