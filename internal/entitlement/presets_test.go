package entitlement

import "testing"

// A preset that names a module the gate does not know would switch nothing on
// while reading as though it had -- the same failure Known exists to stop a
// vendor typing by hand.
func TestPresetsNameOnlyRealModules(t *testing.T) {
	if len(Presets) != 3 {
		t.Fatalf("want three starting points, got %d", len(Presets))
	}
	seen := map[string]bool{}
	for _, p := range Presets {
		if p.Key == "" || p.Name == "" || p.Blurb == "" {
			t.Errorf("%q: a preset needs a key, a name and a reason to pick it", p.Key)
		}
		if seen[p.Key] {
			t.Errorf("two presets share the key %q", p.Key)
		}
		seen[p.Key] = true
		if len(p.Modules) == 0 {
			t.Errorf("%q: no modules. An empty list means 'everything' when stored, "+
				"which is not something a starting point should say by accident", p.Key)
		}
		for _, m := range p.Modules {
			if !Known(m) {
				t.Errorf("%q names %q, which is not a sellable module", p.Key, m)
			}
		}
	}
}
