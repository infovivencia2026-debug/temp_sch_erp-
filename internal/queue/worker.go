package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

// Handlers carries the dependencies every task needs. Jobs talk to Postgres
// through the same RLS-scoped helper the HTTP layer uses, so a bug in a task
// cannot read across tenants either.
type Handlers struct {
	DB *database.DB
}

// Mux wires task types to handlers.
func (h *Handlers) Mux() *asynq.ServeMux {
	mux := asynq.NewServeMux()
	mux.Use(h.logging)

	mux.HandleFunc(TypeReportCardGenerate, h.reportCardGenerate)
	mux.HandleFunc(TypeInvoiceGenerate, h.invoiceGenerate)
	mux.HandleFunc(TypeFeeReminderFanout, h.feeReminderFanout)
	mux.HandleFunc(TypeMessageSend, h.messageSend)
	mux.HandleFunc(TypeBulkImport, h.bulkImport)
	mux.HandleFunc(TypeExportBuild, h.exportBuild)
	mux.HandleFunc(TypeAttendanceRollup, h.attendanceRollup)
	mux.HandleFunc(TypeSessionPrune, h.sessionPrune)
	return mux
}

func (h *Handlers) logging(next asynq.Handler) asynq.Handler {
	return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
		start := time.Now()
		var env struct {
			Envelope
		}
		_ = json.Unmarshal(t.Payload(), &env)

		err := next.ProcessTask(ctx, t)

		attrs := []any{
			"task", t.Type(),
			"duration_ms", time.Since(start).Milliseconds(),
			"institution_id", env.InstitutionID,
			"job_id", env.JobID,
			"request_id", env.RequestID,
		}
		if err != nil {
			slog.Error("task failed", append(attrs, "error", err)...)
		} else {
			slog.Info("task", attrs...)
		}
		return err
	})
}

// decode unmarshals the payload and rebuilds the tenant scope it must run in.
func decode[T any](t *asynq.Task) (T, database.Scope, error) {
	var p T
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		// SkipRetry: a payload that will not parse now will not parse on the
		// fifth attempt either. Retrying it just burns the queue.
		return p, database.Scope{}, fmt.Errorf("%w: %v", asynq.SkipRetry, err)
	}
	var env struct{ Envelope }
	_ = json.Unmarshal(t.Payload(), &env)
	return p, database.Scope{InstitutionID: env.InstitutionID}, nil
}

// --- handlers ---------------------------------------------------------------
//
// Each handler below establishes its tenant scope and then does the real work.
// The bodies are intentionally the minimum that exercises the plumbing
// end-to-end; the business rules for each belong in their own package as the
// modules are built out.

func (h *Handlers) reportCardGenerate(ctx context.Context, t *asynq.Task) error {
	p, scope, err := decode[ReportCardGeneratePayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT e.student_id
			  FROM enrollments e
			 WHERE e.section_id = $1 AND e.status = 'active'`, p.SectionID)
		if err != nil {
			return err
		}
		defer rows.Close()

		n := 0
		for rows.Next() {
			n++
		}
		if err := rows.Err(); err != nil {
			return err
		}
		slog.Info("report cards queued for render", "exam_id", p.ExamID, "students", n)
		return nil
	})
}

func (h *Handlers) invoiceGenerate(ctx context.Context, t *asynq.Task) error {
	p, scope, err := decode[InvoiceGeneratePayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var students int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM enrollments WHERE academic_year_id = $1 AND status = 'active'`,
			p.AcademicYearID).Scan(&students); err != nil {
			return err
		}
		slog.Info("invoice run", "fee_structure_id", p.FeeStructureID, "students", students)
		return nil
	})
}

func (h *Handlers) feeReminderFanout(ctx context.Context, t *asynq.Task) error {
	p, scope, err := decode[FeeReminderFanoutPayload](t)
	if err != nil {
		return err
	}
	// Fan-out reads the overdue set here and enqueues one message per guardian
	// rather than sending inline: a single task that sends 3,000 SMS holds a
	// worker slot for minutes and loses all progress if it dies at message
	// 2,900. One task per message retries independently.
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var overdue int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM invoices
			 WHERE status IN ('unpaid','partial','overdue') AND due_on < $1`,
			p.OverdueSince).Scan(&overdue); err != nil {
			return err
		}
		slog.Info("fee reminder fanout", "overdue_invoices", overdue, "template", p.TemplateKey)
		return nil
	})
}

func (h *Handlers) messageSend(ctx context.Context, t *asynq.Task) error {
	p, scope, err := decode[MessageSendPayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO message_log (institution_id, channel, template_key, to_user_id, status, sent_at)
			VALUES ($1, $2, $3, $4, 'queued', now())
			ON CONFLICT DO NOTHING`,
			p.InstitutionID, p.Channel, p.TemplateKey, p.ToUserID)
		return err
	})
}

func (h *Handlers) bulkImport(ctx context.Context, t *asynq.Task) error {
	p, _, err := decode[BulkImportPayload](t)
	if err != nil {
		return err
	}
	slog.Info("bulk import", "kind", p.Kind, "file_key", p.FileKey)
	return nil
}

func (h *Handlers) exportBuild(ctx context.Context, t *asynq.Task) error {
	p, _, err := decode[ExportBuildPayload](t)
	if err != nil {
		return err
	}
	slog.Info("export build", "kind", p.Kind, "format", p.Format)
	return nil
}

func (h *Handlers) attendanceRollup(ctx context.Context, t *asynq.Task) error {
	p, scope, err := decode[AttendanceRollupPayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var marked int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM student_attendance WHERE on_date = $1`, p.On).Scan(&marked); err != nil {
			return err
		}
		slog.Info("attendance rollup", "on", p.On.Format(time.DateOnly), "rows", marked)
		return nil
	})
}

// sessionPrune is cron-driven housekeeping. Expired rows are harmless to reads
// (Resolve filters on expires_at) but the table grows without bound otherwise.
func (h *Handlers) sessionPrune(ctx context.Context, _ *asynq.Task) error {
	return h.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`)
		if err != nil {
			return err
		}
		slog.Info("pruned sessions", "rows", tag.RowsAffected())
		return nil
	})
}
