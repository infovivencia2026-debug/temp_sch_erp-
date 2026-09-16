package main

// Install Yajur's FA report-card template (per-institution, Yajur only).
// Report by default; -write applies.

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"
const htmlPath = `C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\83199cc2-e47e-4d80-9957-184f2caae6ec\scratchpad\yajur_report_card.html`

func main() {
	write := flag.Bool("write", false, "apply")
	flag.Parse()
	body, err := os.ReadFile(htmlPath)
	if err != nil { fmt.Println("read:", err); os.Exit(1) }
	fmt.Printf("template %d bytes; contains {{student_name}}=%v {{subject_rows}}=%v\n",
		len(body), contains(string(body), "{{student_name}}"), contains(string(body), "{{subject_rows}}"))
	if !*write { fmt.Println("REPORT ONLY. Re-run with -write."); return }
	ctx := context.Background()
	c, e := pgx.Connect(ctx, os.Getenv("DBURL"))
	if e != nil { fmt.Println("conn", e); os.Exit(1) }
	defer c.Close(ctx)
	if _, err := c.Exec(ctx, `INSERT INTO report_card_templates (institution_id,name,template_html)
		VALUES ($1,'Yajur FA report card',$2)
		ON CONFLICT (institution_id) DO UPDATE SET name=EXCLUDED.name, template_html=EXCLUDED.template_html, updated_at=now()`,
		inst, string(body)); err != nil {
		fmt.Println("save:", err); os.Exit(1)
	}
	fmt.Println("COMMITTED: Yajur report-card template installed.")
}
func contains(s, sub string) bool { for i:=0;i+len(sub)<=len(s);i++{ if s[i:i+len(sub)]==sub {return true} }; return false }
