package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* THE SLOW PATH, which was never built.

   help_answers.go answers "how do I X" out of the catalogue in under a
   millisecond, and says in as many words what it cannot do: "It cannot answer
   'why is this parent's invoice wrong' or anything that needs two facts joined
   together. Those still go to the model on the slow path."

   There was no slow path. The SPA posted to VITE_ASSISTANT_URL=/assistant/chat,
   nginx had no location for it, and the request fell through to the SPA
   catch-all -- so the browser got index.html with a 200, res.ok was true, and
   the tab reported a JSON parse error. Every question the fast path missed
   failed that way, and the status pill said "Ready" throughout, because all it
   checks is that the URL string is non-empty.

   This is that path, inside the Go server rather than beside it:

     * NO SECOND SERVICE, and no new nginx location. It lives under /api/v1,
       which nginx already proxies, so there is one process to deploy and one
       to restart.

     * AUTHENTICATED, which the RAG service it replaces was not -- api.go
       records that it "answers anybody who can reach the origin". Here the
       session cookie is the gate, and the roles come from the database, so a
       parent cannot be answered with a staff screen by editing a request body.

     * GROUNDED IN THE CATALOGUE the navigation is built from, so the screens
       it names are screens that exist. The model is told to say it does not
       know rather than invent a screen, because a clerk sent to a menu item
       that is not there loses more time than a refusal costs.

   WHAT IT IS NOT. It has no access to school data: no student, no invoice, no
   salary. It answers questions about how to use the product. Wiring it to the
   tables is a different feature with a different consent conversation, and it
   is not this one. */

// assistantModel is Google Gemini 2.5 Flash. Named here so there is one line
// to change. The school moved off the local/Anthropic path to Gemini for speed.
const assistantModel = "gemini-2.5-flash"

// geminiTurn is one message in the conversation, in Gemini's own vocabulary:
// role is "user" or "model", and the text is the turn. Kept provider-shaped so
// the memory stores exactly what the request sends.
type geminiTurn struct {
	role string
	text string
}

// geminiError carries the HTTP status a failed Gemini call returned, so the
// failure handler can tell a rate limit from a bad key.
type geminiError struct {
	StatusCode int
	Body       string
}

func (e *geminiError) Error() string { return fmt.Sprintf("gemini %d: %s", e.StatusCode, e.Body) }

// metadataValue reads one value from the Cloud Run metadata server. It only
// answers in the cloud; locally there is no metadata server and the assistant
// is simply unavailable, which is the right answer off the platform.
func metadataValue(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://metadata.google.internal/computeMetadata/v1/"+path, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata %s: %d", path, resp.StatusCode)
	}
	return strings.TrimSpace(string(b)), nil
}

// callGemini sends the grounded prompt and conversation to Gemini through
// Vertex AI, authenticated by the Cloud Run service account -- no API key. This
// is what lets it run under an organisation whose policy only issues
// service-account-bound keys: the server proves who it is with its own identity
// and Vertex bills the project. One HTTPS POST, no SDK.
func callGemini(ctx context.Context, _unused, system string, turns []geminiTurn) (string, error) {
	// The project and an OAuth token both come from the metadata server.
	project := strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT"))
	if project == "" {
		p, err := metadataValue(ctx, "project/project-id")
		if err != nil {
			return "", err
		}
		project = p
	}
	tokRaw, err := metadataValue(ctx, "instance/service-accounts/default/token")
	if err != nil {
		return "", err
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal([]byte(tokRaw), &tok); err != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("no access token from metadata")
	}

	type part struct {
		Text string `json:"text"`
	}
	type content struct {
		Role  string `json:"role,omitempty"`
		Parts []part `json:"parts"`
	}
	contents := make([]content, 0, len(turns))
	for _, t := range turns {
		contents = append(contents, content{Role: t.role, Parts: []part{{Text: t.text}}})
	}
	payload := map[string]any{
		"system_instruction": content{Parts: []part{{Text: system}}},
		"contents":           contents,
		"generationConfig":   map[string]any{"maxOutputTokens": assistantMaxTokens},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	url := "https://aiplatform.googleapis.com/v1/projects/" + project +
		"/locations/global/publishers/google/models/" + assistantModel + ":generateContent"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", &geminiError{StatusCode: resp.StatusCode, Body: string(rb)}
	}
	var out struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return "", err
	}
	var sb strings.Builder
	if len(out.Candidates) > 0 {
		for _, p := range out.Candidates[0].Content.Parts {
			sb.WriteString(p.Text)
		}
	}
	return sb.String(), nil
}

/*
Short answers on purpose, and not streamed.

	The tab does one fetch and one res.json(); it cannot render a stream, so a
	long generation would sit behind a spinner and risk the HTTP timeout. A
	help answer that runs past a few hundred words has stopped being an answer
	anyway.
*/
const assistantMaxTokens = 1024

type assistantChatRequest struct {
	Message        string   `json:"message"`
	ConversationID string   `json:"conversation_id,omitempty"`
	Roles          []string `json:"roles,omitempty"`
}

type assistantChatResponse struct {
	Answer         string `json:"answer"`
	ConversationID string `json:"conversation_id"`
}

/*
THE HISTORY, IN MEMORY AND DELIBERATELY FORGETFUL.

	The client sends a conversation id and one message -- never the transcript --
	so somebody has to hold the earlier turns for a follow-up to mean anything.

	In the process, not in Postgres. A chat about which screen to open is worth
	very little an hour later and nothing after a restart, and the alternative is
	a migration, a retention policy and a table of everything every member of
	staff has ever asked, sitting inside a school's database. Losing it on deploy
	is the better failure.

	One process serves this app, so a map is enough. Two would each hold half the
	conversations and a follow-up would land on the wrong one; that is the day
	this moves into Postgres, which already holds everything else the app
	shares between processes (there is no Redis).
*/
type assistantMemory struct {
	mu   sync.Mutex
	byID map[string]*assistantThread
}

type assistantThread struct {
	turns []geminiTurn
	seen  time.Time
}

const (
	assistantMaxThreads = 500
	assistantMaxTurns   = 12
	assistantThreadTTL  = 2 * time.Hour
)

var assistantThreads = &assistantMemory{byID: map[string]*assistantThread{}}

func (m *assistantMemory) load(id string) []geminiTurn {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.byID[id]
	if !ok || time.Since(t.seen) > assistantThreadTTL {
		return nil
	}
	return append([]geminiTurn(nil), t.turns...)
}

func (m *assistantMemory) save(id string, turns []geminiTurn) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Only the tail is kept. A conversation that has run twelve turns has
	// stopped being the question it started as, and the whole transcript is
	// resent on every request, so the bill grows with the square of the chat.
	if len(turns) > assistantMaxTurns {
		turns = turns[len(turns)-assistantMaxTurns:]
	}
	m.byID[id] = &assistantThread{turns: turns, seen: time.Now()}

	if len(m.byID) <= assistantMaxThreads {
		return
	}
	// Over the cap, drop the coldest. Sweeping the expired first means a busy
	// afternoon does not evict a conversation somebody is still in.
	oldest, oldestAt := "", time.Now()
	for k, v := range m.byID {
		if time.Since(v.seen) > assistantThreadTTL {
			delete(m.byID, k)
			continue
		}
		if v.seen.Before(oldestAt) {
			oldest, oldestAt = k, v.seen
		}
	}
	if len(m.byID) > assistantMaxThreads && oldest != "" {
		delete(m.byID, oldest)
	}
}

/*
The screens this person can actually open, as the model's ground truth.

	Built from the same catalogue that builds the navigation, filtered to the
	asker's roles: naming a screen a parent cannot reach is not a small error,
	it is telling somebody the product has a door that is locked to them.
*/
func assistantGrounding(roles []string) string {
	var b strings.Builder
	b.WriteString("The screens this person can open, by workspace:\n")
	seen := map[string]bool{}
	for _, key := range roles {
		role, ok := catalog.RoleByKey(key)
		if !ok {
			continue
		}
		for _, sec := range role.Sections {
			for _, f := range sec.Features {
				if seen[f.Key] {
					continue
				}
				seen[f.Key] = true
				b.WriteString("- ")
				b.WriteString(sec.Workspace)
				b.WriteString(" > ")
				b.WriteString(sec.Name)
				b.WriteString(" > ")
				b.WriteString(f.Name)
				if f.Summary != "" {
					b.WriteString(": ")
					b.WriteString(f.Summary)
				}
				b.WriteString("\n")
			}
		}
	}
	if len(seen) == 0 {
		b.WriteString("- (none recorded for this person's roles)\n")
	}
	return b.String()
}

const assistantSystemPrompt = `You are the help assistant inside a school ERP used by Indian schools.

The people asking are school staff and parents: a clerk at a fee counter, a
teacher marking a register, a principal, a parent on a phone. Answer in plain
English, in a few sentences. No preamble, no headings, no bullet lists unless
the answer really is a list of steps.

Ground every answer in the screens listed below. Name the screen the way the
list names it, and say where it sits, so the person can find it in the menu.

If the answer is not in that list, say you do not know and suggest who in the
school would. Never invent a screen, a button or a menu path: somebody sent to
a menu item that does not exist loses more time than the refusal would cost.

You have no access to school records. You cannot see a child, an invoice, an
attendance register or a salary, and you must not pretend to. If asked about a
specific person or figure, say that you can only explain how to find it, then
explain that.`

func (s *Server) assistantChat(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req assistantChatRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		httpx.BadRequest(w, r, "message is required")
		return
	}

	/* No API key needed: the server calls Gemini through Vertex AI with its own
	   Cloud Run service-account identity. That is what lets it run under an
	   organisation whose policy issues only service-account-bound keys. Off the
	   platform (no metadata server) the call simply fails and is reported as
	   unreachable, which is the honest answer there. */

	// The session's roles, not the body's. The client sends `roles` and it is
	// ignored: it is the one field a curious parent could edit.
	roles := s.assistantRoles(r, id)

	conversationID := req.ConversationID
	if _, err := uuid.Parse(conversationID); err != nil {
		conversationID = uuid.NewString()
	}
	turns := assistantThreads.load(conversationID)
	turns = append(turns, geminiTurn{role: "user", text: req.Message})

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	/* The system prompt carries the catalogue grounding and, when the question
	   is about the asker's own data, a block of role-scoped facts fetched under
	   their identity (see assistantData). The model never queries anything; it
	   only ever sees rows this user is already allowed to see. */
	system := assistantSystemPrompt + "\n\n" + assistantGrounding(roles)
	if facts := s.assistantData(r, id, roles, req.Message); facts != "" {
		system += "\n\n" + facts
	}

	answerText, err := callGemini(ctx, "", system, turns)
	if err != nil {
		s.assistantFailure(w, r, err)
		return
	}

	/* A refusal is an answer, not an error.

	   Returning 500 here would put "something went wrong" in front of somebody
	   whose question was merely declined, and they would ask it again. */
	answer := strings.TrimSpace(answerText)
	if answer == "" {
		answer = "I could not answer that one. Try asking it a different way, or ask the school office."
	}

	turns = append(turns, geminiTurn{role: "model", text: answer})
	assistantThreads.save(conversationID, turns)

	httpx.JSON(w, http.StatusOK, assistantChatResponse{
		Answer:         answer,
		ConversationID: conversationID,
	})
}

/*
The failures worth telling apart.

	A rate limit and a wrong key are both "the assistant did not answer" to the
	person asking, but only one of them is worth waiting out, and only one is
	worth telephoning the office about.
*/
func (s *Server) assistantFailure(w http.ResponseWriter, r *http.Request, err error) {
	httpx.LogError(r, err)

	var apiErr *geminiError
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusTooManyRequests:
			httpx.Error(w, r, http.StatusTooManyRequests, "assistant_busy",
				"the assistant is busy. Wait a moment and ask again.")
			return
		case http.StatusUnauthorized, http.StatusForbidden:
			httpx.Error(w, r, http.StatusServiceUnavailable, "assistant_not_configured",
				"the assistant's key was refused. Ask whoever runs the server to check it.")
			return
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		httpx.Error(w, r, http.StatusGatewayTimeout, "assistant_slow",
			"the assistant took too long to answer. Ask again.")
		return
	}
	httpx.Error(w, r, http.StatusBadGateway, "assistant_unreachable",
		"the assistant could not be reached just now. Ask again in a minute.")
}

// assistantRoles reads the asker's roles the way assistantAsk does, and for the
// same reason: identity carries permissions, not role keys.
func (s *Server) assistantRoles(r *http.Request, id *httpx.Identity) []string {
	roles := []string{}
	if id == nil {
		return roles
	}
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
		// Same call as the fast path makes: a failed role lookup costs
		// precision, not the answer.
		httpx.LogError(r, err)
	}
	sort.Strings(roles)
	return roles
}

/* assistantData — the role-scoped answer layer (feature B).

   The model never touches the database. Instead, when a question looks like it
   is about the school's own data, this fetches a few facts UNDER THE ASKER'S
   OWN IDENTITY and permissions and hands them to the model as ground truth.

   Two guards make it safe on a multi-tenant system:
     1. Every read runs in InTenant(tenantScope(id)), so row-level security
        confines it to the asker's own institution — no other school's rows can
        be reached even by a crafted question.
     2. Each fact is gated on the permission its own screen requires, so a
        parent or a teacher without it simply gets nothing here and the bot
        stays help-only for them. Personal, per-child answers (a single
        family's fees) are deliberately NOT here yet — that needs per-subject
        scoping and its own review.

   Returns "" when there is nothing to add, which is the common case. */
func (s *Server) assistantData(r *http.Request, id *httpx.Identity, roles []string, q string) string {
	if id == nil {
		return ""
	}
	ql := strings.ToLower(q)
	has := func(subs ...string) bool {
		for _, sub := range subs {
			if strings.Contains(ql, sub) {
				return true
			}
		}
		return false
	}
	var facts []string
	_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if has("on leave", "who is away", "who's away", "leave today") && id.Can(rbac.EmployeesRead) {
			rows, err := tx.Query(r.Context(), `
				SELECT btrim(concat_ws(' ', e.first_name, e.last_name))
				  FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
				 WHERE lr.subject_kind='staff' AND lr.status='approved'
				   AND CURRENT_DATE BETWEEN lr.from_date AND lr.to_date
				 ORDER BY 1`)
			if err == nil {
				names := []string{}
				for rows.Next() {
					var n string
					rows.Scan(&n)
					names = append(names, n)
				}
				rows.Close()
				if len(names) == 0 {
					facts = append(facts, "Staff on approved leave today: none.")
				} else {
					facts = append(facts, "Staff on approved leave today: "+strings.Join(names, ", ")+".")
				}
			}
		}
		// AttendanceReadAll, not AttendanceRead: the counts below span the whole
		// institution with no section narrowing, so the scoped View permission
		// -- which a subject teacher has for their own two sections -- must not
		// unlock them, or the bot would report the school's totals to someone
		// entitled only to a slice. A section-scoped teacher simply gets nothing
		// here, which is the correct answer for a whole-school question.
		if has("absent", "attendance today", "present today") && id.Can(rbac.AttendanceReadAll) {
			var absent, marked int
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM student_attendance WHERE on_date=CURRENT_DATE AND status='absent'`).Scan(&absent); err == nil {
				if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM student_attendance WHERE on_date=CURRENT_DATE`).Scan(&marked); err == nil {
					facts = append(facts, fmt.Sprintf("Student attendance today: %d marked absent out of %d marked so far.", absent, marked))
				}
			}
		}
		if has("how many staff", "staff count", "number of staff", "total staff") && id.Can(rbac.EmployeesRead) {
			var n int
			// A swallowed scan error here would report "0 staff" as fact -- worse
			// than saying nothing -- so a failed count adds no fact at all.
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM employees WHERE status='active'`).Scan(&n); err == nil {
				facts = append(facts, fmt.Sprintf("Active staff on the roll: %d.", n))
			}
		}
		if has("how many student", "student count", "strength", "enrolment", "enrollment") && id.Can(rbac.StudentsReadAll) {
			var n int
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM students WHERE status='active'`).Scan(&n); err == nil {
				facts = append(facts, fmt.Sprintf("Active students on the roll: %d.", n))
			}
		}

		/* A named child — their class, and (with the fees permission) what they
		   owe. This is the "I can't see student details or their fees" gap.

		   The child is found by matching an admission number or a first name of
		   four letters or more that actually appears in the question, so a
		   general "how are the fees going" does not drag in a student called
		   Fee. RLS still confines the search to this institution, and the whole
		   branch is gated on institution-wide student access, so a parent or a
		   single-section teacher gets nothing here — their own-child view needs
		   its own scoping and is not opened by this. At most five matches, to
		   keep an ambiguous name from dumping the roll into the prompt. */
		wantsFee := has("fee", "fees", "balance", "dues", "owe", "outstanding", "pending")
		if (has("class", "section", "which grade", "roll", "who is", "details of", "detail of", "about") || wantsFee) &&
			id.Can(rbac.StudentsReadAll) {
			rows, err := tx.Query(r.Context(), `
				SELECT st.id::text,
				       btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)),
				       st.admission_no, c.name, sec.name, en.roll_no
				  FROM students st
				  LEFT JOIN LATERAL (
				      SELECT e.class_id, e.section_id, e.roll_no
				        FROM enrollments e
				       WHERE e.student_id = st.id
				       ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  LEFT JOIN classes  c   ON c.id = en.class_id
				  LEFT JOIN sections sec ON sec.id = en.section_id
				 WHERE st.status='active'
				   AND ( ($1 <> '' AND position(lower(st.admission_no) in $1) > 0)
				      OR (length(st.first_name) >= 4 AND position(lower(st.first_name) in $1) > 0) )
				 ORDER BY st.first_name
				 LIMIT 5`, ql)
			if err == nil {
				type stu struct{ id, name, adm, class, sec string; roll *int }
				var found []stu
				for rows.Next() {
					var s stu
					var cn, sn *string
					rows.Scan(&s.id, &s.name, &s.adm, &cn, &sn, &s.roll)
					if cn != nil {
						s.class = *cn
					}
					if sn != nil {
						s.sec = *sn
					}
					found = append(found, s)
				}
				rows.Close()
				for _, s := range found {
					where := "not yet placed in a class"
					if s.class != "" {
						where = s.class
						if s.sec != "" {
							where += " " + s.sec
						}
						if s.roll != nil {
							where += fmt.Sprintf(", roll no %d", *s.roll)
						}
					}
					line := fmt.Sprintf("%s (admission no %s): %s.", s.name, s.adm, where)
					if wantsFee && id.Can(rbac.FeesRead) {
						var charged, paid int64
						// A failed scan must not report a false ₹0 balance a parent
						// might act on; the fee clause is simply omitted on error.
						if err := tx.QueryRow(r.Context(), `
							SELECT COALESCE((SELECT sum(net_paise) FROM invoices
							                  WHERE student_id=$1 AND status<>'cancelled'),0),
							       COALESCE((SELECT sum(amount_paise) FROM payments
							                  WHERE student_id=$1 AND status='success'),0)`, s.id).Scan(&charged, &paid); err == nil {
							bal := charged - paid
							line += fmt.Sprintf(" Fees: charged %s, paid %s, balance %s.",
								rupees(charged), rupees(paid), rupees(bal))
						}
					}
					facts = append(facts, line)
				}
			}
		}
		return nil
	})
	if len(facts) == 0 {
		return ""
	}
	return "FACTS (already scoped to what you are allowed to see; use these to answer, and do not guess beyond them):\n- " + strings.Join(facts, "\n- ")
}
