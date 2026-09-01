package migrations

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

/* Two ways a migration breaks a deploy, both caught before it leaves anybody's
   machine.

   Neither of these is hypothetical and neither is exotic: both happened on the
   same afternoon, each cost a failed deploy, and each was diagnosed by reading
   a stack trace out of a server log. They are cheap to test and expensive to
   meet, which is the whole argument for the file.

   No database, no fixtures, no build tag — this runs on `go test ./...` with
   nothing set up, so it cannot be the test somebody forgets to enable.
*/

func migrationFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			out = append(out, e.Name())
		}
	}
	if len(out) == 0 {
		t.Fatal("no migrations found; is this test running in the wrong directory?")
	}
	return out
}

var versionRe = regexp.MustCompile(`^(\d+)_`)

/* TestNoDuplicateVersions

   goose refuses two files at one version outright and panics before applying
   anything, so the whole deploy fails at Migrate with the database untouched.

   This happens for a mundane reason that will keep happening: two people, or
   two sessions, write a migration at the same time, both look at the highest
   number on disk, and both take the next one. Neither is wrong and neither can
   see the other. The build has to be the thing that notices.
*/
func TestNoDuplicateVersions(t *testing.T) {
	seen := map[string]string{}
	for _, name := range migrationFiles(t) {
		m := versionRe.FindStringSubmatch(name)
		if m == nil {
			t.Errorf("%s: migration filename must start with a version and an underscore", name)
			continue
		}
		v := strings.TrimLeft(m[1], "0")
		if v == "" {
			v = "0"
		}
		if first, ok := seen[v]; ok {
			t.Errorf("two migrations at version %s: %s and %s.\n"+
				"goose refuses this and the deploy fails at Migrate with nothing "+
				"applied. Renumber the newer one to the next free version.",
				m[1], first, name)
			continue
		}
		seen[v] = name
	}
}

/* TestHasUpAndDown

   A migration with no -- +goose Down cannot be rolled back, and the moment
   that is discovered is the moment somebody needs to roll it back.

   A DELIBERATELY EMPTY Down is fine and this test accepts it: several
   migrations here refuse to undo themselves on purpose — dropping a clearance
   department would orphan the signatures raised against it — and they say so
   in a comment above a `SELECT 1`. What is not fine is the annotation missing
   altogether, which is an omission rather than a decision.
*/
func TestHasUpAndDown(t *testing.T) {
	for _, name := range migrationFiles(t) {
		body, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		s := string(body)
		if !strings.Contains(s, "-- +goose Up") {
			t.Errorf("%s: no `-- +goose Up` annotation", name)
		}
		if !strings.Contains(s, "-- +goose Down") {
			t.Errorf("%s: no `-- +goose Down` annotation. An empty Down is a fine "+
				"answer — say so with a comment and a `SELECT 1` — but a missing "+
				"one is an omission, and it is found on the day it is needed.", name)
		}
	}
}

/* TestStatementBlocksAreClosed

   A DO $$ … $$ block, a function body, anything containing its own semicolons
   must be wrapped in -- +goose StatementBegin / StatementEnd or goose splits
   it exactly as it split the comment above. An unbalanced pair is the same
   failure with a different message.
*/
func TestStatementBlocksAreClosed(t *testing.T) {
	for _, name := range migrationFiles(t) {
		body, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		s := string(body)
		begin := strings.Count(s, "-- +goose StatementBegin")
		end := strings.Count(s, "-- +goose StatementEnd")
		if begin != end {
			t.Errorf("%s: %d StatementBegin against %d StatementEnd", name, begin, end)
		}
		/* A DO block outside a Statement pair is the commonest way to meet
		   this: it always contains semicolons, and goose will cut it up. */
		if strings.Contains(s, "DO $$") && begin == 0 {
			t.Errorf("%s: a DO $$ block with no `-- +goose StatementBegin` around "+
				"it. It contains semicolons, so goose will split it into "+
				"fragments and Postgres will refuse them.", name)
		}
	}
}
