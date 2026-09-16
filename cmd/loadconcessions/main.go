package main

/* THE DISCOUNTS THE SCHOOL HAS ALREADY PROMISED, for 2026-27.

   276 of the 324 children on the roll carry a concession in the school's own
   students sheet -- "Annual Fee 42500", "Annual Fee 20000" -- and none of it
   was in the system. Every one of those families would have been handed a bill
   for the full fee.

   TWO THINGS ABOUT THE ARITHMETIC.

   The sheet states an ANNUAL figure. A fee_concession applies to every invoice
   for the year, and tuition is billed in three terms, so writing 20000 there
   would take 20000 off each term -- 60000 off a 90000 fee. The annual figure
   is therefore divided by the number of instalments the head is billed in, and
   the remainder rides on the first term so the three add back to the promised
   figure exactly.

   And the bills for term 1 are already raised. A concession written now would
   only reach terms 2 and 3, so this also applies the discount to the lines
   already issued -- which is what the demand run would have done had the
   discount been recorded first.

   Idempotent: a child who already has a concession for this year and head is
   left alone. */

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	recs, err := csv.NewReader(f).ReadAll()
	if err != nil {
		panic(err)
	}
	head := map[string]int{}
	for i, h := range recs[0] {
		head[strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))] = i
	}
	col := func(r []string, name string) string {
		i, ok := head[name]
		if !ok || i >= len(r) {
			return ""
		}
		return strings.TrimSpace(r[i])
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

	var yearID uuid.UUID
	var yearName string
	if err := tx.QueryRow(ctx,
		`SELECT id, name FROM academic_years WHERE institution_id=$1 AND is_current`,
		instID).Scan(&yearID, &yearName); err != nil {
		panic(err)
	}

	// The head the sheet means by "Annual Fee", and how many terms it is
	// billed in -- taken from the structures rather than assumed to be three.
	var annualHead uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM fee_heads WHERE institution_id=$1 AND code='ANNU'`, instID).Scan(&annualHead); err != nil {
		panic(fmt.Errorf("no Annual Fee head: %w", err))
	}
	var terms int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(max(i.instalment_no),1)
		  FROM fee_structure_items i
		  JOIN fee_structures s ON s.id = i.fee_structure_id
		 WHERE s.institution_id=$1 AND s.academic_year_id=$2 AND i.fee_head_id=$3`,
		instID, yearID, annualHead).Scan(&terms); err != nil {
		panic(err)
	}
	fmt.Printf("%s, Annual Fee billed in %d terms\n\n", yearName, terms)

	students := map[string]uuid.UUID{}
	rows, err := tx.Query(ctx,
		`SELECT upper(admission_no), id FROM students
		  WHERE institution_id=$1 AND admission_no IS NOT NULL AND status='active'`, instID)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var a string
		var id uuid.UUID
		if err := rows.Scan(&a, &id); err != nil {
			panic(err)
		}
		students[strings.TrimSpace(a)] = id
	}
	rows.Close()

	var made, already, absent, relined int
	var annualTotal, appliedNow int64
	shown := 0

	for i, r := range recs {
		if i == 0 || len(r) == 0 {
			continue
		}
		if !strings.EqualFold(col(r, "Status"), "Active") {
			continue
		}
		raw := col(r, "Concession Amount")
		if raw == "" {
			continue
		}
		rupees, err := strconv.ParseFloat(strings.ReplaceAll(raw, ",", ""), 64)
		if err != nil || rupees <= 0 {
			continue
		}
		admn := strings.ToUpper(col(r, "Enrollment Code"))
		sid, ok := students[admn]
		if !ok {
			absent++
			continue
		}

		annual := int64(rupees * 100)
		annualTotal += annual
		// The remainder rides on term 1, so the terms add back exactly.
		perTerm := annual / int64(terms)

		var exists int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM fee_concessions
			 WHERE student_id=$1 AND academic_year_id=$2 AND fee_head_id=$3`,
			sid, yearID, annualHead).Scan(&exists); err != nil {
			panic(err)
		}
		if exists > 0 {
			already++
			continue
		}

		reason := col(r, "Concession Reason")
		if reason == "" {
			reason = "Concession carried over from the school's register"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO fee_concessions (institution_id, student_id, academic_year_id,
			                             fee_head_id, kind, amount_paise, reason, approved_at)
			VALUES ($1,$2,$3,$4,'other',$5,$6,now())`,
			instID, sid, yearID, annualHead, perTerm, reason); err != nil {
			panic(fmt.Errorf("%s: %w", admn, err))
		}
		made++
		if shown < 6 {
			fmt.Printf("  %-12s Rs %d a year  ->  Rs %d a term\n", admn, annual/100, perTerm/100)
			shown++
		}

		/* AND ONTO THE BILL ALREADY ISSUED.

		   Term 1 went out before the discount was recorded. Rather than leave
		   those families overbilled until somebody notices, the line is
		   discounted here exactly as the run would have done -- capped at the
		   line, because a discount larger than the charge is not a discount. */
		tag, err := tx.Exec(ctx, `
			UPDATE invoice_lines l
			   SET discount_paise = LEAST(l.amount_paise, $4)
			  FROM invoices i
			 WHERE l.invoice_id = i.id
			   AND i.student_id = $1 AND i.academic_year_id = $2
			   AND i.status NOT IN ('cancelled','paid')
			   AND l.fee_head_id = $3
			   AND l.discount_paise = 0`,
			sid, yearID, annualHead, perTerm)
		if err != nil {
			panic(err)
		}
		if n := int(tag.RowsAffected()); n > 0 {
			relined += n
			appliedNow += perTerm * int64(n)
		}
	}

	// Headers follow their lines.
	if _, err := tx.Exec(ctx, `
		UPDATE invoices i SET
		    gross_paise    = COALESCE((SELECT sum(amount_paise)   FROM invoice_lines l WHERE l.invoice_id=i.id),0),
		    discount_paise = COALESCE((SELECT sum(discount_paise) FROM invoice_lines l WHERE l.invoice_id=i.id),0)
		 WHERE i.institution_id=$1 AND i.academic_year_id=$2`, instID, yearID); err != nil {
		panic(err)
	}

	fmt.Printf("\nconcessions written:        %d\n", made)
	fmt.Printf("already had one:            %d\n", already)
	fmt.Printf("not on the active roll:     %d\n", absent)
	fmt.Printf("\npromised for the year:      Rs %d\n", annualTotal/100)
	fmt.Printf("applied to term 1 already:  Rs %d across %d lines\n", appliedNow/100, relined)

	var gross, disc int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(gross_paise),0)::bigint, COALESCE(sum(discount_paise),0)::bigint
		  FROM invoices WHERE institution_id=$1 AND academic_year_id=$2`,
		instID, yearID).Scan(&gross, &disc); err != nil {
		panic(err)
	}
	fmt.Printf("\nterm 1 now: gross Rs %d, discount Rs %d, payable Rs %d\n",
		gross/100, disc/100, (gross-disc)/100)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
