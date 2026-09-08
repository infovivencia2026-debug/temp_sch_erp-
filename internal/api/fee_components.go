package api

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* Per-child fee components: the charges a class structure cannot carry.

   The structure prices a class. The bus prices a stop, and the stop is the
   child's. Everything here exists so that the fare the transport office
   works out is the fare the demand run bills, without either of them having
   to know about the other beyond one table. */

// ensureFeeHead finds the head a per-child charge is raised under, creating
// it if the school has never set one up.
//
// A school that priced its stops before it named a "Transport" head should
// not be refused a bus child's bill over it; a head created here reads on
// the invoice exactly as one the office typed would.
func ensureFeeHead(ctx context.Context, tx pgx.Tx, inst uuid.UUID, code, name string) (uuid.UUID, error) {
	var id uuid.UUID
	// The school's own head first, matched by code and then by name, so a
	// school that already calls it "Bus fee" under code BUS keeps it.
	err := tx.QueryRow(ctx, `
		SELECT id FROM fee_heads
		 WHERE institution_id = $1
		   AND (code = upper($2) OR name ILIKE '%' || $2 || '%')
		 ORDER BY code = upper($2) DESC, created_at
		 LIMIT 1`, inst, code).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != pgx.ErrNoRows {
		return id, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO fee_heads (institution_id, name, code, is_recurring)
		VALUES ($1, $2, upper($3), true)
		ON CONFLICT (institution_id, code) DO UPDATE SET name = fee_heads.name
		RETURNING id`, inst, name, code).Scan(&id)
	return id, err
}

// syncTransportFeeComponent makes the child's live transport charge agree
// with their live transport allocation.
//
// Called after the allocation is written, by both places that write one.
// The old charge is ended the day before today rather than deleted, exactly
// as the allocation is; a new one is written only when the stop has a fare,
// because "no fare set on this stop" and "this stop is free" are different
// facts and a zero line on the invoice would assert the second.
func syncTransportFeeComponent(ctx context.Context, tx pgx.Tx, inst, student uuid.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE student_fee_components
		   SET valid_to = current_date - 1
		 WHERE student_id = $1 AND code = 'transport' AND valid_to IS NULL`,
		student); err != nil {
		return fmt.Errorf("end transport component: %w", err)
	}

	var allocID, yearID uuid.UUID
	var fare *int64
	var route, stop string
	err := tx.QueryRow(ctx, `
		SELECT ta.id, ta.academic_year_id, ps.fare_paise, rt.name, COALESCE(ps.name, '')
		  FROM transport_allocations ta
		  JOIN routes rt ON rt.id = ta.route_id
		  LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
		 WHERE ta.student_id = $1
		   AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
		 ORDER BY ta.valid_from DESC
		 LIMIT 1`, student).Scan(&allocID, &yearID, &fare, &route, &stop)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if fare == nil {
		return nil
	}
	head, err := ensureFeeHead(ctx, tx, inst, "transport", "Transport fee")
	if err != nil {
		return err
	}
	descr := "Transport · " + route
	if stop != "" {
		descr += ", " + stop
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO student_fee_components
		    (institution_id, student_id, academic_year_id, fee_head_id, code,
		     description, amount_paise, valid_from, source_kind, source_id)
		VALUES ($1, $2, $3, $4, 'transport', $5, $6, current_date, 'transport_allocation', $7)`,
		inst, student, yearID, head, descr, *fare, allocID)
	if err != nil {
		return fmt.Errorf("write transport component: %w", err)
	}
	return nil
}

// addComponentLines puts the child's own charges on an invoice the class
// structure has just been copied onto.
//
// instalments is how many the invoice covers: one for a term's demand, the
// structure's count for a whole-year bill. A component is priced per
// instalment, like a structure line, so the bus is not charged once for the
// year on a bill that carries three terms of tuition.
//
// Concessions apply the same way they do to a structure line: a waiver on
// the transport head, or a blanket one, comes off the transport line. A
// family given "50% on everything" was promised everything.
func addComponentLines(ctx context.Context, tx pgx.Tx, inst, invoiceID, student, year uuid.UUID, instalments int) error {
	if instalments < 1 {
		instalments = 1
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
		                           description, amount_paise, discount_paise)
		SELECT $1, $2, c.fee_head_id, c.description, c.amount_paise * $5,
		       LEAST(
		         c.amount_paise * $5,
		         COALESCE((
		           SELECT COALESCE(max(fc.amount_paise),
		                           max(round(c.amount_paise * $5 * fc.percent / 100.0))::bigint)
		             FROM fee_concessions fc
		            WHERE fc.student_id = $3
		              AND fc.academic_year_id = $4
		              AND fc.approved_at IS NOT NULL
		              AND (fc.fee_head_id IS NULL OR fc.fee_head_id = c.fee_head_id)
		         ), 0)
		       )
		  FROM student_fee_components c
		 WHERE c.student_id = $3
		   AND c.academic_year_id = $4
		   AND c.valid_from <= CURRENT_DATE
		   AND (c.valid_to IS NULL OR c.valid_to >= CURRENT_DATE)
		   AND c.amount_paise > 0`,
		inst, invoiceID, student, year, int64(instalments))
	if err != nil {
		return fmt.Errorf("create component lines: %w", err)
	}
	return nil
}
