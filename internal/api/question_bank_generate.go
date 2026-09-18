package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* GENERATE QUESTIONS FROM A LESSON PDF, INTO THE QUESTION BANK.

   This unblocks the paper generator that paper_compose.go draws from: a bank
   with nothing in it draws an empty paper. A teacher uploads the lesson or
   exercise PDF, the model reads it and proposes questions, the teacher reviews
   and fixes them, and only what they confirm is written -- through the very
   same insert path createBankQuestion uses, so a generated question and a
   hand-typed one are indistinguishable in the bank and validated the same way.

   Two endpoints, and the split is the point. /generate reads the PDF and
   returns a PREVIEW; it writes NOTHING, because extraction from a PDF is
   imperfect and a teacher must see the questions before they land in the bank.
   /generate/save takes the reviewed array back and inserts it. Both verify the
   caller teaches the class-subject (classSubjectTaught -> 404), both run under
   the tenant scope, and both are gated on academics.homework.write; /generate
   additionally spends the assistant rate-limit budget, because it is a billed
   third-party call. */

const (
	bankGenMaxPDF       = 10 << 20 // 10 MiB, enforced with io.LimitReader
	bankGenDefaultCount = 10
	bankGenMaxCount     = 50
	// Fifty questions with options and answers is a few thousand tokens; this is
	// comfortably above that and well short of runaway.
	bankGenMaxTokens = 8192
)

// genQuestion is the shape the model is asked for and the shape the browser
// sends back after review, so one struct serves both the preview and the save.
type genQuestion struct {
	Text       string   `json:"text"`
	Kind       string   `json:"kind"`
	Difficulty string   `json:"difficulty"`
	Marks      float64  `json:"marks"`
	Options    []string `json:"options"`
	Answer     string   `json:"answer"`
}

const bankGenSystem = `You are a schoolteacher's assistant that writes exam questions from a lesson.

You are given a lesson or exercise PDF and must propose questions a teacher could
put on a test. The questions must be answerable from the content of the document
and must be at the level the document is pitched at. Do not invent facts that are
not supported by the document.

Return ONLY a JSON array, with no prose, no explanation and no code fences. Each
element is an object of exactly this shape:

  {"text":"", "kind":"mcq|short_answer|long_answer|true_false|fill_blank",
   "difficulty":"easy|medium|hard", "marks":N, "options":["",""], "answer":""}

Rules:
- "text" is the question stem.
- "kind" is one of the five values above, nothing else.
- For "mcq" give at least three plausible "options" and set "answer" to the exact
  text of the correct option.
- For "true_false" give options ["True","False"] and set "answer" to the correct one.
- For "fill_blank" put the missing word or phrase in "answer" and leave "options" empty.
- For "short_answer" and "long_answer" leave "options" empty and put a model answer in "answer".
- "marks" is a small whole number appropriate to the kind (1 for objective, 2-3 for
  short answer, 5 for long answer).
- Output the JSON array and nothing else.`

// normalizeGenKind maps the model's kind vocabulary (and a few likely variants)
// onto the bank's own kinds, or "" for something unrecognised, which is dropped.
func normalizeGenKind(k string) string {
	switch strings.ToLower(strings.TrimSpace(k)) {
	case "mcq", "multiple_choice", "multiple choice":
		return "mcq"
	case "true_false", "true/false", "truefalse", "true or false":
		return "true_false"
	case "fill_blank", "fill_in_the_blank", "fill in the blank", "fill-blank", "fill_in_blank":
		return "fill_blank"
	case "short", "short_answer", "short answer":
		return "short"
	case "long", "long_answer", "long answer", "essay":
		return "long"
	}
	return ""
}

func defaultMarksForKind(kind string) float64 {
	switch kind {
	case "short":
		return 2
	case "long":
		return 5
	default:
		return 1
	}
}

// parseGeneratedQuestions turns the model's text into clean questions, defensively.
//
// The model is told to return only a JSON array, but a stray code fence or a
// sentence before it must not lose the whole batch, so the array is sliced out
// between the first '[' and last ']'. Malformed items are dropped rather than
// failing the request: a teacher would rather review nine good questions than
// see an error because the tenth had no stem.
func parseGeneratedQuestions(raw string) []genQuestion {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
	}
	start := strings.IndexByte(s, '[')
	end := strings.LastIndexByte(s, ']')
	if start < 0 || end < 0 || end < start {
		return []genQuestion{}
	}
	var items []genQuestion
	if err := json.Unmarshal([]byte(s[start:end+1]), &items); err != nil {
		return []genQuestion{}
	}
	out := make([]genQuestion, 0, len(items))
	for _, q := range items {
		q.Text = strings.TrimSpace(q.Text)
		if q.Text == "" {
			continue
		}
		kind := normalizeGenKind(q.Kind)
		if kind == "" {
			continue
		}
		q.Kind = kind
		if !difficulties[q.Difficulty] {
			q.Difficulty = "medium"
		}
		if q.Marks <= 0 || q.Marks > 100 {
			q.Marks = defaultMarksForKind(kind)
		}
		cleaned := make([]string, 0, len(q.Options))
		for _, o := range q.Options {
			if o = strings.TrimSpace(o); o != "" {
				cleaned = append(cleaned, o)
			}
		}
		q.Options = cleaned
		q.Answer = strings.TrimSpace(q.Answer)
		out = append(out, q)
	}
	return out
}

func (s *Server) generateBankQuestions(w http.ResponseWriter, r *http.Request) {
	// A little headroom over the PDF cap so the multipart envelope itself fits.
	if err := r.ParseMultipartForm(bankGenMaxPDF + (1 << 20)); err != nil {
		httpx.BadRequest(w, r, "expected a multipart upload carrying a PDF in the `file` field")
		return
	}
	csID, err := uuid.Parse(strings.TrimSpace(r.FormValue("class_subject_id")))
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	count := bankGenDefaultCount
	if v := strings.TrimSpace(r.FormValue("count")); v != "" {
		n, perr := strconv.Atoi(v)
		if perr != nil || n < 1 || n > bankGenMaxCount {
			httpx.BadRequest(w, r, "count must be a whole number between 1 and 50")
			return
		}
		count = n
	}
	difficulty := strings.TrimSpace(r.FormValue("difficulty"))
	if difficulty != "" && !difficulties[difficulty] {
		httpx.BadRequest(w, r, "difficulty must be easy, medium or hard")
		return
	}
	// kinds is an optional comma-separated list; each is mapped onto the bank's
	// vocabulary and anything unrecognised is ignored rather than refused.
	var kinds []string
	if v := strings.TrimSpace(r.FormValue("kinds")); v != "" {
		seen := map[string]bool{}
		for _, part := range strings.Split(v, ",") {
			if k := normalizeGenKind(part); k != "" && !seen[k] {
				seen[k] = true
				kinds = append(kinds, k)
			}
		}
	}

	file, _, ferr := r.FormFile("file")
	if ferr != nil {
		httpx.BadRequest(w, r, "attach a lesson PDF in the `file` field")
		return
	}
	defer file.Close()
	// io.LimitReader caps the read at one byte past the limit so an oversize
	// upload is detected without loading it all into memory.
	data, err := io.ReadAll(io.LimitReader(file, bankGenMaxPDF+1))
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(data) > bankGenMaxPDF {
		httpx.BadRequest(w, r, "the PDF must be 10MB or smaller")
		return
	}
	if len(data) == 0 {
		httpx.BadRequest(w, r, "the PDF is empty")
		return
	}
	if !bytes.HasPrefix(data, []byte("%PDF")) {
		httpx.BadRequest(w, r, "that file does not look like a PDF")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var taught bool
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		taught = ok
		return nil
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !taught {
		// Same answer as a class-subject that does not exist: a teacher must not
		// be able to probe another section's subjects by id.
		httpx.NotFound(w, r)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	parts := []geminiPart{
		{InlineData: &geminiInlineData{MimeType: "application/pdf", Data: base64.StdEncoding.EncodeToString(data)}},
		{Text: buildBankGenInstruction(count, difficulty, kinds)},
	}
	raw, err := callGeminiParts(ctx, bankGenSystem, parts, bankGenMaxTokens)
	if err != nil {
		// Reuse the assistant's failure mapping: a rate limit, a refused token
		// and a timeout each read differently to the teacher.
		s.assistantFailure(w, r, err)
		return
	}

	questions := parseGeneratedQuestions(raw)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"questions":        questions,
		"class_subject_id": csID.String(),
	})
}

func buildBankGenInstruction(count int, difficulty string, kinds []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Read the attached lesson PDF and write %d exam questions from it.", count)
	if difficulty != "" {
		fmt.Fprintf(&b, " Make them all %s difficulty.", difficulty)
	}
	if len(kinds) > 0 {
		fmt.Fprintf(&b, " Use only these kinds: %s.", strings.Join(kinds, ", "))
	}
	b.WriteString(" Return ONLY the JSON array described in your instructions.")
	return b.String()
}

type bankGenSaveRequest struct {
	ClassSubjectID string        `json:"class_subject_id"`
	Questions      []genQuestion `json:"questions"`
}

func (s *Server) saveGeneratedBankQuestions(w http.ResponseWriter, r *http.Request) {
	var req bankGenSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, err := uuid.Parse(strings.TrimSpace(req.ClassSubjectID))
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	if len(req.Questions) == 0 {
		httpx.BadRequest(w, r, "no questions to save")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	saved := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		for _, gq := range req.Questions {
			bq := genToBankRequest(csID.String(), gq)
			bq.Stem = strings.TrimSpace(bq.Stem)
			if bq.Stem == "" {
				continue
			}
			// The same validation a hand-typed question passes; a generated one
			// the teacher left malformed is skipped rather than failing the batch.
			if verr := validateBankQuestion(&bq, false); verr != nil {
				continue
			}
			var newID string
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO question_bank_questions (institution_id, class_subject_id,
				                                     syllabus_unit_id, kind, difficulty,
				                                     bloom_level, stem, default_marks,
				                                     explanation, is_active, created_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11)
				RETURNING id::text`,
				id.InstitutionID, csID, nullUUID(bq.SyllabusUnitID), bq.Kind,
				bq.Difficulty, bq.BloomLevel, bq.Stem, bq.DefaultMarks,
				bq.Explanation, true, id.UserID).Scan(&newID); err != nil {
				return err
			}
			if err := insertBankOptions(r, tx, id.InstitutionID, newID, bq); err != nil {
				return err
			}
			saved++
		}
		return nil
	})
	if err == errNotTaught {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": saved})
}

// genToBankRequest maps one reviewed question onto the request the bank insert
// path understands, working out the answer key for objective kinds.
func genToBankRequest(csID string, q genQuestion) bankQuestionRequest {
	req := bankQuestionRequest{
		ClassSubjectID: csID,
		Kind:           normalizeGenKind(q.Kind),
		Difficulty:     q.Difficulty,
		Stem:           strings.TrimSpace(q.Text),
		DefaultMarks:   q.Marks,
	}
	if req.Kind == "" {
		req.Kind = q.Kind // let validateBankQuestion reject it
	}
	if ans := strings.TrimSpace(q.Answer); ans != "" {
		req.Explanation = "Answer: " + ans
	}
	if !objectiveKinds[req.Kind] {
		return req
	}

	opts := q.Options
	switch req.Kind {
	case "true_false":
		if len(opts) == 0 {
			opts = []string{"True", "False"}
		}
	case "fill_blank":
		// A fill-in-the-blank needs its correct spelling as the one option, so
		// the objective validation and the auto-marker both have an answer key.
		if len(opts) == 0 {
			if ans := strings.TrimSpace(q.Answer); ans != "" {
				req.Options = []bankOptionInput{{Body: ans, IsCorrect: true}}
			}
			return req
		}
	}

	correct := matchAnswerIndex(opts, q.Answer)
	for i, o := range opts {
		req.Options = append(req.Options, bankOptionInput{Body: o, IsCorrect: i == correct})
	}
	return req
}

// matchAnswerIndex finds which option the model's "answer" refers to: by exact
// text, then by an A/B/C letter or a 1/2/3 number. Falls back to the first
// option so an objective question always carries a key -- the teacher reviewed
// it before saving, and a key they can correct beats one that will not save.
func matchAnswerIndex(opts []string, answer string) int {
	a := strings.TrimSpace(answer)
	if a == "" || len(opts) == 0 {
		return 0
	}
	for i, o := range opts {
		if strings.EqualFold(strings.TrimSpace(o), a) {
			return i
		}
	}
	if len(a) == 1 {
		c := a[0]
		switch {
		case c >= 'a' && c <= 'z' && int(c-'a') < len(opts):
			return int(c - 'a')
		case c >= 'A' && c <= 'Z' && int(c-'A') < len(opts):
			return int(c - 'A')
		case c >= '1' && c <= '9' && int(c-'1') < len(opts):
			return int(c - '1')
		}
	}
	return 0
}
