package migrations

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

/* TestNoCommentMarkerInsideStringLiteral

   goose strips `--` comments without knowing what a string literal is. A `--`
   inside quotes therefore truncates the statement at that point, and the rest
   — including the closing quote and the semicolon — is thrown away. Postgres
   is handed an unterminated query and the deploy dies at Migrate with nothing
   applied.

   This is not a theory. It failed exactly this way on 00187, whose COMMENT ON
   COLUMN contained an em-dash written as `--` in ordinary prose:

     failed to parse migration: unexpected unfinished SQL query … missing
     semicolon?

   The rule is narrow. It looks only at single-quoted strings and only for the
   two characters that start a comment. Prose in a `--` line comment is fine
   and always was; prose inside quotes has to avoid them.

   I previously added a rule here banning semicolons inside block comments,
   believing they caused a similar failure. They do not — thirty migrations
   carry them and have all deployed — and that rule was removed rather than
   kept with an exception list. This one has a failure to point at.
*/
func TestNoCommentMarkerInsideStringLiteral(t *testing.T) {
	// Single-quoted strings, doubled '' escapes allowed inside.
	lit := regexp.MustCompile(`'(?:[^']|'')*'`)
	for _, name := range migrationFiles(t) {
		body, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			// A line that IS a comment cannot break anything.
			if strings.HasPrefix(trimmed, "--") {
				continue
			}
			for _, s := range lit.FindAllString(line, -1) {
				if strings.Contains(s, "--") {
					t.Errorf("%s: a string literal contains `--`: %s\n"+
						"goose strips comments without parsing string literals, so "+
						"this truncates the statement and the deploy fails at "+
						"Migrate with \"unexpected unfinished SQL query\". Write the "+
						"dash as a colon or a single hyphen.", name, s)
				}
			}
		}
	}
}

/* TestDataChangesLiftRowLevelSecurity

   Every tenant table here has FORCE ROW LEVEL SECURITY, which binds the table
   owner too. A migration runs with no app_current_institution() set, so a
   policy of the form `institution_id = app_current_institution()` matches
   nothing. An UPDATE or DELETE against such a table then touches zero rows,
   Postgres reports success, goose records the version as applied, and the
   deploy log is green. Nothing changed and nothing said so.

   That is what 00181 did: it flipped a column default and "moved" the two
   messaging_recipient_policy rows that actually decide whether mail leaves —
   except it moved neither, and the whole thing had to be redone as 00182
   with the lift in place. 00150 exists for the same reason after 00149, and
   00162 hit it a third time before it shipped. The fix is one line and it is
   the same line every time:

     SET LOCAL app.is_platform_admin = 'on';

   (or, inside a DO block, `PERFORM set_config('app.is_platform_admin', 'on',
   true)`, which is the same thing spelled for plpgsql — the trailing `true`
   is what makes it transaction-local.) app_is_platform_admin() is the switch
   every tenant policy already reads, so this asks for the standing the
   platform has rather than turning policies off and back on. 00096 does turn
   it off — `ALTER TABLE mdm_registers NO FORCE ROW LEVEL SECURITY` and back
   — which works because the migration runs as the owner; that form, and
   DISABLE ROW LEVEL SECURITY, are accepted for the one table they name.

   WHICH STATEMENTS NEED IT. The rule is about statements that must FIND
   existing rows: UPDATE, DELETE, MERGE, and an INSERT whose rows come from a
   SELECT over a tenant table (the seed-one-per-school pattern, `INSERT …
   SELECT id FROM institutions`, inserts nothing at all without the lift). A
   plain INSERT … VALUES is deliberately not covered: RLS on an insert is only
   the policy's WITH CHECK, and these migrations insert with an explicit
   institution_id, or none, so the row goes in as written. Making that insert
   carry the lift would be noise, and noise is how a rule gets ignored.

   WHICH TABLES. Not a hard-coded list: every table any migration has applied
   ENABLE or FORCE ROW LEVEL SECURITY to, including the baseline and the two
   migrations (00005, 00008) that do it through a FOREACH loop over an array
   of names. A table that gains RLS later is picked up on the day it does.

   LOCAL, NOT SESSION. goose runs each migration in its own transaction, so a
   SET LOCAL ends exactly where the migration does. A bare SET (or set_config
   with is_local = false) is session-scoped: it outlives the migration, and
   the next migration on the same connection runs as platform admin without
   having asked to. That is checked for every file, allowlist or not.

   GRANDFATHERED. A number of older migrations break this rule and have run
   everywhere. They cannot be edited into compliance — goose keys on the
   version number, and a changed file is not re-run — and they cannot be
   fixed in place at all: the rows they failed to touch either got repaired by
   a later migration or were never going to matter. They are listed by version
   below, with the reason, and the rule is enforced for everything else. The
   list is printed in the test log so its size is visible; the test also fails
   if an entry stops being needed, so the list can only shrink. Do not add to
   it. Add the lift to the new migration instead.

   HOW IT READS THE SQL, AND WHAT IT CANNOT SEE. This is not a parser. It cuts
   the +Up section out, blanks comments, then blanks the body of every
   dollar-quoted block that is not a DO block (a function body runs when the
   function is called, under the caller's tenant, not at migration time; a DO
   block runs now), then blanks string literals, all at equal length so
   positions and line numbers still point at the original. What is left is
   split on semicolons and each piece is searched for the four statement
   shapes by keyword. Known blind spots, accepted rather than half-fixed: a
   statement built as a string and run with EXECUTE is invisible; a `$$`
   inside a string literal, or an E'…' string with a backslash-escaped quote,
   would confuse the blanking; INSERT … ON CONFLICT DO UPDATE against a row
   the migration cannot see is not caught (the conflict target row is
   invisible, so it inserts a duplicate or errors on the unique index — loud
   either way, unlike the silent case this test is for). If a migration does
   something cleverer than these, the reviewer is the test.
*/

/* Version → why it is allowed to stay wrong. Every one of these has already
   been applied on every database this code runs against, so the statement it
   names matched nothing there and will never run again. Where a later
   migration redid the work, it is named; where nothing did, the missed rows
   are a matter for a new migration with the lift, not for editing this one. */
var rlsGrandfathered = map[int]string{
	2:   "payments.allocated_paise reconciliation matched nothing; the repaired trigger keeps the column right for every allocation written since",
	48:  "instructional_norms seed per school inserted nothing; ensureInstructionalNorms in internal/api/statutory.go seeds a school on first read anyway",
	49:  "tally_voucher_type_mappings seed per school inserted nothing; the connector's apply-standard-voucher-types action writes the same map on demand",
	149: "payroll_runs.published_at backfill matched nothing; redone with the lift as 00150",
	155: "sms_gateway_devices.approved_at backfill matched nothing; a device paired before it shows as awaiting approval and is approved by hand",
	156: "vehicle_trackers.approved_at backfill matched nothing; a tracker paired before it shows as awaiting approval and is approved by hand",
	160: "fee_heads.service guess by name matched nothing; schools mark transport and hostel heads themselves, which the migration said they may",
	180: "fee_concessions.status backfill matched nothing, so concessions approved before it read as pending until re-approved; no later migration redid it",
	181: "messaging_recipient_policy mode flip matched nothing; redone with the lift as 00182 — the case this test is written around",
	194: "role_permissions grant to the admissions role inserted nothing; `migrate seed` rewrites role_permissions from the Go catalog on every deploy",
	199: "vehicles.bus_code backfill loop ran zero times; redone with the lift as 00200",
	201: "report_cards.exam_id backfill matched nothing; redone with the lift as 00202",
	231: "roles.is_default for board_member matched nothing; `migrate seed` writes is_default from rbac.optionalRoles, which the migration itself says",
	246: "notifications.pushed_at = now() backfill matched nothing, so the push pump's first run sees every old alert as unpushed; no later migration redid it",
}

func TestDataChangesLiftRowLevelSecurity(t *testing.T) {
	files := migrationFiles(t)
	bodies := map[string]string{}
	for _, name := range files {
		b, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		bodies[name] = string(b)
	}

	rls := rlsTablesFromMigrations(bodies)
	if len(rls) < 100 {
		t.Fatalf("found only %d tables with row level security across all migrations; "+
			"the baseline alone declares far more, so the collector is broken", len(rls))
	}
	t.Logf("%d tables carry row level security; %d migrations grandfathered",
		len(rls), len(rlsGrandfathered))

	stillNeeded := map[int]bool{}
	for _, name := range files {
		m := versionRe.FindStringSubmatch(name)
		if m == nil {
			continue // TestNoDuplicateVersions reports the bad name.
		}
		version, _ := strconv.Atoi(m[1])
		up, upLine, ok := gooseUpSection(bodies[name])
		if !ok {
			continue // TestHasUpAndDown reports the missing marker.
		}
		findings := scanUpForUnliftedDataChanges(up, rls)

		// Session-scoped lifts are wrong in every file, grandfathered or not:
		// the leak is into the NEXT migration, which is not on any list.
		for _, pos := range rlsSessionLiftRe.FindAllStringIndex(stripSQLComments(up), -1) {
			t.Errorf("%s:%d: app.is_platform_admin is set for the session, not the "+
				"transaction. goose runs every migration in its own transaction and "+
				"a session-level SET outlives this one, so the next migration on the "+
				"connection runs as platform admin without asking. Write "+
				"`SET LOCAL app.is_platform_admin = 'on'` (or set_config(…, true)).",
				name, upLine+strings.Count(up[:pos[0]], "\n"))
		}

		if len(findings) == 0 {
			continue
		}
		if reason, ok := rlsGrandfathered[version]; ok {
			stillNeeded[version] = true
			t.Logf("%s: grandfathered (%s): %d unlifted statement(s)", name, reason, len(findings))
			continue
		}
		for _, f := range findings {
			t.Errorf("%s:%d: %s\n"+
				"    %s has row level security and the +Up section has no\n"+
				"    `SET LOCAL app.is_platform_admin = 'on';` before this statement.\n"+
				"    A migration runs with no tenant set, so under FORCE ROW LEVEL SECURITY\n"+
				"    this matches zero rows, reports success, and changes nothing — which is\n"+
				"    what 00181 did, and why 00182 exists. Put the SET LOCAL first.",
				name, upLine+f.line, f.statement, f.table)
		}
	}

	for version, reason := range rlsGrandfathered {
		if !stillNeeded[version] {
			t.Errorf("version %d is on the grandfather list (%s) but no longer needs to be. "+
				"Remove the entry so the list only ever shrinks.", version, reason)
		}
	}
}

/* rlsFinding is one data-changing statement that runs before any lift. line
   is relative to the start of the +Up section. */
type rlsFinding struct {
	line      int
	statement string
	table     string
}

var (
	sqlCommentRe   = regexp.MustCompile(`(?s)/\*.*?\*/|--[^\n]*`)
	sqlStringRe    = regexp.MustCompile(`'(?:[^']|'')*'`)
	sqlDollarTagRe = regexp.MustCompile(`\$[A-Za-z_]*\$`)
	sqlDoBeforeRe  = regexp.MustCompile(`(?i)\bDO\s*$`)

	rlsAlterRe = regexp.MustCompile(
		`(?i)\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)\s+(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY`)
	// FOREACH t IN ARRAY ARRAY['a','b'] LOOP … ROW LEVEL SECURITY … END LOOP
	rlsForeachRe = regexp.MustCompile(
		`(?is)\bFOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[(.*?)\]\s*LOOP(.*?)END\s+LOOP`)
	rlsQuotedNameRe = regexp.MustCompile(`'(\w+)'`)
	// The per-table form of the lift: turning enforcement off for one table.
	rlsTableLiftRe = regexp.MustCompile(
		`(?i)\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)\s+(?:NO\s+FORCE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY`)

	rlsLocalLiftRe = regexp.MustCompile(
		`(?i)\bSET\s+LOCAL\s+app\.is_platform_admin\s*=\s*'on'` +
			`|set_config\(\s*'app\.is_platform_admin'\s*,\s*'on'\s*,\s*true\s*\)`)
	rlsSessionLiftRe = regexp.MustCompile(
		`(?i)\bSET\s+(?:SESSION\s+)?app\.is_platform_admin\s*=` +
			`|set_config\(\s*'app\.is_platform_admin'\s*,\s*'on'\s*,\s*false\s*\)`)

	sqlUpdateRe = regexp.MustCompile(`(?i)\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?(\w+)`)
	sqlDeleteRe = regexp.MustCompile(`(?i)\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?(\w+)`)
	sqlMergeRe  = regexp.MustCompile(`(?i)\bMERGE\s+INTO\s+(?:public\.)?(\w+)`)
	sqlInsertRe = regexp.MustCompile(`(?i)\bINSERT\s+INTO\s+(?:public\.)?(\w+)`)
	sqlSelectRe = regexp.MustCompile(`(?i)\bSELECT\b`)
	sqlSourceRe = regexp.MustCompile(`(?i)\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?(\w+)`)
)

// blankKeepingLines replaces every byte but newlines with a space, so a
// stripped region keeps its length and its line count.
func blankKeepingLines(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c != '\n' {
			b[i] = ' '
		}
	}
	return string(b)
}

func stripSQLComments(s string) string {
	return sqlCommentRe.ReplaceAllStringFunc(s, blankKeepingLines)
}

func stripSQLStrings(s string) string {
	return sqlStringRe.ReplaceAllStringFunc(s, blankKeepingLines)
}

/* blankFunctionBodies blanks every dollar-quoted body except those that
   follow DO. CREATE FUNCTION bodies are full of UPDATE and DELETE that run
   later, under whoever calls them; only a DO block runs during the migration. */
func blankFunctionBodies(s string) string {
	out := []byte(s)
	i := 0
	for i < len(s) {
		loc := sqlDollarTagRe.FindStringIndex(s[i:])
		if loc == nil {
			break
		}
		open := i + loc[0]
		tag := s[open : i+loc[1]]
		close := strings.Index(s[i+loc[1]:], tag)
		if close < 0 {
			break
		}
		end := i + loc[1] + close + len(tag)
		if !sqlDoBeforeRe.MatchString(s[:open]) {
			copy(out[open:end], blankKeepingLines(s[open:end]))
		}
		i = end
	}
	return string(out)
}

// gooseUpSection returns the text between the Up and Down markers and the
// 1-based line the section starts on.
func gooseUpSection(body string) (string, int, bool) {
	start := strings.Index(body, "-- +goose Up")
	if start < 0 {
		return "", 0, false
	}
	line := strings.Count(body[:start], "\n") + 1
	rest := body[start:]
	if down := strings.Index(rest, "-- +goose Down"); down >= 0 {
		rest = rest[:down]
	}
	return rest, line, true
}

/* rlsTablesFromMigrations collects every table that any migration, Up or
   Down, applies row level security to. Strings are kept because the FOREACH
   form names its tables inside them. */
func rlsTablesFromMigrations(bodies map[string]string) map[string]bool {
	out := map[string]bool{}
	for _, body := range bodies {
		s := stripSQLComments(body)
		for _, m := range rlsAlterRe.FindAllStringSubmatch(s, -1) {
			out[strings.ToLower(m[1])] = true
		}
		for _, m := range rlsForeachRe.FindAllStringSubmatch(s, -1) {
			if !strings.Contains(strings.ToUpper(m[2]), "ROW LEVEL SECURITY") {
				continue
			}
			for _, q := range rlsQuotedNameRe.FindAllStringSubmatch(m[1], -1) {
				out[strings.ToLower(q[1])] = true
			}
		}
	}
	return out
}

/* scanUpForUnliftedDataChanges returns every UPDATE / DELETE / MERGE against
   an RLS table, and every INSERT … SELECT that reads one, that appears before
   the first transaction-local lift in the +Up section (or anywhere in it,
   when there is none). */
func scanUpForUnliftedDataChanges(up string, rls map[string]bool) []rlsFinding {
	noComments := stripSQLComments(up)
	noFuncs := blankFunctionBodies(noComments)
	liftAt := len(noFuncs) + 1
	if loc := rlsLocalLiftRe.FindStringIndex(noFuncs); loc != nil {
		liftAt = loc[0]
	}
	code := stripSQLStrings(noFuncs)
	tableLiftAt := map[string]int{}
	for _, m := range rlsTableLiftRe.FindAllStringSubmatchIndex(code, -1) {
		table := strings.ToLower(code[m[2]:m[3]])
		if _, seen := tableLiftAt[table]; !seen {
			tableLiftAt[table] = m[0]
		}
	}

	var out []rlsFinding
	report := func(pos int, statement, table string) {
		if pos > liftAt {
			return
		}
		if at, ok := tableLiftAt[table]; ok && pos > at {
			return
		}
		out = append(out, rlsFinding{
			line:      strings.Count(code[:pos], "\n"),
			statement: statement,
			table:     table,
		})
	}

	offset := 0
	for _, stmt := range strings.Split(code, ";") {
		base := offset
		offset += len(stmt) + 1
		for _, re := range []struct {
			re   *regexp.Regexp
			verb string
		}{{sqlUpdateRe, "UPDATE"}, {sqlDeleteRe, "DELETE FROM"}, {sqlMergeRe, "MERGE INTO"}} {
			for _, m := range re.re.FindAllStringSubmatchIndex(stmt, -1) {
				table := strings.ToLower(stmt[m[2]:m[3]])
				if rls[table] {
					report(base+m[0], re.verb+" "+table, table)
				}
			}
		}
		ins := sqlInsertRe.FindStringSubmatchIndex(stmt)
		if ins == nil || !sqlSelectRe.MatchString(stmt[ins[1]:]) {
			continue
		}
		target := strings.ToLower(stmt[ins[2]:ins[3]])
		for _, m := range sqlSourceRe.FindAllStringSubmatch(stmt[ins[1]:], -1) {
			src := strings.ToLower(m[1])
			if rls[src] {
				report(base+ins[0], "INSERT INTO "+target+" … SELECT … FROM "+src, src)
				break
			}
		}
	}
	return out
}
