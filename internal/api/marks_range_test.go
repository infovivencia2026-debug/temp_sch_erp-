package api

import (
	"errors"
	"strings"
	"testing"
)

func markPtr(v float64) *float64 { return &v }

// TestValidateMark pins the rule that was missing entirely: a mark belongs to
// a paper and cannot exceed it. No database — that is the point of extracting
// it, since DB-backed tests skip silently wherever Postgres is absent and this
// rule would then be covered by nothing at all.
func TestValidateMark(t *testing.T) {
	cases := []struct {
		name    string
		subject string
		max     float64
		marks   *float64
		wantErr bool
		// substrings the message must carry, so a rejection stays actionable
		wantIn []string
	}{
		{name: "not entered yet is allowed", subject: "Mathematics", max: 20, marks: nil},
		{name: "zero is a real mark", subject: "Mathematics", max: 20, marks: markPtr(0)},
		{name: "exactly the maximum is allowed", subject: "Mathematics", max: 20, marks: markPtr(20)},
		{name: "just under the maximum", subject: "Mathematics", max: 20, marks: markPtr(19.75)},
		{
			name:    "the reported case: 50 on a paper out of 20",
			subject: "Mathematics", max: 20, marks: markPtr(50), wantErr: true,
			wantIn: []string{"50", "Mathematics", "20"},
		},
		{
			name:    "a hundredth over is still over",
			subject: "Science", max: 50, marks: markPtr(50.01), wantErr: true,
			wantIn: []string{"Science", "50"},
		},
		{
			name:    "negative is refused even though the column check allows only >= 0",
			subject: "Science", max: 50, marks: markPtr(-1), wantErr: true,
			wantIn: []string{"below zero"},
		},
		{
			name:    "unnamed paper still gets a usable message",
			subject: "", max: 20, marks: markPtr(50), wantErr: true,
			wantIn: []string{"this paper", "20"},
		},
		{
			// A paper with no usable ceiling cannot be checked against one.
			// Refusing every mark on it would block entry outright.
			name: "no ceiling means only the floor applies", subject: "Art", max: 0, marks: markPtr(500),
		},
		{
			name: "no ceiling still refuses a negative", subject: "Art", max: 0, marks: markPtr(-5),
			wantErr: true, wantIn: []string{"below zero"},
		},
		{
			// Ceilings are numeric(6,2) and half marks are ordinary.
			name:    "fractional ceiling, ceiling printed without float noise",
			subject: "Hindi", max: 17.5, marks: markPtr(17.6), wantErr: true,
			wantIn: []string{"17.5"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateMark(tc.subject, tc.max, tc.marks)
			if tc.wantErr != (err != nil) {
				t.Fatalf("validateMark(%q, %v, %v) error = %v, want error = %v",
					tc.subject, tc.max, tc.marks, err, tc.wantErr)
			}
			if err == nil {
				return
			}
			var ceiling *markCeilingError
			if !errors.As(err, &ceiling) {
				t.Fatalf("error is %T, want *markCeilingError — the handlers "+
					"match on that type to build the 4xx", err)
			}
			for _, want := range tc.wantIn {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("message %q does not mention %q", err.Error(), want)
				}
			}
			if strings.Contains(err.Error(), "e+") || strings.Contains(err.Error(), "000000") {
				t.Errorf("message %q prints a float, not a mark", err.Error())
			}
		})
	}
}

// TestValidateMarkDoesNotClamp guards the decision, not the code: somebody
// typed a number and must be told it was wrong. A clamp would make this
// function return nil and silently change the mark, which is how 50 becomes a
// pass mark of 20 that nobody ever reviews.
func TestValidateMarkDoesNotClamp(t *testing.T) {
	m := 50.0
	if err := validateMark("Mathematics", 20, &m); err == nil {
		t.Fatal("50 out of 20 was accepted")
	}
	if m != 50 {
		t.Fatalf("the submitted mark was modified to %v; validation must not clamp", m)
	}
}
