package api

import (
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The assistant's fast path.

   Measured on the production box: one vCPU processes a prompt at about 50
   tokens per second and generates at 13, and the RAG prompt is around 2,400
   tokens once eight retrieved chunks and six turns of history are in it. A
   live answer therefore costs 88 seconds, which is what it actually cost.
   Nothing tunable closes a thirty-fold gap; two seconds means either different
   hardware or not calling a model.

   Nearly every question a clerk asks is "how do I X" or "where is X", and the
   catalogue already answers both for all 267 screens: what the screen is for,
   where it sits in the navigation, what data it reaches. Matching a question
   against that is string work, and it returns in under a millisecond.

   IT IS ALSO MORE ACCURATE, NOT LESS. A 1.5B model paraphrasing the catalogue
   can get the paraphrase wrong; this quotes it. The screens named here exist,
   because the same CSV is what builds the navigation.

   WHAT THIS IS NOT. It does not understand anything. It cannot answer "why is
   this parent's invoice wrong" or anything that needs two facts joined
   together. Those still go to the model on the slow path, and the client is
   told which it got, so a miss reads as "looking it up" rather than as the
   fast path having nothing to say.

   ---------------------------------------------------------------------------
   ROLE IS APPLIED HERE, WHERE IT IS KNOWN FOR CERTAIN

   "How do I collect a fee" has one answer for the clerk who raises the receipt
   and another for the parent who pays it. The client used to signal this by
   naming the asker's roles in the question text, which biases retrieval and
   can be argued with. This is the session's own role list, read server-side
   from the cookie: it cannot be spoofed by editing a request body, and a
   parent cannot be answered with the staff screen for the same words. */

var helpWordRe = regexp.MustCompile(`[a-z0-9]+`)

// helpStop mirrors STOP in scripts/gen_answers.py. The two lists have to agree:
// a word stripped from the stored terms but kept in the question can never
// match, and the failure looks like bad ranking rather than a bug.
var helpStop = map[string]bool{
	"a": true, "an": true, "the": true, "i": true, "how": true, "do": true,
	"does": true, "can": true, "to": true, "of": true, "in": true, "on": true,
	"for": true, "is": true, "are": true, "it": true, "my": true, "me": true,
	"we": true, "you": true, "where": true, "what": true, "and": true,
	"with": true, "from": true, "at": true, "by": true, "or": true, "be": true,
	"as": true, "this": true, "that": true, "if": true, "when": true,
	"there": true, "here": true, "want": true, "need": true, "please": true,
	"would": true, "should": true, "could": true,
}

/*
helpStem mirrors stem() in scripts/gen_answers.py, and must keep mirroring it.

	"How do I collect a fee" matched nothing against a screen filed under the
	workspace "Fees", because fee != fees. Only a trailing plural s is dropped:
	full stemming would collapse "billing" into "bill", which are two different
	screens in this product.
*/
func helpStem(w string) string {
	if len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
		return w[:len(w)-1]
	}
	return w
}

func helpWords(s string) []string {
	out := []string{}
	for _, w := range helpWordRe.FindAllString(strings.ToLower(s), -1) {
		if !helpStop[w] {
			out = append(out, helpStem(w))
		}
	}
	return out
}

type helpMatch struct {
	Answer string
	Name   string
	Where  string
	score  float64
}

/*
matchHelp scores every answer this asker is allowed to see and returns the best.

	Three tiers, because three kinds of word carry different amounts of signal:

	  a word in the screen's own NAME        3.0
	  a word in its workspace or section     2.0
	  a word anywhere in its description     1.0

	The split is not decoration. "Where do I mark attendance" was answered with
	"My students", which sits in a section called Attendance and mentions
	marking -- two mid-weight hits -- while the screen actually CALLED
	Attendance collected one. The name of a thing identifies it; the area it
	lives in only narrows the search.

	Two multipliers on top, and they do different jobs:

	  coverage    how much of the QUESTION landed anywhere. Separates "Collect
	              payment" from "Payment gateway settings" when the question
	              says both words: the entry accounting for the whole question
	              beats one sharing a common term.

	  name match  how much of the screen's NAME the question said. This is what
	              makes a question that names a screen outright win. "Where do I
	              mark attendance" says the whole of "Attendance"; it says none
	              of "My students".

	Normalised by question length, not by entry length: a long screen name must
	not be penalised for being long, and a two-word question must not be easier
	to satisfy than a five-word one.
*/
func matchHelp(question string, roles []string) *helpMatch {
	q := helpWords(question)
	if len(q) == 0 {
		return nil
	}
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}

	var best *helpMatch
	for i := range helpAnswers {
		a := &helpAnswers[i]
		if len(allowed) > 0 && !allowed[a.Role] {
			continue
		}

		set := func(ws []string) map[string]bool {
			m := make(map[string]bool, len(ws))
			for _, w := range ws {
				m[w] = true
			}
			return m
		}
		name, where, terms := set(a.NameW), set(a.WhereW), set(a.Terms)

		score, hit, named := 0.0, 0, 0
		for _, w := range q {
			switch {
			case name[w]:
				score += 3
				hit++
				named++
			case where[w]:
				score += 2
				hit++
			case terms[w]:
				score++
				hit++
			}
		}
		if hit == 0 {
			continue
		}
		coverage := float64(hit) / float64(len(q))
		nameMatch := 0.0
		if len(a.NameW) > 0 {
			nameMatch = float64(named) / float64(len(a.NameW))
		}
		score = score/float64(len(q))*(1+0.5*coverage) + 1.5*nameMatch

		if best == nil || score > best.score {
			best = &helpMatch{Answer: a.Answer, Name: a.Name, Where: a.Where, score: score}
		}
	}
	return best
}

/*
helpConfident is the line below which the fast path keeps quiet.

	Calibrated against real questions rather than picked. Measured scores:

	  "how do I collect a fee"       Collect payment            4.50
	  "where do I mark attendance"   Attendance correction      2.62
	  "why is this invoice wrong"    Demand / invoice gen       1.67
	  "how do I add a new student"   Foreign / NRI Visa Docs    1.47

	2.0 sits in the gap, and the gap is meaningful: above it the question named
	a screen, below it the question shares a word with one. The last two are
	exactly the cases that must fall through -- "why is this invoice wrong" is
	about one parent's invoice and needs reasoning, and admissions has no "add
	a student" screen at all because it takes applications, so the honest reply
	is the model's, not a confident pointer at visa paperwork.

	A confidently wrong answer about where a screen lives costs more than a
	slow correct one: somebody walks to a menu that does not contain what they
	were promised, and stops believing the next answer too. The miss is cheap
	by comparison -- it falls through to the model, which is slow and honest.
*/
const helpConfident = 2.0

type assistantAskRequest struct {
	Message string `json:"message"`
}

type assistantAskResponse struct {
	// Answered is false when nothing cleared the confidence line. The client
	// then asks the model, and shows that it is doing so.
	Answered bool   `json:"answered"`
	Answer   string `json:"answer,omitempty"`
	Screen   string `json:"screen,omitempty"`
	Where    string `json:"where,omitempty"`
}

/*
assistantAsk answers from the catalogue, in under a millisecond, or declines.

	Session-authenticated, unlike the RAG service it sits in front of, which
	answers anybody who can reach the origin. That is not only a fix for the
	speed: it is what makes the role real. The roles come from the cookie the
	browser already holds, so nothing in the request body can widen them.
*/
func (s *Server) assistantAsk(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req assistantAskRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	/* The roles, read from the database rather than taken from the request.

	   Identity carries permissions, not role keys, and the answers are
	   partitioned by role because the help corpus is. One indexed query on a
	   handful of rows, against a lookup that costs microseconds -- worth it to
	   keep the answer's scope out of the caller's hands. */
	roles := []string{}
	if id != nil {
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				 WHERE ur.user_id = $1 ORDER BY r.key`, id.UserID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var k string
				if err := rows.Scan(&k); err != nil {
					return err
				}
				roles = append(roles, k)
			}
			return rows.Err()
		}); err != nil {
			// Not fatal. A role lookup that fails should cost precision, not
			// the answer: with no roles the match runs across every screen,
			// which is what an unscoped assistant already did.
			httpx.LogError(r, err)
		}
	}
	sort.Strings(roles)

	m := matchHelp(req.Message, roles)
	if m == nil || m.score < helpConfident {
		httpx.JSON(w, http.StatusOK, assistantAskResponse{Answered: false})
		return
	}
	httpx.JSON(w, http.StatusOK, assistantAskResponse{
		Answered: true,
		Answer:   m.Answer,
		Screen:   m.Name,
		Where:    m.Where,
	})
}
