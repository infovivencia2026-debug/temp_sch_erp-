package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Errorf("hash should be PHC-encoded argon2id, got %q", hash)
	}
	if strings.Contains(hash, "correct horse") {
		t.Fatal("hash contains the plaintext")
	}

	if err := VerifyPassword("correct horse battery staple", hash); err != nil {
		t.Errorf("correct password rejected: %v", err)
	}
	if err := VerifyPassword("wrong", hash); err != ErrMismatch {
		t.Errorf("wrong password: got %v, want ErrMismatch", err)
	}
}

func TestHashesAreSalted(t *testing.T) {
	// The same password twice must not produce the same hash, or a stolen
	// database tells an attacker which accounts share a password.
	a, err := HashPassword("same-password")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPassword("same-password")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Error("identical passwords produced identical hashes — salt is not being applied")
	}
}

func TestEmptyPasswordRejected(t *testing.T) {
	if _, err := HashPassword(""); err == nil {
		t.Error("empty password should not be hashable")
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	cases := map[string]string{
		"empty":             "",
		"not phc":           "plaintext",
		"wrong algorithm":   "$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
		"truncated":         "$argon2id$v=19$m=65536,t=3,p=4",
		"bad base64 salt":   "$argon2id$v=19$m=65536,t=3,p=4$!!!$aGFzaA",
		"bad base64 digest": "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$!!!",
	}
	for name, hash := range cases {
		t.Run(name, func(t *testing.T) {
			// A malformed hash must be an error, never a silent success.
			if err := VerifyPassword("anything", hash); err == nil {
				t.Error("malformed hash was accepted")
			}
		})
	}
}

func TestNeedsRehash(t *testing.T) {
	current, err := HashPassword("x")
	if err != nil {
		t.Fatal(err)
	}
	if NeedsRehash(current) {
		t.Error("a hash made with current parameters should not need a rehash")
	}

	// Hashed when the cost was lower: should be upgraded on next login.
	weak := "$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHR2YWx1ZXg$gTBl4kHDRJZLBjPzKZfqcZDU7A0hLPKcWXBVN3lHVUY"
	if !NeedsRehash(weak) {
		t.Error("a hash with weaker parameters should need a rehash")
	}

	if !NeedsRehash("garbage") {
		t.Error("an unparseable hash should be treated as needing a rehash")
	}
}

func TestDummyHashIsUsable(t *testing.T) {
	// Login verifies against DummyHash when the account does not exist, so that
	// a missing account and a wrong password take the same time. If this hash
	// were malformed, VerifyPassword would return early and the timing
	// difference would be measurable — which is the whole thing it prevents.
	if err := VerifyPassword("anything at all", DummyHash); err != ErrMismatch {
		t.Errorf("DummyHash must parse and mismatch cleanly, got %v", err)
	}
}
