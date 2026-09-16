package main

// Create Yajur's FA/SA exam records from the school's schedule, one paper per
// class-subject, using the default (CBSE) grade scale. FA out of 50 (the
// school's figure); SA out of the marks passed on the command line (default
// 80). Report by default; -write applies. Skips an exam that already exists.

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

type ex struct {
	name, kind, from, to string
	max                  int
}

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	saMarks := flag.Int("sa", 80, "max marks for the summative (SA) exams")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	var year, campus, scale string
	if e := c.QueryRow(ctx, `SELECT id::text FROM academic_years WHERE institution_id=$1 AND is_current`, inst).Scan(&year); e != nil {
		fmt.Println("current year:", e); os.Exit(1)
	}
	if e := c.QueryRow(ctx, `SELECT campus_id::text FROM sections WHERE institution_id=$1 LIMIT 1`, inst).Scan(&campus); e != nil {
		fmt.Println("campus:", e); os.Exit(1)
	}
	if e := c.QueryRow(ctx, `SELECT id::text FROM grading_scales WHERE institution_id=$1 AND is_default LIMIT 1`, inst).Scan(&scale); e != nil {
		fmt.Println("default grade scale:", e); os.Exit(1)
	}

	exams := []ex{
		{"FA-1", "formative", "2026-07-20", "2026-07-22", 50},
		{"FA-2", "formative", "2026-08-20", "2026-08-22", 50},
		{"SA-1", "summative", "2026-10-05", "2026-10-10", *saMarks},
		{"FA-3", "formative", "2026-12-03", "2026-12-05", 50},
		{"FA-4", "formative", "2027-01-07", "2027-01-09", 50},
		{"SA-2", "summative", "2027-02-20", "2027-02-26", *saMarks},
	}

	var subjects int
	c.QueryRow(ctx, `SELECT count(*) FROM class_subjects WHERE institution_id=$1`, inst).Scan(&subjects)
	fmt.Printf("class-subjects that will each get a paper: %d\n\n", subjects)

	tx, _ := c.Begin(ctx); defer tx.Rollback(ctx)
	made, skipped := 0, 0
	for _, x := range exams {
		var exists bool
		tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM exams WHERE institution_id=$1 AND academic_year_id=$2 AND name=$3)`, inst, year, x.name).Scan(&exists)
		pass := int(float64(x.max)*0.33 + 0.5)
		if pass < 1 { pass = 1 }
		fmt.Printf("  %-5s %-9s %s..%s  out of %d (pass %d)  %s\n", x.name, x.kind, x.from, x.to, x.max, pass,
			func() string { if exists { skipped++; return "EXISTS - skip" }; made++; return "create" }())
		if !*write || exists { continue }
		var exID string
		if err := tx.QueryRow(ctx, `INSERT INTO exams (institution_id,campus_id,academic_year_id,name,kind,starts_on,ends_on,grading_scale_id)
			VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8) RETURNING id::text`,
			inst, campus, year, x.name, x.kind, x.from, x.to, scale).Scan(&exID); err != nil {
			fmt.Println("exam:", err); os.Exit(1)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO exam_subjects (institution_id,exam_id,class_subject_id,exam_date,max_marks,pass_marks)
			SELECT $1,$2,cs.id,$5::date,$3,$4 FROM class_subjects cs WHERE cs.institution_id=$1`,
			inst, exID, x.max, pass, x.from); err != nil {
			fmt.Println("papers:", err); os.Exit(1)
		}
	}
	fmt.Printf("\n%d to create, %d already exist\n", made, skipped)
	if !*write { fmt.Println("REPORT ONLY. Re-run with -write (and -sa <marks> for SA)."); return }
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Println("COMMITTED.")
}
