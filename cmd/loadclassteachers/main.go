package main

// Grade teachers from the allotment sheet -> sections.class_teacher_id.
// Report by default; -write applies. One teacher, one section (moves them).

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

// class, section, teacher employee_code
var rows = [][3]string{
	{"Grade 2", "HITHA", "YPS59100038"}, // HEMLATHA AGARWAL (II H)
	{"Grade 2", "BODHA", "YPS59100048"}, // NAVYA EEDA (II B)
	{"Grade 3", "HITHA", "YPS59100035"}, // NEHA AGARWAL (III H)
	{"Grade 3", "BODHA", "YPS59100052"}, // SOMISHETTI KAVYA (III B)
	{"Grade 4", "HITHA", "YPS59100031"}, // ASAM SRUJANA (IV H)
	{"Grade 4", "BODHA", "YPS59100003"}, // NISHA PAGARE (IV B)
	{"Grade 5", "HITHA", "YPS59100017"}, // ARSHI NAAZ (V H)
	{"Grade 5", "BODHA", "YPS59100016"}, // KADIDELA BENS SRIDEVI (V B)
	{"Grade 6", "HITHA", "YPS59100028"}, // ZAREENA SULTHANA (VI)
	{"Grade 7", "HITHA", "YPS59100054"}, // JATTY JYOTHIRMAYI (VII)
	{"Grade 8", "HITHA", "YPS59100058"}, // EMMADI ANUSHA (VIII)
	{"Grade 9", "HITHA", "YPS59100039"}, // DHEEPIKA THUMMANAPELLI (IX)
}

func main() {
	write := flag.Bool("write", false, "apply (default: report only)")
	flag.Parse()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil { fmt.Println("connect:", err); os.Exit(1) }
	defer c.Close(ctx)

	type res struct{ cls, sec, code, tname, secID, uid, note string }
	var out []res
	bad := 0
	for _, r := range rows {
		var re res
		re.cls, re.sec, re.code = r[0], r[1], r[2]
		// teacher + login
		err := c.QueryRow(ctx, `SELECT btrim(concat_ws(' ',first_name,last_name)), COALESCE(user_id::text,'')
		  FROM employees WHERE institution_id=$1 AND employee_code=$2`, inst, re.code).Scan(&re.tname, &re.uid)
		if err != nil { re.note = "TEACHER NOT FOUND"; bad++; out = append(out, re); continue }
		if re.uid == "" { re.note = "NO LOGIN (cannot be class teacher)"; bad++ }
		// section
		if e := c.QueryRow(ctx, `SELECT sec.id::text FROM sections sec JOIN classes cl ON cl.id=sec.class_id
		  WHERE sec.institution_id=$1 AND cl.name=$2 AND sec.name=$3`, inst, re.cls, re.sec).Scan(&re.secID); e != nil {
			re.note = "SECTION NOT FOUND"; bad++
		}
		out = append(out, re)
	}

	fmt.Printf("=== GRADE TEACHERS (%d rows) ===\n", len(out))
	for _, r := range out {
		fmt.Printf("  %-9s %-7s <- %-26s %-13s %s\n", r.cls, r.sec, r.tname, r.code,
			func() string { if r.note != "" { return "!! " + r.note }; return "ok" }())
	}
	if !*write { fmt.Printf("\nREPORT ONLY. %d problem(s). Re-run with -write when clean.\n", bad); return }
	if bad > 0 { fmt.Printf("\nREFUSING to write: %d problem(s).\n", bad); os.Exit(1) }

	tx, _ := c.Begin(ctx); defer tx.Rollback(ctx)
	for _, r := range out {
		if _, err := tx.Exec(ctx, `UPDATE sections SET class_teacher_id=NULL
		  WHERE class_teacher_id=$1 AND id<>$2`, r.uid, r.secID); err != nil { fmt.Println(err); os.Exit(1) }
		if _, err := tx.Exec(ctx, `UPDATE sections SET class_teacher_id=$2 WHERE id=$1`, r.secID, r.uid); err != nil { fmt.Println(err); os.Exit(1) }
	}
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Printf("\nWROTE %d grade teachers.\n", len(out))
}
