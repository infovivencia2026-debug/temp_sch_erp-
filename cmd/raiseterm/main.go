package main

/* THE TERM'S BILLING RUN, for the children who are actually here.

   This does what POST /api/v1/fees/invoices/generate does, because the
   terminal route was not workable for this school. It deliberately mirrors
   that handler rather than inventing a second way to bill:

     - only 'active' enrolments in the working year are billed, so the 105
       withdrawn children are left alone;
     - a child who already has a non-cancelled invoice for this instalment is
       skipped, which is what makes a second run safe;
     - invoice numbers come from fees.NextNumber, the same series the counter
       uses, so nothing here is distinguishable from a bill raised in the app;
     - a head marked optional reaches only the children who chose it;
     - each child's approved concession is applied per head;
     - unpaid balances from earlier years are carried onto the first bill,
       exactly as carryArrears does;
     - an invoice that ends with no lines is withdrawn rather than left as a
       numbered demand for nothing.

   Tuition only, and one instalment at a time. Application Fee would bill 324
   enrolled children for applying, and the two transport structures carry no
   class, so each would bill every child a slab they may not use. Those are
   decisions for the school, not for a script.
*/

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

type structure struct {
	id      uuid.UUID
	name    string
	classID *uuid.UUID
	class   string
}

func main() {
	instalment := 1
	if len(os.Args) > 1 {
		n, err := strconv.Atoi(os.Args[1])
		if err != nil || n < 1 {
			panic("instalment must be a positive number")
		}
		instalment = n
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

	var yearID, campusID uuid.UUID
	var yearName string
	if err := tx.QueryRow(ctx,
		`SELECT id, name FROM academic_years WHERE institution_id=$1 AND is_current`,
		instID).Scan(&yearID, &yearName); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM campuses WHERE institution_id=$1 LIMIT 1`, instID).Scan(&campusID); err != nil {
		panic(err)
	}
	fmt.Printf("year %s, instalment %d\n\n", yearName, instalment)

	// The tuition structures, one per class.
	var structures []structure
	rows, err := tx.Query(ctx, `
		SELECT fs.id, fs.name, fs.class_id, COALESCE(c.name,'(all classes)')
		  FROM fee_structures fs
		  LEFT JOIN classes c ON c.id = fs.class_id
		 WHERE fs.institution_id=$1 AND fs.academic_year_id=$2 AND fs.is_active
		   AND upper(fs.name) LIKE 'TUTION%'
		 ORDER BY c.name`, instID, yearID)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var s structure
		if err := rows.Scan(&s.id, &s.name, &s.classID, &s.class); err != nil {
			panic(err)
		}
		structures = append(structures, s)
	}
	rows.Close()
	if len(structures) != 13 {
		panic(fmt.Sprintf("expected 13 tuition structures, found %d", len(structures)))
	}

	arrearsHead, err := ensureFeeHead(ctx, tx, instID, "arrears", "Arrears brought forward")
	if err != nil {
		panic(err)
	}

	grandChildren, grandGross, grandArrears := 0, int64(0), int64(0)
	for _, st := range structures {
		// What this structure charges for this instalment.
		var headIDs []uuid.UUID
		var amounts []int64
		irows, err := tx.Query(ctx, `
			SELECT fee_head_id, amount_paise FROM fee_structure_items
			 WHERE fee_structure_id=$1 AND instalment_no=$2`, st.id, instalment)
		if err != nil {
			panic(err)
		}
		for irows.Next() {
			var h uuid.UUID
			var a int64
			if err := irows.Scan(&h, &a); err != nil {
				panic(err)
			}
			headIDs = append(headIDs, h)
			amounts = append(amounts, a)
		}
		irows.Close()
		if len(headIDs) == 0 {
			fmt.Printf("%-14s nothing priced at instalment %d, skipped\n", st.class, instalment)
			continue
		}

		// Who is actually here, and not already billed for this instalment.
		var students []uuid.UUID
		srows, err := tx.Query(ctx, `
			SELECT e.student_id
			  FROM enrollments e
			 WHERE e.academic_year_id=$1 AND e.status='active'
			   AND ($2::uuid IS NULL OR e.class_id=$2)
			   AND NOT EXISTS (
			       SELECT 1 FROM invoices i
			        WHERE i.student_id = e.student_id
			          AND i.academic_year_id = $1
			          AND i.instalment_no = $3
			          AND i.status <> 'cancelled')`,
			yearID, st.classID, instalment)
		if err != nil {
			panic(err)
		}
		for srows.Next() {
			var sid uuid.UUID
			if err := srows.Scan(&sid); err != nil {
				panic(err)
			}
			students = append(students, sid)
		}
		srows.Close()

		made, withdrawn := 0, 0
		var gross, arrears int64
		for _, sid := range students {
			invoiceNo, err := fees.NextNumber(ctx, tx, instID, "invoice")
			if err != nil {
				panic(err)
			}
			dueOn := time.Now().AddDate(0, 0, 14)

			var invID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
				                      invoice_no, instalment_no, issued_on, due_on,
				                      gross_paise, discount_paise, status)
				VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,0,0,'unpaid')
				RETURNING id`,
				instID, campusID, sid, yearID, invoiceNo, instalment, dueOn).Scan(&invID); err != nil {
				panic(fmt.Errorf("invoice for %s: %w", sid, err))
			}

			// The structure's lines, the concession applied per head, and an
			// optional head reaching only the children who chose it.
			if _, err := tx.Exec(ctx, `
				INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
				                           description, amount_paise, discount_paise)
				SELECT $1, $2, l.fee_head_id, fh.name, l.amount_paise,
				       LEAST(
				         l.amount_paise,
				         COALESCE((
				           SELECT COALESCE(max(fc.amount_paise),
				                           max(round(l.amount_paise * fc.percent / 100.0))::bigint)
				             FROM fee_concessions fc
				            WHERE fc.student_id = $3
				              AND fc.academic_year_id = $4
				              AND fc.approved_at IS NOT NULL
				              AND (fc.fee_head_id IS NULL OR fc.fee_head_id = l.fee_head_id)
				         ), 0)
				       )
				  FROM unnest($5::uuid[], $6::bigint[]) AS l(fee_head_id, amount_paise)
				  JOIN fee_heads fh ON fh.id = l.fee_head_id
				 WHERE (NOT fh.optional OR EXISTS (
				     SELECT 1 FROM student_fee_optins o
				      WHERE o.student_id = $3 AND o.academic_year_id = $4
				        AND o.fee_head_id = l.fee_head_id AND o.ended_on IS NULL))`,
				instID, invID, sid, yearID, headIDs, amounts); err != nil {
				panic(fmt.Errorf("lines for %s: %w", sid, err))
			}

			moved, err := carryArrears(ctx, tx, instID, campusID, sid, yearID,
				invID, invoiceNo, arrearsHead)
			if err != nil {
				panic(err)
			}
			arrears += moved

			if _, err := tx.Exec(ctx, `
				UPDATE invoices SET
				    gross_paise    = COALESCE((SELECT sum(amount_paise)   FROM invoice_lines WHERE invoice_id=$1),0),
				    discount_paise = COALESCE((SELECT sum(discount_paise) FROM invoice_lines WHERE invoice_id=$1),0)
				 WHERE id=$1`, invID); err != nil {
				panic(err)
			}

			var lines int
			var net int64
			if err := tx.QueryRow(ctx,
				`SELECT count(*), COALESCE(max(i.net_paise),0) FROM invoice_lines l
				   JOIN invoices i ON i.id = l.invoice_id WHERE l.invoice_id=$1`, invID).
				Scan(&lines, &net); err != nil {
				panic(err)
			}
			if lines == 0 {
				if _, err := tx.Exec(ctx, `DELETE FROM invoices WHERE id=$1`, invID); err != nil {
					panic(err)
				}
				withdrawn++
				continue
			}
			gross += net
			made++
		}

		fmt.Printf("%-14s %3d billed  Rs %-10d", st.class, made, gross/100)
		if arrears > 0 {
			fmt.Printf("  (incl. Rs %d brought forward)", arrears/100)
		}
		if withdrawn > 0 {
			fmt.Printf("  %d had nothing to pay", withdrawn)
		}
		fmt.Println()
		grandChildren += made
		grandGross += gross
		grandArrears += arrears
	}

	fmt.Printf("\n%d children billed, Rs %d in total", grandChildren, grandGross/100)
	if grandArrears > 0 {
		fmt.Printf(", of which Rs %d is arrears carried from earlier years", grandArrears/100)
	}
	fmt.Println()

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}

func ensureFeeHead(ctx context.Context, tx pgx.Tx, inst uuid.UUID, code, name string) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO fee_heads (institution_id, name, code, is_recurring)
		VALUES ($1,$2,upper($3),false)
		ON CONFLICT (institution_id, code) DO UPDATE SET name = fee_heads.name
		RETURNING id`, inst, name, code).Scan(&id)
	return id, err
}

// carryArrears mirrors internal/api/fee_arrears.go, which is unexported.
func carryArrears(ctx context.Context, tx pgx.Tx, inst, campus, student, year,
	invoiceID uuid.UUID, invoiceNo string, head uuid.UUID) (int64, error) {
	type old struct {
		id       uuid.UUID
		no, year string
		balance  int64
	}
	rows, err := tx.Query(ctx, `
		SELECT i.id, i.invoice_no, ay.name, i.net_paise - i.paid_paise
		  FROM invoices i
		  JOIN academic_years ay ON ay.id = i.academic_year_id
		  JOIN academic_years this ON this.id = $2
		 WHERE i.student_id = $1
		   AND i.academic_year_id <> $2
		   AND ay.starts_on < this.starts_on
		   AND i.status IN ('unpaid','partial','overdue')
		   AND i.net_paise > i.paid_paise
		   AND NOT EXISTS (SELECT 1 FROM invoice_carry_forwards cf WHERE cf.from_invoice_id = i.id)
		 ORDER BY COALESCE(i.due_on, i.issued_on), i.invoice_no
		 FOR UPDATE OF i`, student, year)
	if err != nil {
		return 0, err
	}
	var list []old
	for rows.Next() {
		var o old
		if err := rows.Scan(&o.id, &o.no, &o.year, &o.balance); err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, o)
	}
	rows.Close()

	var moved int64
	for _, c := range list {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise)
			VALUES ($1,$2,$3,$4,$5,0)`,
			inst, invoiceID, head,
			fmt.Sprintf("Brought forward from %s (%s)", c.no, c.year), c.balance); err != nil {
			return 0, err
		}
		var payID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO payments (institution_id, campus_id, student_id, amount_paise, mode,
			                      paid_on, status, remarks)
			VALUES ($1,$2,$3,$4,'adjustment',CURRENT_DATE,'success',$5)
			RETURNING id`,
			inst, campus, student, c.balance, "Carried forward to "+invoiceNo).Scan(&payID); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			VALUES ($1,$2,$3,$4)`, inst, payID, c.id, c.balance); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_carry_forwards (institution_id, from_invoice_id, to_invoice_id, payment_id, amount_paise)
			VALUES ($1,$2,$3,$4,$5)`, inst, c.id, invoiceID, payID, c.balance); err != nil {
			return 0, err
		}
		moved += c.balance
	}
	return moved, nil
}
