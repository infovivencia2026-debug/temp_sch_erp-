package api

import "testing"

// The derived value lands in a UDISE return and on a transfer certificate, so
// it has to be something a clerk can read back over the telephone. It is
// deliberately not slugify, which appends eight hex characters.
func TestOptionValueIsReadable(t *testing.T) {
	for label, want := range map[string]string{
		"Telangana Open School Society": "telangana_open_school_society",
		"CBSE":                          "cbse",
		"ICSE / ISC":                    "icse_isc",
		"  Spaces  Around  ":            "spaces_around",
		"Class 10 (SSC)":                "class_10_ssc",
		"Aided — Government":            "aided_government",
	} {
		if got := optionValue(label); got != want {
			t.Errorf("optionValue(%q) = %q, want %q", label, got, want)
		}
	}
}

// A label with nothing to make a value from must fall through to the handler's
// explicit refusal rather than silently storing an empty string, which the
// table's check constraint would reject as a 500 instead of a message.
func TestOptionValueEmptyWhenNothingUsable(t *testing.T) {
	for _, label := range []string{"", "   ", "—", "!!!"} {
		if got := optionValue(label); got != "" {
			t.Errorf("optionValue(%q) = %q, want empty", label, got)
		}
	}
}

// Every kind offered to the client must have a human label, or the management
// screen renders a blank row and nobody can tell what list they are editing.
func TestEveryCustomisableKindHasALabel(t *testing.T) {
	for kind := range customisableKinds {
		if kindLabels[kind] == "" {
			t.Errorf("kind %q has no label", kind)
		}
	}
	// And nothing labelled that is not actually customisable, which would
	// offer a list the server then refuses to write to.
	for kind := range kindLabels {
		if _, ok := customisableKinds[kind]; !ok {
			t.Errorf("kind %q is labelled but not customisable", kind)
		}
	}
}

// The built-in lists must not carry duplicate values: a dropdown offering the
// same board twice is one the school's own reports cannot group by.
func TestBuiltinListsHaveNoDuplicates(t *testing.T) {
	for kind, opts := range customisableKinds {
		seen := map[string]bool{}
		for _, o := range opts {
			if seen[o.Value] {
				t.Errorf("%s offers %q twice", kind, o.Value)
			}
			seen[o.Value] = true
		}
	}
}

func TestSortByKind(t *testing.T) {
	items := []string{"Zebra", "apple", "Mango"}
	sortByKind(items, func(s string) string { return s })
	want := []string{"Mango", "Zebra", "apple"} // byte order, as the caller sees it
	for i := range want {
		if items[i] != want[i] {
			t.Fatalf("sorted = %v, want %v", items, want)
		}
	}
}
