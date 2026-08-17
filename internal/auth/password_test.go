package auth

import "testing"

func TestHashAndVerify(t *testing.T) {
	h := NewHasher("test-pepper")

	hash, err := h.Hash("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := h.Verify(hash, "correct horse battery staple"); err != nil {
		t.Fatalf("verify should succeed: %v", err)
	}
	if err := h.Verify(hash, "wrong password"); err != ErrMismatch {
		t.Fatalf("expected ErrMismatch, got %v", err)
	}
}

// The pepper is the whole point: the same password under a different pepper
// must not validate, so a stolen users table is useless without the env value.
func TestPepperIsLoadBearing(t *testing.T) {
	hash, err := NewHasher("pepper-one").Hash("hunter2hunter2")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := NewHasher("pepper-two").Verify(hash, "hunter2hunter2"); err != ErrMismatch {
		t.Fatalf("a different pepper must not validate, got %v", err)
	}
}

// bcrypt silently truncates its input at 72 bytes. Pre-hashing with HMAC keeps
// long passwords distinct; concatenating pepper+password would not.
func TestLongPasswordsStayDistinct(t *testing.T) {
	h := NewHasher("pepper")
	long := make([]byte, 200)
	for i := range long {
		long[i] = 'a'
	}
	a := string(long)
	b := a[:199] + "b" // differs only past bcrypt's 72-byte cutoff

	hash, err := h.Hash(a)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := h.Verify(hash, b); err != ErrMismatch {
		t.Fatalf("passwords differing past byte 72 must not collide, got %v", err)
	}
}

func TestSaltMakesHashesUnique(t *testing.T) {
	h := NewHasher("pepper")
	a, _ := h.Hash("same password")
	b, _ := h.Hash("same password")
	if a == b {
		t.Fatal("bcrypt must salt each hash independently")
	}
}
