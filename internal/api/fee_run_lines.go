package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* What a demand run is allowed to charge.

   Three records described the fee and none of them reached the invoice: the
   structure's own lines, the versioned snapshot the school activated, and
   the amounts a fee committee approved. The demand run read the first and
   left invoices.fee_structure_version_id empty on every bill it raised, so
   "did we charge what was approved" could not be answered from the
   database — the filing and the invoice had no common key. This is the one
   place that decides which lines a run bills, so the run itself does not
   have to know where they came from. */

// errFeeNotApproved is a structure whose live version was filed with a fee
// committee and has not come back approved.
var errFeeNotApproved = errors.New("fee version not approved")

type feeRunLine struct {
	HeadID      uuid.UUID
	Instalment  int
	AmountPaise int64
}

// feeRunSource is where the lines came from: the version cited on every
// invoice, and the filing whose approved amounts were applied, if any.
type feeRunSource struct {
	VersionID *uuid.UUID
	FilingID  *uuid.UUID
	Lines     []feeRunLine
}

// loadFeeRunLines decides the lines a run may bill from one structure.
//
// A school that has never opened the versioning screen has no version rows
// and bills from fee_structure_items as it always did. One that has bills
// from the live version's snapshot — which is what "versioned" was for —
// and the invoice cites it.
//
// Where the school files its fee with a regulatory committee, the filing
// is the approval, and the run is refused until the committee's decision is
// recorded against the live version. A filing marked approved with
// modification carries the amounts the committee allowed on its lines, and
// those override the version's own: the committee cut the development fee
// by ₹2,000 and the product recorded that fact and kept billing the
// original. Filing is not compulsory — a state without a committee has
// nothing to file — so the gate applies only once the school has filed
// anything for this structure.
func loadFeeRunLines(ctx context.Context, tx pgx.Tx, structureID uuid.UUID, classID *uuid.UUID) (feeRunSource, error) {
	var src feeRunSource

	var versionID uuid.UUID
	var filed, approved bool
	var filingID *uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT v.id,
		       EXISTS (SELECT 1 FROM fee_regulatory_filings f
		                 JOIN fee_structure_versions fv ON fv.id = f.fee_structure_version_id
		                WHERE fv.fee_structure_id = v.fee_structure_id
		                  AND f.status <> 'draft'),
		       EXISTS (SELECT 1 FROM fee_regulatory_filings f
		                WHERE f.fee_structure_version_id = v.id
		                  AND f.status IN ('approved','approved_with_modification')),
		       (SELECT f.id FROM fee_regulatory_filings f
		         WHERE f.fee_structure_version_id = v.id
		           AND f.status = 'approved_with_modification'
		         ORDER BY f.decided_on DESC NULLS LAST, f.created_at DESC
		         LIMIT 1)
		  FROM fee_structure_versions v
		 WHERE v.fee_structure_id = $1
		   AND v.status = 'active'
		   AND v.effective_from <= CURRENT_DATE
		   AND (v.effective_to IS NULL OR v.effective_to >= CURRENT_DATE)
		 ORDER BY v.effective_from DESC
		 LIMIT 1`, structureID).Scan(&versionID, &filed, &approved, &filingID)
	switch {
	case err == pgx.ErrNoRows:
		// Unversioned: the structure's own lines.
		rows, err := tx.Query(ctx, `
			SELECT fee_head_id, instalment_no, amount_paise
			  FROM fee_structure_items WHERE fee_structure_id = $1
			 ORDER BY instalment_no, fee_head_id`, structureID)
		if err != nil {
			return src, err
		}
		src.Lines, err = scanFeeRunLines(rows)
		return src, err
	case err != nil:
		return src, err
	}

	if filed && !approved {
		return src, errFeeNotApproved
	}
	src.VersionID = &versionID
	src.FilingID = filingID

	// The version's snapshot, with the committee's figure where it differs.
	// A class-specific filing line beats a school-wide one for the same
	// head, which is what DISTINCT ON the version line with that ordering
	// gives.
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (vi.id)
		       vi.fee_head_id, vi.instalment_no, COALESCE(fl.approved_paise, vi.amount_paise)
		  FROM fee_structure_version_items vi
		  LEFT JOIN fee_regulatory_filing_lines fl
		         ON $2::uuid IS NOT NULL
		        AND fl.filing_id = $2
		        AND fl.fee_head_id = vi.fee_head_id
		        AND fl.instalment_no = vi.instalment_no
		        AND (fl.class_id IS NULL OR fl.class_id = $3)
		 WHERE vi.version_id = $1
		 ORDER BY vi.id, fl.class_id IS NULL`, versionID, filingID, classID)
	if err != nil {
		return src, err
	}
	src.Lines, err = scanFeeRunLines(rows)
	return src, err
}

func scanFeeRunLines(rows pgx.Rows) ([]feeRunLine, error) {
	defer rows.Close()
	var out []feeRunLine
	for rows.Next() {
		var l feeRunLine
		if err := rows.Scan(&l.HeadID, &l.Instalment, &l.AmountPaise); err != nil {
			return nil, fmt.Errorf("fee run line: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// forInstalment narrows the lines to one instalment, or keeps them all for a
// whole-year bill, and reports how many instalments the result spans.
func (s feeRunSource) forInstalment(n int, all bool) (lines []feeRunLine, worth int64, instalments int) {
	seen := map[int]bool{}
	for _, l := range s.Lines {
		if !all && l.Instalment != n {
			continue
		}
		lines = append(lines, l)
		worth += l.AmountPaise
		seen[l.Instalment] = true
	}
	instalments = len(seen)
	if instalments == 0 {
		instalments = 1
	}
	return
}
