package main

// Load Yajur staff bank details + gross salary from the mapped payroll CSV.
//
// The CSV is keyed by the real YPS employee_code, so every row is matched to
// an employee EXACTLY by code -- no name guessing. Bank account + IFSC go onto
// the employee record; the gross salary becomes the employee's CTC salary
// structure (effective from the academic year start).
//
//	go run ./cmd/loadpayroll            # REPORT: prints what would change, writes nothing
//	go run ./cmd/loadpayroll -write     # WRITE: applies it, in one transaction
//
// Needs DBURL in the environment. Read-only until -write is passed, and it
// refuses to write if any row's YPS code is not found.

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c" // Yajur Public School
const effectiveFrom = "2026-04-01"                  // academic year 2026-27 start
const csvPath = `C:\Users\sony\Desktop\yajur_payroll_final.csv`

// Columns: name, yp, bank_account, ifsc, gross_salary
type row struct {
	name, yp, bank, ifsc string
	gross                int
}

func numOnly(s string) int {
	n := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			n = n*10 + int(r-'0')
		}
	}
	return n
}

func main() {
	write := flag.Bool("write", false, "write to the database (default is a read-only report)")
	flag.Parse()

	ctx := context.Background()
	c, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil {
		fmt.Println("connect:", err)
		os.Exit(1)
	}
	defer c.Close(ctx)

	// Every Yajur employee, by code, for exact matching.
	byCode := map[string]struct{ id, name string }{}
	rows, err := c.Query(ctx, `
		SELECT employee_code, id::text, btrim(concat_ws(' ', first_name, last_name))
		  FROM employees WHERE institution_id=$1`, inst)
	if err != nil {
		fmt.Println("load employees:", err)
		os.Exit(1)
	}
	for rows.Next() {
		var code, id, name string
		if err := rows.Scan(&code, &id, &name); err != nil {
			fmt.Println("scan:", err)
			os.Exit(1)
		}
		byCode[strings.ToUpper(strings.TrimSpace(code))] = struct{ id, name string }{id, name}
	}
	rows.Close()

	// Read the CSV.
	f, err := os.Open(csvPath)
	if err != nil {
		fmt.Println("open csv:", err)
		os.Exit(1)
	}
	defer f.Close()
	rr := csv.NewReader(f)
	rr.FieldsPerRecord = -1
	recs, err := rr.ReadAll()
	if err != nil {
		fmt.Println("read csv:", err)
		os.Exit(1)
	}

	var data []row
	for i, rec := range recs {
		if i == 0 || len(rec) < 5 {
			continue // header
		}
		data = append(data, row{
			name:  strings.TrimSpace(rec[0]),
			yp:    strings.ToUpper(strings.TrimSpace(rec[1])),
			bank:  strings.TrimSpace(rec[2]),
			ifsc:  strings.TrimSpace(rec[3]),
			gross: numOnly(rec[4]),
		})
	}

	fmt.Printf("=== PAYROLL LOAD REPORT (%d rows) ===\n", len(data))
	fmt.Printf("%-13s %-26s %-14s %-12s %-9s %s\n", "YPS", "NAME (DB)", "BANK", "IFSC", "GROSS", "MATCH")
	unmatched := 0
	for _, d := range data {
		e, ok := byCode[d.yp]
		name := d.name
		status := "OK"
		if !ok {
			status = "*** NOT FOUND ***"
			unmatched++
		} else {
			name = e.name
		}
		fmt.Printf("%-13s %-26s %-14s %-12s %-9d %s\n",
			d.yp, name[:min(26, len(name))], d.bank, d.ifsc, d.gross, status)
	}

	if !*write {
		fmt.Printf("\nREAD-ONLY. Nothing written. %d matched, %d unmatched.\n", len(data)-unmatched, unmatched)
		fmt.Println("Re-run with -write once this looks right.")
		return
	}
	if unmatched > 0 {
		fmt.Printf("\nREFUSING to write: %d rows have a YPS code not in the system.\n", unmatched)
		os.Exit(1)
	}

	tx, err := c.Begin(ctx)
	if err != nil {
		fmt.Println("begin:", err)
		os.Exit(1)
	}
	defer tx.Rollback(ctx)

	bankN, salN := 0, 0
	for _, d := range data {
		e := byCode[d.yp]
		if d.bank != "" || d.ifsc != "" {
			if _, err := tx.Exec(ctx,
				`UPDATE employees SET bank_account=NULLIF($2,''), bank_ifsc=NULLIF($3,'')
				  WHERE id=$1`, e.id, d.bank, d.ifsc); err != nil {
				fmt.Println("bank", d.yp, err)
				os.Exit(1)
			}
			bankN++
		}
		if d.gross > 0 {
			var sid string
			err := tx.QueryRow(ctx, `
				SELECT id::text FROM salary_structures
				 WHERE institution_id=$1 AND employee_id=$2 AND effective_to IS NULL
				 ORDER BY effective_from DESC LIMIT 1`, inst, e.id).Scan(&sid)
			if err == pgx.ErrNoRows {
				if _, err := tx.Exec(ctx, `
					INSERT INTO salary_structures (institution_id, employee_id, effective_from, ctc_paise)
					VALUES ($1,$2,$3,$4)`, inst, e.id, effectiveFrom, int64(d.gross)*100); err != nil {
					fmt.Println("salary insert", d.yp, err)
					os.Exit(1)
				}
			} else if err != nil {
				fmt.Println("salary lookup", d.yp, err)
				os.Exit(1)
			} else {
				if _, err := tx.Exec(ctx,
					`UPDATE salary_structures SET ctc_paise=$2 WHERE id=$1`, sid, int64(d.gross)*100); err != nil {
					fmt.Println("salary update", d.yp, err)
					os.Exit(1)
				}
			}
			salN++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		fmt.Println("commit:", err)
		os.Exit(1)
	}
	fmt.Printf("\nWROTE: %d bank records, %d salary structures. Committed.\n", bankN, salN)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
