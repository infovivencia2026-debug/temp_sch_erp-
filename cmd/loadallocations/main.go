package main

// Subject teachers from the allotment sheet -> section_subject_teachers.
// Reads the reviewed CSV. Ensures each subject exists on its class (creating
// the subject and/or the class-subject link when missing), then assigns the
// teacher. Report by default; -write applies. Idempotent.

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"
const csvPath = `C:\Users\sony\Desktop\yajur_subject_teachers_review.csv`

var nonAlnum = regexp.MustCompile(`[^A-Z0-9]+`)

func codeFor(name string) string {
	c := nonAlnum.ReplaceAllString(strings.ToUpper(name), "")
	if len(c) > 8 {
		c = c[:8]
	}
	return c
}

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	var campus string
	if e := c.QueryRow(ctx, `SELECT campus_id::text FROM sections WHERE institution_id=$1 LIMIT 1`, inst).Scan(&campus); e != nil {
		fmt.Println("campus:", e); os.Exit(1)
	}

	f, e := os.Open(csvPath)
	if e != nil { fmt.Println("open:", e); os.Exit(1) }
	defer f.Close()
	rr := csv.NewReader(f); rr.FieldsPerRecord = -1
	recs, e := rr.ReadAll()
	if e != nil { fmt.Println("read:", e); os.Exit(1) }

	type row struct{ cls, sec, sub, code, tname string }
	var rows []row
	for i, r := range recs {
		if i == 0 || len(r) < 6 { continue }
		rows = append(rows, row{cls: r[0], sec: r[1], sub: r[3], tname: r[4], code: r[5]})
	}

	tx, e := c.Begin(ctx)
	if e != nil { fmt.Println("begin:", e); os.Exit(1) }
	defer tx.Rollback(ctx)

	newSubj, newLink, assigned, prob := 0, 0, 0, 0
	subjCache := map[string]string{}   // name -> id
	linkCache := map[string]string{}   // class_id|subject_id -> class_subject_id

	ensureSubject := func(name string) (string, error) {
		if id, ok := subjCache[name]; ok { return id, nil }
		var id string
		err := tx.QueryRow(ctx, `SELECT id::text FROM subjects WHERE institution_id=$1 AND lower(name)=lower($2) LIMIT 1`, inst, name).Scan(&id)
		if err == pgx.ErrNoRows {
			if *write {
				if err := tx.QueryRow(ctx, `INSERT INTO subjects (institution_id,campus_id,name,code,is_scholastic)
					VALUES ($1,$2,$3,$4,true) RETURNING id::text`, inst, campus, name, codeFor(name)).Scan(&id); err != nil {
					return "", err
				}
			} else { id = "(new)" }
			newSubj++
			fmt.Printf("  + subject %q\n", name)
		} else if err != nil { return "", err }
		subjCache[name] = id
		return id, nil
	}

	for _, r := range rows {
		var classID, sectionID, uid string
		if e := tx.QueryRow(ctx, `SELECT cl.id::text, sec.id::text FROM sections sec JOIN classes cl ON cl.id=sec.class_id
			WHERE sec.institution_id=$1 AND cl.name=$2 AND sec.name=$3`, inst, r.cls, r.sec).Scan(&classID, &sectionID); e != nil {
			fmt.Printf("  !! section not found: %s %s\n", r.cls, r.sec); prob++; continue
		}
		if e := tx.QueryRow(ctx, `SELECT COALESCE(user_id::text,'') FROM employees WHERE institution_id=$1 AND employee_code=$2`, inst, r.code).Scan(&uid); e != nil || uid == "" {
			fmt.Printf("  !! teacher %s (%s) no login/not found\n", r.tname, r.code); prob++; continue
		}
		subjID, e := ensureSubject(r.sub)
		if e != nil { fmt.Println("subject:", e); os.Exit(1) }
		if subjID == "(new)" { // report mode, subject would be created; link too
			newLink++
			assigned++
			continue
		}
		lk := classID + "|" + subjID
		csID, ok := linkCache[lk]
		if !ok {
			err := tx.QueryRow(ctx, `SELECT id::text FROM class_subjects WHERE institution_id=$1 AND class_id=$2 AND subject_id=$3`, inst, classID, subjID).Scan(&csID)
			if err == pgx.ErrNoRows {
				if *write && subjID != "(new)" {
					if err := tx.QueryRow(ctx, `INSERT INTO class_subjects (institution_id,class_id,subject_id) VALUES ($1,$2,$3) RETURNING id::text`, inst, classID, subjID).Scan(&csID); err != nil {
						fmt.Println("link:", err); os.Exit(1)
					}
				} else { csID = "(new)" }
				newLink++
			} else if err != nil { fmt.Println("link lookup:", err); os.Exit(1) }
			linkCache[lk] = csID
		}
		if *write && csID != "(new)" {
			if _, err := tx.Exec(ctx, `INSERT INTO section_subject_teachers (institution_id,section_id,class_subject_id,teacher_user_id)
				VALUES ($1,$2,$3,$4) ON CONFLICT (section_id,class_subject_id) DO UPDATE SET teacher_user_id=EXCLUDED.teacher_user_id`,
				inst, sectionID, csID, uid); err != nil {
				fmt.Println("assign:", err); os.Exit(1)
			}
		}
		assigned++
	}

	fmt.Printf("\n%d assignments, %d new subjects, %d new class-links, %d problems\n", assigned, newSubj, newLink, prob)
	if !*write { fmt.Println("REPORT ONLY. Re-run with -write to apply."); return }
	if prob > 0 { fmt.Println("REFUSING to commit: fix problems first."); os.Exit(1) }
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Println("COMMITTED.")
}
