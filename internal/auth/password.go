// Package auth implements password hashing, the session store, and the
// server-rendered sign-in pages.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// Hasher applies a server-side pepper before bcrypt.
//
// The pepper lives in the environment, not the database, so a dump of the
// users table is not by itself enough to mount an offline attack. It is
// pre-hashed with HMAC-SHA256 rather than concatenated because bcrypt silently
// truncates at 72 bytes -- a long password plus a long pepper would otherwise
// collapse to the same input.
type Hasher struct {
	pepper []byte
	cost   int
}

func NewHasher(pepper string) *Hasher {
	return &Hasher{pepper: []byte(pepper), cost: bcrypt.DefaultCost}
}

/*
Sign produces a short verification code for something that is not a password.

	The pepper is not exposed for callers to HMAC with themselves: an exam hall
	ticket and a stored password would then share a key with no separation
	between them, and a weakness in one becomes a weakness in the other.

	purpose is mixed in first, so a code minted for a hall ticket cannot be
	replayed as anything else. Truncated to ten base32 characters and hyphenated
	— long enough that a forged ticket will not match, short enough for an
	invigilator to check by eye at the door.
*/
func (h *Hasher) Sign(purpose, message string) string {
	mac := hmac.New(sha256.New, h.pepper)
	mac.Write([]byte(purpose))
	mac.Write([]byte{0})
	mac.Write([]byte(message))
	sum := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(mac.Sum(nil))
	return sum[:5] + "-" + sum[5:10]
}

func (h *Hasher) prepare(password string) []byte {
	mac := hmac.New(sha256.New, h.pepper)
	mac.Write([]byte(password))
	sum := mac.Sum(nil)
	// base64 so the value is printable and free of NUL bytes, which bcrypt
	// treats as a string terminator.
	out := make([]byte, base64.StdEncoding.EncodedLen(len(sum)))
	base64.StdEncoding.Encode(out, sum)
	return out
}

func (h *Hasher) Hash(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword(h.prepare(password), h.cost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(b), nil
}

var ErrMismatch = errors.New("password does not match")

func (h *Hasher) Verify(hash, password string) error {
	err := bcrypt.CompareHashAndPassword([]byte(hash), h.prepare(password))
	if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		return ErrMismatch
	}
	return err
}
