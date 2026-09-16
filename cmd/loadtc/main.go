package main

/* THE TRANSFER-CERTIFICATE REGISTER, for the children who left in 2025-26.

   Fifty-one children, each with the date the school closed their year, whether
   a certificate was applied for or issued, and for twenty of them the
   certificate number itself.

   THREE THINGS THIS IS CAREFUL ABOUT.

   The date is 2026-03-31 for every one of them. That is the year ending, not
   fifty-one children walking out on the same afternoon, and it is written as
   such -- but it is the school's own year-end and far better than the two bulk
   stamps that were there before, which matched no record anywhere.

   The reason already on the record wins. The file says "TC 42817 issued
   (2025-26 TC register)", which is a restatement of the other columns; the
   database says "moved to canada" and "the parent feels the fee is more and
   asking 50%", which is what somebody in the office actually knew. Where a
   child has no reason at all, the file's is better than nothing.

   And only a child whose certificate was issued becomes 'transferred'. The
   twenty-two who simply did not return for 2026-27 have no certificate and
   were not transferred anywhere; calling them so would put a document in the
   record that does not exist.
*/

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
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
	rd := csv.NewReader(f)
	rd.FieldsPerRecord = -1
	recs, err := rd.ReadAll()
	if err != nil {
		panic(err)
	}
	col := map[string]int{}
	for i, h := range recs[0] {
		col[strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))] = i
	}
	get := func(r []string, name string) string {
		i, ok := col[name]
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

	var dated, transferred, reasoned, tcs, absent, active int
	for i, r := range recs {
		if i == 0 || len(r) == 0 {
			continue
		}
		admn := strings.ToUpper(get(r, "admission_no"))
		if admn == "" {
			continue
		}
		exit := get(r, "exit_date")
		tcNo := get(r, "tc_no")
		fileReason := get(r, "reason")

		var sid uuid.UUID
		var status string
		var reason *string
		if err := tx.QueryRow(ctx, `
			SELECT id, status, exit_reason FROM students
			 WHERE institution_id=$1 AND upper(admission_no)=$2`,
			instID, admn).Scan(&sid, &status, &reason); err != nil {
			absent++
			fmt.Printf("  %-11s not on the roll\n", admn)
			continue
		}
		// A child the school still teaches is not a leaver, whatever an old
		// register says. Two were already found wrongly withdrawn; this must
		// not put them back.
		if status == "active" {
			active++
			fmt.Printf("  %-11s is ACTIVE -- left alone\n", admn)
			continue
		}

		if exit != "" {
			tag, err := tx.Exec(ctx, `
				UPDATE students SET exit_date = $2::date, updated_at = now()
				 WHERE id = $1 AND exit_date IS NULL`, sid, exit)
			if err != nil {
				panic(err)
			}
			dated += int(tag.RowsAffected())
		}

		if tcNo != "" {
			tag, err := tx.Exec(ctx, `
				UPDATE students SET status = 'transferred', updated_at = now()
				 WHERE id = $1 AND status = 'withdrawn'`, sid)
			if err != nil {
				panic(err)
			}
			transferred += int(tag.RowsAffected())

			// The certificate number, appended to what the office wrote rather
			// than replacing it. students has no column for a TC it issued --
			// prior_tc_no is the one a child arrived with.
			tag, err = tx.Exec(ctx, `
				UPDATE students
				   SET exit_reason = COALESCE(NULLIF(exit_reason,''),'') ||
				                     CASE WHEN COALESCE(exit_reason,'') = '' THEN '' ELSE ' ' END ||
				                     '(TC ' || $2 || ')',
				       updated_at = now()
				 WHERE id = $1 AND COALESCE(exit_reason,'') NOT LIKE '%' || $2 || '%'`, sid, tcNo)
			if err != nil {
				panic(err)
			}
			tcs += int(tag.RowsAffected())
		}

		if (reason == nil || strings.TrimSpace(*reason) == "") && fileReason != "" {
			if _, err := tx.Exec(ctx,
				`UPDATE students SET exit_reason = $2, updated_at = now() WHERE id = $1`,
				sid, fileReason); err != nil {
				panic(err)
			}
			reasoned++
		}
	}

	fmt.Printf("\nleaving dates filled:    %d\nmarked transferred:      %d\n", dated, transferred)
	fmt.Printf("TC numbers recorded:     %d\nreasons filled in:       %d\n", tcs, reasoned)
	fmt.Printf("not on the roll:         %d\nstill active, untouched: %d\n", absent, active)

	rows, err := tx.Query(ctx, `
		SELECT status, count(*), count(exit_date), count(exit_reason)
		  FROM students WHERE institution_id=$1 GROUP BY 1 ORDER BY 2 DESC`, instID)
	if err != nil {
		panic(err)
	}
	fmt.Println("\nthe roll now:")
	for rows.Next() {
		var s string
		var n, d, re int
		if err := rows.Scan(&s, &n, &d, &re); err != nil {
			panic(err)
		}
		fmt.Printf("  %-12s %3d   with a leaving date %3d   with a reason %3d\n", s, n, d, re)
	}
	rows.Close()

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
