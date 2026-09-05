package api

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
)

type enqueueRequest struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type enqueueResponse struct {
	JobID    string `json:"job_id"`
	TaskID   string `json:"task_id"`
	Type     string `json:"type"`
	Queue    string `json:"queue"`
	Accepted string `json:"accepted_at"`
	PollURL  string `json:"poll_url"`
}

// enqueueJob is the front door for every expensive operation.
//
// It answers 202, not 200: the work has been accepted, not performed. The
// client polls poll_url. Doing any of these inline would block a worker
// goroutine for minutes and, on a 1 vCPU box, take the whole service with it.
func (s *Server) enqueueJob(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req enqueueRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	env := queue.Envelope{
		InstitutionID: id.InstitutionID,
		ActorUserID:   id.UserID,
		RequestID:     httpx.RequestIDFrom(r.Context()),
		JobID:         uuid.New(),
	}

	// Each type is mapped explicitly rather than passing the client's JSON
	// straight through, so a caller cannot invent a task type or smuggle in an
	// institution_id belonging to someone else.
	var (
		payload any
		qname   string
	)
	switch req.Type {
	case queue.TypeReportCardGenerate:
		p := queue.ReportCardGeneratePayload{Envelope: env}
		p.ExamID = uuidFromMap(req.Payload, "exam_id")
		p.SectionID = uuidFromMap(req.Payload, "section_id")
		if p.ExamID == uuid.Nil || p.SectionID == uuid.Nil {
			httpx.BadRequest(w, r, "exam_id and section_id are required")
			return
		}
		payload, qname = p, queue.QueueBulk

	case queue.TypeInvoiceGenerate:
		p := queue.InvoiceGeneratePayload{Envelope: env}
		p.FeeStructureID = uuidFromMap(req.Payload, "fee_structure_id")
		p.AcademicYearID = uuidFromMap(req.Payload, "academic_year_id")
		p.DueOn = time.Now().AddDate(0, 0, 14)
		if p.FeeStructureID == uuid.Nil || p.AcademicYearID == uuid.Nil {
			httpx.BadRequest(w, r, "fee_structure_id and academic_year_id are required")
			return
		}
		payload, qname = p, queue.QueueBulk

	case queue.TypeFeeReminderFanout:
		p := queue.FeeReminderFanoutPayload{Envelope: env,
			OverdueSince: time.Now(), TemplateKey: stringFromMap(req.Payload, "template_key", "fee.overdue")}
		payload, qname = p, queue.QueueBulk

	case queue.TypeBulkImport:
		p := queue.BulkImportPayload{Envelope: env,
			Kind:    stringFromMap(req.Payload, "kind", ""),
			FileKey: stringFromMap(req.Payload, "file_key", "")}
		if p.Kind == "" || p.FileKey == "" {
			httpx.BadRequest(w, r, "kind and file_key are required")
			return
		}
		payload, qname = p, queue.QueueBulk

	case queue.TypeExportBuild:
		p := queue.ExportBuildPayload{Envelope: env,
			Kind:   stringFromMap(req.Payload, "kind", ""),
			Format: stringFromMap(req.Payload, "format", "csv")}
		if p.Kind == "" {
			httpx.BadRequest(w, r, "kind is required")
			return
		}
		payload, qname = p, queue.QueueBulk

	default:
		httpx.BadRequest(w, r, "unknown or non-enqueueable job type: "+req.Type)
		return
	}
	taskID, err := s.Queue.Enqueue(r.Context(), req.Type, payload, queue.HeavyOptions()...)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusAccepted, enqueueResponse{
		JobID:    env.JobID.String(),
		TaskID:   taskID,
		Type:     req.Type,
		Queue:    qname,
		Accepted: time.Now().UTC().Format(time.RFC3339),
		PollURL:  "/api/v1/jobs/" + taskID,
	})
}

func (s *Server) jobStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.Inspector.Find(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, queue.ErrJobNotFound) {
		// Retention is 24h; past that a completed job is genuinely gone rather
		// than failed, and the client should stop polling.
		httpx.Error(w, r, http.StatusNotFound, "job_not_found",
			"job is unknown or older than the 24h retention window")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

func (s *Server) queueStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.Inspector.Stats(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// QueueStats already carries every column this answered with under
	// asynq, in the same names, so the SPA's table did not change.
	httpx.JSON(w, http.StatusOK, map[string]any{"queues": stats})
}

// --- cron ------------------------------------------------------------------

/*
cronTick is the scheduler's clock, as an endpoint.

	GET or POST /api/v1/cron, with X-Cron-Key equal to CRON_KEY. It evaluates
	every schedule against the last time it ran, enqueues what has come due,
	and answers 200 with counts. That is the whole contract; see
	queue/cron.go for why cron is a request now rather than a goroutine that
	needs a process that never stops.

	Not behind a session, because the caller is a scheduler and not a person;
	not behind an API key, because API keys belong to a tenant and this acts
	for all of them. A shared secret in a header, compared in constant time,
	is the right size of lock for an endpoint whose worst-case abuse is
	running the housekeeping early. Unset CRON_KEY means the endpoint does
	not exist -- 401 to everyone -- so a deployment that has not configured
	it cannot be ticked by a guess of the empty string.

	Idempotent and cheap to call often. Two callers in the same minute
	serialise on an advisory lock and the second enqueues nothing, so a
	scheduler that retries a slow response does no harm. Anything that fails
	is a 500 and the caller's next tick tries again; the schedule is in the
	database, not in the request.
*/
func (s *Server) cronTick(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("CRON_KEY")
	got := r.Header.Get("X-Cron-Key")
	if key == "" || subtle.ConstantTimeCompare([]byte(key), []byte(got)) != 1 {
		httpx.Error(w, r, http.StatusUnauthorized, "unauthorized", "missing or wrong X-Cron-Key")
		return
	}
	if s.Queue == nil {
		httpx.Error(w, r, http.StatusServiceUnavailable, "queue_unavailable", "the queue is not configured")
		return
	}
	c := &queue.Cron{DB: s.DB, Queue: s.Queue, Schedules: s.CronSchedules()}
	res, err := c.Tick(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// CronTick is the exported handler cmd/web mounts at /api/v1/cron, above
// the session and audit middleware that the rest of /api/v1 sits under.
func (s *Server) CronTick(w http.ResponseWriter, r *http.Request) { s.cronTick(w, r) }

func uuidFromMap(m map[string]any, key string) uuid.UUID {
	s, _ := m[key].(string)
	v, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return v
}

func stringFromMap(m map[string]any, key, def string) string {
	if s, ok := m[key].(string); ok && s != "" {
		return s
	}
	return def
}
