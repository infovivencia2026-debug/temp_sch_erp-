package main

// Create the CBSE-style grade scale for Yajur (by percentage, so it applies to
// any exam whatever the max marks). Report by default; -write applies.

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

// grade, min%, max%, grade_point (nil for E)
type band struct {
	grade    string
	min, max float64
	point    *float64
}

func pt(v float64) *float64 { return &v }

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	bands := []band{
		{"A1", 91, 100, pt(10)}, {"A2", 81, 90, pt(9)}, {"B1", 71, 80, pt(8)},
		{"B2", 61, 70, pt(7)}, {"C1", 51, 60, pt(6)}, {"C2", 41, 50, pt(5)},
		{"D", 33, 40, pt(4)}, {"E", 0, 32, nil},
	}

	var existing int
	c.QueryRow(ctx, `SELECT count(*) FROM grading_scales WHERE institution_id=$1`, inst).Scan(&existing)
	fmt.Printf("existing grading scales: %d\n\nPLAN: create \"CBSE Grade Scale\" (default) with:\n", existing)
	for _, b := range bands {
		p := "-"
		if b.point != nil { p = fmt.Sprintf("%.0f", *b.point) }
		fmt.Printf("  %-3s %3.0f-%-3.0f  point=%s\n", b.grade, b.min, b.max, p)
	}
	if !*write { fmt.Println("\nREPORT ONLY. Re-run with -write to apply."); return }

	tx, _ := c.Begin(ctx); defer tx.Rollback(ctx)
	// default only if none exists yet
	def := existing == 0
	var sid string
	if err := tx.QueryRow(ctx, `INSERT INTO grading_scales (institution_id,name,is_default)
		VALUES ($1,'CBSE Grade Scale',$2) RETURNING id::text`, inst, def).Scan(&sid); err != nil {
		fmt.Println("scale:", err); os.Exit(1)
	}
	for _, b := range bands {
		if _, err := tx.Exec(ctx, `INSERT INTO grade_bands
			(institution_id,grading_scale_id,grade,min_percent,max_percent,grade_point)
			VALUES ($1,$2,$3,$4,$5,$6)`, inst, sid, b.grade, b.min, b.max, b.point); err != nil {
			fmt.Println("band", b.grade, err); os.Exit(1)
		}
	}
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Printf("\nCOMMITTED grade scale with %d bands (default=%v).\n", len(bands), def)
}
