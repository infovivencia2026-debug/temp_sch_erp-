package main

// Yajur's leave/LOP rules, exactly as the school gave them:
//   - 1 Casual Leave a month; beyond it -> LOP (max_per_month=1, accrual monthly)
//   - 3 late marks = 1 day lost (leave_policy.late_marks_per_lop_day, default 3)
//   - unused CL paid out (encashable = true)
// Idempotent. Report by default; -write applies.

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

func main() {
	write := flag.Bool("write", false, "apply (default: report)")
	flag.Parse()
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)

	fmt.Println("PLAN:")
	fmt.Println("  leave_policy row (school-wide): grace 10 min, late_marks_per_lop_day = 3, LOP on absence/unpaid leave")
	fmt.Println("  leave type: Casual Leave (CL), 12 a year, paid, no carry-forward")
	fmt.Println("  CL rule: accrual monthly, max 1/month (beyond -> LOP), encashable = yes")
	if !*write { fmt.Println("\nREPORT ONLY. Re-run with -write to apply."); return }

	tx, _ := c.Begin(ctx); defer tx.Rollback(ctx)

	// 1) school-wide policy (defaults already: grace 10, late_marks 3)
	if _, err := tx.Exec(ctx, `INSERT INTO leave_policy (institution_id) VALUES ($1)
		ON CONFLICT (institution_id) DO UPDATE SET late_marks_per_lop_day=3, grace_minutes=10, lop_on_absent=true, lop_on_unpaid_leave=true`, inst); err != nil {
		fmt.Println("leave_policy:", err); os.Exit(1)
	}
	// 2) Casual Leave type
	var ltID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM leave_types WHERE institution_id=$1 AND upper(code)='CL' LIMIT 1`, inst).Scan(&ltID)
	if err == pgx.ErrNoRows {
		if err := tx.QueryRow(ctx, `INSERT INTO leave_types (institution_id,name,code,applies_to,annual_quota,is_paid,carry_forward)
			VALUES ($1,'Casual Leave','CL','staff',12,true,false) RETURNING id::text`, inst).Scan(&ltID); err != nil {
			fmt.Println("leave_type:", err); os.Exit(1)
		}
	} else if err != nil { fmt.Println("lookup:", err); os.Exit(1) } else {
		tx.Exec(ctx, `UPDATE leave_types SET annual_quota=12,is_paid=true,carry_forward=false WHERE id=$1`, ltID)
	}
	// 3) CL policy rule
	if _, err := tx.Exec(ctx, `INSERT INTO leave_policy_rules (leave_type_id,institution_id,accrual,encashable,max_per_month,allow_half_day)
		VALUES ($1,$2,'monthly',true,1,true)
		ON CONFLICT (leave_type_id) DO UPDATE SET accrual='monthly',encashable=true,max_per_month=1`, ltID, inst); err != nil {
		fmt.Println("policy_rule:", err); os.Exit(1)
	}
	if err := tx.Commit(ctx); err != nil { fmt.Println("commit:", err); os.Exit(1) }
	fmt.Println("\nCOMMITTED: Casual Leave (1/month, max 1, encashable) + late_marks 3 + LOP on.")
}
