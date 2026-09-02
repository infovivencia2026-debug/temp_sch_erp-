package api

import (
	"strings"
	"testing"
)

/*
A rule names a field from the list or it names nothing.

	The whole point of storing what the office chose rather than a fragment of
	a query is that the fragment can never exist. This is the test that keeps
	it true: the field is looked up, the value is a parameter, and anything
	that is not on the list is refused rather than interpolated.
*/
func TestGroupRulesRefuseAnythingNotOnTheList(t *testing.T) {
	for _, bad := range []groupRule{
		{Field: "st.id", Op: "is", Value: "x"},
		{Field: "name); DROP TABLE students; --", Op: "is", Value: "x"},
		{Field: "class", Op: "matches", Value: "x"},
		{Field: "custom:", Op: "is", Value: "x"},
	} {
		if _, _, err := buildRules("student", []groupRule{bad}, 1); err == nil {
			t.Errorf("field %q op %q was accepted", bad.Field, bad.Op)
		}
	}

	// A staff field is not a student field: the two whitelists are separate
	// because the queries they are spliced into are.
	if _, _, err := buildRules("student", []groupRule{{Field: "designation", Op: "is", Value: "x"}}, 1); err == nil {
		t.Error("a staff field was accepted on a student group")
	}
}

// The value the office typed is always a parameter, never text in the query.
func TestGroupRuleValuesAreParameters(t *testing.T) {
	where, args, err := buildRules("student", []groupRule{
		{Field: "class", Op: "is", Value: "Class 6"},
		{Field: "custom:Bus stop", Op: "contains", Value: "JNTU"},
	}, 1)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(where, "Class 6") || strings.Contains(where, "JNTU") ||
		strings.Contains(where, "Bus stop") {
		t.Errorf("a value was written into the SQL: %s", where)
	}
	// Class 6, then the custom label, then JNTU: the label is a parameter too,
	// which is what stops a column name being forged out of a jsonb key.
	if len(args) != 3 {
		t.Errorf("got %d parameters, want 3: %v", len(args), args)
	}
	if !strings.Contains(where, "custom_fields ->>") {
		t.Errorf("the custom field was not read out of jsonb: %s", where)
	}
}

// No rules is a hand-picked group, not "everybody".
func TestNoRulesSelectsNobodyByRule(t *testing.T) {
	where, args, err := buildRules("student", nil, 1)
	if err != nil || where != "" || args != nil {
		t.Errorf("empty rules produced %q / %v / %v", where, args, err)
	}
}
