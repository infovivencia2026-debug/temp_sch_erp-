package api

import (
	"strings"
	"testing"
)

/*
The fast path is only worth having if it is right.

	A wrong answer about where a screen lives costs more than a slow correct
	one: somebody walks to a menu that does not contain what they were promised,
	and stops believing the next answer too. So these are the questions people
	actually type, checked against the screen they meant.
*/
func TestMatchHelpAnswersRealQuestions(t *testing.T) {
	cases := []struct {
		question string
		roles    []string
		want     string // substring of the screen name it should find
	}{
		{"how do I collect a fee", []string{"finance"}, "Collect"},
		{"where do I mark attendance", []string{"faculty"}, "ttendance"},
		{"generate a transfer certificate", []string{"institution_admin"}, "ertificate"},
		{"how do I see my child's attendance", []string{"parent"}, "ttendance"},
		{"where is the timetable", []string{"faculty"}, "imetable"},
	}

	for _, c := range cases {
		m := matchHelp(c.question, c.roles)
		if m == nil {
			t.Errorf("%q: no match at all", c.question)
			continue
		}
		if m.score < helpConfident {
			t.Errorf("%q: best was %q at %.2f, below the %.2f line",
				c.question, m.Name, m.score, helpConfident)
			continue
		}
		if !strings.Contains(m.Name, c.want) {
			t.Errorf("%q: answered with %q, wanted something containing %q",
				c.question, m.Name, c.want)
		}
	}
}

/*
Role is the whole point, and it has to bite.

	The same words must not reach a staff screen for a parent. If this ever
	passes by accident -- because the parent role happens to hold a screen with
	the same name -- the answer is still correctly scoped, so the assertion is
	about the ROLE of what came back rather than about getting nothing.
*/
func TestMatchHelpStaysInsideTheRole(t *testing.T) {
	for _, role := range []string{"parent", "student", "finance", "faculty"} {
		m := matchHelp("how do I collect a fee", []string{role})
		if m == nil {
			continue
		}
		var found *helpAnswer
		for i := range helpAnswers {
			if helpAnswers[i].Name == m.Name && helpAnswers[i].Role == role {
				found = &helpAnswers[i]
				break
			}
		}
		if found == nil {
			t.Errorf("role %q was answered with %q, which is not one of its screens",
				role, m.Name)
		}
	}
}

/*
Questions the fast path must NOT answer.

	Admissions has no "add a student" screen -- it takes applications -- so the
	nearest match is visa paperwork, which shares the word "student". And "why
	is this invoice wrong" is about one parent's invoice: it needs two facts
	joined, which is the model's job. Both scored under 2.0 when measured, and
	both must keep missing. A confident pointer at the wrong screen is worse
	than the slow honest answer.
*/
func TestMatchHelpFallsThroughOnReasoning(t *testing.T) {
	cases := []struct {
		question string
		roles    []string
	}{
		{"how do I add a new student", []string{"admissions"}},
		{"why is this invoice wrong", []string{"finance"}},
		{"the parent says they already paid", []string{"finance"}},
	}
	for _, c := range cases {
		if m := matchHelp(c.question, c.roles); m != nil && m.score >= helpConfident {
			t.Errorf("%q was answered confidently with %q (%.2f); it needs the model",
				c.question, m.Name, m.score)
		}
	}
}

// Nothing but filler must not be answered confidently. "hello" matching some
// screen at 1.5 would be the fast path inventing relevance.
func TestMatchHelpDeclinesEmptyQuestions(t *testing.T) {
	for _, q := range []string{"", "hello", "how do I", "the a an of"} {
		if m := matchHelp(q, []string{"finance"}); m != nil && m.score >= helpConfident {
			t.Errorf("%q was answered confidently with %q (%.2f)", q, m.Name, m.score)
		}
	}
}

// Every generated answer must name where the screen is. An answer that says
// what a screen does and not where it lives fails the question most people are
// actually asking.
func TestEveryAnswerSaysWhereItIs(t *testing.T) {
	for _, a := range helpAnswers {
		if !strings.Contains(a.Answer, "sidebar under") {
			t.Errorf("%s/%s does not say where it is: %q", a.Role, a.Name, a.Answer)
		}
		if len(a.NameW) == 0 {
			t.Errorf("%s/%s has no name words and can never match", a.Role, a.Name)
		}
	}
}
