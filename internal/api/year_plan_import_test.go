package api

import "testing"

// The grades in one real workbook are written five ways, sometimes within a
// single subject: G-1, I, 1, grade4, and "G-8 (BIO)" where the bracket is the
// stream and not the grade.
func TestGradeOfReadsEverySpellingTheWorkbookUses(t *testing.T) {
	for in, want := range map[string]int{
		"G-1": 1, "G-9 SL": 9, "G-8 (BIO)": 8, "G-8 (PHY)": 8,
		"I": 1, "III": 3, "VIII": 8, "IX": 9,
		"1": 1, "grade4": 4, "Class 6": 6,
		"MASTER": 0, "": 0, "Grade:": 0,
	} {
		if got := gradeOf(in); got != want {
			t.Errorf("gradeOf(%q) = %d, want %d", in, got, want)
		}
	}
}

// Six spellings of a period count appear in one file. A chapter with no count
// reads as zero here and is defaulted to one by the caller, which is honest
// about not knowing rather than inventing a plausible number.
func TestPeriodsInAcceptsTheWorkbooksSixSpellings(t *testing.T) {
	for in, want := range map[string]int{
		"L5: Plants        (5P)":            5,
		"7. Handicrafts & Handlooms  ( 7 )": 7,
		"11. Pressure           (6P)":       6,
		"à°µ  - à°ªà°¦à°¾à°²à±  5 (p )":                 5,
		"12. Sound (3P)":                    3,
		"Unit - I At Home":                  0,
	} {
		if got := periodsIn(in); got != want {
			t.Errorf("periodsIn(%q) = %d, want %d", in, got, want)
		}
	}
}

// The period marker is stripped from the title, and the run of padding spaces
// the workbook uses to right-align it collapses to one.
func TestCleanTitleDropsTheMarkerAndThePadding(t *testing.T) {
	got := cleanTitle("L14: Air, Water & Weather                        (8P)")
	if want := "L14: Air, Water & Weather"; got != want {
		t.Fatalf("cleanTitle = %q, want %q", got, want)
	}
}
