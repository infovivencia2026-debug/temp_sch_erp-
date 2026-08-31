package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	anthropicopt "github.com/anthropics/anthropic-sdk-go/option"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
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

// assistantModel is Claude Opus 5. Named here so there is one line to change.
const assistantModel = "claude-opus-5"

/* Short answers on purpose, and not streamed.

   The tab does one fetch and one res.json(); it cannot render a stream, so a
   long generation would sit behind a spinner and risk the HTTP timeout. A
   help answer that runs past a few hundred words has stopped being an answer
   anyway. */
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

/* THE HISTORY, IN MEMORY AND DELIBERATELY FORGETFUL.

   The client sends a conversation id and one message -- never the transcript --
   so somebody has to hold the earlier turns for a follow-up to mean anything.

   In the process, not in Postgres. A chat about which screen to open is worth
   very little an hour later and nothing after a restart, and the alternative is
   a migration, a retention policy and a table of everything every member of
   staff has ever asked, sitting inside a school's database. Losing it on deploy
   is the better failure.

   One process serves this app, so a map is enough. Two would each hold half the
   conversations and a follow-up would land on the wrong one; that is the day
   this moves to Redis, which the app already runs. */
type assistantMemory struct {
	mu   sync.Mutex
	byID map[string]*assistantThread
}

type assistantThread struct {
	turns []anthropic.MessageParam
	seen  time.Time
}

const (
	assistantMaxThreads = 500
	assistantMaxTurns   = 12
	assistantThreadTTL  = 2 * time.Hour
)

var assistantThreads = &assistantMemory{byID: map[string]*assistantThread{}}

func (m *assistantMemory) load(id string) []anthropic.MessageParam {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.byID[id]
	if !ok || time.Since(t.seen) > assistantThreadTTL {
		return nil
	}
	return append([]anthropic.MessageParam(nil), t.turns...)
}

func (m *assistantMemory) save(id string, turns []anthropic.MessageParam) {
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

/* The screens this person can actually open, as the model's ground truth.

   Built from the same catalogue that builds the navigation, filtered to the
   asker's roles: naming a screen a parent cannot reach is not a small error,
   it is telling somebody the product has a door that is locked to them. */
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

	/* No key, no pretending.

	   The tab used to fail here with a JSON parse error because nothing was
	   listening. A school that has not bought an assistant should be told that
	   in a sentence, not shown a broken panel. */
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		httpx.Error(w, r, http.StatusServiceUnavailable, "assistant_not_configured",
			"the assistant is not switched on for this school. Ask whoever runs the server to set ANTHROPIC_API_KEY.")
		return
	}

	// The session's roles, not the body's. The client sends `roles` and it is
	// ignored: it is the one field a curious parent could edit.
	roles := s.assistantRoles(r, id)

	conversationID := req.ConversationID
	if _, err := uuid.Parse(conversationID); err != nil {
		conversationID = uuid.NewString()
	}
	turns := assistantThreads.load(conversationID)
	turns = append(turns, anthropic.NewUserMessage(anthropic.NewTextBlock(req.Message)))

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	client := anthropic.NewClient(anthropicopt.WithAPIKey(key))
	resp, err := client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     assistantModel,
		MaxTokens: assistantMaxTokens,
		/* The prompt and the catalogue are cached; the question is not.

		   Every member of staff sends the same several-thousand-token screen
		   list in front of a one-line question, and the cache is a prefix
		   match, so the stable half goes first and carries the breakpoint. */
		System: []anthropic.TextBlockParam{{
			Text:         assistantSystemPrompt + "\n\n" + assistantGrounding(roles),
			CacheControl: anthropic.NewCacheControlEphemeralParam(),
		}},
		Messages: turns,
	})
	if err != nil {
		s.assistantFailure(w, r, err)
		return
	}

	var answer strings.Builder
	for _, block := range resp.Content {
		if text, ok := block.AsAny().(anthropic.TextBlock); ok {
			answer.WriteString(text.Text)
		}
	}
	/* A refusal is an answer, not an error.

	   Returning 500 here would put "something went wrong" in front of somebody
	   whose question was merely declined, and they would ask it again. */
	if strings.TrimSpace(answer.String()) == "" {
		answer.Reset()
		answer.WriteString("I could not answer that one. Try asking it a different way, or ask the school office.")
	}

	turns = append(turns, anthropic.NewAssistantMessage(anthropic.NewTextBlock(answer.String())))
	assistantThreads.save(conversationID, turns)

	httpx.JSON(w, http.StatusOK, assistantChatResponse{
		Answer:         answer.String(),
		ConversationID: conversationID,
	})
}

/* The failures worth telling apart.

   A rate limit and a wrong key are both "the assistant did not answer" to the
   person asking, but only one of them is worth waiting out, and only one is
   worth telephoning the office about. */
func (s *Server) assistantFailure(w http.ResponseWriter, r *http.Request, err error) {
	httpx.LogError(r, err)

	var apiErr *anthropic.Error
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
