package main

// Load the class timetable from the reviewed CSV into timetable_entries.
// Ensures each subject exists on its class, resolves the period by the day's
// own bell schedule, and attaches the teacher. Report by default; -write
// replaces the year's timetable in one transaction.

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
const csvPath = `C:\Users\sony\Desktop\yajur_timetable_review.csv`

var days = map[string]int{"monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6, "sunday": 7}
var nonAlnum = regexp.MustCompile(`[^A-Z0-9]+`)

func codeFor(n string) string {
	c := nonAlnum.ReplaceAllString(strings.ToUpper(n), "")
	if len(c) > 8 { c = c[:8] }
	return c
}

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	var year, campus string
	if e := c.QueryRow(ctx, `SELECT id::text FROM academic_years WHERE institution_id=$1 AND is_current`, inst).Scan(&year); e != nil {
		fmt.Println("current year:", e); os.Exit(1)
	}
	if e := c.QueryRow(ctx, `SELECT campus_id::text FROM sections WHERE institution_id=$1 LIMIT 1`, inst).Scan(&campus); e != nil {
		fmt.Println("campus:", e); os.Exit(1)
	}

	f, e := os.Open(csvPath)
	if e != nil { fmt.Println("open:", e); os.Exit(1) }
	defer f.Close()
	rr := csv.NewReader(f); rr.FieldsPerRecord = -1
	recs, e := rr.ReadAll()
	if e != nil { fmt.Println("read:", e); os.Exit(1) }

	tx, e := c.Begin(ctx)
	if e != nil { fmt.Println("begin:", e); os.Exit(1) }
	defer tx.Rollback(ctx)

	subjCache := map[string]string{}
	linkCache := map[string]string{}
	ensureLink := func(classID, subject string) (string, error) {
		var subjID string
		if id, ok := subjCache[subject]; ok { subjID = id } else {
			err := tx.QueryRow(ctx, `SELECT id::text FROM subjects WHERE institution_id=$1 AND lower(name)=lower($2) LIMIT 1`, inst, subject).Scan(&subjID)
			if err == pgx.ErrNoRows {
				if *write {
					if err := tx.QueryRow(ctx, `INSERT INTO subjects (institution_id,campus_id,name,code,is_scholastic) VALUES ($1,$2,$3,$4,true) RETURNING id::text`, inst, campus, subject, codeFor(subject)).Scan(&subjID); err != nil { return "", err }
				} else { subjID = "new" }
			} else if err != nil { return "", err }
			subjCache[subject] = subjID
		}
		lk := classID + "|" + subjID
		if id, ok := linkCache[lk]; ok { return id, nil }
		if subjID == "new" { linkCache[lk] = "new"; return "new", nil }
		var csID string
		err := tx.QueryRow(ctx, `SELECT id::text FROM class_subjects WHERE institution_id=$1 AND class_id=$2 AND subject_id=$3`, inst, classID, subjID).Scan(&csID)
		if err == pgx.ErrNoRows {
			if *write {
				if err := tx.QueryRow(ctx, `INSERT INTO class_subjects (institution_id,class_id,subject_id) VALUES ($1,$2,$3) RETURNING id::text`, inst, classID, subjID).Scan(&csID); err != nil { return "", err }
			} else { csID = "new" }
		} else if err != nil { return "", err }
		linkCache[lk] = csID
		return csID, nil
	}

	if *write {
		if _, err := tx.Exec(ctx, `DELETE FROM timetable_entries WHERE institution_id=$1 AND academic_year_id=$2`, inst, year); err != nil {
			fmt.Println("clear:", err); os.Exit(1)
		}
	}

	total, prob, withTeacher, shared := 0, 0, 0, 0
	usedSlot := map[string]bool{}
	for i, r := range recs {
		if i == 0 || len(r) < 7 { continue }
		cls, sec, day, period, subject, code := r[0], r[1], r[2], r[3], r[4], r[6]
		wd, ok := days[strings.ToLower(strings.TrimSpace(day))]
		if !ok { fmt.Printf("  !! bad day %q\n", day); prob++; continue }
		var classID, sectionID string
		if e := tx.QueryRow(ctx, `SELECT cl.id::text, sec.id::text FROM sections sec JOIN classes cl ON cl.id=sec.class_id WHERE sec.institution_id=$1 AND cl.name=$2 AND sec.name=$3`, inst, cls, sec).Scan(&classID, &sectionID); e != nil {
			fmt.Printf("  !! section %s %s\n", cls, sec); prob++; continue
		}
		var periodID string
		if e := tx.QueryRow(ctx, `SELECT p.id::text FROM periods p JOIN bell_schedules bs ON bs.id=p.bell_schedule_id WHERE p.institution_id=$1 AND bs.name=$2 AND p.name=$3 LIMIT 1`, inst, day, period).Scan(&periodID); e != nil {
			fmt.Printf("  !! period %s/%s\n", day, period); prob++; continue
		}
		csID, e := ensureLink(classID, subject)
		if e != nil { fmt.Println("link:", e); os.Exit(1) }
		var teacher any
		if strings.TrimSpace(code) != "" {
			var uid string
			if tx.QueryRow(ctx, `SELECT COALESCE(user_id::text,'') FROM employees WHERE institution_id=$1 AND employee_code=$2`, inst, code).Scan(&uid) == nil && uid != "" {
				slot := uid + "|" + fmt.Sprint(wd) + "|" + periodID
				if usedSlot[slot] {
					shared++ // same teacher already in this slot (combined class); leave blank
				} else {
					usedSlot[slot] = true
					teacher = uid
					withTeacher++
				}
			}
		}
		if *write && csID != "new" {
			if _, err := tx.Exec(ctx, `INSERT INTO timetable_entries (institution_id,academic_year_id,section_id,period_id,weekday,class_subject_id,teacher_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				inst, year, sectionID, periodID, wd, csID, teacher); err != nil {
				fmt.Println("insert:", err); os.Exit(1)
			}
		}
		total++
	}
	fmt.Printf("\n%d entries, %d with a teacher, %d problems\n", total, withTeacher, prob)
	if !*write { fmt.Println("REPORT ONLY. Re-run with -write to apply."); return }
	if prob > 0 { fmt.Println("REFUSING to commit: fix problems first."); os.Exit(1) }
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Println("COMMITTED.")
}
