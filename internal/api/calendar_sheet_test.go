package api

import "testing"

/* The school's own calendar, read the way it is written.

   Yajur's calendar is a daily sheet: every day of the year, the kind in
   square brackets before the name, and two things on one day separated by a
   bar. This is the reader that turns a cell into entries, checked against the
   cells that actually appear in that file. */
func TestSheetCalendarEntriesReadTheOfficeFormat(t *testing.T) {
	cases := []struct {
		cell string
		kind string
		want []sheetCalendarEntry
	}{
		{"", "", nil},
		{"[Holiday] Ugadi", "", []sheetCalendarEntry{{"Ugadi", "holiday"}}},
		{"[PTM] SA-1 PTM", "", []sheetCalendarEntry{{"SA-1 PTM", "ptm"}}},
		{"[Exam] FA-1 Exam", "", []sheetCalendarEntry{{"FA-1 Exam", "exam"}}},
		// Revision is a working day with a purpose, not a closure.
		{"[Revision] FA-1 Revision", "", []sheetCalendarEntry{{"FA-1 Revision", "event"}}},
		// Two things on one day.
		{"[Holiday] Raksha Bandhan | [Event] Raksha Bandhan", "",
			[]sheetCalendarEntry{{"Raksha Bandhan", "holiday"}, {"Raksha Bandhan", "event"}}},
		{"[Event] Red Colour Day | [PTM] FA-1 PTM | [Revision] FA-1 Revision", "",
			[]sheetCalendarEntry{{"Red Colour Day", "event"}, {"FA-1 PTM", "ptm"}, {"FA-1 Revision", "event"}}},
		// No bracket: the kind column decides, and blank means holiday.
		{"Independence Day", "", []sheetCalendarEntry{{"Independence Day", "holiday"}}},
		{"Term 1", "term", []sheetCalendarEntry{{"Term 1", "term"}}},
		// The bracket beside the name wins over the column.
		{"[Event] Sports Day", "holiday", []sheetCalendarEntry{{"Sports Day", "event"}}},
	}
	for _, c := range cases {
		got := sheetCalendarEntries(c.cell, c.kind)
		if len(got) != len(c.want) {
			t.Errorf("%q: got %d entries %v, want %d %v", c.cell, len(got), got, len(c.want), c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%q: entry %d = %v, want %v", c.cell, i, got[i], c.want[i])
			}
		}
	}
}

// The dates that file writes, and the ones an office types.
func TestParseSheetDateReadsWhatOfficesWrite(t *testing.T) {
	for _, s := range []string{"01-Mar-2026", "2026-08-15", "15.08.26", "15/08/2026", "2-Jan-06", "15 Aug 2026"} {
		if _, err := parseSheetDate(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	if _, err := parseSheetDate("yesterday"); err == nil {
		t.Error("a word is not a date")
	}
}
