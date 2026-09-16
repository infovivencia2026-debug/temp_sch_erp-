package main
import("context";"fmt";"os";"strings";"github.com/jackc/pgx/v5")
const inst="f0455c35-f2f2-4b4e-86ef-05f40933f39c"
func main(){c,_:=pgx.Connect(context.Background(),os.Getenv("DBURL"));defer c.Close(context.Background())
 var name,html string;c.QueryRow(context.Background(),`SELECT name,template_html FROM report_card_templates WHERE institution_id=$1`,inst).Scan(&name,&html)
 fmt.Printf("Yajur template: %q (%d bytes) has chart token=%v\n",name,len(html),strings.Contains(html,"performance_chart"))}
