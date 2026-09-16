package main

// Grade 1 has one real section (BODHA, all the students) and one empty
// duplicate (HITHA). The school wants a single, plainly named section.
// This renames the real one to "A", makes KODARI DIVYA its class teacher,
// and deletes the empty HITHA. Report by default; -write applies.

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"
const divya = "YPS59100046" // KODARI DIVYA

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	type sec struct{ id, name string; enrolled int }
	var secs []sec
	rows, err := c.Query(ctx, `
		SELECT sec.id::text, sec.name, (SELECT count(*) FROM enrollments en WHERE en.section_id=sec.id)
		  FROM sections sec JOIN classes cl ON cl.id=sec.class_id
		 WHERE sec.institution_id=$1 AND cl.name='Grade 1' ORDER BY sec.name`, inst)
	if err != nil { fmt.Println(err); os.Exit(1) }
	for rows.Next() { var s sec; rows.Scan(&s.id, &s.name, &s.enrolled); secs = append(secs, s) }
	rows.Close()

	var keep, drop *sec
	for i := range secs {
		if secs[i].enrolled > 0 { keep = &secs[i] } else { drop = &secs[i] }
	}
	fmt.Println("Grade 1 sections:")
	for _, s := range secs { fmt.Printf("  %-8s enrolled=%d\n", s.name, s.enrolled) }
	if keep == nil { fmt.Println("no section with students — aborting"); os.Exit(1) }
	fmt.Printf("\nPLAN: rename %q -> \"A\" (keeps %d students), set class teacher KODARI DIVYA",
		keep.name, keep.enrolled)
	if drop != nil { fmt.Printf(", delete empty %q", drop.name) }
	fmt.Println()

	var uid string
	if e := c.QueryRow(ctx, `SELECT COALESCE(user_id::text,'') FROM employees WHERE institution_id=$1 AND employee_code=$2`, inst, divya).Scan(&uid); e != nil || uid == "" {
		fmt.Println("KODARI DIVYA has no login — cannot set class teacher"); os.Exit(1)
	}

	if !*write { fmt.Println("\nREPORT ONLY. Re-run with -write to apply."); return }

	tx, _ := c.Begin(ctx); defer tx.Rollback(ctx)
	if drop != nil {
		if _, err := tx.Exec(ctx, `UPDATE sections SET class_teacher_id=NULL WHERE id=$1`, drop.id); err != nil { fmt.Println(err); os.Exit(1) }
		if _, err := tx.Exec(ctx, `DELETE FROM sections WHERE id=$1`, drop.id); err != nil { fmt.Println("delete:", err); os.Exit(1) }
	}
	// move DIVYA off any other section, then onto this one
	if _, err := tx.Exec(ctx, `UPDATE sections SET class_teacher_id=NULL WHERE class_teacher_id=$1 AND id<>$2`, uid, keep.id); err != nil { fmt.Println(err); os.Exit(1) }
	if _, err := tx.Exec(ctx, `UPDATE sections SET class_teacher_id=$2 WHERE id=$1`, keep.id, uid); err != nil { fmt.Println(err); os.Exit(1) }
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Println("\nDONE: Grade 1 now one section (BODHA) with KODARI DIVYA; empty section removed.")
}
