package main

/* THE TWO CHILDREN WHO TOOK ECA.

   The register does not give the activity a column. It is written in the
   margin of the term-one row -- "10000 paid for ECA ON 18.07.26" in the "Due
   if any" cell -- because the office had nowhere else to put it. Two children
   in Grade 3, ten thousand each, both paid.

   That margin note is exactly what fee_heads.optional and student_fee_optins
   were built for: the head is priced on the structure at ten thousand, and it
   reaches only the children who chose it. So each child gets an opt-in, a bill
   under the ECA head, and the receipt the register records.

   Idempotent: a child already opted in keeps the bill they have. */

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

var ecaRe = regexp.MustCompile(`(?i)(\d[\d,]*)\s*(?:paid\s+for\s+)?ECA`)
var dateRe = regexp.MustCompile(`(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})`)
var shortDate = regexp.MustCompile(`(\d{1,2})[.\-/](\d{1,2})\s*$`)
var notLetter = regexp.MustCompile(`[^A-Z ]+`)

func words(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(notLetter.ReplaceAllString(strings.ToUpper(s), " ")) {
		if len(w) > 1 {
			out[w] = true
		}
	}
	return out
}

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	rd := csv.NewReader(f)
	rd.FieldsPerRecord = -1
	recs, err := rd.ReadAll()
	if err != nil {
		panic(err)
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil {
		panic(err)
	}
	defer conn.Close(ctx)
	instID := uuid.MustParse(inst)

	tx, err := conn.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	var yearID, campusID, ecaHead uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE institution_id=$1 AND is_current`, instID).Scan(&yearID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM campuses WHERE institution_id=$1 LIMIT 1`, instID).Scan(&campusID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM fee_heads WHERE institution_id=$1 AND code='ECA'`, instID).Scan(&ecaHead); err != nil {
		panic(fmt.Errorf("no ECA head: %w", err))
	}
	// It is an activity a family signs up to, so it is owed only by those who
	// did. Set here as well as in the UI, because a head loaded from a sheet
	// never passed through the screen that would have asked.
	if _, err := tx.Exec(ctx,
		`UPDATE fee_heads SET optional = true WHERE id=$1`, ecaHead); err != nil {
		panic(err)
	}

	type kid struct {
		id    uuid.UUID
		admn  string
		name  string
		words map[string]bool
		class string
	}
	var roll []kid
	rows, err := tx.Query(ctx, `
		SELECT s.id, s.admission_no,
		       trim(s.first_name||' '||COALESCE(s.middle_name,'')||' '||COALESCE(s.last_name,'')),
		       COALESCE(c.name,'')
		  FROM students s
		  LEFT JOIN enrollments e ON e.student_id=s.id AND e.status='active'
		  LEFT JOIN classes c ON c.id=e.class_id
		 WHERE s.institution_id=$1 AND s.status='active'`, instID)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var k kid
		if err := rows.Scan(&k.id, &k.admn, &k.name, &k.class); err != nil {
			panic(err)
		}
		k.words = words(k.name)
		roll = append(roll, k)
	}
	rows.Close()

	seq := 0
	made, paid := 0, 0
	for i, r := range recs {
		if i == 0 {
			continue
		}
		// The cell that mentions ECA, not the whole row: the register writes
		// "10000 ECA 21.07" with no year, and the row goes on to carry the
		// books and uniform dates. Searching the joined row found a date four
		// cells later and dated the activity fee to the day the books were
		// bought.
		cell := ""
		for _, v := range r {
			if ecaRe.MatchString(v) {
				cell = v
				break
			}
		}
		if cell == "" {
			continue
		}
		m := ecaRe.FindStringSubmatch(cell)
		if m == nil {
			continue
		}
		amt, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
		if err != nil || amt <= 0 {
			continue
		}
		amount := amt * 100

		name := strings.TrimSpace(r[1])
		want := words(name)
		var found *kid
		for k := range roll {
			all := true
			for w := range want {
				if !roll[k].words[w] {
					all = false
					break
				}
			}
			if all {
				found = &roll[k]
				break
			}
		}
		if found == nil {
			fmt.Printf("  row %-4d %-30s ECA Rs %d -- child not found\n", i+1, name, amt)
			continue
		}

		var already int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM student_fee_optins
			 WHERE student_id=$1 AND fee_head_id=$2 AND academic_year_id=$3 AND ended_on IS NULL`,
			found.id, ecaHead, yearID).Scan(&already); err != nil {
			panic(err)
		}
		if already == 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO student_fee_optins (institution_id, student_id, academic_year_id,
				                                fee_head_id, note)
				VALUES ($1,$2,$3,$4,$5)`,
				instID, found.id, yearID, ecaHead,
				"From the school's fee register"); err != nil {
				panic(err)
			}
		}

		var billed int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
			 WHERE i.student_id=$1 AND i.academic_year_id=$2 AND il.fee_head_id=$3
			   AND i.status <> 'cancelled'`, found.id, yearID, ecaHead).Scan(&billed); err != nil {
			panic(err)
		}
		if billed > 0 {
			fmt.Printf("  %-11s %-28s already billed for ECA\n", found.admn, found.name)
			continue
		}

		seq++
		var invID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, instalment_no, issued_on, due_on,
			                      gross_paise, discount_paise, status)
			VALUES ($1,$2,$3,$4,$5,20,CURRENT_DATE,CURRENT_DATE+14,$6,0,'unpaid')
			RETURNING id`,
			instID, campusID, found.id, yearID,
			fmt.Sprintf("INV/2026-27/ECA%03d", seq), amount).Scan(&invID); err != nil {
			panic(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
			                           description, amount_paise, discount_paise)
			VALUES ($1,$2,$3,'After School ECA',$4,0)`, instID, invID, ecaHead, amount); err != nil {
			panic(err)
		}
		made++

		// The register writes it as already paid, with the date beside it.
		on := time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)
		dated := false
		if d := dateRe.FindStringSubmatch(cell); d != nil {
			dd, _ := strconv.Atoi(d[1])
			mm, _ := strconv.Atoi(d[2])
			yy, _ := strconv.Atoi(d[3])
			if yy < 100 {
				yy += 2000
			}
			if dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 {
				on, dated = time.Date(yy, time.Month(mm), dd, 0, 0, 0, 0, time.UTC), true
			}
		}
		// "21.07" — a day and a month, the year taken as read, because a fee
		// register only ever covers the year it is for.
		if !dated {
			if d := shortDate.FindStringSubmatch(cell); d != nil {
				dd, _ := strconv.Atoi(d[1])
				mm, _ := strconv.Atoi(d[2])
				if dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 {
					on, dated = time.Date(2026, time.Month(mm), dd, 0, 0, 0, 0, time.UTC), true
				}
			}
		}
		if !dated {
			fmt.Printf("  (nothing beside the ECA note reads as a date; posted as at the export day)\n")
		}
		var payID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
			                      amount_paise, allocated_paise, mode, paid_on, status, remarks)
			VALUES ($1,$2,$3,$4,$5,$5,'adjustment',$6,'success',$7)
			RETURNING id`,
			instID, campusID, found.id,
			fmt.Sprintf("RCT/2026-27/ECA%03d", seq), amount, on,
			"After School ECA, from the school's fee register").Scan(&payID); err != nil {
			panic(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			VALUES ($1,$2,$3,$4)`, instID, payID, invID, amount); err != nil {
			panic(err)
		}
		paid++
		fmt.Printf("  %-11s %-28s ECA Rs %d, paid %s\n",
			found.admn, found.name, amt, on.Format("2 Jan 2006"))
	}

	fmt.Printf("\nECA bills raised: %d\nreceipts:         %d\n", made, paid)
	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
