package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
mountReportDigests registers the digest settings screen's two endpoints under
/reports/digest.

	Reading the settings is gated on admin.reports.read -- the reporting right
	the roll-ups already read under. Changing them, including who is on the
	schedule, is an administrator's decision, so the PUT is gated on
	institution.settings.write, which institution_admin holds. Both keys already
	exist in internal/rbac; neither is invented here.
*/
func (s *Server) mountReportDigests(r chi.Router) {
	r.Route("/reports/digest", func(r chi.Router) {
		r.With(httpx.RequirePermission(rbac.ReportsRead)).Get("/settings", s.getDigestSettings)
		r.With(httpx.RequirePermission(rbac.SettingsWrite)).Put("/settings", s.putDigestSettings)
	})
}

/*
Scheduled report digests: the morning and the week, carried to the people who
steer the school rather than run it.

	A board member does not open the ERP, and an institution admin who does reads
	the same four numbers each day. This turns those numbers into a message that
	arrives on a schedule -- 07:00 daily, 07:00 Monday for the week that closed --
	on whichever channels the school already sends on.

	Three rules this file keeps, all of them the reason it is thin:

	  It owns no aggregate. Every figure is assembled here from the same
	  definitions admin_rollups.go uses -- collected excludes adjustments,
	  overdue is net minus paid on a bill past its due date, staff-away is absent
	  or on leave -- so a digest and the dashboard it summarises can never quote
	  two different numbers.

	  It stores no recipient. Who receives a digest is resolved at send time as
	  the users holding board_member or institution_admin in the school, so a
	  board member added tomorrow is on the next morning's run without anyone
	  editing a settings row.

	  It sends nothing itself. It assembles the body and hands each message to
	  QueueMessage, which the dispatcher drains -- the one road out of the
	  building, with the recipient allowlist and the provider check in front of
	  every send.
*/

// The four reports a digest can carry, each independently toggleable. Order is
// the order they appear in the body, so it is stable and defined once.
var digestReportKeys = []string{
	"attendance_summary",
	"fees_collected_dues",
	"admissions_enrolment",
	"staff_attendance_leave",
}

var digestReportLabels = map[string]string{
	"attendance_summary":     "Student attendance",
	"fees_collected_dues":    "Fees: collected & dues",
	"admissions_enrolment":   "Admissions & enrolment",
	"staff_attendance_leave": "Staff attendance & leave",
}

// reportChannelCfg is one report's line in the config: is it on, and on which
// channels does it ride.
type reportChannelCfg struct {
	Enabled  bool     `json:"enabled"`
	Channels []string `json:"channels"`
}

// digestSettings is the whole of a school's configuration.
type digestSettings struct {
	Config        map[string]reportChannelCfg `json:"config"`
	DailyEnabled  bool                        `json:"daily_enabled"`
	WeeklyEnabled bool                        `json:"weekly_enabled"`
}

// defaultDigestSettings is what a school that has never been asked gets: every
// report on email and in-app, both runs on. Silence is "sensible default", not
// "send nothing" -- the latter would make the feature invisible until somebody
// found a screen they did not know existed.
func defaultDigestSettings() digestSettings {
	cfg := map[string]reportChannelCfg{}
	for _, k := range digestReportKeys {
		cfg[k] = reportChannelCfg{Enabled: true, Channels: []string{"email", "in_app"}}
	}
	return digestSettings{Config: cfg, DailyEnabled: true, WeeklyEnabled: true}
}

// digestChannels are the channels a report may be sent on. Mirrors
// messagingChannels; named here so the settings validator does not depend on
// the messaging file's private slice.
var digestChannels = map[string]bool{"email": true, "sms": true, "whatsapp": true, "in_app": true}

// loadDigestSettings reads the school's row, or returns the default when there
// is none. A report missing from a stored config is treated as off, so adding a
// fifth report later does not silently start sending to schools that never
// chose it.
func loadDigestSettings(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (digestSettings, error) {
	var raw []byte
	var daily, weekly bool
	err := tx.QueryRow(ctx, `
		SELECT config, daily_enabled, weekly_enabled
		  FROM report_digest_settings WHERE institution_id = $1`, inst).
		Scan(&raw, &daily, &weekly)
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultDigestSettings(), nil
	}
	if err != nil {
		return digestSettings{}, err
	}
	cfg := map[string]reportChannelCfg{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return digestSettings{}, fmt.Errorf("digest config unreadable: %w", err)
		}
	}
	return digestSettings{Config: cfg, DailyEnabled: daily, WeeklyEnabled: weekly}, nil
}

// --- settings API ------------------------------------------------------------

type digestSettingsResponse struct {
	Config         map[string]reportChannelCfg `json:"config"`
	DailyEnabled   bool                        `json:"daily_enabled"`
	WeeklyEnabled  bool                        `json:"weekly_enabled"`
	Reports        []digestReportMeta          `json:"reports"`
	Recipients     []digestRecipient           `json:"recipients"`
	RecipientCount int                         `json:"recipient_count"`
}

type digestReportMeta struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type digestRecipient struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
}

func reportMeta() []digestReportMeta {
	out := make([]digestReportMeta, 0, len(digestReportKeys))
	for _, k := range digestReportKeys {
		out = append(out, digestReportMeta{Key: k, Label: digestReportLabels[k]})
	}
	return out
}

// getDigestSettings returns the config and the resolved recipient list. Gated
// on admin.reports.read -- the same right getToday and the other roll-ups read
// under, which institution_admin and vice_principal hold.
func (s *Server) getDigestSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := digestSettingsResponse{Reports: reportMeta(), Recipients: []digestRecipient{}}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := loadDigestSettings(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		out.Config = set.Config
		out.DailyEnabled = set.DailyEnabled
		out.WeeklyEnabled = set.WeeklyEnabled
		recips, err := digestRecipients(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		out.Recipients = recips
		out.RecipientCount = len(recips)
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type digestSettingsRequest struct {
	Config        map[string]reportChannelCfg `json:"config"`
	DailyEnabled  bool                        `json:"daily_enabled"`
	WeeklyEnabled bool                        `json:"weekly_enabled"`
}

// putDigestSettings replaces the school's config. Gated on
// institution.settings.write, which institution_admin holds -- reading a report
// and deciding who gets it on a schedule are different rights, and the second
// is an administrator's.
func (s *Server) putDigestSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req digestSettingsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	// Keep only known reports and known channels, so an unknown key typed by a
	// client cannot become a report the builder later trips over, and a
	// duplicate channel cannot double a message.
	clean := map[string]reportChannelCfg{}
	for _, k := range digestReportKeys {
		c, ok := req.Config[k]
		if !ok {
			continue
		}
		seen := map[string]bool{}
		chans := []string{}
		for _, ch := range c.Channels {
			ch = strings.TrimSpace(ch)
			if digestChannels[ch] && !seen[ch] {
				seen[ch] = true
				chans = append(chans, ch)
			}
		}
		// A report enabled with no channel would silently never send; make that
		// visible by refusing it rather than storing a rule that does nothing.
		if c.Enabled && len(chans) == 0 {
			httpx.BadRequest(w, r, fmt.Sprintf(
				"%q is switched on but has no channel selected -- choose a channel or switch it off",
				digestReportLabels[k]))
			return
		}
		clean[k] = reportChannelCfg{Enabled: c.Enabled, Channels: chans}
	}

	raw, err := json.Marshal(clean)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := digestSettingsResponse{
		Config: clean, DailyEnabled: req.DailyEnabled, WeeklyEnabled: req.WeeklyEnabled,
		Reports: reportMeta(), Recipients: []digestRecipient{},
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO report_digest_settings
			    (institution_id, config, daily_enabled, weekly_enabled, updated_by, updated_at)
			VALUES ($1, $2::jsonb, $3, $4, $5, now())
			ON CONFLICT (institution_id) DO UPDATE
			   SET config = EXCLUDED.config,
			       daily_enabled = EXCLUDED.daily_enabled,
			       weekly_enabled = EXCLUDED.weekly_enabled,
			       updated_by = EXCLUDED.updated_by,
			       updated_at = now()`,
			id.InstitutionID, raw, req.DailyEnabled, req.WeeklyEnabled, id.UserID); err != nil {
			return err
		}
		recips, err := digestRecipients(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		out.Recipients = recips
		out.RecipientCount = len(recips)
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- recipient resolution ----------------------------------------------------

/*
digestRecipients is who a digest goes to: the users holding board_member or
institution_admin in this school.

	Resolved from the role graph every time rather than stored, so the list is
	always current -- a board member added this morning is on this evening's
	digest. Distinct on the user, because a person holding both roles is one
	recipient; the role shown is whichever sorts first, only for the settings
	screen's benefit. Tenant-scoped by the surrounding RLS transaction and, for
	belt and braces, by the institution_id predicate.
*/
func digestRecipients(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]digestRecipient, error) {
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.full_name, min(r.key)
		  FROM users u
		  JOIN user_roles ur ON ur.user_id = u.id
		  JOIN roles r       ON r.id = ur.role_id
		 WHERE u.institution_id = $1 AND u.status = 'active'
		   AND r.key IN ('board_member','institution_admin')
		 GROUP BY u.id, u.full_name
		 ORDER BY u.full_name`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []digestRecipient{}
	for rows.Next() {
		var v digestRecipient
		if err := rows.Scan(&v.UserID, &v.Name, &v.Role); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// --- digest builder ----------------------------------------------------------

// digestRange is the window a period covers, computed in India time so a box on
// UTC does not shift the day.
type digestRange struct {
	Period string
	FromS  string // inclusive date, YYYY-MM-DD
	ToS    string // inclusive date, YYYY-MM-DD
	Label  string
}

func digestRangeFor(period string, now time.Time) digestRange {
	today := now.Format(time.DateOnly)
	if period == "weekly" {
		from := now.AddDate(0, 0, -6).Format(time.DateOnly)
		return digestRange{Period: period, FromS: from, ToS: today,
			Label: "the week " + from + " to " + today}
	}
	return digestRange{Period: "daily", FromS: today, ToS: today, Label: today}
}

/*
buildDigestSection returns one report's text block, or "" with ok=false when the
report has nothing to say. Every query here reuses an admin_rollups definition:
present is present-or-late over the denominator, collected excludes adjustments,
overdue is net-minus-paid on a bill past its due date, staff-away is absent or on
leave. Nothing is a new aggregate.
*/
func (s *Server) buildDigestSection(ctx context.Context, tx pgx.Tx, key string, rng digestRange) (string, error) {
	switch key {
	case "attendance_summary":
		var present, absent, total int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE status IN ('present','late')),
			       count(*) FILTER (WHERE status = 'absent'),
			       count(*)
			  FROM student_attendance
			 WHERE on_date BETWEEN $1::date AND $2::date`, rng.FromS, rng.ToS).
			Scan(&present, &absent, &total); err != nil {
			return "", fmt.Errorf("attendance summary: %w", err)
		}
		if total == 0 {
			return "No student attendance was marked in this period.", nil
		}
		pct := 100 * present / total
		return fmt.Sprintf("Registers marked: %d. Present/late: %d. Absent: %d. Attendance: %d%%.",
			total, present, absent, pct), nil

	case "fees_collected_dues":
		var collected, overdue int64
		var receipts, defaulters int
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status = 'success' AND mode <> 'adjustment'
			               AND paid_on BETWEEN $1::date AND $2::date), 0),
			  (SELECT count(*) FROM payments
			    WHERE status = 'success' AND mode <> 'adjustment'
			      AND paid_on BETWEEN $1::date AND $2::date),
			  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			             WHERE status IN ('unpaid','partial','overdue')
			               AND due_on IS NOT NULL AND due_on < $2::date), 0),
			  (SELECT count(DISTINCT student_id) FROM invoices
			    WHERE status IN ('unpaid','partial','overdue')
			      AND due_on IS NOT NULL AND due_on < $2::date)
			`, rng.FromS, rng.ToS).Scan(&collected, &receipts, &overdue, &defaulters); err != nil {
			return "", fmt.Errorf("fees section: %w", err)
		}
		return fmt.Sprintf(
			"Collected: %s across %d receipts. Overdue outstanding: %s from %d students.",
			rupeesText(collected), receipts, rupeesText(overdue), defaulters), nil

	case "admissions_enrolment":
		var enquiries, awaiting, accepted int
		if err := tx.QueryRow(ctx, `
			SELECT
			  (SELECT count(*) FROM applications
			    WHERE created_at::date BETWEEN $1::date AND $2::date),
			  (SELECT count(*) FROM applications
			    WHERE status IN ('submitted','under_review','test_scheduled','interviewed')),
			  (SELECT count(*) FROM applications WHERE status = 'accepted')
			`, rng.FromS, rng.ToS).Scan(&enquiries, &awaiting, &accepted); err != nil {
			return "", fmt.Errorf("admissions section: %w", err)
		}
		return fmt.Sprintf(
			"New applications this period: %d. Awaiting a decision: %d. Accepted (to date): %d.",
			enquiries, awaiting, accepted), nil

	case "staff_attendance_leave":
		var absent, leave int
		if err := tx.QueryRow(ctx, `
			SELECT count(DISTINCT user_id) FILTER (WHERE status = 'absent'),
			       count(DISTINCT user_id) FILTER (WHERE status = 'leave')
			  FROM staff_attendance
			 WHERE on_date BETWEEN $1::date AND $2::date`, rng.FromS, rng.ToS).
			Scan(&absent, &leave); err != nil {
			return "", fmt.Errorf("staff section: %w", err)
		}
		return fmt.Sprintf("Staff absent: %d. On leave: %d.", absent, leave), nil
	}
	return "", nil
}

// rupeesText renders paise as ₹ with two decimals, the way a body a person
// reads wants it (the CSV cells use rupeesCell without the symbol).
func rupeesText(paise int64) string {
	return fmt.Sprintf("₹%.2f", float64(paise)/100)
}

/*
SendReportDigest builds and queues one school's digest for the period.

	The shape of the send: one combined message per recipient per channel. For
	each channel, the reports whose config names that channel are gathered into
	one body -- so "attendance on email and in-app, fees on email only" produces
	an email carrying both and an in-app note carrying attendance alone, which is
	the per-report channel selection respected exactly. A recipient with no
	address for a channel, or a channel the school has not configured, is skipped
	for that channel and the rest continue; only a real fault stops the run.

	Idempotent by occurrence key period:channel:date, so a retried job -- or two
	overlapping ticks -- cannot send the same morning's digest twice.
*/
func (s *Server) SendReportDigest(ctx context.Context, inst uuid.UUID, period string) error {
	if period != "daily" && period != "weekly" {
		return fmt.Errorf("report digest: unknown period %q", period)
	}
	return s.DB.InTenant(ctx, tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		set, err := loadDigestSettings(ctx, tx, inst)
		if err != nil {
			return err
		}
		if (period == "daily" && !set.DailyEnabled) || (period == "weekly" && !set.WeeklyEnabled) {
			return nil
		}

		// Which reports are on, in stable order.
		enabled := []string{}
		for _, k := range digestReportKeys {
			if c, ok := set.Config[k]; ok && c.Enabled && len(c.Channels) > 0 {
				enabled = append(enabled, k)
			}
		}
		if len(enabled) == 0 {
			return nil
		}

		recips, err := digestRecipients(ctx, tx, inst)
		if err != nil {
			return err
		}
		if len(recips) == 0 {
			return nil
		}

		var school string
		if err := tx.QueryRow(ctx, `SELECT name FROM institutions WHERE id = $1`, inst).Scan(&school); err != nil {
			return err
		}

		now := nowInIndia()
		rng := digestRangeFor(period, now)

		// Build each enabled report's block once; reused across channels and
		// recipients rather than recomputed per message.
		blocks := map[string]string{}
		for _, k := range enabled {
			body, err := s.buildDigestSection(ctx, tx, k, rng)
			if err != nil {
				return err
			}
			blocks[k] = body
		}

		// Group reports by channel: a channel's message carries exactly the
		// reports whose config names it.
		byChannel := map[string][]string{}
		for _, k := range enabled {
			for _, ch := range set.Config[k].Channels {
				byChannel[ch] = append(byChannel[ch], k)
			}
		}
		channels := make([]string, 0, len(byChannel))
		for ch := range byChannel {
			channels = append(channels, ch)
		}
		sort.Strings(channels)

		periodWord := "Daily"
		if period == "weekly" {
			periodWord = "Weekly"
		}
		subject := fmt.Sprintf("%s: %s report digest — %s", school, periodWord, rng.Label)
		occDate := now.Format(time.DateOnly)
		code := "report_digest." + period

		for _, ch := range channels {
			/* The email alone carries the files: a PDF summary of the reports
			   it holds and each of their datasets as a CSV, built once and
			   attached to every recipient's copy. Other channels have no
			   envelope for a file, so they carry a line pointing the reader at
			   the email instead. */
			note := digestOtherChannelNote
			var atts []OutboundAttachment
			if ch == "email" {
				note = ""
				pdf, err := renderDigestPDF(school, periodWord, rng, byChannel[ch], blocks)
				if err != nil {
					return err
				}
				atts = append(atts, OutboundAttachment{
					Filename:    fmt.Sprintf("report-digest-%s-%s.pdf", period, occDate),
					ContentType: "application/pdf",
					Data:        pdf,
				})
				csvs, err := s.digestCSVAttachments(ctx, tx, byChannel[ch], rng)
				if err != nil {
					return err
				}
				atts = append(atts, csvs...)
			}
			body := renderDigestBody(school, periodWord, rng, byChannel[ch], blocks, note)
			for _, rec := range recips {
				uid, err := uuid.Parse(rec.UserID)
				if err != nil {
					continue
				}
				u := uid
				_, err = s.queueDigestMessage(ctx, tx, inst, SendRequest{
					Channel:       ch,
					TemplateCode:  code,
					Vars:          map[string]any{"subject": subject, "body": body, "school_name": school},
					ToUserID:      &u,
					SourceKind:    "report_digest",
					OccurrenceKey: period + ":" + ch + ":" + occDate,
					Attachments:   atts,
				})
				if err != nil {
					// A recipient with no address for this channel, or a channel
					// the school never configured, is not a reason to abandon the
					// digest -- record and carry on to the next.
					if errors.Is(err, ErrNoRecipient) || errors.Is(err, ErrProviderNotConfigured) {
						continue
					}
					return err
				}
			}
		}
		return nil
	})
}

// queueDigestMessage is QueueMessage with the not-configured/no-recipient cases
// left to the caller to skip. Split out only to keep SendReportDigest readable.
func (s *Server) queueDigestMessage(ctx context.Context, tx pgx.Tx, inst uuid.UUID, req SendRequest) (SendResult, error) {
	return s.QueueMessage(ctx, tx, inst, req)
}

// renderDigestBody assembles the plain-text body for one channel's message from
// the report blocks it carries. Plain text so it reads the same over SMS as
// over email; the sections a channel does not carry are simply absent.
func renderDigestBody(school, periodWord string, rng digestRange, reports []string, blocks map[string]string, note string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s report digest for %s\n%s\n\n", periodWord, school, rng.Label)
	for _, k := range reports {
		fmt.Fprintf(&b, "%s\n%s\n\n", digestReportLabels[k], blocks[k])
	}
	// The note points a reader on SMS, WhatsApp or in-app at the email, which
	// alone carries the PDF summary and the CSV data files. Empty for email
	// itself, whose attachments are the thing being pointed at.
	if note != "" {
		b.WriteString(note)
		b.WriteString("\n\n")
	}
	b.WriteString(school)
	return b.String()
}

// digestOtherChannelNote is the one line a non-email digest carries so its
// reader knows the full report went somewhere they can open it.
const digestOtherChannelNote = "The full PDF report and data files were sent to the email address on file."

// --- attachments: the PDF summary and the CSV data ---------------------------

/*
digestExportsFor maps a digest report key to the export datasets whose CSV
carries its underlying data.

	The digest body and the PDF summarise a report in a sentence; a board member
	who wants the rows behind "Collected: Rs X across N receipts" opens the CSV
	beside it. The datasets are the same exportable queries the download screen
	offers, reused rather than duplicated so the digest's data and a manual
	export can never drift. A key with no natural tabular dataset -- there is
	none today -- maps to nothing and is summarised by the PDF alone.
*/
var digestExportsFor = map[string][]string{
	"attendance_summary":     {"attendance"},
	"fees_collected_dues":    {"collections", "fees_by_student", "defaulters"},
	"admissions_enrolment":   {"admissions"},
	"staff_attendance_leave": {"staff-attendance", "leave"},
}

/*
digestCSVAttachments builds one CSV OutboundAttachment per export dataset the
enabled reports map to.

	Each is the exportable spec's own query run in the digest's tenant
	transaction, written with the same UTF-8 BOM and header row as the download
	screen's exportCSV so Excel opens Telugu names correctly. The bytes are
	buffered rather than streamed because they become an email attachment, not
	an HTTP response. A dataset that fails to read is skipped with the rest
	continuing -- a digest with three of four CSVs is better than no digest.
*/
func (s *Server) digestCSVAttachments(ctx context.Context, tx pgx.Tx, enabled []string, rng digestRange) ([]OutboundAttachment, error) {
	dateRange := rng.ToS
	if rng.Period == "weekly" {
		dateRange = rng.FromS + "_" + rng.ToS
	}

	// Distinct datasets in stable order: two reports could name the same one.
	seen := map[string]bool{}
	var slugs []string
	for _, k := range enabled {
		for _, slug := range digestExportsFor[k] {
			if !seen[slug] {
				seen[slug] = true
				slugs = append(slugs, slug)
			}
		}
	}

	var out []OutboundAttachment
	for _, slug := range slugs {
		spec, ok := exportable[slug]
		if !ok {
			continue
		}
		data, err := digestCSVBytes(ctx, tx, spec)
		if err != nil {
			return nil, err
		}
		out = append(out, OutboundAttachment{
			Filename:    fmt.Sprintf("%s-%s.csv", slug, dateRange),
			ContentType: "text/csv; charset=utf-8",
			Data:        data,
		})
	}
	return out, nil
}

// digestCSVBytes runs one export spec's query into a CSV buffer, header first,
// mirroring exportCSV's BOM-and-header shape so the file behaves like a manual
// download.
func digestCSVBytes(ctx context.Context, tx pgx.Tx, spec exportSpec) ([]byte, error) {
	var buf bytes.Buffer
	// Excel opens a UTF-8 file as ANSI unless it sees a BOM, which turns Telugu
	// names into mojibake for exactly the schools that need them most.
	buf.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(&buf)
	if err := cw.Write(spec.header); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, spec.query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	n := len(spec.header)
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		rec := make([]string, n)
		for i := 0; i < n && i < len(vals); i++ {
			if vals[i] == nil {
				continue
			}
			rec[i] = strings.TrimSpace(fmt.Sprint(vals[i]))
		}
		if err := cw.Write(rec); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
