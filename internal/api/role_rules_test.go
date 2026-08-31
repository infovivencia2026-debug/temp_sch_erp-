package api

import "testing"

/*
The combinations a school may and may not hand out.

	Written because both of these were wrong in the shipped presets: "Head of
	department" granted hod+faculty, and the sole-maintainer bundle granted every
	role including both. A rule with no test is a rule the next preset breaks.
*/
func TestOverlappingRolesAreRefused(t *testing.T) {
	if err := checkGrantable([]string{"hod", "faculty"}, false); err == nil {
		t.Fatal("hod+faculty was allowed; they draw the same five classroom screens")
	}
	// Either alone is a perfectly good role.
	for _, k := range []string{"hod", "faculty"} {
		if err := checkGrantable([]string{k}, false); err != nil {
			t.Fatalf("%s alone was refused: %v", k, err)
		}
	}
}

func TestCapabilitiesAreNotRolesToHandOut(t *testing.T) {
	for _, k := range []string{"class_teacher", "student", "parent"} {
		err := checkGrantable([]string{k}, true)
		if err == nil {
			t.Fatalf("%s could be granted from the roles screen", k)
		}
		// The refusal has to say where the fact actually lives, or somebody
		// goes looking in the database for it.
		if len(err.Error()) < 30 {
			t.Fatalf("%s refusal says too little: %q", k, err)
		}
	}
}

func TestEveryPresetIsGrantable(t *testing.T) {
	for _, p := range rolePresets {
		if err := checkGrantable(p.RoleKeys, true); err != nil {
			t.Errorf("preset %q cannot be granted: %v", p.Name, err)
		}
	}
}
