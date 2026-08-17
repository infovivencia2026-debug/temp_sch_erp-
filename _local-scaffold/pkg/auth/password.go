// Package auth holds password hashing and session management. Nothing in here
// knows about schools; it is deliberately domain-free.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. These are the tuning knobs to revisit on new hardware —
// the encoded hash carries its own parameters, so raising them does not
// invalidate existing passwords: NeedsRehash reports which ones to upgrade on
// next successful login.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)

var (
	ErrInvalidHash = errors.New("auth: password hash is not in the expected format")
	ErrMismatch    = errors.New("auth: password does not match")
)

// HashPassword returns a PHC-format string carrying the algorithm, its
// parameters, the salt and the digest. Storing the parameters alongside the hash
// is what makes an unattended upgrade possible later.
func HashPassword(password string) (string, error) {
	if password == "" {
		return "", errors.New("auth: password must not be empty")
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	digest := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(digest),
	), nil
}

// VerifyPassword compares a candidate against an encoded hash in constant time.
func VerifyPassword(password, encoded string) error {
	params, salt, digest, err := decodeHash(encoded)
	if err != nil {
		return err
	}
	candidate := argon2.IDKey([]byte(password), salt,
		params.time, params.memory, params.threads, uint32(len(digest)))

	if subtle.ConstantTimeCompare(digest, candidate) != 1 {
		return ErrMismatch
	}
	return nil
}

// NeedsRehash reports whether a stored hash was made with weaker parameters than
// we now use, so the caller can transparently upgrade it during a successful
// login — the only moment the plaintext is available.
func NeedsRehash(encoded string) bool {
	params, _, _, err := decodeHash(encoded)
	if err != nil {
		return true
	}
	return params.memory < argonMemory || params.time < argonTime || params.threads < argonThreads
}

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return argonParams{}, nil, nil, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	if version != argon2.Version {
		return argonParams{}, nil, nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidHash, version)
	}

	var p argonParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	digest, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	return p, salt, digest, nil
}

// DummyHash is a valid hash of a value nobody knows. Login verifies against it
// when the email does not exist, so a missing account and a wrong password take
// the same time and cannot be told apart by a timing measurement.
var DummyHash = "$argon2id$v=19$m=65536,t=3,p=4$" +
	"c29tZXNhbHR2YWx1ZXg$" +
	"gTBl4kHDRJZLBjPzKZfqcZDU7A0hLPKcWXBVN3lHVUY"
