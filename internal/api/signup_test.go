package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// The signature is the only thing standing between a real payment and a
// claimed one, so it is tested against an independently computed value rather
// than against itself.
func TestSignMatchesRazorpayAlgorithm(t *testing.T) {
	sp := &SignupPages{GatewaySecret: "test_secret_value"}
	order, payment := "order_abc123def456", "pay_xyz789uvw012"

	mac := hmac.New(sha256.New, []byte("test_secret_value"))
	mac.Write([]byte(order + "|" + payment))
	want := hex.EncodeToString(mac.Sum(nil))

	if got := sp.sign(order, payment); got != want {
		t.Fatalf("sign() = %s, want %s", got, want)
	}
}

func TestVerifySignatureRejectsForgeries(t *testing.T) {
	sp := &SignupPages{GatewaySecret: "a-real-secret"}
	order, payment := "order_abc123def456", "pay_xyz789uvw012"
	good := sp.sign(order, payment)

	if !sp.verifySignature(order, payment, good) {
		t.Fatal("a signature we produced ourselves did not verify")
	}

	// Each of these is a way a caller could try to claim a payment that did
	// not happen: a made-up signature, one lifted from a different order, one
	// truncated, and none at all.
	other := sp.sign("order_someoneelses", payment)
	for name, sig := range map[string]string{
		"empty":            "",
		"garbage":          "deadbeef",
		"another order":    other,
		"truncated":        good[:len(good)-2],
		"case flipped":     strings.ToUpper(good),
		"one byte changed": flipLast(good),
	} {
		if sp.verifySignature(order, payment, sig) {
			t.Errorf("%s signature verified but should not have", name)
		}
	}

	// A different secret must not verify — this is what stops a forgery built
	// against a secret guessed from another installation.
	wrong := &SignupPages{GatewaySecret: "a-different-secret"}
	if wrong.verifySignature(order, payment, good) {
		t.Error("signature verified under the wrong secret")
	}
}

func flipLast(s string) string {
	if s == "" {
		return s
	}
	last := s[len(s)-1]
	if last == 'a' {
		return s[:len(s)-1] + "b"
	}
	return s[:len(s)-1] + "a"
}

func TestGatewayRefShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		ref, err := gatewayRef("order")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(ref, "order_") {
			t.Fatalf("ref %q lacks the prefix", ref)
		}
		if len(ref) != len("order_")+14 {
			t.Fatalf("ref %q is the wrong length", ref)
		}
		for _, c := range strings.TrimPrefix(ref, "order_") {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
				t.Fatalf("ref %q has a character a gateway would not emit: %q", ref, c)
			}
		}
		// An order reference that repeated would let one school's payment
		// provision another school's tenant.
		if seen[ref] {
			t.Fatalf("duplicate reference %q after %d draws", ref, i)
		}
		seen[ref] = true
	}
}

func TestLooksLikeEmail(t *testing.T) {
	for _, ok := range []string{
		"principal@school.in",
		"a.b+tag@sub.domain.co.in",
		"head_teacher@vidyalaya.org",
	} {
		if !looksLikeEmail(ok) {
			t.Errorf("%q rejected but is a real address", ok)
		}
	}
	for _, bad := range []string{
		"", "principal", "principal@", "@school.in", "principal@school",
		"two@at@school.in", "has space@school.in", "trailing@school.",
	} {
		if looksLikeEmail(bad) {
			t.Errorf("%q accepted but cannot receive mail", bad)
		}
	}
}

func TestValidUsername(t *testing.T) {
	for _, ok := range []string{"principal", "head.teacher", "admin_01", "svn2026"} {
		if !validUsername(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "abc", "Principal", "has space", "a@b", strings.Repeat("x", 33)} {
		if validUsername(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// provisionParams.validate is what stops a tenant being created with an
// administrator nobody can identify at the sign-in box.
func TestProvisionParamsValidate(t *testing.T) {
	base := provisionParams{SchoolName: "Sunrise", AdminName: "Ramesh"}

	if err := base.validate(); err == nil {
		t.Error("an administrator with no email, phone or username was accepted")
	}

	withEmail := base
	withEmail.AdminEmail = "a@b.in"
	if err := withEmail.validate(); err != nil {
		t.Errorf("valid params rejected: %v", err)
	}

	withUsername := base
	withUsername.AdminUsername = "principal"
	if err := withUsername.validate(); err != nil {
		t.Errorf("username alone should be enough: %v", err)
	}

	noSchool := withEmail
	noSchool.SchoolName = ""
	if err := noSchool.validate(); err == nil {
		t.Error("a school with no name was accepted")
	}

	noAdmin := withEmail
	noAdmin.AdminName = ""
	if err := noAdmin.validate(); err == nil {
		t.Error("an administrator with no name was accepted")
	}
}
