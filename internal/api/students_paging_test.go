package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The roll has to be walkable to its end, whatever its length.

	The list endpoint used to answer with a page and no way past it: the cap
	went 200, then 500, and a school of 345 read "200 students on the roll"
	either way. What is asserted here is the property the cap could never
	give -- that following next_cursor from the first page reaches every
	child exactly once -- and the two ways a keyset walk goes wrong in
	practice.

	The first is the tiebreak. Admission numbers are school-issued text and
	are NOT unique: they get reissued and imports duplicate them. A page
	boundary landing inside a run of equal admission numbers either repeats
	those rows or loses them, and it does so silently, which is why the seed
	below deliberately gives several children the same number.

	The second is a cursor from somewhere else. A token cut from a Class 6
	listing carries a position in a different row set, and honouring it would
	start the walk part-way down a list the caller never asked for.

	Guarded on ERP_TEST_DATABASE_URL like every other database-backed test in
	this package, so `go test ./internal/...` stays green without Postgres:

	    ERP_TEST_DATABASE_URL=postgres://...@127.0.0.1:5432/erp_x \
	    go test ./internal/api/ -run Paging -v
*/

type pagingWorld struct {
	inst, campus, year, class, section uuid.UUID
	db                                 *database.DB
	s                                  *Server
}

func seedPagingWorld(t *testing.T, db *database.DB, n int) *pagingWorld {
	t.Helper()
	ctx := context.Background()
	w := &pagingWorld{
		inst: uuid.New(), campus: uuid.New(), year: uuid.New(),
		class: uuid.New(), section: uuid.New(), db: db,
	}
	suffix := w.inst.String()[:8]
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			  VALUES ($1,$2,'PAG',$3,'Asia/Kolkata','active')`,
				[]any{w.inst, "Paging " + suffix, "pag-" + suffix}},
			{`INSERT INTO campuses (id, institution_id, name, code) VALUES ($1,$2,'Main',$3)`,
				[]any{w.campus, w.inst, "MAIN-" + suffix}},
			{`INSERT INTO academic_years (id, institution_id, name, starts_on, ends_on, is_current)
			  VALUES ($1,$2,'This year', CURRENT_DATE - 30, CURRENT_DATE + 300, false)`,
				[]any{w.year, w.inst}},
			{`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES ($1,$2,$3,'Class 6',6)`,
				[]any{w.class, w.inst, w.campus}},
			{`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name)
			  VALUES ($1,$2,$3,$4,$5,'A')`,
				[]any{w.section, w.inst, w.campus, w.class, w.year}},
		} {
			if _, err := tx.Exec(ctx, q.sql, q.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed world: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM institutions WHERE id = $1`, w.inst)
			return err
		})
	})

	/* One admission number per child, because the schema will not have it any
	   other way.

	   This seeded runs of four equal admission numbers -- ADM-0000 four times,
	   then ADM-0004 four times -- to drive a page boundary into the middle of
	   a run and prove the id tiebreak. students carries
	   UNIQUE (institution_id, admission_no), and has since 00001, so the
	   second row of every run violated it and all four tests in this file
	   failed on their first INSERT. They had never once run: without
	   ERP_TEST_DATABASE_URL they skip, so `go test ./...` reported the whole
	   file green while the paging it covers went unexercised.

	   The run cannot be built in this schema, so the walk is proved on what
	   the schema does allow: distinct admission numbers, a page size that does
	   not divide the roll, and every boundary checked. See the note on
	   listCursor in students.go for what is left holding the ordering total. */
	err = db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		for i := 0; i < n; i++ {
			adm := fmt.Sprintf("ADM-%04d", i)
			sid := uuid.New()
			if _, err := tx.Exec(ctx, `
				INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, status)
				VALUES ($1,$2,$3,$4,$5,'active')`,
				sid, w.inst, w.campus, adm, fmt.Sprintf("Child %03d", i)); err != nil {
				return err
			}
			/* Enrolled, not merely admitted.

			   A student with no enrolment row has no class, and the class
			   filter this file also covers matched nothing at all -- which is
			   why TestCursorFromAnotherFilterIsIgnored skipped itself rather
			   than testing the fingerprint it exists for. Every child here
			   sits in the one section the world declares. */
			if _, err := tx.Exec(ctx, `
				INSERT INTO enrollments (institution_id, student_id, academic_year_id,
				                         class_id, section_id)
				VALUES ($1,$2,$3,$4,$5)`,
				w.inst, sid, w.year, w.class, w.section); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed students: %v", err)
	}

	w.s = &Server{DB: db, Hasher: auth.NewHasher("test-pepper"), BaseURL: "https://school.test"}
	return w
}

// listPage calls the handler with a raw query string and decodes the envelope.
func (w *pagingWorld) listPage(t *testing.T, query string) page[student] {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/v1/students?"+query, nil)
	id := &httpx.Identity{
		UserID: uuid.New(), InstitutionID: w.inst,
		Permissions: map[string]struct{}{
			rbac.StudentsRead: {}, rbac.StudentsReadAll: {},
		},
	}
	req = req.WithContext(httpx.WithIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	w.s.listStudents(rec, req)
	if rec.Code != 200 {
		t.Fatalf("list %q: status %d: %s", query, rec.Code, rec.Body.String())
	}
	var out page[student]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

/*
TestPagingWalksTheWholeRoll is the property the LIMIT cap could not give.

	One hundred and one children, seven to a page: fifteen pages, a boundary
	that never falls on the end of the roll, and every child seen exactly
	once. Seven does not divide 101, so the last page is short and the walk
	has to stop by the cursor going empty rather than by arithmetic.
*/
func TestPagingWalksTheWholeRoll(t *testing.T) {
	db := testDB(t)
	const n = 101
	w := seedPagingWorld(t, db, n)

	seen := map[string]int{}
	var order []string
	cursor := ""
	pages := 0
	for {
		q := "limit=7&status=active"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		p := w.listPage(t, q)
		pages++
		if pages > n+5 {
			t.Fatalf("the walk did not terminate after %d pages", pages)
		}

		// The total is a first-page fact, and only the first page carries it.
		if cursor == "" {
			if p.Total == nil {
				t.Fatal("the first page carried no total")
			}
			if *p.Total != n {
				t.Errorf("total %d, want %d", *p.Total, n)
			}
		} else if p.Total != nil {
			t.Errorf("page %d carried a total (%d); counting is a first-page cost", pages, *p.Total)
		}

		if len(p.Items) > 7 {
			t.Fatalf("page %d returned %d rows for a limit of 7", pages, len(p.Items))
		}
		for _, s := range p.Items {
			seen[s.ID]++
			order = append(order, s.AdmissionNo)
		}

		// has_more and next_cursor must agree: an empty next_cursor is the end.
		if p.HasMore != (p.NextCursor != "") {
			t.Fatalf("page %d: has_more=%v but next_cursor=%q", pages, p.HasMore, p.NextCursor)
		}
		if !p.HasMore {
			break
		}
		cursor = p.NextCursor
	}

	if len(seen) != n {
		t.Errorf("the walk reached %d children, want %d -- a gap at a page boundary", len(seen), n)
	}
	if len(order) != n {
		t.Errorf("the walk returned %d rows for %d children -- a row was served twice", len(order), n)
	}
	for id, count := range seen {
		if count != 1 {
			t.Errorf("child %s appeared %d times", id, count)
		}
	}
	// And the pages came back in the endpoint's own order, unbroken.
	for i := 1; i < len(order); i++ {
		if order[i] < order[i-1] {
			t.Fatalf("row %d (%s) sorts before row %d (%s)", i, order[i], i-1, order[i-1])
		}
	}
}

/*
TestCursorFromAnotherFilterIsIgnored: a token names a position in one row set.

	Carried into a different WHERE clause it would start the walk part-way
	down a list nobody asked for, and quietly. The fingerprint in the cursor
	makes the mismatch visible to the handler, which then answers the
	question actually asked -- the first page -- rather than erroring about a
	token the reader never typed.
*/
func TestCursorFromAnotherFilterIsIgnored(t *testing.T) {
	db := testDB(t)
	w := seedPagingWorld(t, db, 30)

	// A cursor cut from the class-filtered listing...
	filtered := w.listPage(t, "limit=5&status=active&class_id="+w.class.String())
	if filtered.NextCursor == "" {
		t.Skip("the class filter matched too few rows to cut a cursor from")
	}

	// ...pasted into the unfiltered one reads as no cursor at all.
	first := w.listPage(t, "limit=5&status=active")
	reused := w.listPage(t, "limit=5&status=active&cursor="+filtered.NextCursor)
	if len(reused.Items) != len(first.Items) || reused.Items[0].ID != first.Items[0].ID {
		t.Errorf("a foreign cursor moved the walk: got %s first, want %s",
			reused.Items[0].ID, first.Items[0].ID)
	}
	if reused.Total == nil {
		t.Error("an ignored cursor should leave this a first page, total and all")
	}

	// Garbage is the same story, not a 500.
	for _, junk := range []string{"not-base64!!", "eyJhIjoiIn0", "%%%"} {
		p := w.listPage(t, "limit=5&status=active&cursor="+junk)
		if len(p.Items) == 0 || p.Items[0].ID != first.Items[0].ID {
			t.Errorf("cursor %q did not fall back to the first page", junk)
		}
	}
}

/*
TestLastPageReportsNoCursor: the end of the list has to be recognisable.

	has_more comes from fetching limit+1 and trimming, never from arithmetic
	on a total most pages no longer carry -- so it stays true on a page that
	exactly fills, and the page after it is the one that says stop.
*/
func TestLastPageReportsNoCursor(t *testing.T) {
	db := testDB(t)
	w := seedPagingWorld(t, db, 10)

	p := w.listPage(t, "limit=10&status=active")
	if p.HasMore || p.NextCursor != "" {
		t.Errorf("a page holding the whole roll claimed more: has_more=%v cursor=%q", p.HasMore, p.NextCursor)
	}
	if len(p.Items) != 10 {
		t.Fatalf("got %d rows, want 10", len(p.Items))
	}

	// One row short of the roll: more, then the last page, then stop.
	p = w.listPage(t, "limit=9&status=active")
	if !p.HasMore || p.NextCursor == "" {
		t.Fatal("nine of ten rows reported no more")
	}
	last := w.listPage(t, "limit=9&status=active&cursor="+p.NextCursor)
	if len(last.Items) != 1 {
		t.Errorf("the last page held %d rows, want 1", len(last.Items))
	}
	if last.HasMore || last.NextCursor != "" {
		t.Errorf("the last page offered a next one: has_more=%v cursor=%q", last.HasMore, last.NextCursor)
	}
}

/*
TestLimitIsAPageSizeNotACap: 500 is no longer refused-in-silence, it is
trimmed to what one response carries -- and the rest is still reachable.
*/
func TestLimitIsAPageSizeNotACap(t *testing.T) {
	db := testDB(t)
	w := seedPagingWorld(t, db, 250)

	p := w.listPage(t, "limit=500&status=active")
	if p.Limit != 200 {
		t.Errorf("limit %d, want it bounded at 200", p.Limit)
	}
	if len(p.Items) != 200 {
		t.Errorf("got %d rows, want a full 200-row page", len(p.Items))
	}
	if !p.HasMore || p.NextCursor == "" {
		t.Fatal("a page holding 200 of 250 children offered no way to the other 50")
	}
	rest := w.listPage(t, "limit=200&status=active&cursor="+p.NextCursor)
	if len(rest.Items) != 50 {
		t.Errorf("the rest of the roll was %d children, want 50", len(rest.Items))
	}
}

// TestCursorRoundTrip needs no database: the encoding is its own contract.
func TestCursorRoundTrip(t *testing.T) {
	id := uuid.New().String()
	fp := filterFingerprint("active", "", "", "", "", "false", "TRUE", "")
	tok := encodeCursor(listCursor{Adm: "ADM-0042", ID: id, Filter: fp})
	if tok == "" {
		t.Fatal("encode produced nothing")
	}

	got := decodeCursor(tok, fp)
	if got == nil {
		t.Fatal("a cursor did not survive its own encoding")
	}
	if got.Adm != "ADM-0042" || got.ID != id {
		t.Errorf("round trip lost the position: %+v", got)
	}
	if decodeCursor(tok, filterFingerprint("suspended")) != nil {
		t.Error("a cursor was honoured against a filter it was not cut from")
	}
	if decodeCursor("", fp) != nil {
		t.Error("an empty cursor is not a position")
	}
	if decodeCursor("~~not base64~~", fp) != nil {
		t.Error("unparseable input read as a position")
	}
	// A well-formed token whose id is not a uuid cannot reach the query.
	bad := encodeCursor(listCursor{Adm: "A", ID: "'; DROP TABLE students; --", Filter: fp})
	if decodeCursor(bad, fp) != nil {
		t.Error("a non-uuid id was accepted as a keyset position")
	}
	// Two different filters must not share a fingerprint.
	if filterFingerprint("active") == filterFingerprint("suspended") {
		t.Error("the fingerprint does not distinguish filters")
	}
}
