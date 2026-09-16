package main

/* CAN THE REGISTER BE MATCHED TO THE ROLL AT ALL?

   The fee register names children; it does not number them. Every other sheet
   the school keeps is keyed by admission number, so this one has to be joined
   on the name, and a name is the least reliable key there is: "PABBA
   ALANKRITHA (N)" here is "ALANKRITA PABBA" in the student list, word order
   reversed, a spelling apart, with a "(N)" for new.

   So nothing is written until the join is proven. This reports how many of the
   324 rows find exactly one child, and lists the ones that do not, because a
   fee posted to the wrong child is worse than a fee not posted at all.

   Matching is done in tiers, most certain first, and a row that reaches a
   weaker tier is only accepted when the answer is unique:

     1. every word of the register name appears in the child's name, and the
        class agrees;
     2. the same, with the class ignored (the register writes NUR, the roll
        says Nursery);
     3. the father's mobile identifies one family and one child in that class.
*/

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

type child struct {
	id     uuid.UUID
	admn   string
	name   string
	words  map[string]bool
	class  string
	mobile string
}

var notLetter = regexp.MustCompile(`[^A-Z ]+`)

func words(s string) map[string]bool {
	s = notLetter.ReplaceAllString(strings.ToUpper(s), " ")
	out := map[string]bool{}
	for _, w := range strings.Fields(s) {
		// Initials carry no evidence and match everybody.
		if len(w) > 1 {
			out[w] = true
		}
	}
	return out
}

// The register writes NUR, LKG, UKG, I..IX; the roll says Nursery, Jr KG,
// Grade 1. Neither spelling is wrong, so both are mapped to one.
var classOf = map[string]string{
	"NUR": "Nursery", "LKG": "Jr KG", "UKG": "Sr KG", "PP": "Pre Nursery",
	"I": "Grade 1", "II": "Grade 2", "III": "Grade 3", "IV": "Grade 4",
	"V": "Grade 5", "VI": "Grade 6", "VII": "Grade 7", "VIII": "Grade 8",
	"IX": "Grade 9",
}

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	recs, err := r.ReadAll()
	if err != nil {
		panic(err)
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil {
		panic(err)
	}
	defer conn.Close(ctx)

	var roll []child
	rows, err := conn.Query(ctx, `
		SELECT s.id, s.admission_no,
		       trim(s.first_name || ' ' || COALESCE(s.middle_name,'') || ' ' || COALESCE(s.last_name,'')),
		       COALESCE(c.name,''),
		       -- Any guardian's number will do to break a tie between two
		       -- children who share a name; the father's is preferred only
		       -- because that is the one the register writes.
		       COALESCE((SELECT g.phone FROM student_guardians sg
		                   JOIN guardians g ON g.id = sg.guardian_id
		                  WHERE sg.student_id = s.id AND g.phone IS NOT NULL
		                  ORDER BY (lower(g.relation) LIKE 'father%') DESC,
		                           sg.is_primary DESC
		                  LIMIT 1), '')
		  FROM students s
		  LEFT JOIN enrollments e ON e.student_id = s.id AND e.status='active'
		  LEFT JOIN classes c ON c.id = e.class_id
		 WHERE s.institution_id=$1 AND s.status='active'`, inst)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var c child
		if err := rows.Scan(&c.id, &c.admn, &c.name, &c.class, &c.mobile); err != nil {
			panic(err)
		}
		c.words = words(c.name)
		roll = append(roll, c)
	}
	rows.Close()
	fmt.Printf("active children on the roll: %d\n", len(roll))

	var matched, byClass, byName, byPhone int
	var unmatched, ambiguous []string
	used := map[uuid.UUID]string{}

	for i, rec := range recs {
		if i == 0 || len(rec) < 6 {
			continue
		}
		name := strings.TrimSpace(rec[1])
		if name == "" {
			continue
		}
		regClass := classOf[strings.ToUpper(strings.TrimSpace(rec[2]))]
		mobile := strings.TrimSpace(rec[4])
		want := words(name)
		if len(want) == 0 {
			continue
		}

		contains := func(c child) bool {
			for w := range want {
				if !c.words[w] {
					return false
				}
			}
			return true
		}

		var hits []child
		tier := ""
		for _, c := range roll {
			if contains(c) && c.class == regClass && regClass != "" {
				hits = append(hits, c)
			}
		}
		if len(hits) == 1 {
			tier = "class+name"
			byClass++
		}
		/* THE NAME ALONE, but only when the name says enough.

		   "G AADVIKA" reduces to the single word AADVIKA once the initial is
		   dropped, and that matched KADARI AADVIKA two classes above -- a fee
		   posted to the wrong child. One word is not a name, so a class-free
		   match now needs at least two of them. */
		if len(hits) != 1 && len(want) >= 2 {
			hits = nil
			for _, c := range roll {
				if contains(c) {
					hits = append(hits, c)
				}
			}
			if len(hits) == 1 {
				tier = "name"
				byName++
			}
		}
		if len(hits) != 1 && mobile != "" {
			var phoneHits []child
			for _, c := range roll {
				if c.mobile != "" && strings.HasSuffix(c.mobile, mobile[max(0, len(mobile)-10):]) &&
					c.class == regClass {
					phoneHits = append(phoneHits, c)
				}
			}
			if len(phoneHits) == 1 {
				hits = phoneHits
				tier = "phone+class"
				byPhone++
			}
		}

		switch {
		case len(hits) == 1:
			matched++
			if prev, dup := used[hits[0].id]; dup {
				ambiguous = append(ambiguous,
					fmt.Sprintf("row %-4d %-34s -> %s ALREADY TAKEN by %s", i+1, name, hits[0].admn, prev))
			}
			used[hits[0].id] = name
			_ = tier
		case len(hits) == 0:
			/* AND WHO IT MIGHT HAVE BEEN.

			   "PABBA ALANKRITHA" and "ALANKRITA PABBA" are the same child, one
			   H apart. Rather than guess at that, the nearest names in the
			   same class are printed so a person can say yes or no. */
			type near struct {
				c     child
				score int
			}
			var best []near
			for _, c := range roll {
				if c.class != regClass {
					continue
				}
				score := 0
				for w := range want {
					for cw := range c.words {
						if w == cw || (len(w) > 3 && len(cw) > 3 && prefix(w, cw) >= 4) {
							score++
							break
						}
					}
				}
				if score > 0 {
					best = append(best, near{c, score})
				}
			}
			sort.Slice(best, func(a, b int) bool { return best[a].score > best[b].score })
			line := fmt.Sprintf("row %-4d %-34s %-10s", i+1, name, regClass)
			for k, n := range best {
				if k >= 3 {
					break
				}
				line += fmt.Sprintf("  | %s %s", n.c.admn, n.c.name)
			}
			if len(best) == 0 {
				line += "  | nothing close in that class"
			}
			unmatched = append(unmatched, line)
		default:
			names := []string{}
			for _, h := range hits {
				names = append(names, h.admn)
			}
			sort.Strings(names)
			ambiguous = append(ambiguous,
				fmt.Sprintf("row %-4d %-34s %-10s %d possibles: %s",
					i+1, name, regClass, len(hits), strings.Join(names, " ")))
		}
	}

	fmt.Printf("\nmatched: %d  (by class+name %d, by name %d, by phone %d)\n",
		matched, byClass, byName, byPhone)
	fmt.Printf("no match:  %d\nambiguous: %d\n", len(unmatched), len(ambiguous))

	if len(unmatched) > 0 {
		fmt.Println("\n--- no match ---")
		for _, u := range unmatched {
			fmt.Println("  " + u)
		}
	}
	if len(ambiguous) > 0 {
		fmt.Println("\n--- ambiguous ---")
		for _, a := range ambiguous {
			fmt.Println("  " + a)
		}
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// prefix counts the leading letters two words share, which is how most of the
// spelling differences in this register present: ALANKRITHA against ALANKRITA,
// AVANTIKA against AVANTHIKA.
func prefix(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}
