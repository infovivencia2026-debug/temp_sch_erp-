package api

import (
	"fmt"
	"strconv"
)

/*
Marks are bounded above by the paper they belong to.

	The only constraint the database carried was marks_obtained >= 0. Nothing —
	not the schema, not any handler — tied a mark to its exam subject's
	max_marks, so 50 on a paper out of 20 was stored happily and every screen
	that divides by max_marks then reported it: Performance overview at 169%
	average, subject averages to 190%, a range to 250%. The numbers were not
	wrong; the data was.

	The rule lives here, as a plain function over three floats, so it can be
	tested without a database — this machine has no Postgres and the DB-backed
	tests skip silently, which is exactly how a validation rule rots.

	It rejects. It does not clamp. Somebody typed 50 into a box for a paper out
	of 20 and the only useful answer names the paper and the ceiling, because
	the real mark is either 5 or 20 and only the person holding the script
	knows which.
*/

// markCeilingError is returned when a mark is outside its paper's range. It
// carries the subject and ceiling so the handler can say both in the 4xx
// rather than the useless "marks out of range".
type markCeilingError struct {
	Subject string  // may be empty when the paper's subject could not be named
	Max     float64 // the paper's max_marks
	Got     float64 // what was submitted
}

func (e *markCeilingError) Error() string {
	paper := "this paper"
	if e.Subject != "" {
		paper = e.Subject
	}
	if e.Got < 0 {
		return fmt.Sprintf("%s is not a mark: %s cannot be scored below zero",
			trimFloat(e.Got), paper)
	}
	return fmt.Sprintf("%s is above the maximum for %s: that paper is out of %s",
		trimFloat(e.Got), paper, trimFloat(e.Max))
}

// validateMark checks one submitted mark against one paper's maximum.
//
// A nil mark is "not entered yet" and is allowed; absence is recorded
// separately by is_absent. maxMarks <= 0 means the paper has no usable ceiling
// (max_marks is nullable on some paper tables): there is nothing to check
// against, and refusing every mark on such a paper would block entry entirely,
// so only the lower bound applies.
func validateMark(subject string, maxMarks float64, marks *float64) error {
	if marks == nil {
		return nil
	}
	if *marks < 0 {
		return &markCeilingError{Subject: subject, Max: maxMarks, Got: *marks}
	}
	if maxMarks > 0 && *marks > maxMarks {
		return &markCeilingError{Subject: subject, Max: maxMarks, Got: *marks}
	}
	return nil
}

// trimFloat prints 20 as "20" and 17.5 as "17.5". A ceiling shown as
// "20.000000" in an error message reads like a system fault rather than a
// number off a mark sheet.
func trimFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
