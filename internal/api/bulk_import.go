package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Setting a school up from the spreadsheets it already has.

   Students could be imported from a CSV; classes, sections and staff could
   not. A school with ten classes, thirty sections and forty teachers had to
   type all eighty into a form one at a time, on the day they were trying to
   decide whether the product was any good. Every one of those lists already
   exists in the school office as a spreadsheet.

   The shape is the students importer's, because it is the right one and a
   second convention would be worse than a longer file:

     Dry run by default. The clerk uploads, sees exactly which rows are wrong
     and why, fixes them in Excel, uploads again. Nothing is written until
     ?commit=true, so a bad file costs nothing.

     Problems are reported per row with the row number and the offending data,
     not as a single "import failed". A message that does not say which of 300
     rows is wrong is a message that sends somebody back to the beginning.

     Every column is matched by header name, case- and space-insensitively,
     because the sheet came out of somebody else's software and its headers
     will not be ours.

   One transaction per import, so a file that fails halfway leaves nothing
   behind. Half a class list is worse than none: nobody can tell which half. */

/* Every lookup below names the institution explicitly.

   Relying on row level security alone was wrong in a way that only shows up
   at the worst moment: RLS is bypassed for a platform administrator, and an
   operator acting inside a school is exactly such a session. A lookup written
   as "the class called Grade 6" then means "the first Grade 6 on the
   installation", and an import run that way writes one school's rows against
   another school's sections. Eighty-four rows on this installation were in
   that state before this was fixed.

   The tenant predicate is therefore in the SQL as well as in the policy. RLS
   is the guarantee for ordinary sessions; this is the guarantee for the ones
   that outrank it. */

// importSpec is one entity's worth of importer.
type importSpec struct {
	// Perm is the permission the equivalent single-row form requires. Checked
	// per entity rather than on the route, because one route serves them all
	// and the loosest of them would otherwise become the price of admission:
	// importing staff must need what creating a staff member needs, not what
	// creating a class needs.
	Perm string
	// Columns, in the order the template writes them. The first is the one a
	// blank row is detected by.
	Columns []string
	// Required names the columns a row cannot be built without.
	Required []string
	Sample   []string
	// Check validates one row without touching the database, during the dry
	// run. Without it a value the writer will reject — a level that is not a
	// number — is reported as valid, the clerk fixes the rows they were told
	// about, uploads again, and the commit fails on a row the check had
	// already seen and passed. A dry run that misses errors is worse than no
	// dry run, because it is trusted.
	Check func(row map[string]string) error
	/* Verify checks what only the database can answer, during the dry run.

	   Check runs before any connection is open, so it can catch "level must
	   be a number" and cannot catch "there is no subject called SCI". That
	   second kind was reported at commit time, after the screen had already
	   said the file was ready — which is the failure the comment on Check
	   warns about, in the one place Check could not reach.

	   Read-only by contract. It runs in the same transaction the commit would
	   use, and on a dry run that transaction writes nothing. */
	Verify func(ctx *importCtx, row map[string]string) error
	// Write inserts one row. It is called inside the import transaction, with
	// the header-keyed values of that row.
	Write func(ctx *importCtx, row map[string]string) error
}

// createdRow is one record an import brought into existence, as opposed to one
// it edited. Only these are removed when an import is undone.
type createdRow struct {
	entity string
	id     uuid.UUID
}

type importCtx struct {
	r    *http.Request
	tx   pgx.Tx
	inst uuid.UUID
	// campus and year are resolved once for the whole file rather than per
	// row: three hundred rows should not mean three hundred lookups of a
	// value that cannot change during the import.
	campus uuid.UUID
	year   *uuid.UUID
	// classes maps a lowercased class name to its id, so a sections file can
	// say "Grade 6" where the database wants a uuid. Filled lazily.
	classes map[string]uuid.UUID
	// sections is keyed "class/section" and teachers by email, both
	// lowercased. Three hundred rows should not mean three hundred lookups
	// of values that cannot change during one import.
	sections map[string]uuid.UUID
	teachers map[string]uuid.UUID
	/* The biometric reader a punch file names, by serial, and the punches
	   this file has already accounted for.

	   Both are per import rather than per row for the usual reason -- a nine
	   hundred row export should not be nine hundred lookups of one serial --
	   and punchSeen answers a question no database query can answer during a
	   dry run: whether the file repeats itself. A vendor export pasted twice
	   into one sheet is a real thing clerks produce, and without this the two
	   copies both pass verification and the second is quietly swallowed by
	   the unique index at commit time, leaving the report claiming it wrote a
	   row it did not. */
	devices   map[string]uuid.UUID
	punchSeen map[string]bool
	// Years and exams the import itself brought into being, so a file with
	// nine terms across three years creates each of them once.
	pastYears map[string]uuid.UUID
	pastExams map[string]uuid.UUID
	/* What is true of the whole mark sheet rather than of one child: it is
	   one exam, of one class, in one year, out of one maximum. Carried once
	   instead of repeated on every row, because a value repeated forty times
	   is a value that can differ on the thirty-ninth. */
	sheet sheetFacts
	// subject name -> the header of the column holding its marks.
	subjectCols map[string]string
	/* What this import created.

	   Every writer here upserts, so a second upload of a corrected sheet
	   edits rows that existed before it — and undoing that upload must not
	   delete a class the school created by hand in March. */
	created []createdRow
	server  *Server
}

/*
deviceBySerial finds the reader a punch file names.

	The serial is the natural key for a device and the only thing about it a
	clerk can see: it is printed on the back of the machine, it is what the
	push path authenticates on, and biometric_devices already carries it under
	a unique constraint. Asking a file for our internal uuid instead would be
	asking a school for a number it has no way to know.

	An unregistered serial fails the row with what to do about it. "No such
	device" is not an instruction; a school that has just exported a file from
	a reader nobody added to Settings needs to be told that is what happened,
	because otherwise the obvious reading is that the file is wrong.

	The institution is named in the SQL and not left to row level security,
	for the reason at the top of this file: an operator acting inside a school
	is a platform session, RLS is bypassed for it, and "the reader with this
	serial" would then mean "the first one on the installation".
*/
func (c *importCtx) deviceBySerial(serial string) (uuid.UUID, error) {
	key := strings.ToLower(strings.TrimSpace(serial))
	if key == "" {
		return uuid.Nil, errors.New("device_serial is required: it is the serial number printed on the reader")
	}
	if c.devices == nil {
		c.devices = map[string]uuid.UUID{}
	}
	if id, ok := c.devices[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM biometric_devices WHERE institution_id = $1 AND lower(serial) = $2`,
		c.inst, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no biometric reader is registered with serial %q. "+
			"Add it under Settings, Biometric devices, using the serial printed on the "+
			"machine, then upload this file again", strings.TrimSpace(serial))
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.devices[key] = id
	return id, nil
}

/*
rollUpImportedDay turns one imported punch into the day it belongs to.

	Punches are the primitive and the day is derived from them. That is already
	true of the push path, and it has to stay true of this one, or a school
	that loads a file sees rows in the biometric log and an empty staff
	register and concludes the import did nothing.

	The rule is deliberately the push path's rule, word for word: first punch
	of the day is the arrival, last is the departure. A reader by one door
	records a teacher stepping out for lunch as two more punches, and anything
	cleverer turns that into a half day.

	It is not a call to rollUpPunches, and the difference matters twice. That
	one recomputes the last seven days in a transaction of its own, which is
	right for a device pushing today's punch and wrong here in both halves: an
	import is usually a backfill of last month, which the window would miss
	entirely, and a separate transaction would leave a register standing after
	the row that produced it had been rolled back. This writes the one employee
	and the one date the row is about, inside the import's own savepoint.

	Only rows a device wrote are touched, matching the push path. A day HR
	corrected by hand keeps the correction: a file must not overwrite a
	person's judgement about a person. source is 'device' and device_ref is the
	serial for the same reason the push path chose them -- a second word for
	the same fact would split one register in two and this guard would then
	skip every row the other path wrote.
*/
func (c *importCtx) rollUpImportedDay(empID uuid.UUID, at time.Time, serial string) error {
	// The date is computed here, in school time, rather than left to the
	// database, so that "which day was this" has exactly one answer across the
	// parser, the register and this. A punch at 00:20 belongs to that date and
	// not to the one UTC would name.
	onDate := at.In(indiaTZ()).Format(time.DateOnly)
	_, err := c.tx.Exec(c.r.Context(), `
		INSERT INTO staff_attendance
		    (institution_id, user_id, on_date, status, check_in, check_out, source, device_ref)
		SELECT $1, e.user_id, $4::date, 'present', d.first_seen,
		       -- One punch is an arrival, not a nought-hour day. A null
		       -- check_out says "still in, or never punched out", which is
		       -- true; stamping it equal to check_in says they left the
		       -- moment they arrived, which is not.
		       CASE WHEN d.last_seen > d.first_seen THEN d.last_seen END,
		       'device', $3
		  FROM (SELECT min(p.punched_at) AS first_seen, max(p.punched_at) AS last_seen
		          FROM biometric_punches p
		         WHERE p.institution_id = $1 AND p.employee_id = $2
		           AND (p.punched_at AT TIME ZONE 'Asia/Kolkata')::date = $4::date) d
		  JOIN employees e ON e.id = $2 AND e.user_id IS NOT NULL
		 WHERE d.first_seen IS NOT NULL
		ON CONFLICT (user_id, on_date) DO UPDATE
		   SET check_in  = LEAST(staff_attendance.check_in, EXCLUDED.check_in),
		       check_out = GREATEST(staff_attendance.check_out, EXCLUDED.check_out),
		       status    = 'present'
		 WHERE staff_attendance.source = 'device'`,
		c.inst, empID, serial, onDate)
	return err
}

func (c *importCtx) classID(name string) (uuid.UUID, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if id, ok := c.classes[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM classes WHERE institution_id = $1 AND lower(name) = $2`,
		c.inst, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no class called %q. Create the classes first", name)
	}
	if err != nil {
		return uuid.Nil, err
	}
	if c.classes == nil {
		c.classes = map[string]uuid.UUID{}
	}
	c.classes[key] = id
	return id, nil
}

/*
noteCreated remembers a row so the import can be taken back out.

	Called only where the insert actually inserted. Postgres answers that with
	xmax = 0 on the returned row — zero means no transaction has updated it, so
	the INSERT branch was taken — and, where the writer says DO NOTHING, by
	returning no row at all on a conflict. Both are exact, where counting rows
	before and after is not.
*/
func (c *importCtx) noteCreated(entity string, id uuid.UUID, inserted bool) {
	if inserted {
		c.created = append(c.created, createdRow{entity: entity, id: id})
	}
}

/*
classImportLevel is the one place the importer decides what year a class row

	is in, for both the dry run and the commit.

	It exists because those were two separate readings of the same cell and they
	drifted apart. The dry run refused anything that was not a positive whole
	number; the writer called strconv.Atoi and threw the error away, so a cell
	the check had rejected would still have gone in as level 0 had the check
	ever been bypassed, and a blank cell the check had accepted was derived from
	the name by a second copy of the rule. Two readings of one cell is how a
	file passes the dry run and fails the commit, which is the failure the
	importer exists to avoid: the clerk is told the file is ready, uploads it,
	and loses the afternoon to a row the check had already seen.

	The accepted values are exactly the ones classLevelFromName can produce,
	because a level typed into the column and a level read out of the name end
	up in the same column and are counted against the same government norms.
	That means Nursery, LKG and UKG (-3, -2, -1) are levels a school may type,
	Class 1 to 15 are levels, and 0 is not one: level is NOT NULL and zero is
	what an unparsed cell becomes, so accepting it would be accepting the
	failure silently.
*/
func classImportLevel(row map[string]string) (int, error) {
	v := strings.TrimSpace(row["level"])
	if v == "" {
		// Nothing typed, so the name has to say it. Checked during the dry run
		// rather than at the commit, because "Grade 6" says six and a name
		// with no year in it must be reported while the file can still be
		// fixed.
		level := classLevelFromName(row["name"])
		if level == 0 {
			return 0, errors.New("no year could be read from that name. " +
				"Add a level column, or write it as Grade 6")
		}
		return level, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n == 0 || n < classLevelFloor || n > classLevelCeiling {
		return 0, fmt.Errorf("level must be a whole number between %d and %d, "+
			"where the negatives are the pre-school years (-3 is Nursery, -2 LKG, "+
			"-1 UKG). Leave it empty to take the year from the name",
			classLevelFloor, classLevelCeiling)
	}
	return n, nil
}

var importSpecs = map[string]importSpec{
	"classes": {
		Perm: rbac.AcademicsWrite,
		/* ONE SHEET FOR CLASSES AND THEIR SECTIONS.

		   There were two: upload the classes, then upload the sections against
		   the classes you had just made. Two templates for one list, and the
		   second only works after the first has landed -- so a school that did
		   them in the wrong order got every row rejected for a class that did
		   not exist yet, which reads as the file being wrong.

		   Nobody writes those separately either. The list a school already has
		   is one sheet with the sections beside the class, which is exactly
		   this shape.

		   Only the name is required. Sections and capacity are optional
		   because a school may not have decided them yet, and level is
		   optional because it is already in the name. */
		/* Three columns, and two of them optional.

		   Level and stream came off the template. Level is already in the name
		   -- a sheet that says Grade 6 has said six -- and asking for it again
		   is asking somebody to restate what they wrote and to be blamed when
		   the two disagree. Stream is a thing a handful of senior schools use
		   and every other school had to look at and decide to leave empty.

		   Both are still read where a file happens to carry them, so a sheet
		   written against the old template still imports. They are simply not
		   asked for. */
		Columns:  []string{"name", "sections", "capacity", "strength"},
		Required: []string{"name"},
		Sample:   []string{"Grade 6", "A, B", "40", "38"},
		Check: func(row map[string]string) error {
			/* Capacity, checked here so a bad one fails during the dry run
			   rather than at the commit. */
			if cap := strings.TrimSpace(row["capacity"]); cap != "" {
				n, err := strconv.Atoi(strings.ReplaceAll(cap, ",", ""))
				if err != nil || n <= 0 {
					return errors.New("capacity must be a whole number of seats above zero")
				}
			}
			/* Strength is how many children are on the roll today, which is a
			   different question from how many desks there are. Zero is a real
			   answer -- a section opened for next year has none -- so it is
			   allowed where capacity is not. */
			if st := strings.TrimSpace(row["strength"]); st != "" {
				n, err := strconv.Atoi(strings.ReplaceAll(st, ",", ""))
				if err != nil || n < 0 {
					return errors.New("strength must be a whole number of children, or blank")
				}
				if cap := strings.TrimSpace(row["capacity"]); cap != "" {
					if c, cerr := strconv.Atoi(strings.ReplaceAll(cap, ",", "")); cerr == nil && n > c {
						return errors.New("more children than seats: strength is above capacity")
					}
				}
			}
			// One resolver for the level, shared with the writer below, so the
			// dry run and the commit cannot come to disagree about it.
			_, err := classImportLevel(row)
			return err
		},
		Write: func(c *importCtx, row map[string]string) error {
			/* The same resolver the dry run used, and its error is
			   returned rather than dropped. Reading the level twice, in two
			   places, is how the dry run and the commit came to disagree. */
			level, err := classImportLevel(row)
			if err != nil {
				return err
			}
			/* RETURNING with DO NOTHING yields no row on a conflict, which is
			   exactly the signal wanted: a row came back means this INSERT
			   created the class, and ErrNoRows means it was already there. */
			var id uuid.UUID
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO classes (institution_id, campus_id, name, level, stream)
				VALUES ($1,$2,$3,$4,NULLIF($5,''))
				ON CONFLICT DO NOTHING
				RETURNING id`,
				c.inst, c.campus, strings.TrimSpace(row["name"]), level,
				strings.TrimSpace(row["stream"])).Scan(&id)
			/* A class that already existed still needs its sections read.

			   DO NOTHING returns no row on a conflict, and returning early
			   there meant a corrected re-upload -- the commonest second action
			   after a first attempt -- silently skipped every section on every
			   class it had already created. */
			existed := errors.Is(err, pgx.ErrNoRows)
			if existed {
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT id FROM classes
					 WHERE institution_id = $1 AND lower(name) = lower($2)`,
					c.inst, strings.TrimSpace(row["name"])).Scan(&id); err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
			c.noteCreated("classes", id, !existed)

			if err := c.writeSections(row, id); err != nil {
				return err
			}
			return err
		},
	},
	"sections": {
		/* WHAT ONLY THE DATABASE CAN ANSWER, ASKED BEFORE ANYTHING IS WRITTEN.

		   Without this the dry run reports every row ready and the commit then
		   rejects the ones naming a class, a head or a teacher the school does
		   not have. A check that passes a file the write refuses is worse than
		   no check: the clerk has been told it is ready, and spends the credit
		   the dry run had.

		   Read-only by contract, in the transaction the commit would use. */
		Verify: func(c *importCtx, row map[string]string) error {
			_, err := c.classID(row["class"])
			return err
		},
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"class", "name", "capacity", "room"},
		Required: []string{"class", "name"},
		Sample:   []string{"Grade 6", "A", "40", ""},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["capacity"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					return errors.New("capacity must be a whole number above zero")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			capacity := 40
			if v := strings.TrimSpace(row["capacity"]); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					capacity = n
				} else {
					return errors.New("capacity must be a whole number above zero")
				}
			}
			// Mirrors createSection exactly, campus and conflict target
			// included. Writing a shorter INSERT here was how the importer
			// came to omit campus_id, which the column forbids — an importer
			// that diverges from the form it replaces will diverge again.
			var id uuid.UUID
			var inserted bool
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
				                      name, capacity, room)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
				ON CONFLICT (class_id, academic_year_id, name)
				DO UPDATE SET capacity = EXCLUDED.capacity, room = EXCLUDED.room
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, classID, c.year, strings.TrimSpace(row["name"]), capacity,
				strings.TrimSpace(row["room"])).Scan(&id, &inserted)
			c.noteCreated("sections", id, inserted)
			return err
		},
	},
	/* Subjects. Code is what the report card prints and what the upsert keys
	   on, so a second upload of a corrected sheet edits rather than doubles. */
	"subjects": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"name", "code", "is_scholastic"},
		Required: []string{"name", "code"},
		Sample:   []string{"Mathematics", "MATH", "Y"},
		Check: func(row map[string]string) error {
			if strings.TrimSpace(row["code"]) == "" {
				return errors.New("code is what the report card prints; it cannot be blank")
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			// Blank means scholastic: most subjects are, and a school that
			// leaves the column off should get the common case.
			scholastic := !isNo(row["is_scholastic"])
			var id uuid.UUID
			var inserted bool
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
				VALUES ($1,$2,$3,upper($4),$5)
				ON CONFLICT (institution_id, campus_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_scholastic = EXCLUDED.is_scholastic
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, strings.TrimSpace(row["name"]),
				strings.TrimSpace(row["code"]), scholastic).Scan(&id, &inserted)
			c.noteCreated("subjects", id, inserted)
			return err
		},
	},
	/* The school day. sequence orders the grid, so it is required and has to
	   be a number -- a period list sorted by name puts P10 before P2. */
	"periods": {
		Perm: rbac.AcademicsWrite,
		/* A SCHOOL DOES NOT ALWAYS RUN ONE BELL.

		   Primary starts later, finishes earlier and takes a longer lunch, and
		   a sheet that can only describe one day forces the school to type the
		   second one by hand -- which is the half that gets skipped, after
		   which primary attendance is marked against periods nobody sat.

		   day names which timetable a row belongs to, and classes says who
		   runs to it. Both empty means the whole school, which is what every
		   sheet written before this meant and still means. */
		Columns: []string{"day", "classes", "sequence", "name",
			"starts_at", "ends_at", "is_break"},
		Required: []string{"sequence", "name"},
		Sample:   []string{"Primary", "Nursery, LKG, UKG", "1", "P1", "09:30", "10:10", "N"},
		Check: func(row map[string]string) error {
			if n, err := strconv.Atoi(strings.TrimSpace(row["sequence"])); err != nil || n <= 0 {
				return errors.New("sequence must be a whole number above zero. It is what orders the day")
			}
			for _, k := range []string{"starts_at", "ends_at"} {
				if v := strings.TrimSpace(row[k]); v != "" {
					if _, err := time.Parse("15:04", v); err != nil {
						return errors.New(k + " must be a 24-hour time such as 09:45")
					}
				}
			}
			return nil
		},
		/* THE CLASSES NAMED IN THE SHEET, CHECKED BEFORE ANYTHING IS WRITTEN.

		   Without this the dry run reported fifteen rows valid and the commit
		   then rejected six of them for classes the school does not have. A
		   check that passes a file the write refuses is worse than no check:
		   the clerk was told the file was ready.

		   Read-only, in the transaction the commit would use, which is what
		   Verify is for. */
		Verify: func(c *importCtx, row map[string]string) error {
			for _, name := range strings.FieldsFunc(row["classes"], func(r rune) bool {
				return r == ',' || r == ';' || r == '/'
			}) {
				if name = strings.TrimSpace(name); name == "" {
					continue
				}
				if _, err := c.classID(name); err != nil {
					return err
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			seq, _ := strconv.Atoi(strings.TrimSpace(row["sequence"]))

			schedule, err := c.bellScheduleID(row["day"])
			if err != nil {
				return err
			}

			var id uuid.UUID
			var inserted bool
			/* ON CONFLICT (bell_schedule_id, sequence), which is how periods
			   are actually keyed.

			   This said (institution_id, campus_id, sequence) and no such
			   index exists -- the same fault the school-day form had. Postgres
			   refuses a conflict target it cannot match, so every commit of
			   this sheet failed outright. A dry run never runs the write, so
			   the file was reported valid and then would not load. */
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO periods (institution_id, campus_id, bell_schedule_id,
				                     name, sequence, starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::time,NULLIF($7,'')::time,$8)
				ON CONFLICT (bell_schedule_id, sequence)
				DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
				              ends_at = EXCLUDED.ends_at, is_break = EXCLUDED.is_break
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, schedule, strings.TrimSpace(row["name"]), seq,
				strings.TrimSpace(row["starts_at"]), strings.TrimSpace(row["ends_at"]),
				isYes(row["is_break"])).Scan(&id, &inserted); err != nil {
				return err
			}
			c.noteCreated("periods", id, inserted)

			/* The classes that run to this day, named on the row.

			   Repeated on every period of the day, which is how a spreadsheet
			   says it -- the alternative is a second sheet relating days to
			   classes, and nobody keeps one. Applying it every time is
			   harmless: it is the same statement each row. */
			for _, name := range strings.FieldsFunc(row["classes"], func(r rune) bool {
				return r == ',' || r == ';' || r == '/'
			}) {
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				classID, cerr := c.classID(name)
				if cerr != nil {
					return cerr
				}
				if _, err := c.tx.Exec(c.r.Context(),
					`UPDATE classes SET bell_schedule_id = $2 WHERE id = $1`,
					classID, schedule); err != nil {
					return err
				}
			}
			return nil
		},
	},
	/* Fee heads. Not fee amounts -- those are per class and belong to the
	   structure, which is a different sheet and a different decision. */
	"fee_heads": {
		Perm:     rbac.FeesWrite,
		Columns:  []string{"name", "code", "is_recurring"},
		Required: []string{"name", "code"},
		Sample:   []string{"Tuition", "TUI", "Y"},
		Write: func(c *importCtx, row map[string]string) error {
			recurring := !isNo(row["is_recurring"])
			var id uuid.UUID
			var inserted bool
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO fee_heads (institution_id, name, code, is_recurring,
				                       is_taxable, gst_rate_bp)
				VALUES ($1,$2,upper($3),$4,false,0)
				ON CONFLICT (institution_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_recurring = EXCLUDED.is_recurring
				RETURNING id, (xmax = 0)`,
				c.inst, strings.TrimSpace(row["name"]), strings.TrimSpace(row["code"]),
				recurring).Scan(&id, &inserted)
			c.noteCreated("fee_heads", id, inserted)
			return err
		},
	},
	/* What each class pays, a year at a time.

	   Fees are re-set every year and the form takes one class at a time, so a
	   school of ten grades and six heads types sixty amounts to change a
	   number that moved with inflation. The sheet is the thing the office
	   already has: a grid of classes down the side and heads across the top,
	   flattened to one row per class per head.

	   The instalment count divides the annual amount rather than being typed
	   per term, because a school says "45,000 a year, three terms", not
	   "15,000, 15,000, 15,000" -- and the remainder of a division that does
	   not come out evenly goes on the first instalment, where a parent
	   expects the odd rupee.
	*/
	"fee_structures": {
		/* WHAT ONLY THE DATABASE CAN ANSWER, ASKED BEFORE ANYTHING IS WRITTEN.

		   Without this the dry run reports every row ready and the commit then
		   rejects the ones naming a class, a head or a teacher the school does
		   not have. A check that passes a file the write refuses is worse than
		   no check: the clerk has been told it is ready, and spends the credit
		   the dry run had.

		   Read-only by contract, in the transaction the commit would use. */
		Verify: func(c *importCtx, row map[string]string) error {
			if cls := strings.TrimSpace(row["class"]); cls != "" {
				if _, err := c.classID(cls); err != nil {
					return err
				}
			}
			head := strings.TrimSpace(row["fee_head"])
			if head == "" {
				return nil
			}
			var ok bool
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT EXISTS (SELECT 1 FROM fee_heads
				                WHERE institution_id = $1
				                  AND (lower(name) = lower($2) OR upper(code) = upper($2)))`,
				c.inst, head).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("no fee head called %q. Add the fee heads first", head)
			}
			return nil
		},
		Perm:     rbac.FeesWrite,
		Columns:  []string{"structure", "class", "fee_head", "annual_amount", "instalments"},
		Required: []string{"structure", "fee_head", "annual_amount"},
		Sample:   []string{"2026-2027", "Grade 6", "Tuition Fee", "45000", "3"},
		Check: func(row map[string]string) error {
			if _, err := strconv.ParseFloat(strings.TrimSpace(row["annual_amount"]), 64); err != nil {
				return errors.New("annual_amount must be a number, in rupees")
			}
			if v := strings.TrimSpace(row["instalments"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n < 1 || n > 12 {
					return errors.New("instalments must be a whole number between 1 and 12")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			name := strings.TrimSpace(row["structure"])

			// A blank class is the structure every class pays, which is how a
			// school with one fee for the whole school writes it.
			var classID *uuid.UUID
			if v := strings.TrimSpace(row["class"]); v != "" {
				id, err := c.classID(v)
				if err != nil {
					return err
				}
				classID = &id
			}

			// The head by code or by name. The office writes "Tuition Fee".
			want := strings.TrimSpace(row["fee_head"])
			var headID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT id FROM fee_heads
				 WHERE institution_id = $1
				   AND (upper(code) = upper($2) OR lower(name) = lower($2))`,
				c.inst, want).Scan(&headID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("no fee head called %q -- add the fee heads first", want)
				}
				return err
			}

			if c.year == nil {
				return errors.New("create an academic year before loading fee structures")
			}

			/* One structure per name and class, reused across the rows of the
			   sheet. Without this every row would make its own structure and a
			   class would end up with six of them, one per head. */
			var structID uuid.UUID
			var inserted bool
			if err := c.tx.QueryRow(c.r.Context(), `
				WITH found AS (
				    SELECT id FROM fee_structures
				     WHERE institution_id = $1 AND name = $3
				       AND class_id IS NOT DISTINCT FROM $4::uuid
				), made AS (
				    INSERT INTO fee_structures (institution_id, campus_id, academic_year_id,
				                                class_id, name, applies_to, is_active)
				    SELECT $1, $2, $5, $4::uuid, $3, 'all', true
				     WHERE NOT EXISTS (SELECT 1 FROM found)
				    RETURNING id
				)
				SELECT id, true FROM made
				UNION ALL SELECT id, false FROM found
				LIMIT 1`,
				c.inst, c.campus, name, classID, *c.year).Scan(&structID, &inserted); err != nil {
				return err
			}
			c.noteCreated("fee_structures", structID, inserted)

			rupees, _ := strconv.ParseFloat(strings.TrimSpace(row["annual_amount"]), 64)
			total := int64(rupees*100 + 0.5)
			terms := 1
			if v := strings.TrimSpace(row["instalments"]); v != "" {
				terms, _ = strconv.Atoi(v)
			}
			if terms < 1 {
				terms = 1
			}
			each := total / int64(terms)
			first := each + total - each*int64(terms) // the odd rupee, up front

			for n := 1; n <= terms; n++ {
				amount := each
				if n == 1 {
					amount = first
				}
				if _, err := c.tx.Exec(c.r.Context(), `
					INSERT INTO fee_structure_items (institution_id, fee_structure_id,
					                                 fee_head_id, instalment_no, amount_paise)
					VALUES ($1,$2,$3,$4,$5)
					ON CONFLICT (fee_structure_id, fee_head_id, instalment_no)
					DO UPDATE SET amount_paise = EXCLUDED.amount_paise`,
					c.inst, structID, headID, n, amount); err != nil {
					return err
				}
			}
			return nil
		},
	},
	/* Which subjects a class studies, and -- in the same row -- who teaches
	   them. The two were separate steps, so a school listed the subject on
	   step seven and came back on step nine to say who takes it, reading the
	   same sheet twice. A class list from a school already has both columns
	   next to each other. */
	"class_subjects": {
		Perm: rbac.AcademicsWrite,
		/* WHAT EACH CLASS STUDIES, AND WHO TEACHES IT, IN ONE SHEET.

		   This needed the subjects to exist already, which meant a separate
		   upload first -- and a school that did them the other way round had
		   every row rejected for a subject that plainly exists on the sheet in
		   front of them. Naming a subject against a class IS the school
		   declaring that subject, so it is created here rather than demanded
		   in advance.

		   Section and class_teacher_email are optional and do the rest of the
		   job in the same file: which teacher takes 6-A as a form class, and
		   which teacher takes a subject in a particular section rather than
		   across the whole class. Left out, the subject teacher covers every
		   section of the class, which is what a small school means. */
		/* ONE SHEET FOR ALL THREE, OR ANY ONE OF THEM.

		   There were three boxes on this step: the subject list, what each
		   class studies, and who teaches it where. They are three views of the
		   same fact, and a school keeps them on one page -- so keeping them
		   apart made the school do the splitting, and made the order matter,
		   and rejected rows for subjects written on the very sheet being
		   uploaded.

		   This takes the union of all three. Which job a row does is decided
		   by what it carries:

		     subject alone            adds the subject
		     class + subject          the class studies it
		     + section                that section only, and its room
		     + class_teacher_email    who takes the form class
		     + teacher_email          who teaches the subject

		   Only the subject is required, so a plain list of subject names is a
		   valid file, and so is a full allocation grid, and so is anything
		   between them. The separate sheets still work for a school that
		   already has them split. */
		/* The teacher columns are no longer email-only, so they are no longer
		   called email. A school's sheet has the teacher's name in it, or the
		   staff code the office files them under; requiring an address meant
		   looking up forty of them before a timetable could be uploaded, and
		   the mapping screen offered nothing else to point a name column at.
		   Either name still works, so older sheets load unchanged. */
		Columns: []string{"subject", "class", "section", "room",
			"class_teacher", "teacher", "max_marks", "periods_per_week"},
		Required: []string{"subject"},
		Sample: []string{"Mathematics", "Grade 6", "A", "6A",
			"Priya Rao", "T-014", "100", "6"},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					return errors.New("max_marks must be a whole number above zero")
				}
			}
			if v := strings.TrimSpace(row["periods_per_week"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n < 0 || n > 40 {
					return errors.New("periods_per_week must be a whole number, 0 to 40")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			/* A row naming only a subject adds the subject and stops.

			   That is the whole of the old subjects sheet, and it is a
			   legitimate file on its own: a school listing what it teaches
			   before deciding who studies it should not have to invent a
			   class to say so. */
			subjectOnly := strings.TrimSpace(row["class"]) == ""
			var classID uuid.UUID
			if !subjectOnly {
				var cerr error
				classID, cerr = c.classID(row["class"])
				if cerr != nil {
					return cerr
				}
			}
			/* The code or the name, because a school writes both.

			   The column is called subject_code and the sheet the office
			   actually keeps says "General Science". Insisting on the code
			   rejected files whose every row named a subject that plainly
			   exists. The staff importer had already learned this; these two
			   had not. */
			want := strings.TrimSpace(row["subject"])
			if want == "" {
				// The older template called this column subject_code, and
				// sheets written against it still load.
				want = strings.TrimSpace(row["subject_code"])
			}
			var subjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT id FROM subjects
				 WHERE institution_id = $1
				   AND (upper(code) = upper($2) OR lower(name) = lower($2))`,
				c.inst, want).Scan(&subjectID); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				/* Created, because naming a subject against a class is how a
				   school says it teaches that subject. Demanding it exist
				   first made the order of two uploads matter, and getting it
				   wrong rejected every row for a subject written on the sheet
				   in front of them.

				   Matched on name or code above before creating, so a second
				   row naming the same subject joins the first rather than
				   making a twin. */
				var fresh bool
				/* Subjects are unique on (institution, campus, code), not on
				   (institution, code) -- and Postgres refuses a conflict
				   target it cannot match, so this raised a raw 42P10 at the
				   school rather than creating anything. The campus was
				   missing from both the target and the insert. */
				if err := c.tx.QueryRow(c.r.Context(), `
					INSERT INTO subjects (institution_id, campus_id, name, code)
					VALUES ($1,$2,$3,upper(left(regexp_replace($3,'[^A-Za-z]','','g'),6)))
					ON CONFLICT (institution_id, campus_id, code)
					DO UPDATE SET name = subjects.name
					RETURNING id, xmax = 0`,
					c.inst, c.campus, want).Scan(&subjectID, &fresh); err != nil {
					return err
				}
				c.noteCreated("subjects", subjectID, fresh)
			}
			if subjectOnly {
				return nil
			}

			maxMarks := 100
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				maxMarks, _ = strconv.Atoi(v)
			}

			/* How many periods a week the subject wants.

			   The timetable solver reads this and nothing else wrote it, so
			   every school reached "Generate a draft" and was told no subject
			   has a weekly requirement yet — with no screen that could set
			   one. The sheet a school keeps has this column; it just had
			   nowhere to go. Left alone when the column is absent, so a file
			   without it still loads and the value already stored survives a
			   re-upload. */
			var perWeek *int
			if v := strings.TrimSpace(row["periods_per_week"]); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					perWeek = &n
				}
			}

			var csID uuid.UUID
			var csNew bool
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO class_subjects (institution_id, class_id, subject_id,
				                            max_marks, periods_per_week)
				VALUES ($1,$2,$3,$4,COALESCE($5, 0))
				ON CONFLICT (class_id, subject_id)
				DO UPDATE SET max_marks = EXCLUDED.max_marks,
				              periods_per_week = COALESCE($5, class_subjects.periods_per_week)
				RETURNING id, xmax = 0`,
				c.inst, classID, subjectID, maxMarks, perWeek).Scan(&csID, &csNew); err != nil {
				return err
			}
			/* Recorded, so this upload can be taken back out.

			   Two of the thirteen importers never noted what they created --
			   this one and the timetable -- so their uploads reported "139
			   added" and then "nothing to remove", for ever, however many rows
			   they had put in. The school reads that as the delete being
			   broken, which is fair: the row says it added 139 things and that
			   there is nothing of its own to remove. */
			c.noteCreated("class_subjects", csID, csNew)

			/* The section, where the row names one: its room, and the
			   teacher who takes it as a form class. This was a separate sheet,
			   and a school filling in "who teaches 6-A maths" is thinking
			   about 6-A's form teacher and its room at the same moment. */
			var sectionID uuid.UUID
			haveSection := strings.TrimSpace(row["section"]) != ""
			if haveSection {
				var err error
				sectionID, err = c.sectionIDFor(row["class"], row["section"])
				if err != nil {
					return err
				}
				if room := strings.TrimSpace(row["room"]); room != "" {
					if _, err := c.tx.Exec(c.r.Context(),
						`UPDATE sections SET room = $2 WHERE id = $1`,
						sectionID, room); err != nil {
						return err
					}
				}
				/* Named, or ticked. A sheet either says who the class
				   teacher is, or says Yes on the line of the teacher who is
				   one -- and the second is the natural thing to write when a
				   teacher column already sits beside it. */
				named, ticked := classTeacherIs(
					optional(row, "class_teacher", "class_teacher_email"))
				if ticked {
					named = optional(row, "teacher", "teacher_email")
				}
				if named != "" {
					ctID, err := c.teacherByEmail(named)
					if err != nil {
						return err
					}
					if _, err := c.tx.Exec(c.r.Context(),
						`UPDATE sections SET class_teacher_id = $2 WHERE id = $1`,
						sectionID, ctID); err != nil {
						return err
					}
				}
			}

			// Naming a teacher with no section attaches them to every section
			// of that class -- which is what "who teaches Grade 6 maths" means
			// in a school with two sections and one maths teacher.
			email := optional(row, "teacher", "teacher_email")
			if email == "" {
				return nil
			}
			teacher, terr := c.teacherByEmail(email)
			if terr != nil {
				return terr
			}
			/* One section where the row named one, every section where it did
			   not. A school with two sections and one maths teacher writes the
			   class; a school splitting 6-A and 6-B between two teachers
			   writes the section, and both mean what they wrote. */
			if haveSection {
				_, aerr := c.tx.Exec(c.r.Context(), `
					INSERT INTO section_subject_teachers (institution_id, section_id,
					                                      class_subject_id, teacher_user_id)
					VALUES ($1,$2,$3,$4)
					ON CONFLICT (section_id, class_subject_id)
					DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
					c.inst, sectionID, csID, teacher)
				return aerr
			}
			_, aerr := c.tx.Exec(c.r.Context(), `
				INSERT INTO section_subject_teachers (institution_id, section_id,
				                                      class_subject_id, teacher_user_id)
				SELECT $1, sec.id, $2, $3 FROM sections sec WHERE sec.class_id = $4
				ON CONFLICT (section_id, class_subject_id)
				DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
				c.inst, csID, teacher, classID)
			return aerr
		},
	},
	/* Who runs which room, and who teaches what in it.

	   Two facts a school keeps on one sheet and the product made them enter
	   in two places: the class teacher and the room for a section, and the
	   teacher against each subject in that section. Both are here, and every
	   column but the class and the section is optional — a school with only
	   class teachers fills three columns and leaves the rest blank, and a
	   school listing subject teachers repeats the class and section down the
	   rows the way a spreadsheet does.

	   Nothing is required to appear together. A row with a class teacher and
	   no subject sets the class teacher. A row with a subject and no class
	   teacher sets the subject teacher. A row with both does both.
	*/
	"allocations": {
		/* Checked before anything is written, for the same reason as every
		   other sheet here: a dry run that passes rows the commit refuses has
		   told the clerk the file is ready and spent the trust it needs. */
		Verify: func(c *importCtx, row map[string]string) error {
			if _, err := c.sectionIDFor(row["class"], row["section"]); err != nil {
				return err
			}
			/* The tick is not a name and must not be looked up as one. This
			   is the check that produced "no member of staff called Yes" on
			   fifteen rows of a hundred and seventy-one -- and because a
			   rejected row stops the whole file, the other hundred and
			   fifty-six did not go in either. */
			ctName, _ := classTeacherIs(
				optional(row, "class_teacher", "class_teacher_email"))
			for _, who := range []string{ctName, optional(row, "teacher", "teacher_email")} {
				if who == "" {
					continue
				}
				if _, err := c.teacherByEmail(who); err != nil {
					return err
				}
			}
			return nil
		},
		Perm: rbac.AcademicsWrite,
		// Teachers by name or staff code as well as by email, like the sheet
		// above. Both column spellings are read, so older files still load.
		Columns:  []string{"class", "section", "room", "class_teacher", "subject", "teacher"},
		Required: []string{"class", "section"},
		Sample:   []string{"Grade 6", "A", "6A", "Priya Rao", "MATH", "T-014"},
		Write: func(c *importCtx, row map[string]string) error {
			sectionID, err := c.sectionIDFor(row["class"], row["section"])
			if err != nil {
				return err
			}

			if room := strings.TrimSpace(row["room"]); room != "" {
				if _, err := c.tx.Exec(c.r.Context(),
					`UPDATE sections SET room = $2 WHERE id = $1`, sectionID, room); err != nil {
					return err
				}
			}

			// Named, or ticked on the line of the teacher who is one.
			ctName, ticked := classTeacherIs(
				optional(row, "class_teacher", "class_teacher_email"))
			if ticked {
				ctName = optional(row, "teacher", "teacher_email")
			}
			if ctName != "" {
				teacher, err := c.teacherByEmail(ctName)
				if err != nil {
					return err
				}
				if _, err := c.tx.Exec(c.r.Context(),
					`UPDATE sections SET class_teacher_id = $2 WHERE id = $1`,
					sectionID, teacher); err != nil {
					return err
				}
			}

			code := firstOf(row, "subject", "subject_code")
			email := optional(row, "teacher", "teacher_email")
			if code == "" || email == "" {
				// A row that only names the class teacher is complete. Treating
				// a blank subject as an error would mean two files for what a
				// school keeps as one.
				return nil
			}
			teacher, err := c.teacherByEmail(email)
			if err != nil {
				return err
			}
			var csID, subjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT cs.id, cs.subject_id
				  FROM class_subjects cs
				  JOIN subjects sub ON sub.id = cs.subject_id
				  JOIN sections sec ON sec.class_id = cs.class_id
				 WHERE sec.id = $1 AND cs.institution_id = $3
				   AND (upper(sub.code) = upper($2) OR lower(sub.name) = lower($2))`,
				sectionID, code, c.inst).Scan(&csID, &subjectID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("%s does not study %q. Map the subject to the class first",
						row["class"], code)
				}
				return err
			}
			/* Recorded, so a timetable uploaded by mistake can be taken back
			   out. This importer noted nothing, so a run that placed 139
			   allocations reported "139 added" and "nothing to remove" in the
			   same row, for ever. A school reads that as the delete being
			   broken, and it is right to. */
			var alloc uuid.UUID
			var allocNew bool
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO section_subject_teachers (institution_id, section_id,
				                                      class_subject_id, teacher_user_id)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (section_id, class_subject_id)
				DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id
				RETURNING id, xmax = 0`,
				c.inst, sectionID, csID, teacher).Scan(&alloc, &allocNew); err != nil {
				return err
			}
			c.noteCreated("allocations", alloc, allocNew)
			// Assigning somebody to teach a subject is also a statement that
			// they teach it, which is what the dropdowns read.
			_, err = c.tx.Exec(c.r.Context(), `
				INSERT INTO teacher_subjects (institution_id, user_id, subject_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, c.inst, teacher, subjectID)
			return err
		},
	},
	/* A CLOSED YEAR, AS THE SCHOOL REMEMBERS IT.

	   The years before this system are not rows of the same kind: attendance
	   is a total, not a register, and fees are a figure, not receipts. Both
	   are held apart from the live tables, because writing them in would make
	   money collected in 2023 appear in today's collection report and would
	   invent register entries for dates the school can still be asked about.

	   One row per child per year, so a corrected re-upload edits a history
	   rather than doubling it. */
	/* PAST EXAM RESULTS, INTO THE REAL TABLES.

	   Unlike attendance and fees, marks belong in the live tables and nothing
	   is distorted by putting them there: an exam is scoped to its academic
	   year, so a 2023 exam is simply an exam in 2023. It does not appear in
	   this year's analysis, and a report card for that year renders from it
	   like any other -- which is the point. A school that carried three years
	   across can print the card it could print before.

	   The year, the exam and the paper are created where the file names ones
	   that do not exist, because they do not: they predate the school's use of
	   this system, and asking a clerk to key in nine terms of exams by hand
	   before uploading the marks is asking them not to bother.

	   The child, the class and the subject are NOT created. Those are the
	   school's own lists, and inventing a subject called "Maths" beside the
	   existing "Mathematics" is how a roll ends up with two of everything. */
	/* A MEMBER OF STAFF'S CLOSED YEARS.

	   The same shape as a child's, and for the same reason: a teacher who has
	   been at the school eleven years arrives with eleven years of service
	   that the live tables cannot hold. Their attendance is a total, not a
	   register, and writing invented days into the staff register would show
	   them present on dates the school can still be asked about.

	   Service history is what a school reaches for when it writes an
	   experience certificate, decides seniority, or answers an inspector
	   asking how long somebody has taught a subject. Without it, an imported
	   teacher has worked here since the day of the upload. */
	"staff_history": {
		Perm: rbac.EmployeesWrite,
		Columns: []string{"employee_code", "year", "designation", "days_present",
			"days_total", "leaves_taken", "notes"},
		Required: []string{"employee_code", "year"},
		Sample: []string{"T-014", "2025-26", "Senior Teacher", "212", "220", "8",
			"Class teacher, Grade 5-A"},
		Check: func(row map[string]string) error {
			for _, k := range []string{"days_present", "days_total", "leaves_taken"} {
				v := strings.TrimSpace(strings.ReplaceAll(row[k], ",", ""))
				if v == "" {
					continue
				}
				n, err := strconv.Atoi(v)
				if err != nil || n < 0 {
					return fmt.Errorf("%s must be a whole number that is not negative", k)
				}
			}
			pres := strings.TrimSpace(strings.ReplaceAll(row["days_present"], ",", ""))
			total := strings.TrimSpace(strings.ReplaceAll(row["days_total"], ",", ""))
			if pres != "" && total != "" {
				a, _ := strconv.Atoi(pres)
				b, _ := strconv.Atoi(total)
				if b > 0 && a > b {
					return errors.New("days_present is more than days_total")
				}
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			var exists bool
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT EXISTS (SELECT 1 FROM employees
				                 WHERE institution_id = $1 AND employee_code = $2)`,
				c.inst, strings.TrimSpace(row["employee_code"])).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return fmt.Errorf("nobody on the roll with employee code %q. Import the staff first",
					strings.TrimSpace(row["employee_code"]))
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			var empID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM employees WHERE institution_id = $1 AND employee_code = $2`,
				c.inst, strings.TrimSpace(row["employee_code"])).Scan(&empID); err != nil {
				return err
			}
			var id uuid.UUID
			var inserted bool
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO employee_year_history (institution_id, employee_id, year_name,
				        designation, days_present, days_total, leaves_taken, notes)
				VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,NULLIF($8,''))
				ON CONFLICT (employee_id, year_name) DO UPDATE SET
				    designation = EXCLUDED.designation,
				    days_present = EXCLUDED.days_present,
				    days_total = EXCLUDED.days_total,
				    leaves_taken = EXCLUDED.leaves_taken,
				    notes = EXCLUDED.notes,
				    updated_at = now()
				RETURNING id, xmax = 0`,
				c.inst, empID, strings.TrimSpace(row["year"]),
				strings.TrimSpace(row["designation"]),
				intOrNil(row["days_present"]), intOrNil(row["days_total"]),
				intOrNil(row["leaves_taken"]),
				strings.TrimSpace(row["notes"])).Scan(&id, &inserted); err != nil {
				return err
			}
			c.noteCreated("staff_history", id, inserted)
			return nil
		},
	},

	/* THE MARK SHEET THE SCHOOL ALREADY HAS.

	   The row-per-subject importer above is the correct shape for a database
	   and the wrong shape for a school. A class of forty across six subjects
	   is two hundred and forty rows, and nobody keeps marks that way: the
	   sheet in every staff room is a grid -- children down the side, subjects
	   across the top, one mark in each cell.

	   Asking somebody to reshape that before uploading it is asking them to do
	   by hand, forty times, the transformation a computer exists to do. Most
	   will not, which means the marks stay in the spreadsheet and the year has
	   no results in the system.

	   So the subjects are the columns. Which columns those are cannot be
	   guessed -- "Total", "Rank", "Remarks" and "Attendance" sit in the same
	   header row and are not subjects -- so the clerk maps each subject
	   column, exactly as they map everything else, using subject:<name>.

	   Everything else is one value for the whole sheet: it is one exam, of one
	   class, in one year, out of one maximum. Repeating those on every row is
	   how one typo puts one child's paper out of ten. */
	"marks_grid": {
		Perm:     rbac.MarksWrite,
		Columns:  []string{"admission_no", "year", "exam", "class", "max_marks"},
		Required: []string{"admission_no"},
		Sample:   []string{"ADM0001", "2025-26", "Annual Examination", "Grade 5", "100"},
		// The four that describe the sheet rather than the child are taken
		// from the request, because they are the same on every row of it.
		Check: func(row map[string]string) error {
			if strings.TrimSpace(row["admission_no"]) == "" {
				return errors.New("every row needs the child's admission number")
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			var exists bool
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT EXISTS (SELECT 1 FROM students
				                 WHERE institution_id = $1 AND admission_no = $2)`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return fmt.Errorf("no child with admission number %q. Import the students first",
					strings.TrimSpace(row["admission_no"]))
			}
			if len(c.subjectCols) == 0 {
				return errors.New("no subject columns were chosen. Point at least one " +
					"column at a subject, so the marks in it have somewhere to go")
			}
			classID, err := c.classID(c.sheet.class)
			if err != nil {
				return err
			}
			for subject, header := range c.subjectCols {
				var ok bool
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT EXISTS (
					  SELECT 1 FROM class_subjects cs
					    JOIN subjects sub ON sub.id = cs.subject_id
					   WHERE cs.class_id = $1
					     AND (lower(sub.name) = lower($2) OR upper(sub.code) = upper($2)))`,
					classID, subject).Scan(&ok); err != nil {
					return err
				}
				if !ok {
					return fmt.Errorf("%s does not teach %q, which you pointed the %q column at",
						c.sheet.class, subject, header)
				}
			}
			// One bad cell fails its own row and names the subject, rather
			// than failing the sheet: a class of forty where one child's
			// Hindi was typed as "AB" should import thirty-nine.
			for subject := range c.subjectCols {
				v := strings.TrimSpace(row[normaliseHeader("subject:"+subject)])
				if v == "" || strings.EqualFold(v, "AB") || strings.EqualFold(v, "A") {
					continue
				}
				n, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", ""), 64)
				if err != nil || n < 0 {
					return fmt.Errorf("%s is %q, which is not a mark. Leave it blank, or write AB for absent",
						subject, v)
				}
				if c.sheet.maxMarks > 0 && n > c.sheet.maxMarks {
					return fmt.Errorf("%s is %s, more than the %g the paper is out of",
						subject, v, c.sheet.maxMarks)
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			var studentID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM students WHERE institution_id = $1 AND admission_no = $2`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&studentID); err != nil {
				return err
			}
			classID, err := c.classID(c.sheet.class)
			if err != nil {
				return err
			}
			yearID, err := c.pastYearID(c.sheet.year)
			if err != nil {
				return err
			}
			examID, err := c.pastExamID(yearID, c.sheet.exam)
			if err != nil {
				return err
			}

			for subject := range c.subjectCols {
				raw := strings.TrimSpace(row[normaliseHeader("subject:"+subject)])
				// A blank cell is a subject this child does not take, which is
				// not the same as a zero and must not be recorded as one.
				if raw == "" {
					continue
				}
				var classSubjectID uuid.UUID
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT cs.id FROM class_subjects cs
					  JOIN subjects sub ON sub.id = cs.subject_id
					 WHERE cs.class_id = $1
					   AND (lower(sub.name) = lower($2) OR upper(sub.code) = upper($2))
					 LIMIT 1`, classID, subject).Scan(&classSubjectID); err != nil {
					return err
				}
				var examSubjectID uuid.UUID
				if err := c.tx.QueryRow(c.r.Context(), `
					INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id, max_marks)
					VALUES ($1,$2,$3,$4)
					ON CONFLICT (exam_id, class_subject_id)
					DO UPDATE SET max_marks = EXCLUDED.max_marks
					RETURNING id`,
					c.inst, examID, classSubjectID, c.sheet.maxMarks).Scan(&examSubjectID); err != nil {
					return err
				}

				absent := strings.EqualFold(raw, "AB") || strings.EqualFold(raw, "A")
				var obtained any
				if !absent {
					n, _ := strconv.ParseFloat(strings.ReplaceAll(raw, ",", ""), 64)
					obtained = n
				}
				var markID uuid.UUID
				var inserted bool
				if err := c.tx.QueryRow(c.r.Context(), `
					INSERT INTO marks (institution_id, exam_subject_id, student_id,
					                   marks_obtained, is_absent)
					VALUES ($1,$2,$3,$4,$5)
					ON CONFLICT (exam_subject_id, student_id) DO UPDATE SET
					    marks_obtained = EXCLUDED.marks_obtained,
					    is_absent = EXCLUDED.is_absent
					RETURNING id, xmax = 0`,
					c.inst, examSubjectID, studentID, obtained, absent).Scan(&markID, &inserted); err != nil {
					return err
				}
				c.noteCreated("marks", markID, inserted)
			}
			return nil
		},
	},

	"marks": {
		Perm: rbac.MarksWrite,
		Columns: []string{"admission_no", "year", "exam", "class", "subject",
			"max_marks", "marks_obtained", "grade"},
		Required: []string{"admission_no", "year", "exam", "class", "subject", "max_marks"},
		Sample: []string{"ADM0001", "2025-26", "Annual Examination", "Grade 5",
			"Mathematics", "100", "87", "A1"},
		Check: func(row map[string]string) error {
			maxM, err := strconv.ParseFloat(strings.TrimSpace(row["max_marks"]), 64)
			if err != nil || maxM <= 0 {
				return errors.New("max_marks must be a number above zero")
			}
			got := strings.TrimSpace(row["marks_obtained"])
			if got == "" {
				// Blank is absent, which is a real result and not a mistake.
				return nil
			}
			n, err := strconv.ParseFloat(got, 64)
			if err != nil || n < 0 {
				return errors.New("marks_obtained must be a number that is not negative, or blank for absent")
			}
			// A mark above the paper prints as over 100 per cent on a report
			// card, and is nearly always a column read into the wrong field.
			if n > maxM {
				return fmt.Errorf("marks_obtained (%s) is more than max_marks (%s)", got, row["max_marks"])
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			var exists bool
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT EXISTS (SELECT 1 FROM students
				                 WHERE institution_id = $1 AND admission_no = $2)`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return fmt.Errorf("no child with admission number %q. Import the students first",
					strings.TrimSpace(row["admission_no"]))
			}
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			var ok bool
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT EXISTS (
				  SELECT 1 FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
				   WHERE cs.class_id = $1
				     AND (lower(sub.name) = lower($2) OR upper(sub.code) = upper($2)))`,
				classID, strings.TrimSpace(row["subject"])).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("%s does not teach %q. Check the class-subject list for the exact name",
					strings.TrimSpace(row["class"]), strings.TrimSpace(row["subject"]))
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			var studentID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM students WHERE institution_id = $1 AND admission_no = $2`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&studentID); err != nil {
				return err
			}
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			yearID, err := c.pastYearID(strings.TrimSpace(row["year"]))
			if err != nil {
				return err
			}
			examID, err := c.pastExamID(yearID, strings.TrimSpace(row["exam"]))
			if err != nil {
				return err
			}

			var classSubjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT cs.id FROM class_subjects cs
				  JOIN subjects sub ON sub.id = cs.subject_id
				 WHERE cs.class_id = $1
				   AND (lower(sub.name) = lower($2) OR upper(sub.code) = upper($2))
				 LIMIT 1`, classID, strings.TrimSpace(row["subject"])).Scan(&classSubjectID); err != nil {
				return err
			}

			maxM, _ := strconv.ParseFloat(strings.TrimSpace(row["max_marks"]), 64)
			var examSubjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id, max_marks)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (exam_id, class_subject_id)
				DO UPDATE SET max_marks = EXCLUDED.max_marks
				RETURNING id`, c.inst, examID, classSubjectID, maxM).Scan(&examSubjectID); err != nil {
				return err
			}

			got := strings.TrimSpace(row["marks_obtained"])
			var obtained any
			absent := got == ""
			if !absent {
				n, _ := strconv.ParseFloat(got, 64)
				obtained = n
			}
			var markID uuid.UUID
			var inserted bool
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO marks (institution_id, exam_subject_id, student_id,
				                   marks_obtained, grade, is_absent)
				VALUES ($1,$2,$3,$4,NULLIF($5,''),$6)
				ON CONFLICT (exam_subject_id, student_id) DO UPDATE SET
				    marks_obtained = EXCLUDED.marks_obtained,
				    grade = EXCLUDED.grade,
				    is_absent = EXCLUDED.is_absent
				RETURNING id, xmax = 0`,
				c.inst, examSubjectID, studentID, obtained,
				strings.TrimSpace(row["grade"]), absent).Scan(&markID, &inserted); err != nil {
				return err
			}
			c.noteCreated("marks", markID, inserted)
			return nil
		},
	},

	"student_history": {
		Perm: rbac.StudentsWrite,
		Columns: []string{"admission_no", "year", "class", "days_present",
			"days_total", "fee_billed", "fee_paid", "fee_waived", "notes"},
		Required: []string{"admission_no", "year"},
		Sample: []string{"ADM0001", "2025-26", "Grade 5", "187", "210",
			"35500", "35500", "0", "Promoted with distinction"},
		Check: func(row map[string]string) error {
			/* THE CHECK HAS TO ACCEPT WHAT THE WRITER ACCEPTS.

			   This read the raw string while the writer strips thousands
			   separators, so a sheet that says 28,000 -- which is how every
			   school writes money -- was refused by the validator for a value
			   the importer would have stored correctly. A dry run that
			   rejects good rows is worse than one that misses bad ones: the
			   clerk edits a file that was right, and learns not to trust the
			   screen. */
			for _, k := range []string{"days_present", "days_total",
				"fee_billed", "fee_paid", "fee_waived"} {
				v := strings.TrimSpace(row[k])
				if v == "" {
					continue
				}
				n, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", ""), 64)
				if err != nil || n < 0 {
					return fmt.Errorf("%s must be a number that is not negative", k)
				}
			}
			// Present days above the days the school ran is the commonest
			// thing wrong with a hand-kept summary, and it prints on a
			// certificate as an attendance above 100 per cent.
			pres, ptotal := strings.TrimSpace(row["days_present"]), strings.TrimSpace(row["days_total"])
			if pres != "" && ptotal != "" {
				a, _ := strconv.ParseFloat(strings.ReplaceAll(pres, ",", ""), 64)
				b, _ := strconv.ParseFloat(strings.ReplaceAll(ptotal, ",", ""), 64)
				if b > 0 && a > b {
					return errors.New("days_present is more than days_total")
				}
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			var exists bool
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT EXISTS (SELECT 1 FROM students
				                 WHERE institution_id = $1 AND admission_no = $2)`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return fmt.Errorf("no child with admission number %q. Import the students first",
					strings.TrimSpace(row["admission_no"]))
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			var studentID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM students WHERE institution_id = $1 AND admission_no = $2`,
				c.inst, strings.TrimSpace(row["admission_no"])).Scan(&studentID); err != nil {
				return err
			}
			var id uuid.UUID
			var inserted bool
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO student_year_history (institution_id, student_id, year_name,
				        class_name, days_present, days_total,
				        fee_billed_paise, fee_paid_paise, fee_waived_paise, notes)
				VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,NULLIF($10,''))
				ON CONFLICT (student_id, year_name) DO UPDATE SET
				    class_name = EXCLUDED.class_name,
				    days_present = EXCLUDED.days_present,
				    days_total = EXCLUDED.days_total,
				    fee_billed_paise = EXCLUDED.fee_billed_paise,
				    fee_paid_paise = EXCLUDED.fee_paid_paise,
				    fee_waived_paise = EXCLUDED.fee_waived_paise,
				    notes = EXCLUDED.notes,
				    updated_at = now()
				RETURNING id, xmax = 0`,
				c.inst, studentID, strings.TrimSpace(row["year"]),
				strings.TrimSpace(row["class"]),
				intOrNil(row["days_present"]), intOrNil(row["days_total"]),
				paiseOrNil(row["fee_billed"]), paiseOrNil(row["fee_paid"]),
				paiseOrNil(row["fee_waived"]),
				strings.TrimSpace(row["notes"])).Scan(&id, &inserted); err != nil {
				return err
			}
			c.noteCreated("student_history", id, inserted)
			return nil
		},
	},

	"staff": {
		Perm: rbac.EmployeesWrite,
		// status is here so a sheet carrying one can be mapped to it -- which
		// is also what lets the crossed-column swap below see both values.
		Columns: []string{"employee_code", "first_name", "last_name", "email", "phone",
			"designation", "department", "employment_type", "status",
			"role", "joined_on", "relieved_on", "subjects"},
		Required: []string{"employee_code", "first_name"},
		Sample: []string{"YPS001", "Priya Rao", "", "priya@school.in", "9876543210",
			"Teacher", "Teaching staff", "Permanent", "Active",
			"faculty", "01 Jan 2024", "", "MATH; SCI"},
		Check: func(row map[string]string) error {
			/* The same date reader the student sheet uses.

			   This one parsed YYYY-MM-DD and nothing else, so a staff export
			   reading "01 Jan 2024" -- which is what a real one does -- was
			   rejected row by row for a date any person can read. Two
			   importers in one product disagreeing about what a date looks
			   like is a difference nobody can be expected to know about. */
			if v := strings.TrimSpace(row["joined_on"]); v != "" {
				if normaliseDate(v) == v {
					if _, err := time.Parse(time.DateOnly, v); err != nil {
						return errors.New("joined_on is not a date this can read. " +
							"Write it as 2026-06-01, 01/06/2026 or 01 Jun 2026")
					}
				}
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			// Named before the upload rather than after it: a subject that
			// does not exist is the commonest thing wrong with a staff sheet,
			// because a school writes "Science" where the list says "General
			// Science".
			for _, want := range splitSubjects(row["subjects"]) {
				var exists bool
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT EXISTS (SELECT 1 FROM subjects
					                WHERE institution_id = $2
					                  AND (upper(code) = upper($1) OR lower(name) = lower($1)))`,
					want, c.inst).Scan(&exists); err != nil {
					return err
				}
				if !exists {
					return fmt.Errorf("no subject called %q. Check the Subjects step for the exact name", want)
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			/* A KNOWN EXPORT WRITES THESE TWO COLUMNS THE WRONG WAY ROUND.

			   One school's staff export has "Teacher" under Status and
			   "Active" under Role / Designation. Mapping them crossed on the
			   screen works, and asks the clerk to notice and remember it every
			   time -- which they will not, and then every member of staff is
			   appointed to the post of Active.

			   Swapped only when the evidence is unambiguous: the designation
			   column holds a word that is plainly a status, and the status
			   column does not. A school whose designation really is "Active"
			   does not exist; a school whose designation is "Teacher" is every
			   school. */
			if isStaffStatusWord(row["designation"]) && !isStaffStatusWord(row["status"]) {
				row["designation"], row["status"] = row["status"], row["designation"]
			}
			/* The post, resolved from the word the sheet uses.

			   The designation column has been in this importer's template
			   since it was written, was read into the row, and was then never
			   put anywhere: employeeRequest.Designation is a designation_id,
			   and nothing assigned it. So every school that filled in that
			   column got a roll of staff with no posts, and the import
			   reported success.

			   Created where the school has not set it up, like subjects. A
			   staff sheet naming a post is the school declaring that post, and
			   there is no earlier moment to declare it in. */
			designationID, derr := c.designationID(row["designation"])
			if derr != nil {
				return derr
			}
			/* The department, like the post: a name the school writes, and
			   employees.department_id is a uuid nothing was filling. */
			departmentID, dperr := c.departmentID(row["department"])
			if dperr != nil {
				return dperr
			}

			/* A NAME IN ONE COLUMN IS A NAME.

			   Every export writes "RAMYA SRI RACHERLA" in a single Staff Name
			   cell. This read first_name and last_name, so the whole name went
			   into the first and the surname was empty -- and a school's staff
			   list then sorts, searches and prints on a letter by a surname
			   nobody has. Split on the last space where the sheet gives one
			   column, exactly as the student sheet already does. */
			first, last := strings.TrimSpace(row["first_name"]), strings.TrimSpace(row["last_name"])
			if last == "" {
				if i := strings.LastIndex(first, " "); i > 0 {
					first, last = strings.TrimSpace(first[:i]), strings.TrimSpace(first[i+1:])
				}
			}

			req := employeeRequest{
				EmployeeCode: strings.TrimSpace(row["employee_code"]),
				FirstName:    first,
				LastName:     last,
				Email:        strings.TrimSpace(row["email"]),
				Phone:        strings.TrimSpace(row["phone"]),
				Designation:  designationID,
				Department:   departmentID,
				// Permanent, Contract, Probation, Part time, Visiting -- the
				// words a school writes, mapped onto the five the column takes.
				EmploymentType: normaliseEmployment(row["employment_type"]),
				JoinedOn:       normaliseDate(row["joined_on"]),
				/* The system role, from the role column or from the post.

				   A school's staff sheet says Teacher, Librarian, Accountant.
				   Those are what the school calls the post; they are not the
				   keys this product grants permissions by, so a file mapped
				   honestly to `role` matched nothing and fifty-eight teachers
				   were imported holding no role at all -- able to sign in and
				   see an empty product, which is indistinguishable from being
				   broken.

				   The key is taken where the sheet gives a real one, and read
				   off the post otherwise. Only where the post says plainly
				   what somebody is: an unrecognised title grants nothing
				   rather than guessing, because a wrong role is worse than
				   none -- it hands somebody a workspace that is not theirs. */
				RoleKey: staffRoleKey(row["role"], row["designation"]),
			}
			// A login is minted only where there is an address to send it to.
			// A teacher with no email is still a teacher; inventing a username
			// for them creates an account nobody will ever sign in to.
			req.CreateLogin = req.Email != "" && req.RoleKey != ""
			empID, userID, created, err := appointEmployee(c.r.Context(), c.tx, c.inst, c.campus, req)
			if err != nil {
				return err
			}
			/* THE DAY SOMEBODY LEFT, and the status that goes with it.

			   A roll carries people who have left -- forty-one of eighty-nine
			   in one real export -- with the date they went. Importing them
			   all as active gives a school a staff list half full of people
			   who are not there, and every one of them gets a login. */
			if left := normaliseDate(row["relieved_on"]); left != "" {
				if _, err := c.tx.Exec(c.r.Context(), `
					UPDATE employees
					   SET relieved_on = $2::date,
					       status = CASE WHEN status = 'active' THEN 'resigned' ELSE status END
					 WHERE institution_id = $1 AND employee_code = $3`,
					c.inst, left, strings.TrimSpace(row["employee_code"])); err != nil {
					return err
				}
			} else if st := strings.ToLower(strings.TrimSpace(row["status"])); st != "" &&
				isStaffStatusWord(st) && st != "active" {
				if _, err := c.tx.Exec(c.r.Context(), `
					UPDATE employees SET status = $2
					 WHERE institution_id = $1 AND employee_code = $3`,
					c.inst, staffStatusValue(st), strings.TrimSpace(row["employee_code"])); err != nil {
					return err
				}
			}

			// Only staff this file brought onto the roll. The upsert matches on
			// employee_code, so a corrected re-upload edits people who were
			// already appointed and undoing it must not remove them.
			if parsed, perr := uuid.Parse(empID); perr == nil {
				c.noteCreated("staff", parsed, created)
			}

			/* THE COLUMNS THIS PRODUCT HAS NO FIELD FOR.

			   Every school's staff sheet carries something we did not think of
			   — a PF number, a bus route, a qualification code, the branch
			   they were hired at. Those columns were read into the row and
			   then dropped, so the import reported sixty staff imported and
			   quietly lost half of what the file said about them.

			   Kept under the school's own header, which is the label the
			   office will look for. employees.custom_fields exists for exactly
			   this and had nothing writing to it from the importer. */
			if extra := leftoverColumns(row, staffKnownColumns); len(extra) > 0 {
				if _, err := c.tx.Exec(c.r.Context(), `
					UPDATE employees
					   SET custom_fields = custom_fields || $2::jsonb,
					       updated_at = now()
					 WHERE id = $1`, empID, jsonMap(extra)); err != nil {
					return err
				}
			}

			/* What they teach, where the sheet says.

			   A school knows who its maths teachers are and had nowhere to
			   put that, so the subject-teacher dropdown offered every member
			   of staff for every subject and the Telugu row listed the
			   accountant.

			   Separated by semicolons or commas, matched on the subject code
			   or its name, because a school writes "MATH; SCI" in one column
			   and should not have to learn which of the two we wanted. An
			   unknown subject fails the row by name rather than being
			   skipped: silently dropping half of "MATH; PHYSICS" leaves
			   somebody believing a fact that is not recorded. */
			/* WHAT A TEACHER TEACHES IS RECORDED AGAINST THEIR ACCOUNT.

			   teacher_subjects keys on user_id, so a member of staff with no
			   account has nowhere to put it. That used to return quietly, and
			   the note above promised the subjects would go in "when they are
			   given a login" -- nothing does that, and by then the sheet is
			   gone. One school imported fifty-eight teachers with a subjects
			   column filled in and finished with none recorded, told nothing.

			   An account is created during the import wherever there is an
			   email and a role to give, and the role is now read off the post,
			   so this is rare. Where it still happens it is said out loud and
			   the row is refused, because a silently dropped column is a fact
			   somebody believes is recorded. */
			list := strings.TrimSpace(row["subjects"])
			if list == "" {
				return nil
			}
			if strings.TrimSpace(userID) == "" {
				return fmt.Errorf(
					"%q teaches %s, and what somebody teaches is held against their "+
						"login. This row has no email, or no role to give, so no "+
						"account was made and the subjects would be lost. Add an "+
						"email and a role, or leave the subjects column out and set "+
						"them on the allocation sheet",
					strings.TrimSpace(row["first_name"]), list)
			}
			for _, want := range splitSubjects(list) {
				var subjectID uuid.UUID
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT id FROM subjects
					 WHERE upper(code) = upper($1) OR lower(name) = lower($1)
					 LIMIT 1`, want).Scan(&subjectID); err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						return fmt.Errorf("no subject called %q. Add the subjects first", want)
					}
					return err
				}
				if _, err := c.tx.Exec(c.r.Context(), `
					INSERT INTO teacher_subjects (institution_id, user_id, subject_id)
					VALUES ($1,$2::uuid,$3) ON CONFLICT DO NOTHING`,
					c.inst, userID, subjectID); err != nil {
					return err
				}
			}
			return nil
		},
	},

	/* The register that arrives as a file, because the reader is on a LAN we
	   cannot reach.

	   The push path in iclock.go is the good case: the machine posts its
	   punches to us and the register is right within the minute. Most schools
	   are not that case. The reader sits on the office LAN behind a router
	   nobody will forward a port on, and what the school actually has is the
	   vendor software's export -- an eSSL/ZKTeco sheet of id, name and
	   timestamp -- with nowhere in this product to put it. Until now the
	   answer was to key a hundred rows into the staff register by hand, which
	   means the answer was that nobody did.

	   So this importer accepts the vendor export as it comes, and writes the
	   same rows down the same pipe the device would have written them. Punches
	   are the primitive; the day is derived from them below, exactly as the
	   push path derives it. Importing days directly was rejected: two writers
	   for one register disagree the first time somebody uploads both, and a
	   day is an opinion about punches ("first in, last out") that we already
	   hold in one place. */
	"punches": {
		// A punch becomes a line in the staff register, so importing a file of
		// them must cost what marking staff attendance by hand costs, which is
		// hr.attendance.write. Nothing looser: this writes the record a
		// school's payroll is argued from.
		Perm: rbac.StaffAttend,
		/* The columns a vendor export actually has, plus the one it does not.

		   id, name and timestamp are what eSSL prints; the machine knows which
		   machine it is and so never says. We need to know, because a punch
		   without a device is not a fact about anywhere: biometric_punches
		   requires a device and the uniqueness that stops a double count is
		   per device. The serial is the natural key -- biometric_devices
		   already stores it, the push path already authenticates on it, and it
		   is printed on the back of the reader -- so the clerk fills one
		   column down with one value, which Excel does in a drag.

		   name is read and not stored as a column, because employees are
		   matched on the enrolled id and never on a name that arrives as
		   "CH,ASHOK". It is kept in raw with the rest of the row, so anyone
		   looking at an unclaimed punch can see who the machine thought it
		   was. Dropping it would throw away the only human-readable thing in
		   the file. */
		Columns:  []string{"device_serial", "device_user_id", "name", "punched_at"},
		Required: []string{"device_serial", "device_user_id", "punched_at"},
		Sample:   []string{"OGJ3220160104", "T001", "RAMYASRI.R", "2026-09-02 08:40:55"},
		Check: func(row map[string]string) error {
			/* THE ID IS A STRING. It is T001 and N039 on the reader this was
			   written against, and treating it as a number is the bug that
			   silently threw away a day of pushes before the column was
			   migrated to text. Length is bounded to match the push path's
			   bound, so the two agree about what an id can be. */
			uid := strings.ToUpper(strings.TrimSpace(row["device_user_id"]))
			if uid == "" {
				return errors.New("device_user_id is required: it is the id enrolled on the reader, such as T001")
			}
			if len(uid) > 64 {
				return errors.New("device_user_id is longer than any reader issues; check the columns are lined up")
			}
			/* Parsed with the push path's own parser, and this is the whole
			   reason it is that function and not a local time.Parse.

			   A vendor export writes local school time with no zone on it. If
			   this read it as UTC while iclock read it as Asia/Kolkata, the
			   same 08:40 punch would land five and a half hours apart
			   depending on how it reached us, and a teacher would be marked
			   late by a file and on time by the machine. One parser, one
			   answer, and it accepts the three shapes ZK firmware writes so a
			   file exported without seconds is not a hundred rejected rows. */
			at, err := parsePunchTime(strings.TrimSpace(row["punched_at"]))
			if err != nil {
				return errors.New("punched_at must be a date and time as the reader writes it, " +
					"such as 2026-09-02 08:40:55")
			}
			// A punch cannot have happened tomorrow. This catches the mistyped
			// year and the column read from the wrong place, while a day of
			// slack allows for a reader whose clock is a little ahead and for
			// a school in a timezone we guessed wrong about.
			if at.After(time.Now().Add(24 * time.Hour)) {
				return fmt.Errorf("punched_at is in the future (%s); check the date column",
					at.In(indiaTZ()).Format("2006-01-02 15:04"))
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			// The device has to exist before its punches can. Named here
			// rather than at the commit, and told what to do about it, because
			// "device not found" against a serial the clerk copied off the
			// machine is not an instruction.
			devID, err := c.deviceBySerial(strings.TrimSpace(row["device_serial"]))
			if err != nil {
				return err
			}
			/* A repeat is skipped and said so, not written and not failed.

			   Somebody will upload the same export twice -- the second time
			   because they are not sure the first one worked, which is the
			   commonest reason anybody re-uploads anything. biometric_punches
			   has a unique index on (device_id, device_user_id, punched_at)
			   precisely so a punch cannot be counted twice, and the writer
			   leans on it.

			   Failing the upload was rejected: a file that is nine tenths
			   already loaded and one tenth new is exactly the file a school
			   sends after a partial import, and refusing it leaves the new
			   tenth unloadable. Silently writing nothing was rejected too,
			   because then the report says "300 imported" when the answer is
			   zero and nobody can tell the two runs apart.

			   So the row is reported by number with the reason, in the dry run
			   and before anything is written, and left out of the commit. The
			   count of skipped rows is the count of rows the school already
			   had. */
			uid := strings.ToUpper(strings.TrimSpace(row["device_user_id"]))
			at, err := parsePunchTime(strings.TrimSpace(row["punched_at"]))
			if err != nil {
				return err
			}
			key := devID.String() + "\x00" + uid + "\x00" + at.UTC().Format(time.RFC3339Nano)
			if c.punchSeen == nil {
				c.punchSeen = map[string]bool{}
			}
			if c.punchSeen[key] {
				return fmt.Errorf("this file already has a punch for %s at %s on this reader; "+
					"the repeat is skipped so the day is not counted twice",
					uid, at.In(indiaTZ()).Format("2006-01-02 15:04:05"))
			}
			c.punchSeen[key] = true
			var exists bool
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT EXISTS (SELECT 1 FROM biometric_punches
				                WHERE institution_id = $1 AND device_id = $2
				                  AND device_user_id = $3 AND punched_at = $4)`,
				c.inst, devID, uid, at).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return fmt.Errorf("%s already has a punch at %s on this reader, so this row was "+
					"loaded before; it is skipped rather than counted twice",
					uid, at.In(indiaTZ()).Format("2006-01-02 15:04:05"))
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			devID, err := c.deviceBySerial(strings.TrimSpace(row["device_serial"]))
			if err != nil {
				return err
			}
			uid := strings.ToUpper(strings.TrimSpace(row["device_user_id"]))
			at, err := parsePunchTime(strings.TrimSpace(row["punched_at"]))
			if err != nil {
				return err
			}
			/* Resolved to an employee here, and kept when it resolves to
			   nobody -- the same decision the push path makes, for the same
			   reason.

			   A punch from an id no employee claims is not a bad row. It is
			   how a school finds out that somebody enrolled a finger at the
			   machine without telling the office, and the unresolved list
			   exists to show them. Rejecting the row would hide exactly the
			   thing worth seeing, and would also reject the ordinary case of a
			   file uploaded before the staff sheet, which is the order a
			   school does things in.

			   raw carries the line as the export wrote it, name included, so
			   an unclaimed id can be traced back to whoever the vendor
			   software believed it was. */
			raw := strings.Join([]string{
				strings.TrimSpace(row["device_serial"]), uid,
				strings.TrimSpace(row["name"]), strings.TrimSpace(row["punched_at"]),
			}, "\t")
			var empID *uuid.UUID
			var id uuid.UUID
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO biometric_punches
				    (institution_id, device_id, device_user_id, employee_id, punched_at, raw)
				VALUES ($1, $2, $3,
				        (SELECT id FROM employees
				          WHERE institution_id = $1 AND upper(device_user_id) = $3),
				        $4, $5)
				ON CONFLICT (device_id, device_user_id, punched_at) DO NOTHING
				RETURNING id, employee_id`,
				c.inst, devID, uid, at, raw).Scan(&id, &empID)
			if errors.Is(err, pgx.ErrNoRows) {
				// Verify already reported and removed the repeats it could
				// see, so reaching here means a punch arrived from the device
				// itself between the dry run and the commit. Nothing to write
				// and nothing to complain about: the punch is on file, which
				// is what the row was asking for.
				return nil
			}
			if err != nil {
				return err
			}
			/* Not recorded as undoable, and that is deliberate rather than an
			   omission.

			   Undo deletes the rows an import created, and these rows are half
			   of a fact: the staff attendance day below is derived from them
			   and would be left standing, so an undone punch file would leave
			   a register nobody could reconcile against any punch. A punch is
			   also the one thing here that is a machine's observation rather
			   than a school's statement, and deleting observations by the
			   hundred is not a button this product should grow casually. The
			   repair path is the uniqueness index: correct the export, upload
			   it again, and the rows that were already right are skipped. */
			if empID == nil {
				return nil
			}
			return c.rollUpImportedDay(*empID, at, strings.TrimSpace(row["device_serial"]))
		},
	},
}

/*
pastYearID finds an academic year by the name a school writes, creating it if
it is genuinely new.

	Created, unlike a class or a subject, because these are the years before
	the school used this system: by definition none of them is on file, and
	requiring a clerk to key in nine terms of exams before uploading the marks
	is requiring them not to bother.

	Never current. One year is current at a time and it is this one; a past
	year that marked itself current would move the whole school into it.

	The dates are the Indian school year around the leading number, so the year
	sorts and reports correctly. A school whose year runs differently can
	correct the dates afterwards; what it must not do is fail the import.
*/
func (c *importCtx) pastYearID(name string) (uuid.UUID, error) {
	key := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(name)), " ", "")
	if c.pastYears == nil {
		c.pastYears = map[string]uuid.UUID{}
	}
	if id, ok := c.pastYears[key]; ok {
		return id, nil
	}
	id, err := ensurePastYear(c.r.Context(), c.tx, c.inst, c.campus, name)
	if err != nil {
		return uuid.Nil, err
	}
	c.pastYears[key] = id
	return id, nil
}

/*
ensurePastYear finds an academic year by the name a school writes, creating it
if it is genuinely new.

	Shared, because two importers had to agree about this and did not: the
	marks sheet created a missing year and the student sheet quietly skipped
	the row, so whether a child's previous class was recorded depended on which
	file the school happened to upload first. Nothing said so.

	Created, unlike a class or a subject, because these are the years before
	the school used this system: by definition none of them is on file, and
	requiring a clerk to key in nine terms by hand before uploading the marks
	is requiring them not to bother.

	Never current. One year is current at a time and it is this one; a past
	year that marked itself current would move the whole school into it.
*/
func ensurePastYear(ctx context.Context, tx pgx.Tx, inst, campus uuid.UUID,
	name string) (uuid.UUID, error) {

	key := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(name)), " ", "")
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM academic_years
		 WHERE institution_id = $1
		   AND replace(lower(name),' ','') = $2`, inst, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		start := 0
		if len(key) >= 4 {
			start, _ = strconv.Atoi(key[:4])
		}
		if start == 0 {
			return uuid.Nil, fmt.Errorf("cannot read a year from %q. Write it as 2025-26", name)
		}
		// The Indian school year around the leading number, so it sorts and
		// reports correctly. A school whose year runs differently can correct
		// the dates afterwards; what it must not do is fail the import.
		err = tx.QueryRow(ctx, `
			INSERT INTO academic_years (institution_id, campus_id, name,
			                            starts_on, ends_on, is_current)
			VALUES ($1,$2,$3, make_date($4,6,1), make_date($4 + 1,3,31), false)
			RETURNING id`, inst, campus, strings.TrimSpace(name), start).Scan(&id)
	}
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// pastExamID finds or creates one exam within a past year. Unpublished:
// publishing is what tells families a result is ready, and a result from three
// years ago has already been told.
func (c *importCtx) pastExamID(year uuid.UUID, name string) (uuid.UUID, error) {
	key := year.String() + "|" + strings.ToLower(strings.TrimSpace(name))
	if c.pastExams == nil {
		c.pastExams = map[string]uuid.UUID{}
	}
	if id, ok := c.pastExams[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(), `
		SELECT id FROM exams
		 WHERE institution_id = $1 AND academic_year_id = $2
		   AND lower(name) = lower($3)`, c.inst, year, strings.TrimSpace(name)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = c.tx.QueryRow(c.r.Context(), `
			INSERT INTO exams (institution_id, campus_id, academic_year_id, name, kind)
			VALUES ($1,$2,$3,$4,'term') RETURNING id`,
			c.inst, c.campus, year, strings.TrimSpace(name)).Scan(&id)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.pastExams[key] = id
	return id, nil
}

/*
bellScheduleID finds the school day a row belongs to, creating it when the
sheet names one the school has not set up.

	An empty name is the school's own day -- which is what every sheet written
	before this meant, and what a school running one bell always means. A named
	one is created rather than demanded, because the whole point of naming it
	in a sheet is that it does not exist yet.

	Never the default. One day is the school's own and a second day that
	marked itself default would silently move every class that has not been
	told otherwise.
*/
func (c *importCtx) bellScheduleID(name string) (uuid.UUID, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if c.pastYears == nil {
		c.pastYears = map[string]uuid.UUID{}
	}
	if id, ok := c.pastYears["bell:"+key]; ok {
		return id, nil
	}

	var id uuid.UUID
	var err error
	if key == "" {
		err = c.tx.QueryRow(c.r.Context(), `
			SELECT id FROM bell_schedules
			 WHERE institution_id = $1
			 ORDER BY is_default DESC, created_at LIMIT 1`, c.inst).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
				VALUES ($1,$2,'Standard day',true) RETURNING id`,
				c.inst, c.campus).Scan(&id)
		}
	} else {
		err = c.tx.QueryRow(c.r.Context(), `
			SELECT id FROM bell_schedules
			 WHERE institution_id = $1 AND lower(name) = $2`, c.inst, key).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
				VALUES ($1,$2,$3,false) RETURNING id`,
				c.inst, c.campus, strings.TrimSpace(name)).Scan(&id)
		}
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.pastYears["bell:"+key] = id
	return id, nil
}

// isStaffStatusWord says whether a cell holds an employment status rather
// than a post. Deliberately a short, closed list: the point is to be certain,
// not clever, and a word that is not on it is treated as a designation.
/*
designationID finds a post by name, creating it where the sheet names a new one.

	Matched case-insensitively, so Teacher, teacher and TEACHER are one post
	rather than three -- which is what a column of hand-typed job titles would
	otherwise produce, and what makes a designation dropdown useless.
*/
func (c *importCtx) designationID(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return "", nil
	}
	var id string
	err := c.tx.QueryRow(c.r.Context(), `
		SELECT id::text FROM designations
		 WHERE institution_id = $1 AND lower(name) = lower($2)`, c.inst, n).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = c.tx.QueryRow(c.r.Context(), `
			INSERT INTO designations (institution_id, name)
			VALUES ($1,$2) RETURNING id::text`, c.inst, n).Scan(&id)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

/*
departmentID finds a department by name, creating it where the sheet names one
the school has not set up.

	employees.department_id is a uuid and nothing was filling it, so a staff
	sheet's Department column -- which every export has -- was read and
	dropped, the same way the designation was.
*/
func (c *importCtx) departmentID(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return "", nil
	}
	var id string
	err := c.tx.QueryRow(c.r.Context(), `
		SELECT id::text FROM departments
		 WHERE institution_id = $1 AND lower(name) = lower($2)`, c.inst, n).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = c.tx.QueryRow(c.r.Context(), `
			INSERT INTO departments (institution_id, name)
			VALUES ($1,$2) RETURNING id::text`, c.inst, n).Scan(&id)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// normaliseEmployment maps the words a school writes onto the five the column
// takes. Anything unrecognised is left empty rather than guessed at: a wrong
// employment type decides notice periods and gratuity.
func normaliseEmployment(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "permanent", "regular", "confirmed":
		return "permanent"
	case "contract", "contractual":
		return "contract"
	case "probation", "probationary", "on probation":
		return "probation"
	case "part time", "part-time", "parttime":
		return "part_time"
	case "visiting", "guest", "guest faculty":
		return "visiting"
	}
	return ""
}

// staffStatusValue maps a status word onto what the column stores.
func staffStatusValue(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "inactive", "left", "resigned":
		return "resigned"
	case "retired":
		return "retired"
	case "terminated":
		return "terminated"
	case "on leave":
		return "on_leave"
	case "suspended":
		return "suspended"
	}
	return "active"
}

/*
staffRoleKey decides which workspace a member of staff is being given.

	The `role` column where the school wrote one of ours. Otherwise the post,
	which is the column every school's export actually carries: "Teacher",
	"Librarian", "Accountant", "PET". Matched on the words a post is written
	in rather than on the whole string, so "Sr. Teacher (Maths)" and "TGT
	Teacher" both land on faculty.

	Anything unrecognised returns nothing at all. A wrong role is worse than
	no role: no role shows somebody an empty product and is obviously
	unfinished, and a wrong one quietly hands them a workspace that is not
	theirs.
*/
func staffRoleKey(role, designation string) string {
	known := map[string]bool{
		"faculty": true, "hod": true, "class_teacher": true, "vice_principal": true,
		"institution_admin": true, "hr": true, "finance": true, "admissions": true,
		"librarian": true, "nurse": true, "counsellor": true, "front_office": true,
		"transport_manager": true, "driver": true, "hostel_warden": true,
		"exam_controller": true, "it_admin": true, "operations": true,
		"discipline_officer": true, "activity_coord": true, "board_member": true,
	}
	if k := strings.ToLower(strings.TrimSpace(role)); known[k] {
		return k
	}
	// Longest first, so "vice principal" is not read as "principal" and
	// "head of department" is not read as a plain teacher.
	byPost := []struct{ word, key string }{
		{"vice principal", "vice_principal"},
		{"head of department", "hod"},
		{"headmistress", "institution_admin"},
		{"headmaster", "institution_admin"},
		{"principal", "institution_admin"},
		{"class teacher", "faculty"},
		{"librarian", "librarian"},
		{"library", "librarian"},
		{"accountant", "finance"},
		{"accounts", "finance"},
		{"cashier", "finance"},
		{"admission", "admissions"},
		{"counsel", "counsellor"},
		{"nurse", "nurse"},
		{"warden", "hostel_warden"},
		{"driver", "driver"},
		{"transport", "transport_manager"},
		{"exam", "exam_controller"},
		{"receptionist", "front_office"},
		{"front office", "front_office"},
		{"clerk", "front_office"},
		{"office assistant", "front_office"},
		{"hr", "hr"},
		{"human resource", "hr"},
		{"system admin", "it_admin"},
		{"it admin", "it_admin"},
		{"teacher", "faculty"},
		{"lecturer", "faculty"},
		{"tutor", "faculty"},
		{"tgt", "faculty"},
		{"pgt", "faculty"},
		{"prt", "faculty"},
		{"pet", "faculty"},
	}
	post := strings.ToLower(strings.TrimSpace(designation))
	for _, m := range byPost {
		if strings.Contains(post, m.word) {
			return m.key
		}
	}
	return ""
}

/*
classTeacherIs reads the class-teacher column, which schools fill in two ways.

	Some name the person: an email, a staff code, "KODARI DIVYA". Others tick
	the row -- Yes, Y, TRUE, 1 -- meaning "the teacher named on this line is the
	class teacher of this section", which is the natural thing to write on a
	sheet that already has a teacher column beside it.

	The second was read as a name and looked up: "no member of staff called
	Yes". Fifteen rows of a hundred and seventy-one, and because a rejected row
	stops the whole file, none of the other hundred and fifty-six went in either.

	Returns the name to look up, and whether the row was ticked instead.
*/
func classTeacherIs(v string) (name string, ticked bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "yes", "y", "true", "1", "class teacher", "class-teacher":
		return "", true
	case "no", "n", "false", "0", "":
		return "", false
	}
	return strings.TrimSpace(v), false
}

func isStaffStatusWord(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "active", "inactive", "left", "resigned", "retired",
		"terminated", "on leave", "suspended":
		return true
	}
	return false
}

// intOrNil turns a blank column into NULL rather than into zero. A school that
// does not keep attendance totals must not have "0 of 0" printed against every
// child, which reads as a year in which nobody attended.
func intOrNil(v string) any {
	t := strings.TrimSpace(v)
	if t == "" {
		return nil
	}
	n, err := strconv.Atoi(strings.ReplaceAll(t, ",", ""))
	if err != nil {
		return nil
	}
	return n
}

// paiseOrNil reads rupees as they are written in a school's sheet -- 35500 or
// 35500.00 -- and stores paise, because every other amount in the system is
// paise and a second unit is how a fee becomes a hundredth of itself.
func paiseOrNil(v string) any {
	t := strings.TrimSpace(v)
	if t == "" {
		return nil
	}
	f, err := strconv.ParseFloat(strings.ReplaceAll(t, ",", ""), 64)
	if err != nil {
		return nil
	}
	return int64(math.Round(f * 100))
}

/*
columnMapFrom reads the column mapping a clerk chose on screen.

	Sent as a header rather than in the body because the body is the file, and
	a school's file is not ours to wrap in an envelope: it arrives as the CSV
	it is, so the same request works from a script, from curl, and from the
	screen.

	Absent means the file's own headers are the names, which is every upload
	made before this existed and every file written from our template.
*/
func columnMapFrom(r *http.Request) map[string]string {
	raw := strings.TrimSpace(r.Header.Get("X-Column-Map"))
	if raw == "" {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		// A malformed map is treated as no map rather than as an error: the
		// file is still readable by its own headers, and the required-column
		// check below will say what is missing in plain words.
		return nil
	}
	return m
}

/*
getImportFields lists what this importer can be given, so the screen can ask
somebody to point each one at a column of their own file.

	Required is the honest word: those are the fields a row cannot be built
	without, and the import refuses when nothing is pointed at them. Everything
	else may be left unmapped, and a school that does not keep blood groups
	does not have to invent a column to satisfy us.

	Nothing here is guessed on the school's behalf. A guessed mapping that is
	wrong is worse than no mapping at all: it imports, it reports success, and
	the error is found months later in a column nobody thought to check.
*/
func (s *Server) getImportFields(w http.ResponseWriter, r *http.Request) {
	entity := chiURLParam(r, "entity")

	// The students importer predates the shared one and has its own columns.
	if entity == "students" {
		httpx.JSON(w, http.StatusOK, map[string]any{"fields": studentImportFields()})
		return
	}
	spec, ok := importSpecs[entity]
	if !ok {
		httpx.BadRequest(w, r, "nothing can be imported as "+entity)
		return
	}
	if !httpx.IdentityFrom(r.Context()).Can(spec.Perm) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot import "+entity)
		return
	}
	required := map[string]bool{}
	for _, k := range spec.Required {
		required[k] = true
	}
	fields := make([]map[string]any, 0, len(spec.Columns))
	for i, c := range spec.Columns {
		f := map[string]any{"name": c, "required": required[c]}
		if i < len(spec.Sample) {
			f["example"] = spec.Sample[i]
		}
		fields = append(fields, f)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"fields": fields})
}

// sheetFacts is what one uploaded mark sheet says about itself.
type sheetFacts struct {
	year     string
	exam     string
	class    string
	maxMarks float64
}

/*
sheetFactsFrom reads them off the request rather than off every row.

	A grid mark sheet has no column for the exam or the class -- it is titled
	"Grade 5, Annual Examination" at the top and every cell below belongs to
	it. Asking for them once is both what the file looks like and what stops
	one mistyped row putting one child in a different class.
*/
func sheetFactsFrom(r *http.Request) sheetFacts {
	q := r.URL.Query()
	f := sheetFacts{
		year:  strings.TrimSpace(q.Get("year")),
		exam:  strings.TrimSpace(q.Get("exam")),
		class: strings.TrimSpace(q.Get("class")),
	}
	if v := strings.TrimSpace(q.Get("max_marks")); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			f.maxMarks = n
		}
	}
	return f
}

/*
subjectColumnsFrom picks the subject columns out of the column map.

	Which columns are subjects cannot be guessed: "Total", "Rank", "Remarks"
	and "Attendance" live in the same header row and are not subjects, and a
	guess that treats Total as a subject writes a child's total into a paper
	nobody sat. So the clerk says, one column at a time, with subject:<name>.
*/
func subjectColumnsFrom(r *http.Request) map[string]string {
	out := map[string]string{}
	for ours, theirs := range columnMapFrom(r) {
		if name, ok := strings.CutPrefix(ours, "subject:"); ok {
			if name = strings.TrimSpace(name); name != "" && strings.TrimSpace(theirs) != "" {
				out[name] = strings.TrimSpace(theirs)
			}
		}
	}
	return out
}

/*
writeSections creates the sections named beside a class on the same row.

	Separated by commas or spaces, because a school writes "A, B" and "A B" and
	should not have to learn which we wanted. Empty is allowed: a class with no
	sections yet is a real state, and inventing an "A" for it would put a
	section in the register that the school never asked for.

	Capacity defaults to 40 rather than to nothing. A section with no capacity
	can never be full, so the admissions screen cannot warn anybody, and the
	first a school hears of it is a forty-first child in a room of forty.
*/
func (c *importCtx) writeSections(row map[string]string, classID uuid.UUID) error {
	list := strings.TrimSpace(row["sections"])
	if list == "" {
		return nil
	}
	capacity := 40
	if v := strings.TrimSpace(strings.ReplaceAll(row["capacity"], ",", "")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			capacity = n
		}
	}
	/* The roll the school says this section has.

	   A pointer, so "not stated" and "stated as zero" stay different answers:
	   a section opened for next year genuinely has none, and blanking the
	   column on a re-upload should not record that as a claim of nought.

	   The strength on the class row applies to every section named on it,
	   which is right for the common sheet -- one line per class with its
	   sections listed -- and is why it is compared, never trusted. */
	var strength *int
	if v := strings.TrimSpace(strings.ReplaceAll(row["strength"], ",", "")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			strength = &n
		}
	}

	var yearID uuid.UUID
	if err := c.tx.QueryRow(c.r.Context(), `
		SELECT id FROM academic_years
		 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
		return errors.New("open the academic year before importing sections")
	}

	for _, raw := range strings.FieldsFunc(list, func(r rune) bool {
		return r == ',' || r == ';' || r == '/'
	}) {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		var secID uuid.UUID
		var fresh bool
		if err := c.tx.QueryRow(c.r.Context(), `
			INSERT INTO sections (institution_id, campus_id, class_id,
			                      academic_year_id, name, capacity, stated_strength)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			-- A re-upload corrects the capacity rather than failing, which is
			-- what somebody expects from editing a row they can see. The
			-- stated strength is only overwritten when the sheet carries one,
			-- so a later upload that leaves the column out does not erase what
			-- the school declared the first time.
			ON CONFLICT (class_id, academic_year_id, name)
			DO UPDATE SET capacity = EXCLUDED.capacity,
			              stated_strength = COALESCE(EXCLUDED.stated_strength,
			                                         sections.stated_strength)
			RETURNING id, xmax = 0`,
			c.inst, c.campus, classID, yearID, name, capacity, strength).Scan(&secID, &fresh); err != nil {
			return err
		}
		c.noteCreated("sections", secID, fresh)
	}
	return nil
}

// getBulkTemplate hands back a CSV with the headers and one filled example
// row, because an empty template is a puzzle about what the columns mean.
func (s *Server) getBulkTemplate(w http.ResponseWriter, r *http.Request) {
	entity := chiURLParam(r, "entity")
	spec, ok := importSpecs[entity]
	if !ok {
		httpx.BadRequest(w, r, "nothing can be imported as "+entity)
		return
	}
	if !httpx.IdentityFrom(r.Context()).Can(spec.Perm) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot import "+entity)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+entity+`-template.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(spec.Columns)
	if len(spec.Sample) == len(spec.Columns) {
		_ = cw.Write(spec.Sample)
	}
	cw.Flush()
}

// bulkImport validates a CSV and, on commit, writes it.
func (s *Server) bulkImport(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	entity := chiURLParam(r, "entity")
	spec, ok := importSpecs[entity]
	if !ok {
		httpx.BadRequest(w, r, "nothing can be imported as "+entity)
		return
	}
	if !id.Can(spec.Perm) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot import "+entity)
		return
	}
	commit := r.URL.Query().Get("commit") == "true"

	// 8 MB is a few thousand rows. Past that it is a data migration, which is
	// somebody sitting down with the database rather than a drag and drop.
	// Read once and parse from memory, because the file is wanted twice: to
	// import it, and to keep it against the history so somebody can open the
	// upload later and see what was actually in it.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		httpx.BadRequest(w, r, "could not read the file. Is it larger than 8 MB?")
		return
	}

	reader := csv.NewReader(bytes.NewReader(raw))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1 // ragged rows are reported per row, not fatal

	head, err := reader.Read()
	if err != nil {
		httpx.BadRequest(w, r, "that file has no header row")
		return
	}
	index := map[string]int{}
	for i, h := range head {
		index[normaliseHeader(h)] = i
	}
	/* THE SCHOOL'S COLUMN NAMES, NOT OURS.

	   Header matching only ever normalised case and spacing, so a sheet whose
	   column says "Adm No" where we say "admission_no" did not fail loudly --
	   it imported every child with a generated admission number instead,
	   because that column was simply not seen.

	   A mapping replaces the index outright rather than adding to it. Falling
	   back to a same-named column when a mapping exists would mean a field
	   somebody deliberately left unmapped could still be read from the file,
	   which is the opposite of what leaving it unmapped says. */
	if m := columnMapFrom(r); len(m) > 0 {
		remapped := map[string]int{}
		for ours, theirs := range m {
			if strings.TrimSpace(theirs) == "" {
				continue
			}
			if i, ok := index[normaliseHeader(theirs)]; ok {
				remapped[normaliseHeader(ours)] = i
				continue
			}
			// A column named by position rather than by header: see the
			// students importer, where the same rule is spelled out. Blank
			// and repeated headers are real and cannot be named any other way.
			t := strings.TrimSpace(theirs)
			if n, err := strconv.Atoi(strings.TrimPrefix(t, "#")); err == nil &&
				strings.HasPrefix(t, "#") && n >= 0 && n < len(head) {
				remapped[normaliseHeader(ours)] = n
			}
		}
		index = remapped
	}
	for _, need := range spec.Required {
		if _, ok := index[need]; !ok {
			httpx.BadRequest(w, r,
				"nothing is mapped to "+need+", and a row cannot be built without it. "+
					"Choose which of your columns holds it.")
			return
		}
	}

	type parsed struct {
		row  int
		data map[string]string
	}
	var rows []parsed
	out := importResult{DryRun: !commit, Problems: []importRow{}}

	for n := 2; ; n++ {
		rec, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			out.Total++
			out.Rejected++
			out.Problems = append(out.Problems, importRow{Row: n, Problem: "could not read this row: " + err.Error()})
			continue
		}
		data := map[string]string{}
		for col, i := range index {
			if i < len(rec) {
				data[col] = strings.TrimSpace(rec[i])
			}
		}
		// A trailing blank line is not a rejected row. Spreadsheets add them
		// and a report that calls them errors teaches people to ignore it.
		if allBlank(data) {
			continue
		}
		out.Total++

		missing := ""
		for _, need := range spec.Required {
			if data[need] == "" {
				missing = need
				break
			}
		}
		if missing != "" {
			out.Rejected++
			out.Problems = append(out.Problems, importRow{Row: n, Data: data, Problem: missing + " is required"})
			continue
		}
		if spec.Check != nil {
			if err := spec.Check(data); err != nil {
				out.Rejected++
				out.Problems = append(out.Problems, importRow{Row: n, Data: data, Problem: err.Error()})
				continue
			}
		}
		out.Valid++
		rows = append(rows, parsed{row: n, data: data})
	}

	/* The database-dependent checks, before the screen says "ready".

	   Runs on a dry run and on a commit alike: on a commit it is the same
	   answer a moment earlier, and the cost of asking twice is a few selects
	   against rows already in cache. */
	if spec.Verify != nil && len(rows) > 0 {
		verr := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			campus, err := ensureCampus(r, tx, id.InstitutionID)
			if err != nil {
				return err
			}
			ctx := &importCtx{r: r, tx: tx, inst: id.InstitutionID, campus: campus,
				sheet: sheetFactsFrom(r), subjectCols: subjectColumnsFrom(r),
				classes: map[string]uuid.UUID{}, server: s}
			for _, p := range rows {
				if err := spec.Verify(ctx, p.data); err != nil {
					out.Valid--
					out.Rejected++
					out.Problems = append(out.Problems,
						importRow{Row: p.row, Data: p.data, Problem: err.Error()})
				}
			}
			return nil
		})
		if verr != nil {
			httpx.Internal(w, r, verr)
			return
		}
		if out.Rejected > 0 {
			// Rebuilt so the rows that failed verification are not written on
			// a commit that got this far.
			kept := rows[:0]
			bad := map[int]bool{}
			for _, p := range out.Problems {
				bad[p.Row] = true
			}
			for _, p := range rows {
				if !bad[p.row] {
					kept = append(kept, p)
				}
			}
			rows = kept
		}
	}

	/* A bad row is a bad row, not a bad file.

	   This used to refuse the whole upload if any row failed, on the reasoning
	   that a partial import leaves the office reconciling what went in against
	   what did not. That reasoning holds for two schools and fails for the
	   rest: a sixty-row roll with one child whose section was typed "6A"
	   instead of "6-A" cannot be loaded at all, and the office has no way to
	   get the other fifty-nine in while somebody works out which. It also
	   makes the product the obstacle at exactly the moment a school is trying
	   to start using it.

	   So the good rows land and the rest are named, with the row number and
	   the reason. Nothing is silent: the count of what was skipped is returned
	   beside the count of what was written, and re-uploading the corrected
	   sheet updates rather than duplicates, because every importer upserts. */
	if !commit || len(rows) == 0 {
		httpx.JSON(w, http.StatusOK, out)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		ctx := &importCtx{r: r, tx: tx, inst: id.InstitutionID, campus: campus,
			sheet: sheetFactsFrom(r), subjectCols: subjectColumnsFrom(r),
			classes: map[string]uuid.UUID{}, server: s}

		var year uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).
			Scan(&year); err == nil {
			ctx.year = &year
		}

		/* Each row inside its own savepoint.

		   One row's failure used to abort the transaction, and with it every
		   row that had already succeeded. A savepoint per row means a row that
		   cannot be written is rolled back on its own and the file carries on
		   — which is the difference between "we could not load your sheet" and
		   "we loaded your sheet apart from row 14, which says this". */
		for _, p := range rows {
			sp, berr := tx.Begin(r.Context())
			if berr != nil {
				return berr
			}
			outer, madeSoFar := ctx.tx, len(ctx.created)
			ctx.tx = sp
			werr := spec.Write(ctx, p.data)
			ctx.tx = outer
			if werr != nil {
				_ = sp.Rollback(r.Context())
				// Anything the failed row claimed to have created went back
				// with it, so the undo record must not still name those rows.
				ctx.created = ctx.created[:madeSoFar]
				/* AND NEITHER MAY THE LOOKUP CACHES.

				   A row that creates something and then fails takes the thing
				   it created back with it, but the id stayed cached -- so
				   every later row pointed at a class, a year, a schedule or an
				   exam that no longer existed, and failed on a foreign key
				   naming a constraint rather than anything a school could act
				   on.

				   Found by committing a file rather than dry-running it: one
				   row named a class this school does not have, and the six
				   rows after it failed on a bell schedule that had been rolled
				   back underneath them. Cheap to clear and re-read; the cache
				   exists to save lookups, not correctness. */
				/* Cleared, not emptied -- and every reader creates the
				   map it needs, because a nil map reads fine and panics on
				   write. That distinction cost a 500 on the first commit
				   after this was added: the classes cache was cleared
				   correctly and the next lookup that found a class tried to
				   remember it. */
				ctx.classes = nil
				ctx.sections = nil
				ctx.teachers = nil
				ctx.pastYears = nil
				ctx.pastExams = nil
				out.Rejected++
				out.Problems = append(out.Problems,
					importRow{Row: p.row, Data: p.data, Problem: werr.Error()})
				continue
			}
			if cerr := sp.Commit(r.Context()); cerr != nil {
				return cerr
			}
			out.Imported++
		}

		/* The record of what was loaded, written in the same transaction as
		   the rows themselves.

		   Outside it, a failed import could still leave a log entry claiming
		   success -- which is worse than no log, because somebody would then
		   not re-import a file that never landed. */
		return recordImportRunFull(r, tx, id.InstitutionID, entity,
			r.URL.Query().Get("filename"), out.Total, out.Imported, out.Rejected,
			ctx.created, string(raw))
	})
	if err != nil {
		out.Imported = 0
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// normaliseHeader makes "Employee Code", "employee_code" and "EMPLOYEE CODE"
// the same column, because the sheet came from somebody else's software.
/* What the staff importer knows about, so everything else can be kept.

   Listed once rather than derived from the spec's Columns, because the two
   answer different questions: Columns is what the template offers, and this is
   what the writer above actually reads. A column added to one and not the
   other would silently start being stored twice. */
var staffKnownColumns = map[string]bool{
	"employee_code": true, "first_name": true, "last_name": true,
	"email": true, "phone": true, "designation": true, "role": true,
	"joined_on": true, "subjects": true,
}

// leftoverColumns is everything in the row this importer did not read, with
// blanks left out: an extra field that is empty on most people is a column of
// dashes on every record, which is worse than not having it.
func leftoverColumns(row map[string]string, known map[string]bool) map[string]string {
	out := map[string]string{}
	for k, v := range row {
		if known[k] {
			continue
		}
		if v = strings.TrimSpace(v); v != "" {
			out[k] = v
		}
	}
	return out
}

// jsonMap renders a flat map for a jsonb parameter.
func jsonMap(m map[string]string) []byte {
	b, err := json.Marshal(m)
	if err != nil {
		// A map[string]string cannot fail to marshal; an empty object is
		// still the safe thing to concatenate.
		return []byte("{}")
	}
	return b
}

func normaliseHeader(h string) string {
	// The byte order mark Excel writes is not whitespace, so TrimSpace
	// leaves it on the first column and that column stops matching its
	// own name.
	h = strings.TrimPrefix(h, "\ufeff")
	h = strings.ToLower(strings.TrimSpace(h))
	h = strings.ReplaceAll(h, " ", "_")
	h = strings.ReplaceAll(h, "-", "_")
	return strings.Trim(h, "_")
}

func allBlank(data map[string]string) bool {
	for _, v := range data {
		if v != "" {
			return false
		}
	}
	return true
}

// --- what was loaded, and by whom ----------------------------------------

// recordImportRun logs one committed import. Dry runs are deliberately not
// recorded: nothing happened, and a log full of things that did not happen is
// a log people stop reading.
func recordImportRun(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int) error {

	return recordImportRunWith(r, tx, inst, entity, filename, read, imported, rejected, nil)
}

// recordImportRunWith also remembers which records the import created, which
// is the whole of what makes undoing it possible.
func recordImportRunWith(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int, created []createdRow) error {
	return recordImportRunFull(r, tx, inst, entity, filename, read, imported, rejected, created, "")
}

// maxKeptImportBytes is how much of an uploaded file is kept for later
// reading. A class list is a few hundred kilobytes; a data migration is not
// something to hold a copy of in a text column, and half a file kept is worse
// than none because it reads as the whole one.
const maxKeptImportBytes = 1 << 20

// recordImportRunFull also keeps the file, so somebody can open the history
// later and see what was actually uploaded rather than only how many rows it
// had.
func recordImportRunFull(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int,
	created []createdRow, content string) error {

	kept := content
	omitted := false
	if len(kept) > maxKeptImportBytes {
		kept, omitted = "", true
	}

	var runID uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO import_runs (institution_id, entity, filename,
		                         rows_read, rows_imported, rows_rejected, imported_by,
		                         content, content_omitted)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,NULLIF($8,''),$9)
		RETURNING id`,
		inst, entity, strings.TrimSpace(filename), read, imported, rejected,
		httpx.IdentityFrom(r.Context()).UserID, kept, omitted).Scan(&runID); err != nil {
		return err
	}
	for _, c := range created {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO import_run_rows (run_id, institution_id, entity, record_id)
			VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
			runID, inst, c.entity, c.id); err != nil {
			return err
		}
	}
	return nil
}

type importRunRow struct {
	ID       string  `json:"id"`
	Entity   string  `json:"entity"`
	Filename *string `json:"filename,omitempty"`
	RowsRead int     `json:"rows_read"`
	Imported int     `json:"rows_imported"`
	Rejected int     `json:"rows_rejected"`
	By       *string `json:"imported_by,omitempty"`
	At       string  `json:"created_at"`
	UndoneAt *string `json:"undone_at,omitempty"`
	// Created counts what this upload brought into existence rather than
	// edited, which is the only part an undo can remove.
	Created int `json:"created_rows"`
}

/*
listImportRuns answers "has somebody already loaded this?"

	The question a school office asks when three people share the work and the
	second one is holding the same spreadsheet as the first. Every importer
	reported a count on screen and forgot it on refresh, so the honest answer
	was to go and look at the rows and guess.

	Newest first, and not narrowed by who did it: the point is to see the other
	person's upload, not your own.
*/
func (s *Server) listImportRuns(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT ir.id::text, ir.entity, ir.filename, ir.rows_read, ir.rows_imported,
		       ir.rows_rejected, u.full_name,
		       to_char(ir.created_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
		       to_char(ir.undone_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
		       (SELECT count(*) FROM import_run_rows w WHERE w.run_id = ir.id)::int
		  FROM import_runs ir
		  LEFT JOIN users u ON u.id = ir.imported_by
		 WHERE ($1::text IS NULL OR ir.entity = $1)
		 ORDER BY ir.created_at DESC
		 LIMIT 50`,
		[]any{nullString(r.URL.Query().Get("entity"))},
		func(rows pgx.Rows) (importRunRow, error) {
			var v importRunRow
			return v, rows.Scan(&v.ID, &v.Entity, &v.Filename, &v.RowsRead, &v.Imported,
				&v.Rejected, &v.By, &v.At, &v.UndoneAt, &v.Created)
		})
	respond(w, r, items, err)
}

// isYes and isNo read the Y/N, yes/no, true/false and 1/0 that a school's
// spreadsheet actually contains. Kept as two functions rather than one with a
// default, because "blank means yes" is right for a subject being scholastic
// and wrong for a period being a break.
func isYes(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "y", "yes", "true", "1":
		return true
	}
	return false
}

func isNo(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "n", "no", "false", "0":
		return true
	}
	return false
}

// sectionIDFor resolves "Grade 6" + "A" to a section, the same idea as
// classID and cached the same way.
func (c *importCtx) sectionIDFor(className, sectionName string) (uuid.UUID, error) {
	classID, err := c.classID(className)
	if err != nil {
		return uuid.Nil, err
	}
	key := strings.ToLower(strings.TrimSpace(className)) + "/" +
		strings.ToLower(strings.TrimSpace(sectionName))
	if c.sections == nil {
		c.sections = map[string]uuid.UUID{}
	}
	if id, ok := c.sections[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err = c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM sections
		  WHERE institution_id = $1 AND class_id = $2 AND lower(name) = $3
		  LIMIT 1`,
		c.inst, classID, strings.ToLower(strings.TrimSpace(sectionName))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("%s has no section %q. Create the sections first",
			className, sectionName)
	}
	if err != nil {
		return uuid.Nil, err
	}
	if c.sections == nil {
		c.sections = map[string]uuid.UUID{}
	}
	c.sections[key] = id
	return id, nil
}

// firstOf returns the first of several column names the file actually carries.
// Columns get renamed as they learn to accept more than they did; a sheet
// written against the older name has to go on working.
func firstOf(row map[string]string, names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(row[n]); v != "" {
			return v
		}
	}
	return ""
}

/*
blankWords are the ways a school writes "there isn't one" in a cell.

	A sheet came in with class_teacher: No against every Grade 1 row, and the
	import read "No" as somebody's name and failed the row for a member of
	staff who does not exist. The school had not made a mistake -- they had
	answered the question. Nobody leaves a cell empty in a printed register;
	they write No, or NA, or a dash, and the meaning is identical.

	Only ever applied to a column naming a person or a thing that may be
	absent. A subject called "None" would be nonsense, but a class teacher
	genuinely may not be appointed yet.
*/
var blankWords = map[string]bool{
	"no": true, "none": true, "nil": true, "na": true, "n/a": true,
	"-": true, "--": true, "not applicable": true, "not assigned": true,
	"nan": true, "null": true, "tbd": true, "to be decided": true,
	"vacant": true, "pending": true,
}

// optional reads a column that may legitimately be answered rather than left
// empty, and treats an answer of "none" as empty.
func optional(row map[string]string, names ...string) string {
	v := firstOf(row, names...)
	if blankWords[strings.ToLower(strings.TrimSpace(v))] {
		return ""
	}
	return v
}

/*
teacherByEmail finds the member of staff a spreadsheet names.

	Named for the address because that is all it once accepted, and that was
	the problem: the sheet a school keeps has the teacher's NAME in it, or the
	staff code the office uses -- not an email address. Requiring the address
	meant looking up forty of them by hand before a timetable could be
	uploaded, and the mapping screen offered "teacher email" and nothing else
	to point a column at.

	So it takes whichever of the three the school wrote, tried in order of how
	certainly they identify one person:

	  the email      exact, and unique by construction
	  the staff code exact, and unique within the school
	  the full name  matched case-insensitively, and refused when two people
	                 share it -- naming which two, because the school knows
	                 which one they meant and we cannot

	A name that matches two people is the one case worth failing on. Picking
	either would put a class on the wrong teacher's timetable, and nothing
	afterwards would look wrong.
*/
func (c *importCtx) teacherByEmail(who string) (uuid.UUID, error) {
	if c.teachers == nil {
		c.teachers = map[string]uuid.UUID{}
	}
	key := strings.ToLower(strings.TrimSpace(who))
	if key == "" {
		return uuid.Nil, errors.New("no teacher named")
	}
	if id, ok := c.teachers[key]; ok {
		return id, nil
	}

	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(), `
		SELECT u.id FROM users u
		 WHERE u.institution_id = $1 AND u.email = $2::citext`,
		c.inst, key).Scan(&id)

	if errors.Is(err, pgx.ErrNoRows) {
		// The staff code, which is what the office actually files people under.
		err = c.tx.QueryRow(c.r.Context(), `
			SELECT e.user_id FROM employees e
			 WHERE e.institution_id = $1 AND lower(e.employee_code) = $2
			   AND e.user_id IS NOT NULL`,
			c.inst, key).Scan(&id)
	}

	if errors.Is(err, pgx.ErrNoRows) {
		// The name, refused where it is ambiguous rather than guessed at.
		var n int
		if cerr := c.tx.QueryRow(c.r.Context(), `
			SELECT count(*)::int FROM employees e
			 WHERE e.institution_id = $1 AND e.user_id IS NOT NULL
			   AND lower(btrim(concat_ws(' ', e.first_name, e.last_name))) = $2`,
			c.inst, key).Scan(&n); cerr != nil {
			return uuid.Nil, cerr
		}
		if n > 1 {
			return uuid.Nil, fmt.Errorf(
				"%d members of staff are called %q, so this row could mean either. "+
					"Use their staff code or their email instead", n, who)
		}
		err = c.tx.QueryRow(c.r.Context(), `
			SELECT e.user_id FROM employees e
			 WHERE e.institution_id = $1 AND e.user_id IS NOT NULL
			   AND lower(btrim(concat_ws(' ', e.first_name, e.last_name))) = $2`,
			c.inst, key).Scan(&id)
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf(
			"no member of staff called %q, by email, staff code or name. "+
				"Import the staff first. Somebody with no email "+
				"has a record but no account, so nothing can be assigned to them",
			who)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.teachers[key] = id
	return id, nil
}

// splitSubjects reads the "MATH; SCI" a school writes in one column. Semicolon,
// comma or pipe, because a spreadsheet is written by a person and not a parser.
func splitSubjects(v string) []string {
	out := []string{}
	for _, raw := range strings.FieldsFunc(v, func(r rune) bool {
		return r == ';' || r == ',' || r == '|'
	}) {
		if t := strings.TrimSpace(raw); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// --- taking an import back out ---------------------------------------------

// undoableTables maps the entity names recorded against an import run to the
// tables they live in. A fixed list in code rather than trusting the column:
// the entity is written by this package and read back into a DELETE, and a
// table name interpolated from the database is the shape of a very bad day.
var undoableTables = map[string]string{
	"classes":   "classes",
	"sections":  "sections",
	"subjects":  "subjects",
	"periods":   "periods",
	"fee_heads": "fee_heads",
	"students":  "students",
	"staff":     "employees",
	// Undoing a fee structure upload removes the structures it created; the
	// priced lines under them go with the cascade, which is what a school
	// means by "take last year's fees off".
	"fee_structures": "fee_structures",
	/* The two that recorded nothing and so could never be undone.

	   Both are joins rather than things -- which subject a class studies, and
	   who teaches it in which section -- and both are safe to remove, because
	   nothing hangs off them that is not also a statement about teaching.
	   Their absence here was not a decision; they simply were not added when
	   undo was, and an upload of 139 allocations has been reporting "nothing
	   to remove" ever since. */
	"class_subjects": "class_subjects",
	"allocations":    "section_subject_teachers",
	// The closed-year records, which are the likeliest of all to be uploaded
	// wrongly: a school's first attempt at a history file usually is.
	"student_history": "student_year_history",
	"staff_history":   "employee_year_history",
	"marks":           "marks",
	"marks_grid":      "marks",
}

/*
Deleting a student cascades.

	Nearly forty tables reference students with ON DELETE CASCADE — marks,
	attendance, invoices, report cards, discipline records. That is right for a
	school removing a record deliberately and wrong for an undo, which would
	take a term's work with it without saying so.

	So a child is removed only while nothing has happened to them yet. The
	enrolment and the guardian the import itself created are expected and do
	not count; anything else means the school has begun using the record, and
	the row is kept and reported instead.
*/
const studentIsUntouched = `
	SELECT NOT EXISTS (SELECT 1 FROM student_attendance a WHERE a.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM marks m            WHERE m.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM invoices i         WHERE i.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM report_cards rc    WHERE rc.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM homework_submissions h WHERE h.student_id = $1)`

/*
permForImportEntity is the right an import of this kind needed.

	importSpecs covers the entities the shared importer handles. Students go in
	through their own endpoint and are not in that map, so looking their
	permission up there returned the empty string — and Can("") is false for
	everybody, including the principal who did the upload. Reading back or
	undoing a student import was refused to the one person certain to be
	allowed.

	Falling back to a deny would repeat that mistake for the next importer
	added outside the map, so an unknown entity resolves to the right that
	governs the records it would touch, and an entity with no answer at all is
	the only one refused.
*/
func permForImportEntity(entity string) string {
	if spec, ok := importSpecs[entity]; ok {
		return spec.Perm
	}
	switch entity {
	case "students":
		return rbac.StudentsWrite
	}
	return ""
}

type undoResult struct {
	Removed int      `json:"removed"`
	Kept    int      `json:"kept"`
	Reasons []string `json:"reasons"`
}

/*
undoImport deletes the records one upload created.

	Only the records it created. Every importer upserts, so a second upload of
	a corrected sheet edits rows that were already there, and undoing it must
	not remove a class the school typed in by hand in March.

	Rows that something else now depends on are kept rather than cascaded. A
	section with children enrolled in it is not an accident of the import any
	more, and deleting it to satisfy an undo would take the enrolments with it.
	The count of what was kept, and why, is returned rather than swallowed —
	an undo that silently does half its job is worse than one that refuses.
*/
func (s *Server) undoImport(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid import id")
		return
	}

	var out undoResult
	out.Reasons = []string{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var entity string
		var undone *time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT entity, undone_at FROM import_runs WHERE id = $1`, runID).
			Scan(&entity, &undone); err != nil {
			return err
		}
		if undone != nil {
			return errAlreadyUndone
		}
		need := permForImportEntity(entity)
		if need == "" || !id.Can(need) {
			return errNotYours
		}

		rows, err := tx.Query(r.Context(),
			`SELECT entity, record_id FROM import_run_rows WHERE run_id = $1`, runID)
		if err != nil {
			return err
		}
		type target struct {
			entity string
			id     uuid.UUID
		}
		var targets []target
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.entity, &t.id); err != nil {
				rows.Close()
				return err
			}
			targets = append(targets, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, t := range targets {
			table, ok := undoableTables[t.entity]
			if !ok {
				out.Kept++
				continue
			}
			/* A member of staff who has started work is not just a row this
			   file created either. Deleting an employee takes their leave,
			   their payroll and their timetable with it, so anybody holding a
			   class or a section is kept. */
			if t.entity == "staff" {
				var busy bool
				if err := tx.QueryRow(r.Context(), `
					SELECT EXISTS (SELECT 1 FROM section_subject_teachers t
					                JOIN employees e ON e.user_id = t.teacher_user_id
					               WHERE e.id = $1)
					    OR EXISTS (SELECT 1 FROM sections s
					                JOIN employees e ON e.user_id = s.class_teacher_id
					               WHERE e.id = $1)`, t.id).Scan(&busy); err != nil {
					return err
				}
				if busy {
					out.Kept++
					if len(out.Reasons) < 5 {
						out.Reasons = append(out.Reasons,
							"a teacher is assigned to a class or subject and was left alone")
					}
					continue
				}
			}

			// A child who has been marked present, examined or invoiced is no
			// longer just a row this file created.
			if t.entity == "students" {
				var untouched bool
				if err := tx.QueryRow(r.Context(), studentIsUntouched, t.id).Scan(&untouched); err != nil {
					return err
				}
				if !untouched {
					out.Kept++
					if len(out.Reasons) < 5 {
						out.Reasons = append(out.Reasons,
							"a child already has attendance, marks or fees recorded and was left alone")
					}
					continue
				}
			}
			// A savepoint per row, so one row held back by a foreign key does
			// not abort the transaction and lose the rest of the undo.
			if _, err := tx.Exec(r.Context(), "SAVEPOINT undo_row"); err != nil {
				return err
			}
			_, derr := tx.Exec(r.Context(),
				"DELETE FROM "+table+" WHERE id = $1", t.id)
			if derr != nil {
				if _, err := tx.Exec(r.Context(), "ROLLBACK TO SAVEPOINT undo_row"); err != nil {
					return err
				}
				out.Kept++
				if len(out.Reasons) < 5 {
					out.Reasons = append(out.Reasons,
						"one "+t.entity+" row is still in use and was left alone")
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), "RELEASE SAVEPOINT undo_row"); err != nil {
				return err
			}
			out.Removed++
		}

		/* UNDONE ONLY IF SOMETHING WAS ACTUALLY UNDONE.

		   Marked rather than deleted: "loaded and then undone" is a different
		   fact from "never loaded", and an empty history says the second.

		   But it was stamped whatever happened, including when every row was
		   held back as in use. So pressing delete on nine staff who all teach
		   a class removed none of them, marked the upload undone, and took the
		   link away -- and from the other side of the screen that is a delete
		   button that does nothing and then disappears. The rows are still
		   there, the history says they are gone, and there is no second try.

		   A run that gave nothing up is left exactly as it was, so it can be
		   pressed again once whatever holds those rows has been dealt with. */
		if out.Removed == 0 {
			return nil
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE import_runs SET undone_at = now(), undone_by = $2 WHERE id = $1`,
			runID, id.UserID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errAlreadyUndone):
		httpx.BadRequest(w, r, "that upload has already been undone")
		return
	case errors.Is(err, errNotYours):
		httpx.Forbidden(w, r, "undoing this kind of import")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

var (
	errAlreadyUndone = errStr("already undone")
	errNotYours      = errStr("not permitted")
)

/*
getImportContent hands back the file one upload was made from.

	The history could say that 4-staff.csv added ten rows and never say which
	ten. That is the question anybody actually has when they open it — usually
	because something looks wrong and they want to compare the sheet against
	what is now in the school.

	Returned as the CSV it was, not as a rendering of it. The screen parses it
	with the same code it uses for a file being dropped, so what is shown here
	and what was shown then are the same table by construction rather than by
	two pieces of code agreeing.
*/
func (s *Server) getImportContent(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid import id")
		return
	}

	var (
		entity   string
		filename *string
		content  *string
		omitted  bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT entity, filename, content, content_omitted
			  FROM import_runs WHERE id = $1`, runID).
			Scan(&entity, &filename, &content, &omitted)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// The same right the import needed. Reading back a staff sheet is reading
	// staff records, whatever route it arrives by.
	need := permForImportEntity(entity)
	if need == "" || !id.Can(need) {
		httpx.Forbidden(w, r, "reading this upload")
		return
	}

	body := ""
	if content != nil {
		body = *content
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"entity":   entity,
		"filename": filename,
		"content":  body,
		// Told apart on purpose: a file too large to keep is not an empty
		// file, and an empty table would say the second.
		"omitted": omitted,
	})
}
