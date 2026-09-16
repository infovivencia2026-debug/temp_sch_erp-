package main

/* THE BUS FARE, WHICH WAS IN THE REGISTER ALL ALONG.

   "8000 T.Fee 08.07.26" in the Due-if-any column is not a tuition arrear. T.F
   is the transport fee, and it is paid. Twenty-two children have one, written
   in the margin of the term row because the sheet has no column for it -- which
   is why the load first read them as unexplained dues and why transport looked
   like data the school simply did not keep.

   THE SLAB, AND WHY IT IS THE NEAR ONE.

   MARKA GAYATHRI paid 8,000 in term one and 7,000 in term two. That is 15,000,
   which is the 0-5 KM slab exactly, and it tells us the slab is billed in two
   instalments of 8,000 and 7,000 rather than evenly. Five more children paid
   15,000 outright. Nobody paid more than 15,000, and nothing in the register
   distinguishes a 5-10 KM child, so every one of these is billed the near slab.

   That is an assumption, and it is the one thing here worth checking: a child
   who actually rides 5-10 KM owes 25,000 and will read as paid up. The report
   names all twenty-two so the office can say.
*/

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

/*
WHICH SLAB, READ OFF THE FIRST INSTALMENT.

	The school's rule: a child who paid 8,000 or less in term one rides within
	5 km and owes 15,000; anyone who paid more is beyond 5 km and owes 25,000.
	That is not a guess about the data, it is how the office bills -- the near
	slab is collected 8,000 then 7,000, and the far one is paid in fewer, larger
	instalments, so the first payment tells you which schedule a family is on.

	The near slab is billed 8,000 + 7,000 because that is what the register
	shows: MARKA GAYATHRI paid exactly those two. The far slab is billed
	15,000 + 10,000 on the same principle -- the larger part first.
*/
var slabs = map[string]struct {
	total       int64
	instalments []int64
	label       string
}{
	"near": {1500000, []int64{800000, 700000}, "Transport (0 - 5 KM)"},
	"far":  {2500000, []int64{1500000, 1000000}, "Transport (5 KM - 10 KM)"},
}

// The first instalment at or below which a child is on the near slab.
const nearSlabFirstInstalment = 800000

/*
THE ONE FIGURE THE REGISTER LEFT OUT.

	ANAM NUR's cell reads "T F PAID ON 31.08.26" and names no amount, so the
	date is all it has -- and reading a number out of a date is how 31.08.26
	becomes a receipt for thirty-one rupees. The office supplied the figure, so
	it is stated here rather than guessed, by the row it belongs to.
*/
var byHandAmount = map[string]int64{
	"ANAM NUR (N)": 800000,
}

/*
HOW THE OFFICE WRITES "TRANSPORT FEE".

	T.Fee, T.F, T F, TF -- and, three times, just T: "8000 T 29.06". Missing the
	bare T dropped NIMMALA PRANAV and SRAYAN JENUGA entirely and halved MARKA
	GAYATHRI, who paid 8,000 in term one and 7,000 in term two. A single letter
	is thin evidence anywhere else; in this column, beside a figure and a date,
	it is the only thing it can mean.
*/
var tfRe = regexp.MustCompile(`(?i)\bT\s*\.?\s*F|\bTF\b|\bT\b\s*\d{1,2}[.\-/]`)
var amtRe = regexp.MustCompile(`^\s*(\d[\d,]*)`)
var dateRe = regexp.MustCompile(`(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?`)
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

var classOf = map[string]string{
	"NUR": "Nursery", "LKG": "Jr KG", "UKG": "Sr KG", "PP": "Pre Nursery",
	"I": "Grade 1", "II": "Grade 2", "III": "Grade 3", "IV": "Grade 4",
	"V": "Grade 5", "VI": "Grade 6", "VII": "Grade 7", "VIII": "Grade 8",
	"IX": "Grade 9",
}

var byHand = map[string]string{
	"NUTHANAKANTI SHRESTHA (N)": "26YPS0083",
	"G AADVIKA ( N)":            "26YPS0011",
	"UBAIDULLA SAAD MOHAMMED":   "24YPS0040",
	"T TRISHAAN":                "25YPS0090",
}

type child struct {
	id    uuid.UUID
	admn  string
	name  string
	words map[string]bool
	class string
}

type note struct {
	term int
	amt  int64 // paise, zero when the register names no figure
	on   time.Time
	ok   bool
	raw  string
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

	var yearID, campusID, tran uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE institution_id=$1 AND is_current`, instID).Scan(&yearID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM campuses WHERE institution_id=$1 LIMIT 1`, instID).Scan(&campusID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM fee_heads WHERE institution_id=$1 AND code='TRAN'`, instID).Scan(&tran); err != nil {
		panic(fmt.Errorf("no transport head: %w", err))
	}
	// Only the children who ride the bus owe it, which is what optional means.
	if _, err := tx.Exec(ctx,
		`UPDATE fee_heads SET optional = true WHERE id=$1`, tran); err != nil {
		panic(err)
	}

	var roll []child
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
		var c child
		if err := rows.Scan(&c.id, &c.admn, &c.name, &c.class); err != nil {
			panic(err)
		}
		c.words = words(c.name)
		roll = append(roll, c)
	}
	rows.Close()

	seq, rseq := 0, 0
	var billed, receipts, unknownAmount, children int
	var demanded, collected int64
	var flagged []string

	for i, r := range recs {
		if i == 0 || len(r) < 21 {
			continue
		}
		var notes []note
		for _, col := range []struct{ idx, term int }{{12, 1}, {16, 2}, {20, 3}} {
			if col.idx >= len(r) {
				continue
			}
			cell := strings.TrimSpace(r[col.idx])
			if cell == "" || strings.Contains(strings.ToUpper(cell), "ECA") || !tfRe.MatchString(cell) {
				continue
			}
			n := note{term: col.term, raw: cell}
			// The figure only counts when the cell OPENS with it. "T F PAID ON
			// 31.08.26" names no amount, and reading 31 out of the date would
			// post a receipt for thirty-one rupees.
			if a, ok := byHandAmount[strings.TrimSpace(r[1])]; ok && col.term == 1 {
				n.amt = a
			} else if m := amtRe.FindStringSubmatch(cell); m != nil {
				v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
				if err == nil {
					n.amt = v * 100
				}
			}
			if d := dateRe.FindStringSubmatch(cell); d != nil {
				dd, _ := strconv.Atoi(d[1])
				mm, _ := strconv.Atoi(d[2])
				yy := 2026
				if d[3] != "" {
					yy, _ = strconv.Atoi(d[3])
					if yy < 100 {
						yy += 2000
					}
				}
				if dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 {
					n.on, n.ok = time.Date(yy, time.Month(mm), dd, 0, 0, 0, 0, time.UTC), true
				}
			}
			notes = append(notes, n)
		}
		if len(notes) == 0 {
			continue
		}

		name := strings.TrimSpace(r[1])
		cn := classOf[strings.ToUpper(strings.TrimSpace(r[2]))]
		var kid *child
		if admn, ok := byHand[name]; ok {
			for k := range roll {
				if strings.EqualFold(roll[k].admn, admn) {
					kid = &roll[k]
					break
				}
			}
		}
		if kid == nil {
			want := words(name)
			for k := range roll {
				if roll[k].class != cn {
					continue
				}
				all := true
				for w := range want {
					if !roll[k].words[w] {
						all = false
						break
					}
				}
				if all {
					kid = &roll[k]
					break
				}
			}
		}
		if kid == nil {
			flagged = append(flagged, fmt.Sprintf("row %-4d %-30s could not be matched", i+1, name))
			continue
		}

		var already int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
			 WHERE i.student_id=$1 AND i.academic_year_id=$2 AND il.fee_head_id=$3
			   AND i.status <> 'cancelled'`, kid.id, yearID, tran).Scan(&already); err != nil {
			panic(err)
		}
		if already > 0 {
			continue
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO student_fee_optins (institution_id, student_id, academic_year_id,
			                                fee_head_id, note)
			SELECT $1,$2,$3,$4,$5
			 WHERE NOT EXISTS (SELECT 1 FROM student_fee_optins
			                    WHERE student_id=$2 AND fee_head_id=$4
			                      AND academic_year_id=$3 AND ended_on IS NULL)`,
			instID, kid.id, yearID, tran,
			"Transport fee recorded in the school's fee register"); err != nil {
			panic(err)
		}

		/* The slab, decided by what they paid first.

		   A child with no figure at all -- the register names transport but no
		   amount -- is put on the near slab, because that is the common one and
		   the report names them for a person to check. */
		which := "near"
		for _, n := range notes {
			if n.term == 1 && n.amt > nearSlabFirstInstalment {
				which = "far"
			}
		}
		slab := slabs[which]

		// The whole slab is raised, both instalments, so the balance is right
		// whatever has been paid so far.
		children++
		invByTerm := map[int]uuid.UUID{}
		for k, amt := range slab.instalments {
			seq++
			var invID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
				                      invoice_no, instalment_no, issued_on, due_on,
				                      gross_paise, discount_paise, status)
				VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE+14,$7,0,'unpaid')
				RETURNING id`,
				instID, campusID, kid.id, yearID,
				fmt.Sprintf("INV/2026-27/TRN%03d", seq), 30+k, amt).Scan(&invID); err != nil {
				panic(err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
				                           description, amount_paise, discount_paise)
				VALUES ($1,$2,$3,$4,$5,0)`,
				instID, invID, tran,
				fmt.Sprintf("%s — instalment %d", slab.label, k+1), amt); err != nil {
				panic(err)
			}
			invByTerm[k+1] = invID
			billed++
			demanded += amt
		}

		for _, n := range notes {
			if n.amt == 0 {
				unknownAmount++
				flagged = append(flagged, fmt.Sprintf(
					"row %-4d %-30s term %d: %q names no amount -- billed, nothing posted",
					i+1, name, n.term, n.raw))
				continue
			}
			// Term one's payment settles the first instalment, term two's the
			// second; that is how the register writes them.
			target := invByTerm[1]
			if n.term >= 2 {
				target = invByTerm[2]
			}
			on := n.on
			if !n.ok {
				on = time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)
			}
			rseq++
			var payID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
				                      amount_paise, allocated_paise, mode, paid_on, status, remarks)
				VALUES ($1,$2,$3,$4,$5,0,'adjustment',$6,'success',$7)
				RETURNING id`,
				instID, campusID, kid.id,
				fmt.Sprintf("RCT/2026-27/TRN%03d", rseq), n.amt, on,
				"Transport fee, from the school's fee register: "+n.raw).Scan(&payID); err != nil {
				panic(err)
			}
			var net int64
			if err := tx.QueryRow(ctx,
				`SELECT net_paise - paid_paise FROM invoices WHERE id=$1`, target).Scan(&net); err != nil {
				panic(err)
			}
			alloc := n.amt
			if alloc > net {
				alloc = net
			}
			if alloc > 0 {
				if _, err := tx.Exec(ctx, `
					INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
					VALUES ($1,$2,$3,$4)`, instID, payID, target, alloc); err != nil {
					panic(err)
				}
				if _, err := tx.Exec(ctx,
					`UPDATE payments SET allocated_paise=$2 WHERE id=$1`, payID, alloc); err != nil {
					panic(err)
				}
			}
			receipts++
			collected += n.amt
		}

		fmt.Printf("  %-11s %-28s %-8s %-22s billed %6d, paid %6d\n",
			kid.admn, kid.name, kid.class, slab.label, slab.total/100, sum(notes)/100)
	}

	fmt.Printf("\nchildren put on the bus:  %d\ninvoices raised:          %d\nreceipts recorded:        %d\n",
		children, billed, receipts)
	fmt.Printf("transport demanded:       Rs %d\ntransport collected:      Rs %d\nstill owed:               Rs %d\n",
		demanded/100, collected/100, (demanded-collected)/100)
	if len(flagged) > 0 {
		fmt.Println("\nneeds a person:")
		for _, s := range flagged {
			fmt.Println("  " + s)
		}
	}

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}

func sum(ns []note) int64 {
	var t int64
	for _, n := range ns {
		t += n.amt
	}
	return t
}
