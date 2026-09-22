package main

/* THE SCHOOL'S FEE REGISTER, PUT INTO THE LEDGER AS IT IS WRITTEN.

   "Yajur Total" is the book the office actually keeps: one row per child, the
   year's fee, the concession, three terms with what was paid and when, and
   books and uniform beside them. Everything loaded before this was a guess at
   that book. This replaces the guess.

   WHAT THE REGISTER SAYS THAT THE GUESS GOT WRONG

   The terms are not equal thirds. An 85,000 fee is 35,000 then 30,000 then
   20,000; a 90,000 fee is 36,000, 32,000, 22,000. And the concession comes off
   the LAST term -- terms one and two are always charged in full. Row 66 proves
   it: 90,000 with 10,000 off, terms of 36,000 and 32,000, and the register's
   own third-term figure is 12,000, which is 80,000 less 68,000.

   So the 324 invoices raised earlier at a third each are withdrawn, the
   structures are rewritten from the register's own figures, and all three
   terms are raised as the school bills them.

   WHAT IS DELIBERATELY NOT INFERRED

   A new child's first term is paid at 36,000 against a 35,000 charge. That
   extra 1,000 is almost certainly the application fee, but the register does
   not say so, so it is not posted as one: the payment is recorded whole and
   the surplus is left unallocated, where it shows as a credit on the family's
   ledger rather than as a fee somebody invented.

   Term fees carry no payment mode in the register, so they are recorded as
   'adjustment' -- an entry in the books rather than a counter collection --
   which is what they are. Books and uniform do carry a mode, and it is kept.
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

// The day the register was exported from the school's sheet. Used only as the
// stated date of a payment the register records without one.
var registerExported = time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)

// Columns of the register, by position: it has repeated "Amount Paid" and
// "Paid on" headers, so a name-keyed lookup cannot tell them apart.
const (
	cName      = 1
	cClass     = 2
	cMobile    = 4
	cTotal     = 6
	cConcess   = 7
	cTerm1     = 9
	cPaid1     = 10
	cOn1       = 11
	cTerm2     = 13
	cPaid2     = 14
	cOn2       = 15
	cTerm3     = 17
	cPaid3     = 18
	cOn3       = 19
	cBooks     = 21
	cBooksPaid = 22
	cBooksMode = 23
	cBooksOn   = 24
	cUnif      = 25
	cUnifPaid  = 26
	cUnifOn    = 27
)

var classOf = map[string]string{
	"NUR": "Nursery", "LKG": "Jr KG", "UKG": "Sr KG", "PP": "Pre Nursery",
	"I": "Grade 1", "II": "Grade 2", "III": "Grade 3", "IV": "Grade 4",
	"V": "Grade 5", "VI": "Grade 6", "VII": "Grade 7", "VIII": "Grade 8",
	"IX": "Grade 9",
}

/*
THE FOUR THE NAME COULD NOT REACH.

	Two are spelt differently in the fee register than on the roll -- SHRESTHA
	against SHRESHTA, "G AADVIKA" against ADVIKA GARNEPALLI -- and no rule on a
	name should be loose enough to bridge those without also joining children
	who merely rhyme. Two more were marked withdrawn in error and so were not on
	the roll to be found at all.

	The school's own admission analysis names all four, so they are stated here
	by admission number rather than guessed at by a cleverer matcher. A person
	checked each one; that is what this map records.
*/
var byHand = map[string]string{
	"NUTHANAKANTI SHRESTHA (N)": "26YPS0083",
	"G AADVIKA ( N)":            "26YPS0011",
	"UBAIDULLA SAAD MOHAMMED":   "24YPS0040",
	"T TRISHAAN":                "25YPS0090",
}

var notLetter = regexp.MustCompile(`[^A-Z ]+`)
var money = regexp.MustCompile(`[0-9]+`)
var dateRe = regexp.MustCompile(`(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})`)

type child struct {
	id    uuid.UUID
	admn  string
	name  string
	words map[string]bool
	class string
	phone string
}

func words(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(notLetter.ReplaceAllString(strings.ToUpper(s), " ")) {
		if len(w) > 1 {
			out[w] = true
		}
	}
	return out
}

/*
AN AMOUNT CELL THAT IS ACTUALLY A DATE.

	Five rows have the payment date typed into the "Amount Paid" column and the
	rest of the row left blank -- PUDI SADVIK's term 1 reads 22.08.26 where a
	figure should be. Reading the first number out of that gives a payment of
	Rs 22, which is how a typing slip becomes a receipt. The true amount is not
	recorded anywhere, so these are reported and left for the office rather than
	assumed to be the full term.
*/
func looksLikeDate(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	m := dateRe.FindString(s)
	return m != "" && len(m) >= len(s)-2
}

// rupees reads the first number in a cell. The register writes "4000(FULL)"
// and "2350(1 PAIR + 1 PE)"; the figure is the part that matters.
func rupees(s string) int64 {
	m := money.FindString(strings.ReplaceAll(s, ",", ""))
	if m == "" {
		return 0
	}
	v, err := strconv.ParseInt(m, 10, 64)
	if err != nil {
		return 0
	}
	return v * 100
}

// firstDate reads the earliest date a cell mentions. Several cells name two
// ("17.06.26 & 03.09.26") because the family paid in parts against one figure;
// the register does not split the amount, so neither does this.
func firstDate(s string) (time.Time, string, bool) {
	for _, m := range dateRe.FindAllStringSubmatch(s, -1) {
		d, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		if y < 100 {
			y += 2000
		}
		if d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2020 || y > 2030 {
			continue
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		note := ""
		if len(dateRe.FindAllString(s, -1)) > 1 {
			note = "register records: " + strings.TrimSpace(s)
		}
		return t, note, true
	}
	return time.Time{}, "", false
}

func mode(s string) (string, string) {
	u := strings.ToUpper(s)
	switch {
	case strings.Contains(u, "PHONEPE") || strings.Contains(u, "UPI"):
		return "upi", s
	case strings.Contains(u, "CASH"):
		return "cash", s
	case strings.Contains(u, "ONLINE") || strings.Contains(u, "PHONE"):
		return "netbanking", s
	}
	return "adjustment", s
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

	var yearID, campusID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE institution_id=$1 AND is_current`, instID).Scan(&yearID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM campuses WHERE institution_id=$1 LIMIT 1`, instID).Scan(&campusID); err != nil {
		panic(err)
	}

	head := func(code, name string, recurring bool) uuid.UUID {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO fee_heads (institution_id, name, code, is_recurring)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (institution_id, code) DO UPDATE SET name = fee_heads.name
			RETURNING id`, instID, name, code, recurring).Scan(&id); err != nil {
			panic(err)
		}
		return id
	}
	annu := head("ANNU", "Annual Fee", true)
	book := head("BOOK", "Books & Stationery", false)
	unif := head("UNIF", "Uniform", false)

	// --- the roll, for the join ------------------------------------------
	var roll []child
	rows, err := tx.Query(ctx, `
		SELECT s.id, s.admission_no,
		       trim(s.first_name || ' ' || COALESCE(s.middle_name,'') || ' ' || COALESCE(s.last_name,'')),
		       COALESCE(c.name,''),
		       COALESCE((SELECT g.phone FROM student_guardians sg
		                   JOIN guardians g ON g.id = sg.guardian_id
		                  WHERE sg.student_id = s.id AND g.phone IS NOT NULL
		                  ORDER BY (lower(g.relation) LIKE 'father%') DESC, sg.is_primary DESC
		                  LIMIT 1), '')
		  FROM students s
		  LEFT JOIN enrollments e ON e.student_id = s.id AND e.status='active'
		  LEFT JOIN classes c ON c.id = e.class_id
		 WHERE s.institution_id=$1 AND s.status='active'`, instID)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var c child
		if err := rows.Scan(&c.id, &c.admn, &c.name, &c.class, &c.phone); err != nil {
			panic(err)
		}
		c.words = words(c.name)
		roll = append(roll, c)
	}
	rows.Close()

	classID := map[string]uuid.UUID{}
	crows, err := tx.Query(ctx, `SELECT id, name FROM classes WHERE institution_id=$1`, instID)
	if err != nil {
		panic(err)
	}
	for crows.Next() {
		var id uuid.UUID
		var n string
		if err := crows.Scan(&id, &n); err != nil {
			panic(err)
		}
		classID[n] = id
	}
	crows.Close()

	// --- 1. withdraw what was raised on the wrong split ------------------
	//
	// The arrears carried onto those invoices must be undone with them, or the
	// 2025-26 bills they settled would stay marked paid against a bill that no
	// longer exists.
	var carried int
	if err := tx.QueryRow(ctx, `
		WITH cf AS (
			DELETE FROM invoice_carry_forwards c
			 USING invoices i
			 WHERE c.to_invoice_id = i.id AND i.institution_id=$1 AND i.academic_year_id=$2
			 RETURNING c.payment_id
		), al AS (
			DELETE FROM payment_allocations a USING cf WHERE a.payment_id = cf.payment_id RETURNING 1
		)
		SELECT count(*) FROM al`, instID, yearID).Scan(&carried); err != nil {
		panic(err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM payments p
		 WHERE p.institution_id=$1 AND p.mode='adjustment'
		   AND p.remarks LIKE 'Carried forward to INV/%'
		   AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id)`,
		instID); err != nil {
		panic(err)
	}
	var scrapped int
	if err := tx.QueryRow(ctx, `
		WITH gone AS (
			DELETE FROM invoices WHERE institution_id=$1 AND academic_year_id=$2 RETURNING 1
		) SELECT count(*) FROM gone`, instID, yearID).Scan(&scrapped); err != nil {
		panic(err)
	}

	/* AND THE RECEIPTS THIS LOAD WROTE LAST TIME.

	   Deleting an invoice takes its allocations with it and leaves the payment
	   standing. Run this twice and the school has two receipts for every rupee
	   the register records -- a crore and a half of collections counted again,
	   and nothing in the totals to show which half was real.

	   Only the rows this program wrote are removed, identified by their own
	   receipt series. A payment taken at the counter, or carried in from an
	   earlier year, is not in that series and is not touched. */
	var reissued int
	if err := tx.QueryRow(ctx, `
		WITH gone AS (
			DELETE FROM payments
			 WHERE institution_id=$1
			   AND receipt_no LIKE 'RCT/2026-27/%'
			 RETURNING 1
		) SELECT count(*) FROM gone`, instID).Scan(&reissued); err != nil {
		panic(err)
	}

	fmt.Printf("withdrew %d invoices and %d receipts from the previous load (%d arrears carries undone)\n\n",
		scrapped, reissued, carried)

	// --- 2. the real term split, read out of the register ----------------
	type split struct{ t1, t2, t3 int64 }
	perClass := map[string]split{}
	for i, r := range recs {
		if i == 0 || len(r) <= cTerm3 {
			continue
		}
		cn := classOf[strings.ToUpper(strings.TrimSpace(r[cClass]))]
		if cn == "" {
			continue
		}
		if _, seen := perClass[cn]; seen {
			continue
		}
		total, t1, t2 := rupees(r[cTotal]), rupees(r[cTerm1]), rupees(r[cTerm2])
		if total == 0 || t1 == 0 || t2 == 0 {
			continue
		}
		perClass[cn] = split{t1, t2, total - t1 - t2}
	}

	for cn, s := range perClass {
		cid, ok := classID[cn]
		if !ok {
			continue
		}
		var sid uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT fs.id FROM fee_structures fs
			 WHERE fs.institution_id=$1 AND fs.academic_year_id=$2 AND fs.class_id=$3
			   AND upper(fs.name) LIKE 'TUTION%'`, instID, yearID, cid).Scan(&sid)
		if err != nil {
			fmt.Printf("  %-13s no tuition structure, skipped\n", cn)
			continue
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM fee_structure_items WHERE fee_structure_id=$1 AND fee_head_id=$2`,
			sid, annu); err != nil {
			panic(err)
		}
		for k, amt := range []int64{s.t1, s.t2, s.t3} {
			if amt <= 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO fee_structure_items (institution_id, fee_structure_id,
				                                 fee_head_id, instalment_no, amount_paise)
				VALUES ($1,$2,$3,$4,$5)`, instID, sid, annu, k+1, amt); err != nil {
				panic(err)
			}
		}
		fmt.Printf("  %-13s %d / %d / %d\n", cn, s.t1/100, s.t2/100, s.t3/100)
	}

	// --- 3. every child's bills and receipts -----------------------------
	seq := 0
	nextNo := func() string {
		seq++
		return fmt.Sprintf("INV/2026-27/%05d", seq)
	}
	rseq := 0
	nextReceipt := func() string {
		rseq++
		return fmt.Sprintf("RCT/2026-27/%05d", rseq)
	}

	raise := func(sid uuid.UUID, inst int, headID uuid.UUID, desc string,
		amount, discount int64, due time.Time) (uuid.UUID, error) {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, instalment_no, issued_on, due_on,
			                      gross_paise, discount_paise, status)
			VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,'unpaid')
			RETURNING id`,
			instID, campusID, sid, yearID, nextNo(), inst, due, amount, discount).Scan(&id); err != nil {
			return id, err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
			                           description, amount_paise, discount_paise)
			VALUES ($1,$2,$3,$4,$5,$6)`, instID, id, headID, desc, amount, discount)
		return id, err
	}

	pay := func(sid, invID uuid.UUID, amount int64, on time.Time, md, remark string) error {
		var payID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
			                      amount_paise, allocated_paise, mode, paid_on, status, remarks)
			VALUES ($1,$2,$3,$4,$5,0,$6,$7,'success',$8)
			RETURNING id`,
			instID, campusID, sid, nextReceipt(), amount, md, on, remark).Scan(&payID); err != nil {
			return err
		}
		var net int64
		if err := tx.QueryRow(ctx,
			`SELECT net_paise - paid_paise FROM invoices WHERE id=$1`, invID).Scan(&net); err != nil {
			return err
		}
		alloc := amount
		if alloc > net {
			// The surplus stays unallocated: a credit on the family's ledger,
			// not a fee nobody charged.
			alloc = net
		}
		if alloc <= 0 {
			return nil
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			VALUES ($1,$2,$3,$4)`, instID, payID, invID, alloc); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE payments SET allocated_paise=$2 WHERE id=$1`, payID, alloc)
		return err
	}

	var billed, receipts, unmatched, noDate, shifted int
	var demanded, collected, concessions, surplus int64
	var skipped []string

	for i, r := range recs {
		if i == 0 || len(r) <= cTerm3 {
			continue
		}
		name := strings.TrimSpace(r[cName])
		if name == "" {
			continue
		}
		cn := classOf[strings.ToUpper(strings.TrimSpace(r[cClass]))]
		want := words(name)
		if len(want) == 0 {
			continue
		}

		var hits []child
		if admn, ok := byHand[name]; ok {
			for _, c := range roll {
				if strings.EqualFold(c.admn, admn) {
					hits = []child{c}
					break
				}
			}
			if len(hits) == 0 {
				unmatched++
				skipped = append(skipped, fmt.Sprintf(
					"row %-4d %-34s named as %s, but that admission number is not on the active roll",
					i+1, name, admn))
				continue
			}
		}
		for _, c := range roll {
			if len(hits) == 1 {
				break
			}
			if c.class != cn {
				continue
			}
			all := true
			for w := range want {
				if !c.words[w] {
					all = false
					break
				}
			}
			if all {
				hits = append(hits, c)
			}
		}
		if len(hits) != 1 {
			// Same class, and every word matches to within a shared prefix --
			// which is what ALANKRITHA against ALANKRITA amounts to.
			var near []child
			for _, c := range roll {
				if c.class != cn {
					continue
				}
				got := 0
				for w := range want {
					for cw := range c.words {
						if w == cw || (len(w) > 4 && len(cw) > 4 && pfx(w, cw) >= 5) {
							got++
							break
						}
					}
				}
				if got == len(want) {
					near = append(near, c)
				}
			}
			if len(near) == 1 {
				hits = near
			}
		}
		if len(hits) != 1 {
			/* THE FATHER'S NUMBER, when the name will not settle it.
			   Thirteen children in this register are spelt differently enough
			   that no rule on the name finds them, and the mobile picks out
			   exactly one family in the class. */
			if m := strings.TrimSpace(colAt(r, cMobile)); len(m) >= 10 {
				tail := m[len(m)-10:]
				var byPhone []child
				for _, c := range roll {
					if c.class == cn && len(c.phone) >= 10 && strings.HasSuffix(c.phone, tail) {
						byPhone = append(byPhone, c)
					}
				}
				if len(byPhone) == 1 {
					hits = byPhone
				}
			}
		}
		if len(hits) != 1 {
			unmatched++
			skipped = append(skipped, fmt.Sprintf("row %-4d %-34s %s  NOT MATCHED, fees not loaded", i+1, name, cn))
			continue
		}
		kid := hits[0]

		s := perClass[cn]
		conc := rupees(colAt(r, cConcess))

		/* THE CONCESSION EATS THE YEAR FROM THE BACK.

		   Taking it all off the final term works while it is smaller than that
		   term, and silently loses money when it is not. A 42,500 concession on
		   an 85,000 fee leaves a family owing 42,500, but the final term is only
		   20,000 -- capping there would have billed them 65,000 and quietly
		   thrown 22,500 of promised discount away.

		   What the register actually does is charge the terms in order until the
		   net fee is used up: 35,000 for term one, 7,500 for term two, nothing
		   for term three. So the charge is the full term and the discount is
		   whatever that term cannot be paid out of what remains -- which for
		   every small concession reduces to "all of it on the last term", the
		   case the register shows on its face. */
		net := s.t1 + s.t2 + s.t3 - conc
		if net < 0 {
			net = 0
		}
		charge := make([]int64, 3)
		left := net
		for k, full := range []int64{s.t1, s.t2, s.t3} {
			c := full
			if c > left {
				c = left
			}
			charge[k] = c
			left -= c
		}

		terms := []struct {
			no      int
			amount  int64
			disc    int64
			paid    int64
			on      string
			rawPaid string
		}{
			{1, s.t1, s.t1 - charge[0], rupees(colAt(r, cPaid1)), colAt(r, cOn1), colAt(r, cPaid1)},
			{2, s.t2, s.t2 - charge[1], rupees(colAt(r, cPaid2)), colAt(r, cOn2), colAt(r, cPaid2)},
			{3, s.t3, s.t3 - charge[2], rupees(colAt(r, cPaid3)), colAt(r, cOn3), colAt(r, cPaid3)},
		}
		concessions += s.t1 + s.t2 + s.t3 - net
		for _, t := range terms {
			if t.amount <= 0 {
				continue
			}
			due := time.Now().AddDate(0, 0, 14)
			invID, err := raise(kid.id, t.no, annu,
				fmt.Sprintf("Annual Fee, term %d", t.no), t.amount, t.disc, due)
			if err != nil {
				panic(fmt.Errorf("row %d term %d: %w", i+1, t.no, err))
			}
			billed++
			demanded += t.amount - t.disc
			if looksLikeDate(t.rawPaid) {
				shifted++
				skipped = append(skipped, fmt.Sprintf(
					"row %-4d %-30s term %d: the register has a date (%s) where the amount goes -- nothing posted",
					i+1, name, t.no, strings.TrimSpace(t.rawPaid)))
				continue
			}
			if t.paid <= 0 {
				continue
			}
			/* A PAYMENT WITH NO DATE IS STILL A PAYMENT.
			   Three families paid and the register left the date cell empty.
			   Dropping the money to protect a date would misstate the balance,
			   so it is posted on the day the register was exported and says so,
			   which is honest about what is and is not known. */
			on, note, ok := firstDate(t.on)
			if !ok {
				noDate++
				on = registerExported
				note = "the register does not record the date; posted as at the date the register was exported"
			}
			remark := fmt.Sprintf("Term %d, from the school's fee register", t.no)
			if note != "" {
				remark += ". " + note
			}
			if err := pay(kid.id, invID, t.paid, on, "adjustment", remark); err != nil {
				panic(fmt.Errorf("row %d term %d payment: %w", i+1, t.no, err))
			}
			receipts++
			collected += t.paid
			if over := t.paid - (t.amount - t.disc); over > 0 {
				surplus += over
			}
		}

		// Books and uniform: charged only where the register names a figure.
		extras := []struct {
			amount int64
			paid   int64
			on     string
			md     string
			headID uuid.UUID
			label  string
		}{
			{rupees(r[cBooks]), rupees(r[cBooksPaid]), colAt(r, cBooksOn), colAt(r, cBooksMode), book, "Books & stationery"},
			{rupees(r[cUnif]), rupees(r[cUnifPaid]), colAt(r, cUnifOn), "", unif, "Uniform"},
		}
		for k, e := range extras {
			if e.amount <= 0 {
				continue
			}
			due := time.Now().AddDate(0, 0, 14)
			invID, err := raise(kid.id, 10+k, e.headID, e.label, e.amount, 0, due)
			if err != nil {
				panic(fmt.Errorf("row %d %s: %w", i+1, e.label, err))
			}
			billed++
			demanded += e.amount
			if e.paid <= 0 {
				continue
			}
			on, note, ok := firstDate(e.on)
			if !ok {
				noDate++
				on = registerExported
				note = "the register does not record the date; posted as at the date the register was exported"
			}
			md, raw := mode(e.md)
			remark := e.label + ", from the school's fee register"
			if raw != "" {
				remark += ". Register says: " + strings.TrimSpace(raw)
			}
			if note != "" {
				remark += ". " + note
			}
			if err := pay(kid.id, invID, e.paid, on, md, remark); err != nil {
				panic(err)
			}
			receipts++
			collected += e.paid
		}
	}

	// --- 4. the concessions, recorded as concessions ---------------------
	//
	// The discount is already on the term 3 line. This records WHY, so the
	// discount book and Student 360 can answer for it.
	var concRows int
	for i, r := range recs {
		if i == 0 || len(r) <= cConcess {
			continue
		}
		conc := rupees(r[cConcess])
		if conc <= 0 {
			continue
		}
		name := strings.TrimSpace(r[cName])
		cn := classOf[strings.ToUpper(strings.TrimSpace(r[cClass]))]
		want := words(name)
		var kid *child
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
		if kid == nil {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO fee_concessions (institution_id, student_id, academic_year_id,
			                             fee_head_id, kind, amount_paise, reason, approved_at)
			SELECT $1,$2,$3,$4,'other',$5,$6,now()
			 WHERE NOT EXISTS (SELECT 1 FROM fee_concessions
			                    WHERE student_id=$2 AND academic_year_id=$3 AND fee_head_id=$4)`,
			instID, kid.id, yearID, annu, conc,
			"From the school's fee register; taken off the final term"); err != nil {
			panic(err)
		}
		concRows++
	}

	fmt.Printf("\nbills raised:      %d\nreceipts recorded: %d\nconcessions:       %d\n",
		billed, receipts, concRows)
	fmt.Printf("\ndemanded (net of concession) Rs %d\ncollected                    Rs %d\noutstanding                  Rs %d\n",
		demanded/100, collected/100, (demanded-collected)/100)
	fmt.Printf("concession given             Rs %d\npaid over the charge         Rs %d (left as credit)\n",
		concessions/100, surplus/100)
	fmt.Printf("\nchildren not matched: %d\npayments dated the export day: %d\ncolumn-shift rows left alone: %d\n", unmatched, noDate, shifted)
	for _, s := range skipped {
		fmt.Println("  " + s)
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

func colAt(r []string, i int) string {
	if i < len(r) {
		return r[i]
	}
	return ""
}

func pfx(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}
