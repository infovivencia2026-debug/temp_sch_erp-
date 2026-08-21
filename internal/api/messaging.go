package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
	"github.com/school-erp/erp/internal/rbac"
)

/* The messaging foundation: one sender, one trigger contract, one dedupe key.

   Four features are queued behind this file — absence alerts, PTM reminders,
   fee reminders and admissions campaign sequences — and every one of them
   wants the same sentence: "when X happens, tell these people this." Built
   separately they would arrive as four senders with four ideas of what a
   duplicate is, and a parent would get the same fee chase three times because
   three of them agreed it was overdue.

   What is here, and what is deliberately not:

     A provider is the only way out of the building. SMTP is real and
     testable today; the SMS and WhatsApp gateways are the same code path
     waiting on a vendor account, so they are one row of credentials away
     rather than one release away. Nothing here ever pretends to have sent
     something. An unconfigured provider refuses, loudly, at the point of
     asking — not silently at 3 a.m. inside a worker.

     A trigger rule is a row: event, condition, audience, template, lead time
     and quiet hours. "Remind guardians 24 hours before a PTM" is a form
     somebody fills in. Rules are read by the sweep below; they are never a
     query the administrator writes, because a rule an administrator can edit
     must not be able to read a table they cannot.

     Idempotency lives in one index. message_log carries source_kind,
     source_id and occurrence_key, and 00039 puts a unique index across them —
     the same scheme portal_school_life.go already uses on notifications. The
     dedupe is the database's job, not the caller's: a feature that has to
     remember to check first is a feature that forgets on the retry path.

   Two things this file leaves alone on purpose. queue.TypeMessageSend exists
   and its worker handler writes columns message_log has never had, so it has
   never delivered anything; wiring the contract to it would inherit that. And
   notifications remains the in-app channel, written by portal_school_life.go —
   a message here is what leaves the building, an alert there is what waits
   inside it, and merging them would put an SMS charge behind a screen refresh. */

// --- errors ------------------------------------------------------------------

/*
ErrProviderNotConfigured is what every caller gets instead of a pretend send.

	Returned by name rather than as a string so a fan-out can tell "this school
	has not set up email yet" — an operator's job — apart from "the mail server
	rejected us", which is an incident. The screen shows the first as a prompt
	and the second as a fault.
*/
var ErrProviderNotConfigured = errors.New("messaging provider is not configured")

// ErrNoRecipient is a message with nowhere to go: a guardian with no email on
// file, a student whose account has no phone. Not an error in the sender, and
// not a reason to fail the whole sweep — it is recorded against the one
// recipient and the rest of the fan-out continues.
var ErrNoRecipient = errors.New("no address on file for this recipient")

// --- the provider abstraction ------------------------------------------------

// OutboundMessage is what a provider is handed. Deliberately post-render: the
// provider knows about wires, never about templates or tenancy.
type OutboundMessage struct {
	To      string
	Subject string
	Body    string
	// The DLT template id the Indian SMS regime requires on every commercial
	// message. Empty for channels that have no such regime.
	DLTTemplateID string

	/* WA is the approved WhatsApp template this message is to be sent as.

	   Added by internal/api/whatsapp.go. Outside a 24-hour customer-service
	   window the WhatsApp Cloud API accepts only a pre-approved template --
	   a name and positional parameters, not a body -- and every message this
	   product sends is outside that window, because parents do not message
	   the school first. Body alone is therefore not enough to send WhatsApp,
	   and pretending otherwise produces a provider that passes every test
	   here and is rejected by Meta for every real parent.

	   Still post-render, like the rest of this struct: it carries resolved
	   values, never a template lookup. Nil for every other channel, and nil
	   for a WhatsApp message with no approved template mapped -- which the
	   Cloud provider refuses by name rather than downgrading to free text. */
	WA *whatsappTemplateSend
}

/*
MessagingProvider is one way out of the building.

	Three channels, one interface, so that the two blocked on a vendor account
	are a missing credential rather than missing code. Adding a fourth is a
	struct and a case in loadProviders; it is not a change to any caller.

	Configured() is separate from Send() because the honest answer to "can this
	school send an SMS" has to be available before anybody asks it to, so the
	screen can say "not set up" rather than the parent finding out.
*/
type MessagingProvider interface {
	// Channel is the message_log.channel value this provider serves.
	Channel() string
	// Name is what goes in message_log.provider — 'smtp', 'sms:msg91'.
	Name() string
	// Configured reports whether a send would be attempted at all.
	Configured() bool
	// Why explains an unconfigured provider in a sentence an administrator can
	// act on. Empty when Configured is true.
	Why() string
	// Send returns the provider's own message id when it has one.
	Send(ctx context.Context, m OutboundMessage) (string, error)
}

// providerSet is every channel's provider for one school, loaded once per
// fan-out. A per-message load would read integrations once per guardian.
type providerSet map[string]MessagingProvider

// messagingChannels are the channels a rule or a send may name. push is absent
// on purpose: there is no device token anywhere in this schema, so offering it
// would be the pretend send this file exists to avoid.
var messagingChannels = []string{"email", "sms", "whatsapp", "in_app"}

func knownChannel(c string) bool {
	for _, k := range messagingChannels {
		if k == c {
			return true
		}
	}
	return false
}

// --- unconfigured ------------------------------------------------------------

// unconfiguredProvider is what a channel resolves to when nobody has set it
// up. It exists so that "not configured" travels through the same interface as
// a working provider: the alternative is a nil check at every call site, and
// the one that gets forgotten is the one that panics during a fee run.
type unconfiguredProvider struct {
	channel string
	reason  string
}

func (p unconfiguredProvider) Channel() string { return p.channel }
func (p unconfiguredProvider) Name() string    { return p.channel + ":unconfigured" }
func (p unconfiguredProvider) Configured() bool {
	return false
}
func (p unconfiguredProvider) Why() string { return p.reason }
func (p unconfiguredProvider) Send(context.Context, OutboundMessage) (string, error) {
	return "", fmt.Errorf("%s: %w: %s", p.channel, ErrProviderNotConfigured, p.reason)
}

// --- in-app ------------------------------------------------------------------

/*
inAppProvider is the one channel that needs no vendor.

	It is always configured because delivering it is writing a row this
	installation already owns. Kept behind the same interface so a trigger rule
	can name in_app exactly as it names email, and so a school with no SMS
	account can still automate something on day one.
*/
type inAppProvider struct{}

func (inAppProvider) Channel() string  { return "in_app" }
func (inAppProvider) Name() string     { return "in_app" }
func (inAppProvider) Configured() bool { return true }
func (inAppProvider) Why() string      { return "" }

// Send is a no-op that reports success: the message_log row the dispatcher
// writes around this call *is* the delivery for this channel. The parent's
// feed is materialised by portal_school_life.go from the facts themselves, so
// writing a notifications row here too would show the same absence twice.
func (inAppProvider) Send(context.Context, OutboundMessage) (string, error) {
	return "", nil
}

// --- SMTP --------------------------------------------------------------------

type smtpSettings struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	FromAddress string `json:"from_address"`
	FromName    string `json:"from_name"`
	// none | starttls | tls. Named rather than inferred from the port, because
	// a school on 587 with an appliance that does not offer STARTTLS otherwise
	// gets a connection that hangs with no explanation.
	Security string `json:"security"`
}

type smtpProvider struct {
	cfg      smtpSettings
	password string
}

func (p smtpProvider) Channel() string { return "email" }
func (p smtpProvider) Name() string    { return "smtp" }

func (p smtpProvider) Configured() bool { return p.Why() == "" }

func (p smtpProvider) Why() string {
	switch {
	case strings.TrimSpace(p.cfg.Host) == "":
		return "no SMTP host set"
	case p.cfg.Port <= 0:
		return "no SMTP port set"
	case strings.TrimSpace(p.cfg.FromAddress) == "":
		return "no From address set — a message with no sender is rejected by every recipient"
	}
	return ""
}

/*
Send delivers one message over SMTP.

	The dial timeout is explicit and short. net/smtp's own Dial has none, so a
	mail host that accepts the TCP connection and then says nothing holds the
	dispatcher until the request times out — and the school sees a screen that
	never returns rather than a message that failed.
*/
func (p smtpProvider) Send(ctx context.Context, m OutboundMessage) (string, error) {
	if !p.Configured() {
		return "", fmt.Errorf("email: %w: %s", ErrProviderNotConfigured, p.Why())
	}
	addr := fmt.Sprintf("%s:%d", p.cfg.Host, p.cfg.Port)

	// Explicit, and short. net/smtp's own Dial has no timeout at all, so a
	// host that completes the TCP handshake and then says nothing holds the
	// dispatcher for as long as the request lives.
	dialer := &net.Dialer{Timeout: 15 * time.Second}

	var conn net.Conn
	var err error
	if strings.EqualFold(p.cfg.Security, "tls") {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr,
			&tls.Config{ServerName: p.cfg.Host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return "", fmt.Errorf("dial %s: %w", addr, err)
	}
	defer conn.Close() //nolint:errcheck // the QUIT below is the orderly close

	// The deadline covers the whole conversation, not just the dial. A server
	// that accepts DATA and then stalls is the same hang one layer down.
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	}

	c, err := smtp.NewClient(conn, p.cfg.Host)
	if err != nil {
		return "", err
	}
	defer c.Close() //nolint:errcheck

	if strings.EqualFold(p.cfg.Security, "starttls") {
		if err := c.StartTLS(&tls.Config{ServerName: p.cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return "", fmt.Errorf("starttls: %w", err)
		}
	}
	// Authentication is skipped when no username is stored, which is the shape
	// of a school relaying through its own on-premises mail server. Sending
	// credentials to a host that did not ask for them is how a password ends
	// up in somebody else's log.
	if p.cfg.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", p.cfg.Username, p.password, p.cfg.Host)); err != nil {
			return "", fmt.Errorf("auth: %w", err)
		}
	}
	if err := c.Mail(p.cfg.FromAddress); err != nil {
		return "", fmt.Errorf("from: %w", err)
	}
	if err := c.Rcpt(m.To); err != nil {
		return "", fmt.Errorf("rcpt %s: %w", m.To, err)
	}
	w, err := c.Data()
	if err != nil {
		return "", err
	}
	if _, err := w.Write(p.rfc822(m)); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	_ = c.Quit()
	return "", nil
}

// rfc822 assembles the wire form. Headers are built here rather than left to
// the caller so that a body containing a line starting "Subject:" cannot
// forge one.
func (p smtpProvider) rfc822(m OutboundMessage) []byte {
	from := p.cfg.FromAddress
	if n := strings.TrimSpace(p.cfg.FromName); n != "" {
		from = fmt.Sprintf("%s <%s>", headerSafe(n), p.cfg.FromAddress)
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", headerSafe(m.To))
	fmt.Fprintf(&b, "Subject: %s\r\n", headerSafe(m.Subject))
	fmt.Fprintf(&b, "Date: %s\r\n", nowInIndia().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	// Dot-stuffing: a body line that is a single full stop ends the DATA
	// command early, truncating the message and leaving the connection out of
	// step with what the server thinks it is reading.
	for _, line := range strings.Split(strings.ReplaceAll(m.Body, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, ".") {
			b.WriteString(".")
		}
		b.WriteString(line)
		b.WriteString("\r\n")
	}
	return b.Bytes()
}

// headerSafe strips CR and LF. A subject rendered from a template variable is
// attacker-influenced the moment a parent can name their child, and a newline
// in a header is a second header of the sender's choosing.
func headerSafe(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
}

// --- SMS and WhatsApp: one HTTP gateway, described by configuration ----------

/*
gatewaySettings describes a vendor's send endpoint without naming the vendor.

	Every Indian SMS gateway and every WhatsApp Business reseller offers the
	same shape: an HTTPS endpoint, an API key, a registered sender id, and a
	handful of form or JSON fields. Modelling that as configuration is what
	makes the claim "blocked on a vendor account, not on code" true — when the
	account arrives, somebody fills in this form and messages go out. Writing a
	MSG91Provider today would be guessing at which vendor a school will buy,
	and would be dead code for every school that buys a different one.

	Placeholders in Params are substituted at send: {to}, {text}, {sender},
	{key}, {dlt}.
*/
type gatewaySettings struct {
	Endpoint   string            `json:"endpoint"`
	Method     string            `json:"method"`
	SenderID   string            `json:"sender_id"`
	AuthHeader string            `json:"auth_header"`
	Params     map[string]string `json:"params"`
	// form | json. How Params is carried.
	Encoding string `json:"encoding"`
}

type gatewayProvider struct {
	channel string
	cfg     gatewaySettings
	apiKey  string
}

func (p gatewayProvider) Channel() string { return p.channel }
func (p gatewayProvider) Name() string {
	if h := hostOf(p.cfg.Endpoint); h != "" {
		return p.channel + ":" + h
	}
	return p.channel
}

func (p gatewayProvider) Configured() bool { return p.Why() == "" }

func (p gatewayProvider) Why() string {
	switch {
	case strings.TrimSpace(p.cfg.Endpoint) == "":
		return "no gateway endpoint set — blocked on a vendor account"
	case !strings.HasPrefix(p.cfg.Endpoint, "http://") && !strings.HasPrefix(p.cfg.Endpoint, "https://"):
		return "gateway endpoint must be an http or https URL"
	case p.apiKey == "" && strings.TrimSpace(p.cfg.AuthHeader) == "":
		return "no API key stored — blocked on a vendor account"
	}
	return ""
}

func (p gatewayProvider) Send(ctx context.Context, m OutboundMessage) (string, error) {
	if !p.Configured() {
		return "", fmt.Errorf("%s: %w: %s", p.channel, ErrProviderNotConfigured, p.Why())
	}
	sub := strings.NewReplacer(
		"{to}", m.To, "{text}", m.Body, "{sender}", p.cfg.SenderID,
		"{key}", p.apiKey, "{dlt}", m.DLTTemplateID)

	fields := map[string]string{}
	for k, v := range p.cfg.Params {
		fields[k] = sub.Replace(v)
	}

	method := strings.ToUpper(strings.TrimSpace(p.cfg.Method))
	if method == "" {
		method = http.MethodPost
	}

	var req *http.Request
	var err error
	switch {
	case method == http.MethodGet:
		q := url.Values{}
		for k, v := range fields {
			q.Set(k, v)
		}
		sep := "?"
		if strings.Contains(p.cfg.Endpoint, "?") {
			sep = "&"
		}
		req, err = http.NewRequestWithContext(ctx, method, p.cfg.Endpoint+sep+q.Encode(), nil)
	case strings.EqualFold(p.cfg.Encoding, "json"):
		body, _ := json.Marshal(fields)
		req, err = http.NewRequestWithContext(ctx, method, p.cfg.Endpoint, bytes.NewReader(body))
		if req != nil {
			req.Header.Set("Content-Type", "application/json")
		}
	default:
		q := url.Values{}
		for k, v := range fields {
			q.Set(k, v)
		}
		req, err = http.NewRequestWithContext(ctx, method, p.cfg.Endpoint, strings.NewReader(q.Encode()))
		if req != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	}
	if err != nil {
		return "", err
	}
	if h := strings.TrimSpace(p.cfg.AuthHeader); h != "" {
		req.Header.Set("Authorization", sub.Replace(h))
	}

	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close() //nolint:errcheck
	// Capped: a gateway that answers with an HTML error page must not put a
	// megabyte of markup into message_log.error.
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("gateway %s: %s", res.Status, strings.TrimSpace(string(raw)))
	}
	return strings.TrimSpace(string(raw)), nil
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// --- credentials at rest -----------------------------------------------------

/*
sealSecret encrypts a provider password for integrations.credentials.

	An SMTP password in a bytea column that anybody with a database dump can
	read is the same as no password: the mailbox it opens is the school's own,
	and the first thing sent from it will be a convincing fee demand. AES-GCM
	rather than a plain cipher so a tampered ciphertext fails to open instead
	of decrypting to rubbish that is then handed to a mail server.

	The key is SHA-256 of CREDENTIAL_KEY, because the deployed value is a
	passphrase of whatever length the operator chose and AES wants exactly 32
	bytes. Read from the environment rather than from a Server field because
	Server carries no config today and adding one is a change to api.go, which
	this feature does not own.
*/
func sealSecret(plain string) ([]byte, error) {
	key := os.Getenv("CREDENTIAL_KEY")
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("CREDENTIAL_KEY is not set — refusing to store a password in clear")
	}
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plain), nil), nil
}

// openSecret is sealSecret's inverse. A failure here is reported as an
// unconfigured provider rather than an error: the usual cause is that
// CREDENTIAL_KEY was rotated, and the honest reading of that is "these
// credentials are no longer usable, enter them again".
func openSecret(sealed []byte) (string, error) {
	if len(sealed) == 0 {
		return "", nil
	}
	key := os.Getenv("CREDENTIAL_KEY")
	if strings.TrimSpace(key) == "" {
		return "", errors.New("CREDENTIAL_KEY is not set")
	}
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", errors.New("stored credential is truncated")
	}
	out, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("stored credential will not decrypt — CREDENTIAL_KEY may have changed")
	}
	return string(out), nil
}

// --- loading providers -------------------------------------------------------

// providerRow is one integrations row, narrowed to what messaging uses.
type providerRow struct {
	Channel     string
	Config      []byte
	Credentials []byte
	Enabled     bool
	LastOKAt    *time.Time
	LastError   *string
}

/*
loadProviders reads this school's provider configuration.

	integrations already carries provider, credentials, config, enabled,
	last_ok_at and last_error with UNIQUE (institution_id, provider), which is
	a provider registry in every respect except that nothing had used it yet.
	Adding messaging_providers beside it would have been the same row twice,
	and the second copy is the one that goes stale.

	Every channel is present in the returned set, configured or not. A missing
	key would mean the caller has to distinguish "no row" from "row that is not
	usable", and those are the same answer to the only question being asked.
*/
func (s *Server) loadProviders(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (providerSet, error) {
	rows, err := tx.Query(ctx, `
		SELECT provider, config, credentials, enabled, last_ok_at, last_error
		  FROM integrations
		 WHERE institution_id = $1 AND kind = 'messaging'`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stored := map[string]providerRow{}
	for rows.Next() {
		var r providerRow
		if err := rows.Scan(&r.Channel, &r.Config, &r.Credentials, &r.Enabled,
			&r.LastOKAt, &r.LastError); err != nil {
			return nil, err
		}
		stored[r.Channel] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	set := providerSet{"in_app": inAppProvider{}}
	for _, ch := range []string{"email", "sms", "whatsapp"} {
		row, ok := stored[ch]
		if !ok {
			set[ch] = unconfiguredProvider{ch, notSetUpReason(ch)}
			continue
		}
		if !row.Enabled {
			set[ch] = unconfiguredProvider{ch, "configured but switched off"}
			continue
		}
		// The phone SMS gateway: a paired handset rather than a vendor's HTTP
		// endpoint. Checked before the credential is opened because this
		// provider has no API key to open -- its credential belongs to the
		// phone, not to the school. See internal/api/sms_gateway.go; this case
		// and the struct behind it are the whole of what a fifth channel cost,
		// exactly as the comment on MessagingProvider above says it should be.
		if ch == "sms" && isPhoneGatewayConfig(row.Config) {
			set[ch] = s.loadPhoneGateway(ctx, tx, inst)
			continue
		}
		secret, err := openSecret(row.Credentials)
		if err != nil {
			set[ch] = unconfiguredProvider{ch, err.Error()}
			continue
		}
		set[ch] = buildProvider(ch, row.Config, secret)
	}
	return set, nil
}

// notSetUpReason distinguishes "nobody has filled this in" from "nobody can
// fill this in yet". SMS and WhatsApp need a commercial account with a gateway
// and, for SMS, a DLT registration that takes weeks — an administrator who
// reads "not set up yet" goes looking for the form, and there isn't one to
// find until procurement finishes.
func notSetUpReason(channel string) string {
	if channel == "sms" || channel == "whatsapp" {
		return "not set up — awaiting a vendor account and its credentials"
	}
	return "not set up yet"
}

// buildProvider turns one stored row into a provider. Split out so the
// test-connection handler can build from an unsaved draft: an operator must be
// able to prove credentials work before committing them, or the only way to
// find out is to send a real parent a real message.
func buildProvider(channel string, cfg []byte, secret string) MessagingProvider {
	switch channel {
	case "email":
		var st smtpSettings
		if len(cfg) > 0 {
			if err := json.Unmarshal(cfg, &st); err != nil {
				return unconfiguredProvider{channel, "stored settings are not readable"}
			}
		}
		return smtpProvider{cfg: st, password: secret}
	case "whatsapp":
		// WhatsApp is two products wearing one channel name: Meta's own Cloud
		// API, whose body shape and template policy the generic gateway below
		// cannot express, and a reseller, for which it is exactly right.
		// buildWhatsAppProvider (whatsapp.go) picks by what is stored, so a
		// school already sending through a reseller is untouched.
		return buildWhatsAppProvider(channel, cfg, secret)
	case "sms":
		var st gatewaySettings
		if len(cfg) > 0 {
			if err := json.Unmarshal(cfg, &st); err != nil {
				return unconfiguredProvider{channel, "stored settings are not readable"}
			}
		}
		return gatewayProvider{channel: channel, cfg: st, apiKey: secret}
	case "in_app":
		return inAppProvider{}
	}
	return unconfiguredProvider{channel, "unknown channel"}
}

// --- templates ---------------------------------------------------------------

// builtinTemplate is the body used when a school has written none of its own.
//
// Held in code rather than seeded as rows so that a school provisioned
// tomorrow can set a reminder working today. A seed would only reach the
// tenants that existed when the migration ran, and the next school would find
// a trigger screen it cannot use until somebody authors four templates.
type builtinTemplate struct {
	Subject string
	Body    string
}

var builtinTemplates = map[string]builtinTemplate{
	"attendance.absent": {
		Subject: "{{student_name}} was marked absent",
		Body:    "Dear parent,\n\n{{student_name}} was marked absent on {{on_date}} at {{school_name}}.\n\nIf this is unexpected, please contact the school office.",
	},
	"fees.overdue": {
		Subject: "Fees overdue for {{student_name}}",
		Body:    "Dear parent,\n\nInvoice {{invoice_no}} for {{student_name}} shows {{amount_due}} outstanding since {{due_on}}.\n\n{{school_name}}",
	},
	"ptm.reminder": {
		Subject: "Parent-teacher meeting on {{on_date}}",
		Body:    "Dear parent,\n\nYour meeting about {{student_name}} is on {{on_date}} at {{starts_at}}.\n\n{{school_name}}",
	},
	/* The three things a family is told about that never left the building.

	   Homework, a remark and a published report card each wrote a notification
	   row and stopped there, so a parent learned about them on the day they
	   happened to open the app. A school that has just configured email
	   expects the opposite, and says so.

	   Email only, deliberately. An absence is worth a text because somebody
	   needs to know within the hour; homework set on a Tuesday is not, and a
	   school that texts every family every evening is a school whose parents
	   stop reading the texts. */
	"homework.set": {
		Subject: "New work for {{student_name}} - {{subject}}",
		Body:    "Dear parent,\n\n{{title}}\n\nSubject: {{subject}}\nDue: {{due_on}}\n\n{{school_name}}",
	},
	"student.remark": {
		Subject: "{{title}}",
		Body:    "Dear parent,\n\n{{summary}}\n\nWritten by {{teacher}} on {{on_date}}.\n\n{{school_name}}",
	},
	"reportcard.published": {
		Subject: "{{student_name}} - report card ready",
		Body:    "Dear parent,\n\nThe {{exam_name}} report card for {{student_name}} has been published. Sign in to see the marks, the grade and the attendance.\n\n{{school_name}}",
	},
	"announcement.published": {
		Subject: "{{title}}",
		Body:    "{{title}}\n\n{{body}}\n\n{{school_name}}",
	},
	// Carries whatever the sender typed. The only built-in whose body is a
	// single variable: a direct send has no school-authored wording to render.
	"messaging.direct": {
		Subject: "{{subject}}",
		Body:    "{{text}}",
	},
	"messaging.test": {
		Subject: "Test message from {{school_name}}",
		Body:    "This is a test message sent from the messaging settings screen. If you are reading it, the provider works.",
	},
}

var templateVar = regexp.MustCompile(`\{\{\s*([a-z0-9_]+)\s*\}\}`)

// renderTemplate substitutes {{name}} from vars.
//
// Deliberately not text/template. A template body is data a school types, and
// text/template on attacker-influenced input is a way to read the surrounding
// Go values. An unknown placeholder is left standing rather than blanked, so a
// misspelt variable shows up in the test send instead of producing a message
// with a hole in the middle of a sentence.
func renderTemplate(body string, vars map[string]any) string {
	return templateVar.ReplaceAllStringFunc(body, func(m string) string {
		name := strings.Trim(m, "{} ")
		v, ok := vars[name]
		if !ok {
			return m
		}
		return fmt.Sprint(v)
	})
}

// resolveTemplate finds the school's own template for a code and channel, and
// falls back to the built-in. Returns ok=false when neither exists, which is a
// rule naming a template nobody ever wrote — reported, never guessed at.
func (s *Server) resolveTemplate(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	code, channel string) (subject, body, dlt string, ok bool, err error) {

	var sub, bod, d *string
	err = tx.QueryRow(ctx, `
		SELECT subject, body, dlt_template_id
		  FROM message_templates
		 WHERE institution_id = $1 AND code = $2 AND channel = $3 AND is_active`,
		inst, code, channel).Scan(&sub, &bod, &d)
	switch {
	case err == nil:
		if sub != nil {
			subject = *sub
		}
		if bod != nil {
			body = *bod
		}
		if d != nil {
			dlt = *d
		}
		return subject, body, dlt, true, nil
	case errors.Is(err, pgx.ErrNoRows):
		if t, found := builtinTemplates[code]; found {
			return t.Subject, t.Body, "", true, nil
		}
		return "", "", "", false, nil
	default:
		return "", "", "", false, err
	}
}

// --- the send contract -------------------------------------------------------

/*
SendRequest is what a feature asks for when it wants a message sent.

	This is the contract the absence-alert, PTM-reminder, fee-reminder and
	campaign features build against. None of them should assemble a
	message_log row themselves: the shape of that row is what the one-per-
	occurrence index keys on, and a second writer is a second chance to get it
	wrong.

	SourceKind, SourceID and OccurrenceKey together are the idempotency key.
	Leaving SourceKind empty is legal and means "this is a one-off, send it
	even if it looks like something I sent before" — right for a person
	clicking Send, wrong for anything automated.
*/
type SendRequest struct {
	// Channel is one of email, sms, whatsapp, in_app.
	Channel string
	// TemplateCode names a message_templates row, or a built-in.
	TemplateCode string
	// Vars fills the {{placeholders}} in the template.
	Vars map[string]any

	// Who it is for. ToUserID resolves an address from the account; Recipient
	// overrides it when the address is known and the person has no account —
	// a guardian with a phone number and no portal login.
	ToUserID  *uuid.UUID
	StudentID *uuid.UUID
	Recipient string

	// The idempotency key. See the type comment.
	SourceKind    string
	SourceID      *uuid.UUID
	OccurrenceKey string

	// SendAfter holds the message until a moment — the end of a quiet period,
	// or the lead time before an event. Nil sends at the next dispatch.
	SendAfter *time.Time
}

// SendResult reports what QueueMessage did. Duplicate is not a failure: it is
// the index doing its job, and a fan-out counts it separately so the screen
// can say "40 queued, 3 already sent" rather than claiming 43 sends.
type SendResult struct {
	ID        uuid.UUID
	Duplicate bool
}

/*
QueueMessage records one outbound message and leaves it for the dispatcher.

	The single entry point every feature uses. It runs inside the caller's
	transaction on purpose: marking a register and queueing the absence alert
	have to commit together, or a rolled-back attendance correction leaves a
	parent already told their child was missing.

	It refuses rather than pretends. An unconfigured provider returns
	ErrProviderNotConfigured before any row is written, because a queued
	message nothing will ever send is a lie that sits in the log looking like
	progress.
*/
func (s *Server) QueueMessage(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	req SendRequest) (SendResult, error) {

	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return SendResult{}, err
	}
	return s.queueWith(ctx, tx, inst, set, req)
}

// queueWith is QueueMessage with the provider set already loaded, for fan-outs
// that would otherwise re-read integrations once per recipient.
func (s *Server) queueWith(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	set providerSet, req SendRequest) (SendResult, error) {

	if !knownChannel(req.Channel) {
		return SendResult{}, fmt.Errorf("unknown channel %q", req.Channel)
	}
	p, ok := set[req.Channel]
	if !ok || !p.Configured() {
		why := "not set up yet"
		if ok {
			why = p.Why()
		}
		return SendResult{}, fmt.Errorf("%s: %w: %s", req.Channel, ErrProviderNotConfigured, why)
	}

	req.Recipient = strings.TrimSpace(req.Recipient)
	if req.Recipient == "" && req.ToUserID != nil {
		addr, err := s.addressFor(ctx, tx, *req.ToUserID, req.Channel)
		if err != nil {
			return SendResult{}, err
		}
		req.Recipient = addr
	}
	if req.Recipient == "" {
		return SendResult{}, ErrNoRecipient
	}

	// The DLT template id is deliberately not read here. It belongs to the
	// template, which the school may edit between queueing and sending, and
	// the id that matters to the regulator is the one in force at the moment
	// the message goes out — so the dispatcher reads it then.
	subject, body, _, found, err := s.resolveTemplate(ctx, tx, inst, req.TemplateCode, req.Channel)
	if err != nil {
		return SendResult{}, err
	}
	if !found {
		return SendResult{}, fmt.Errorf("no template %q for %s, and no built-in", req.TemplateCode, req.Channel)
	}
	subject = renderTemplate(subject, req.Vars)
	body = renderTemplate(body, req.Vars)

	/* ON CONFLICT DO NOTHING against the one-per-occurrence index.

	   The index is named rather than inferred by column list because the
	   COALESCE expressions have to match it exactly — Postgres compares the
	   inference clause against the index expression, and a near-miss raises
	   instead of skipping, which would turn a suppressed duplicate into a
	   failed fee run. */
	/* The vars are kept as well as the rendered body.

	   A WhatsApp Cloud template send transmits the approved template's name
	   and its parameter VALUES; Meta hydrates the text itself, so the rendered
	   body is the wrong thing to carry and the values cannot be recovered from
	   it once a school rewords its own body. This is the same data that is
	   already in body, in the form the other wire needs. See whatsapp.go. */
	varsJSON, err := json.Marshal(req.Vars)
	if err != nil {
		return SendResult{}, err
	}

	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO message_log (institution_id, channel, template_code, recipient,
		                         user_id, student_id, subject, body, status, provider,
		                         source_kind, source_id, occurrence_key, send_after,
		                         template_vars)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,
		        NULLIF($10,''), $11, NULLIF($12,''), $13, $14)
		ON CONFLICT (institution_id, channel, source_kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(occurrence_key, ''))
		  WHERE source_kind IS NOT NULL
		DO NOTHING
		RETURNING id`,
		inst, req.Channel, req.TemplateCode, req.Recipient, req.ToUserID, req.StudentID,
		nullIfEmpty(subject), body, p.Name(),
		req.SourceKind, req.SourceID, req.OccurrenceKey, req.SendAfter,
		varsJSON).Scan(&id)

	if errors.Is(err, pgx.ErrNoRows) {
		// The index refused it: this exact occurrence has already been sent to
		// this person on this channel. That is the whole point.
		return SendResult{Duplicate: true}, nil
	}
	if err != nil {
		return SendResult{}, err
	}
	return SendResult{ID: id}, nil
}

/*
QueueOutbound is the queue package's way in, and the reason internal/queue does
not have to import this one.

	It is QueueMessage with the transaction opened here rather than passed in.
	The distinction matters: QueueMessage takes a tx because a feature queueing
	a message wants it to commit with the change that caused it, and a
	rolled-back attendance correction must not leave a parent already told. A
	worker task has no such surrounding change -- the thing that happened
	committed before the job was enqueued -- so it opens its own.

	Signature and types are queue.Messaging / queue.OutboundRequest, satisfied
	structurally. This file names them explicitly so that a change to the
	interface fails the build here rather than silently at the wiring in
	cmd/worker, where a *Server that no longer satisfies it would only show up
	as a compile error a long way from the cause.
*/
func (s *Server) QueueOutbound(ctx context.Context, inst uuid.UUID, req queue.OutboundRequest) error {
	return s.DB.InTenant(ctx, tenantScopeFor(inst, false), func(tx pgx.Tx) error {
		send := SendRequest{
			Channel:       req.Channel,
			TemplateCode:  req.TemplateCode,
			Vars:          req.Vars,
			SourceKind:    req.SourceKind,
			OccurrenceKey: req.OccurrenceKey,
		}
		if req.ToUserID != uuid.Nil {
			u := req.ToUserID
			send.ToUserID = &u
		}
		if req.SourceID != uuid.Nil {
			id := req.SourceID
			send.SourceID = &id
		}
		res, err := s.QueueMessage(ctx, tx, inst, send)
		if err != nil {
			return err
		}
		if res.Duplicate {
			// Not a failure. The one-per-occurrence index refused a second
			// copy, which on a task retry is exactly the outcome wanted --
			// reporting it as an error would make asynq retry it again.
			slog.Info("outbound message already queued for this occurrence",
				"institution_id", inst, "template", req.TemplateCode)
		}
		return nil
	})
}

// Compile-time proof that the inversion holds. If queue.Messaging grows a
// method, the build fails here, at the implementation, rather than at the
// wiring in cmd/worker a long way from the cause.
var _ queue.Messaging = (*Server)(nil)

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// addressFor is where a message to an account actually goes. Email needs an
// email, SMS and WhatsApp need a phone; a user with neither is not an error in
// the sender, so the caller decides whether to skip or report.
func (s *Server) addressFor(ctx context.Context, tx pgx.Tx, user uuid.UUID, channel string) (string, error) {
	var email, phone *string
	if err := tx.QueryRow(ctx,
		`SELECT email::text, phone FROM users WHERE id = $1`, user).Scan(&email, &phone); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNoRecipient
		}
		return "", err
	}
	switch channel {
	case "email":
		if email != nil {
			return *email, nil
		}
	case "sms", "whatsapp":
		if phone != nil {
			return *phone, nil
		}
	case "in_app":
		return user.String(), nil
	}
	return "", ErrNoRecipient
}

// --- the dispatcher ----------------------------------------------------------

/*
DispatchMessages hands queued messages to their provider, one transaction each.

	One at a time, with FOR UPDATE SKIP LOCKED, because the alternative is a
	network round trip inside a transaction holding a batch of rows: a mail
	server that takes eight seconds then locks twenty parents' messages for
	nearly three minutes, and a second dispatcher blocks behind it. One row per
	transaction bounds the lock to a single send, and SKIP LOCKED lets a second
	dispatcher work the same queue rather than wait for the first.

	send_after is the quiet period made real: a row held until 09:00 is simply
	not selected before then, so nothing is dropped and nobody is woken.
*/
func (s *Server) DispatchMessages(ctx context.Context, inst uuid.UUID, platform bool, limit int) (sent, failed int, err error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	scope := tenantScopeFor(inst, platform)

	for i := 0; i < limit; i++ {
		var done bool
		err = s.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
			var (
				id        uuid.UUID
				channel   string
				recipient string
				subject   *string
				body      *string
				code      *string
				attempts  int
				varsRaw   []byte
			)
			row := tx.QueryRow(ctx, `
				SELECT id, channel, recipient, subject, body, template_code, attempts,
				       template_vars
				  FROM message_log
				 WHERE institution_id = $1 AND status = 'queued'
				   AND (send_after IS NULL OR send_after <= now())
				 ORDER BY queued_at
				 FOR UPDATE SKIP LOCKED
				 LIMIT 1`, inst)
			if err := row.Scan(&id, &channel, &recipient, &subject, &body, &code, &attempts,
				&varsRaw); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					done = true
					return nil
				}
				return err
			}

			/* The recipient allowlist, checked here and nowhere else.

			   Here because this is the single road every queued message takes
			   -- the screen's Dispatch button, the scheduler's five-minute
			   sweep, and the worker task all arrive at this loop -- so a
			   caller that queues directly cannot go around it. Inside one
			   provider it would guard one channel, and "we are testing, do
			   not message real families" is not a per-channel sentence.

			   A held message is marked, not dropped. status 'suppressed'
			   carries the reason to the log screen, so the school can see
			   exactly what would have gone out; a silent discard is how
			   somebody concludes the product is broken. It is deliberately
			   not counted as failed: failing it would put it on the retry
			   schedule to be refused four more times, and it is not a
			   failure. See whatsapp.go for the guard itself. */
			guard, err := s.loadRecipientGuard(ctx, tx, inst)
			if err != nil {
				return err
			}
			if allowed, why := guard.permits(channel, recipient); !allowed {
				_, e := tx.Exec(ctx, `
					UPDATE message_log
					   SET status = 'suppressed', error = $2, send_after = NULL
					 WHERE id = $1`, id, truncate(why, 500))
				return e
			}

			set, err := s.loadProviders(ctx, tx, inst)
			if err != nil {
				return err
			}
			p, ok := set[channel]
			if !ok {
				p = unconfiguredProvider{channel, "unknown channel"}
			}

			var dlt string
			if code != nil {
				if _, _, d, _, e := s.resolveTemplate(ctx, tx, inst, *code, channel); e == nil {
					dlt = d
				}
			}

			/* The approved WhatsApp template, resolved here rather than in
			   the provider, because a provider never touches the database and
			   never knows about tenancy. A resolution failure is treated as a
			   send failure so it lands in message_log.error where somebody
			   will read it, rather than aborting the whole sweep. */
			var wa *whatsappTemplateSend
			var waErr error
			if channel == "whatsapp" && code != nil {
				vars := map[string]any{}
				if len(varsRaw) > 0 {
					_ = json.Unmarshal(varsRaw, &vars)
				}
				wa, waErr = s.whatsappSendFor(ctx, tx, inst, *code, vars)
			}

			// A per-send deadline the provider cannot exceed. Without it a
			// hung mail host holds this row's lock for as long as the HTTP
			// request lives, and the dispatch endpoint never answers.
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()

			msgID, sendErr := "", waErr
			if sendErr == nil {
				msgID, sendErr = p.Send(sendCtx, OutboundMessage{
					To: recipient, Subject: strVal(subject), Body: strVal(body),
					DLTTemplateID: dlt, WA: wa,
				})
			}
			if sendErr != nil {
				failed++
				/* A failed send is held, not buried.

				   Marking it 'failed' on the first error made every failure
				   terminal, because the dispatcher only ever selects rows that
				   are still 'queued'. The two failures that matter most here
				   are both temporary: a provider nobody has finished setting
				   up yet -- this deployment has no SMS or WhatsApp account, so
				   that is the normal case -- and a gateway that is briefly
				   unreachable. Burying either means the school configures the
				   credentials and the backlog of reminders it was configured
				   for stays dead in the table.

				   So the row goes back to 'queued' with send_after pushed out,
				   carrying the error text the whole time: visible on the log
				   screen as a message that has not gone out and why, rather
				   than silence. Only after retryAttempts does it become
				   'failed', which is the honest reading of a message nobody is
				   going to be able to send. */
				retry, delay := retrySchedule(attempts + 1)
				if !retry {
					_, e := tx.Exec(ctx, `
						UPDATE message_log
						   SET status = 'failed', error = $2, attempts = attempts + 1, provider = $3
						 WHERE id = $1`, id, truncate(sendErr.Error(), 500), p.Name())
					return e
				}
				_, e := tx.Exec(ctx, `
					UPDATE message_log
					   SET status = 'queued', error = $2, attempts = attempts + 1,
					       provider = $3, send_after = now() + $4::interval
					 WHERE id = $1`,
					id, truncate(sendErr.Error(), 500), p.Name(),
					fmt.Sprintf("%d seconds", int(delay.Seconds())))
				return e
			}
			sent++
			if _, e := tx.Exec(ctx, `
				UPDATE message_log
				   SET status = 'sent', sent_at = now(), attempts = attempts + 1,
				       provider = $3, provider_msg_id = NULLIF($2,''), error = NULL
				 WHERE id = $1`, id, truncate(msgID, 200), p.Name()); e != nil {
				return e
			}

			/* An in-app message has to land somewhere a person looks.

			   inAppProvider.Send is a no-op and stays one: it is handed an
			   OutboundMessage with no user id, so it could not write this row
			   if it wanted to. The dispatcher is the layer that knows who the
			   message is for, so the delivery happens here.

			   Without it the channel was a quiet hole. The parent feed is
			   materialised from facts by deliverFamilyAlerts -- fee due,
			   absence, and so on -- which is why the gap never showed in
			   testing: those alerts arrive, so the inbox looks alive. What
			   never arrived was anything a human *authored*: a reminder plan,
			   a circular, a counsellor's note. Those wrote a message_log row
			   marked 'sent' and were never seen by anybody.

			   Keyed on the message id so a re-dispatch cannot duplicate it,
			   and skipped when the row names no user -- an in-app message to
			   a bare address has nobody to show it to. */
			if channel == "in_app" {
				if _, e := tx.Exec(ctx, `
					INSERT INTO notifications (institution_id, user_id, student_id,
					        kind, title, body, source_kind, source_id)
					SELECT m.institution_id, m.user_id, m.student_id,
					       COALESCE(m.template_code, 'message'),
					       COALESCE(NULLIF(m.subject,''), 'Message from school'),
					       m.body, 'message', m.id
					  FROM message_log m
					 WHERE m.id = $1 AND m.user_id IS NOT NULL
					   AND NOT EXISTS (
					       SELECT 1 FROM notifications n
					        WHERE n.source_kind = 'message' AND n.source_id = m.id)`,
					id); e != nil {
					return e
				}
			}
			return nil
		})
		if err != nil || done {
			return sent, failed, err
		}
	}
	return sent, failed, nil
}

/*
retryAttempts is where a message stops being late and starts being undeliverable.

	Five, with the backoff below, spans a little over three hours. That is
	chosen against the failure it is most likely to be waiting out: a gateway
	outage or a mail host refusing connections, both of which resolve inside an
	hour or are an incident somebody is already handling. Waiting longer would
	mean a fee reminder arriving the following morning under a subject line
	about yesterday, which is worse than the log saying plainly that it never
	went.
*/
const retryAttempts = 5

/*
retrySchedule decides what happens to a message whose send just failed.

	Exponential from five minutes, capped at an hour, so a provider that is
	down does not get hit every five minutes by a growing backlog -- the cap
	matters more than the growth, because the number of held messages rises
	while the outage lasts and each one is a connection attempt.

	It returns a duration rather than reading the clock so that the decision is
	testable without one.
*/
func retrySchedule(attempt int) (retry bool, delay time.Duration) {
	if attempt >= retryAttempts {
		return false, 0
	}
	delay = 5 * time.Minute
	for i := 1; i < attempt; i++ {
		delay *= 3
	}
	if delay > time.Hour {
		delay = time.Hour
	}
	return true, delay
}

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// tenantScopeFor builds an RLS scope from an institution alone, for the
// dispatcher's own transactions, which run outside any single request's
// identity.
func tenantScopeFor(inst uuid.UUID, platform bool) database.Scope {
	return database.Scope{InstitutionID: inst, PlatformAdmin: platform}
}

// --- trigger rules -----------------------------------------------------------

/*
MessageSubject is one occurrence of an event: the thing that happened, who it
is about, when it happens, and the facts a condition may test.

	Passed to EmitMessageEvent by whichever feature noticed. Facts are what
	conditions read; Vars are what templates read. They are separate because a
	condition testing days_overdue and a template printing "₹4,500 due since 12
	August" want the same occurrence described two different ways, and merging
	them means every new template variable silently becomes a condition key.
*/
type MessageSubject struct {
	// StudentID is the child the occurrence is about, and is what audience
	// 'guardians' and 'student' resolve against.
	StudentID *uuid.UUID
	// EmployeeID is the member of staff the occurrence names — the teacher
	// whose PTM it is. What audience 'staff' resolves against.
	EmployeeID *uuid.UUID
	// OccurrenceKey identifies this occurrence for the life of the school: an
	// attendance row id, an invoice id, a date. The third leg of the dedupe.
	OccurrenceKey string
	// At is when the thing happens. lead_minutes counts back from it. Zero
	// means "now", which is right for anything already in the past.
	At time.Time
	// Facts are what a rule's condition tests. Numbers and strings only.
	Facts map[string]any
	// Vars fill the template.
	Vars map[string]any
}

// triggerRule is one message_trigger_rules row.
type triggerRule struct {
	ID           uuid.UUID
	Name         string
	Event        string
	Condition    map[string]any
	Audience     string
	Channel      string
	TemplateCode string
	LeadMinutes  int
	QuietFrom    *string
	QuietTo      *string
}

/*
EmitMessageEvent is the push half of the trigger contract.

	A feature that has just recorded something calls this from inside its own
	transaction, naming the event and the occurrence. Every active rule on that
	event is evaluated; the ones whose condition matches queue a message.

	The caller never names a channel, a template or a recipient. That is the
	entire point: "who hears about an absence, on what channel, saying what" is
	the school's configuration, not the attendance module's business, and a
	feature that hard-codes it has to be redeployed when the school changes its
	mind.

	Returns how many messages were queued. The only error it can return is a
	database fault. An occurrence matching no rule, a rule on a channel nobody
	has configured, a guardian with no phone number — none of those are errors
	here, because this runs inside the caller's transaction and returning one
	would roll back the attendance register that prompted it. A school that has
	not finished buying an SMS account must still be able to mark a register.
	Configuration failures are recorded on the rule instead, where the trigger
	screen shows them.
*/
func (s *Server) EmitMessageEvent(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	event string, subjects ...MessageSubject) (int, error) {

	rules, err := s.loadRules(ctx, tx, inst, event, nil)
	if err != nil || len(rules) == 0 {
		return 0, err
	}
	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, rule := range rules {
		out, err := s.applyRule(ctx, tx, inst, set, rule, subjects)
		if err != nil {
			return total, err
		}
		total += out.Queued
		if err := s.recordRuleRun(ctx, tx, rule.ID, out); err != nil {
			return total, err
		}
	}
	return total, nil
}

// recordRuleRun stamps what a rule just did onto the rule itself, so the
// trigger screen can answer "is this working" without the operator having to
// reconstruct it from the message log.
func (s *Server) recordRuleRun(ctx context.Context, tx pgx.Tx, rule uuid.UUID, out ruleOutcome) error {
	_, err := tx.Exec(ctx, `
		UPDATE message_trigger_rules
		   SET last_run_at = now(), last_queued = $2, last_error = NULLIF($3,'')
		 WHERE id = $1`, rule, out.Queued, out.Blocked)
	return err
}

/*
loadRules reads the active rules for an event, or one rule by id.

	plan_kind IS NULL excludes reminder plans (00103), which are driven by
	runMessagePlans in message_rules.go instead. Both halves matter and the
	exclusion is not tidiness: a plan's occurrence key carries the chase number
	(invoice#2) or the absent day (student:2026-08-19), and the generic finder
	for the same event produces neither. Letting both evaluate one rule would
	write two message_log rows the one-per-occurrence index cannot see as
	duplicates -- which is a family chased twice on the same morning, the exact
	failure the index exists to prevent.
*/
func (s *Server) loadRules(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	event string, only *uuid.UUID) ([]triggerRule, error) {

	rows, err := tx.Query(ctx, `
		SELECT id, name, event, condition, audience, channel, template_code,
		       lead_minutes, quiet_from::text, quiet_to::text
		  FROM message_trigger_rules
		 WHERE institution_id = $1 AND is_active AND plan_kind IS NULL
		   AND ($2::text IS NULL OR event = $2)
		   AND ($3::uuid IS NULL OR id = $3)
		 ORDER BY name`, inst, nullIfEmpty(event), only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []triggerRule{}
	for rows.Next() {
		var r triggerRule
		var cond []byte
		if err := rows.Scan(&r.ID, &r.Name, &r.Event, &cond, &r.Audience, &r.Channel,
			&r.TemplateCode, &r.LeadMinutes, &r.QuietFrom, &r.QuietTo); err != nil {
			return nil, err
		}
		r.Condition = map[string]any{}
		if len(cond) > 0 {
			_ = json.Unmarshal(cond, &r.Condition)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

/*
matchesCondition tests one occurrence against a rule's condition.

	A flat constraint map, not an expression language. min_<fact> passes when
	the fact is at least the value, max_<fact> when it is at most, and any
	other key is equality on the fact of that name. An unknown fact fails the
	rule rather than passing it: a condition on days_overdue against an
	occurrence that never carried that number is a rule the author believed was
	narrowing something, and silently sending to everybody is the expensive
	direction to be wrong in.
*/
func matchesCondition(cond map[string]any, facts map[string]any) bool {
	for key, want := range cond {
		switch {
		case strings.HasPrefix(key, "min_"):
			got, ok := numFact(facts, strings.TrimPrefix(key, "min_"))
			if !ok || got < toNum(want) {
				return false
			}
		case strings.HasPrefix(key, "max_"):
			got, ok := numFact(facts, strings.TrimPrefix(key, "max_"))
			if !ok || got > toNum(want) {
				return false
			}
		default:
			got, ok := facts[key]
			if !ok || fmt.Sprint(got) != fmt.Sprint(want) {
				return false
			}
		}
	}
	return true
}

func numFact(facts map[string]any, name string) (float64, bool) {
	v, ok := facts[name]
	if !ok {
		return 0, false
	}
	return toNum(v), true
}

func toNum(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}

// recipient is one resolved person: their account where they have one, and the
// address to use where they do not.
type recipient struct {
	UserID  *uuid.UUID
	Address string
	Name    string
}

// ruleOutcome is what one rule did on one pass.
//
// Blocked is separate from Err because they need opposite handling. A rule
// naming a channel nobody has set up is a configuration gap: it is reported,
// the other rules carry on, and the caller's own transaction is untouched. Err
// is a database fault, which genuinely must abort.
type ruleOutcome struct {
	Queued     int
	Duplicates int
	Blocked    string
}

/*
applyRule turns matching occurrences into queued messages.

	Queued and Duplicates are counted apart, because "nothing was sent" and
	"nothing needed sending" look identical on a screen that reports only one
	of them — and the first is a fault while the second is the system working.

	Nothing about a school's configuration is allowed to surface as an error
	here. This runs inside the caller's transaction: an attendance register
	being marked, a payment being recorded. If an unconfigured SMS gateway came
	back as an error, the feature that called EmitMessageEvent would roll back
	the register — a school would lose a morning's attendance because nobody
	had finished buying an SMS account. The messaging layer must never be able
	to fail the business transaction that triggered it.
*/
func (s *Server) applyRule(ctx context.Context, tx pgx.Tx, inst uuid.UUID, set providerSet,
	rule triggerRule, subjects []MessageSubject) (ruleOutcome, error) {

	var out ruleOutcome

	// Checked once, before any occurrence. A provider that is not set up will
	// refuse identically for all two thousand of them, and reporting it two
	// thousand times is not more informative than reporting it once.
	if p, ok := set[rule.Channel]; !ok {
		out.Blocked = "unknown channel " + rule.Channel
		return out, nil
	} else if !p.Configured() {
		out.Blocked = "cannot send: " + p.Why()
		return out, nil
	}

	for _, sub := range subjects {
		if !matchesCondition(rule.Condition, sub.Facts) {
			continue
		}
		people, err := s.audienceFor(ctx, tx, inst, rule, sub)
		if err != nil {
			return out, err
		}
		when := sendAtFor(rule, sub)

		for _, person := range people {
			vars := map[string]any{}
			for k, v := range sub.Vars {
				vars[k] = v
			}
			vars["recipient_name"] = person.Name
			vars["rule_name"] = rule.Name

			ruleID := rule.ID
			res, err := s.queueWith(ctx, tx, inst, set, SendRequest{
				Channel:       rule.Channel,
				TemplateCode:  rule.TemplateCode,
				Vars:          vars,
				ToUserID:      person.UserID,
				StudentID:     sub.StudentID,
				Recipient:     person.Address,
				SourceKind:    "trigger_rule",
				SourceID:      &ruleID,
				OccurrenceKey: sub.OccurrenceKey,
				SendAfter:     when,
			})
			switch {
			case errors.Is(err, ErrNoRecipient):
				// A guardian with no email on file is not a reason to abandon
				// the other twenty-nine parents in the class.
				continue
			case errors.Is(err, ErrProviderNotConfigured):
				// Raced with somebody clearing the credentials mid-sweep.
				out.Blocked = truncate(err.Error(), 300)
				return out, nil
			case err != nil:
				return out, err
			case res.Duplicate:
				out.Duplicates++
			default:
				out.Queued++
			}
		}
	}
	return out, nil
}

/*
sendAtFor works out when the message may go, from the lead time and the quiet
hours.

	Two separate ideas that both move a send in time. Lead time is the school's
	intent — a day before the meeting. Quiet hours are the floor under it: TRAI
	puts commercial SMS outside 21:00-09:00, and a parent woken at 02:00 makes
	a complaint the regulator is not needed for. A send inside the window is
	held to the end of it, never dropped, because dropping means the school
	quietly stopped chasing that invoice.
*/
func sendAtFor(rule triggerRule, sub MessageSubject) *time.Time {
	now := nowInIndia()
	at := now
	if !sub.At.IsZero() && rule.LeadMinutes > 0 {
		at = sub.At.In(now.Location()).Add(-time.Duration(rule.LeadMinutes) * time.Minute)
	}
	if at.Before(now) {
		at = now
	}
	if rule.QuietFrom != nil && rule.QuietTo != nil {
		at = afterQuiet(at, *rule.QuietFrom, *rule.QuietTo)
	}
	if at.Sub(now) < time.Minute {
		return nil
	}
	return &at
}

// afterQuiet moves a moment out of the quiet window. A window that wraps
// midnight (21:00 to 09:00) is the normal case in India, not the exception,
// so it is handled first rather than as a correction.
func afterQuiet(at time.Time, from, to string) time.Time {
	f, okF := parseClock(from)
	t, okT := parseClock(to)
	if !okF || !okT || f == t {
		return at
	}
	mins := at.Hour()*60 + at.Minute()
	inWindow := false
	if f < t {
		inWindow = mins >= f && mins < t
	} else {
		// Wraps midnight: 21:00-09:00 is late evening or early morning.
		inWindow = mins >= f || mins < t
	}
	if !inWindow {
		return at
	}
	out := time.Date(at.Year(), at.Month(), at.Day(), t/60, t%60, 0, 0, at.Location())
	if !out.After(at) {
		out = out.AddDate(0, 0, 1)
	}
	return out
}

func parseClock(s string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) < 2 {
		return 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

/*
audienceFor resolves a rule's audience against one occurrence.

	Addresses come from the guardian and employee records rather than only from
	user accounts, because most Indian schools hold a mother's mobile number
	long before she has ever signed in to a portal — and a reminder that only
	reaches families with logins reaches almost nobody in year one.
*/
func (s *Server) audienceFor(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	rule triggerRule, sub MessageSubject) ([]recipient, error) {

	wantEmail := rule.Channel == "email"
	out := []recipient{}

	switch {
	case rule.Audience == "guardians":
		if sub.StudentID == nil {
			return out, nil
		}
		rows, err := tx.Query(ctx, `
			SELECT g.user_id, g.email::text, g.phone, g.full_name
			  FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1 AND sg.institution_id = $2
			 ORDER BY sg.is_primary DESC, g.full_name`, *sub.StudentID, inst)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var uid *uuid.UUID
			var email, phone *string
			var name string
			if err := rows.Scan(&uid, &email, &phone, &name); err != nil {
				return nil, err
			}
			out = append(out, recipient{UserID: uid, Address: pick(wantEmail, email, phone), Name: name})
		}
		return out, rows.Err()

	case rule.Audience == "student":
		if sub.StudentID == nil {
			return out, nil
		}
		var uid *uuid.UUID
		var name string
		if err := tx.QueryRow(ctx, `
			SELECT user_id, concat_ws(' ', first_name, last_name)
			  FROM students WHERE id = $1`, *sub.StudentID).Scan(&uid, &name); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return out, nil
			}
			return nil, err
		}
		return append(out, recipient{UserID: uid, Name: name}), nil

	case rule.Audience == "staff":
		if sub.EmployeeID == nil {
			return out, nil
		}
		var uid *uuid.UUID
		var email, phone *string
		var name string
		if err := tx.QueryRow(ctx, `
			SELECT user_id, email::text, phone, concat_ws(' ', first_name, last_name)
			  FROM employees WHERE id = $1`, *sub.EmployeeID).Scan(&uid, &email, &phone, &name); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return out, nil
			}
			return nil, err
		}
		return append(out, recipient{UserID: uid, Address: pick(wantEmail, email, phone), Name: name}), nil

	case strings.HasPrefix(rule.Audience, "role:"):
		role := strings.TrimPrefix(rule.Audience, "role:")
		rows, err := tx.Query(ctx, `
			SELECT u.id, u.full_name
			  FROM users u
			  JOIN user_roles ur ON ur.user_id = u.id
			  JOIN roles r ON r.id = ur.role_id
			 WHERE u.institution_id = $1 AND u.status = 'active' AND r.key = $2`, inst, role)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var uid uuid.UUID
			var name string
			if err := rows.Scan(&uid, &name); err != nil {
				return nil, err
			}
			id := uid
			out = append(out, recipient{UserID: &id, Name: name})
		}
		return out, rows.Err()
	}
	return out, nil
}

func pick(wantFirst bool, first, second *string) string {
	if wantFirst {
		if first != nil {
			return *first
		}
		return ""
	}
	if second != nil {
		return *second
	}
	return ""
}

// --- the sweep ---------------------------------------------------------------

// eventFinder gathers the occurrences of one event that are live right now.
type eventFinder struct {
	Description string
	Facts       string
	Find        func(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]MessageSubject, error)
}

/*
knownEvents is the pull half of the trigger contract.

	Not every reminder has a moment to hook. "Tell them 24 hours before the
	meeting" is not something the booking code can emit, because at booking
	time the answer is "not yet" — somebody has to come back and look. These
	finders are that somebody: a sweep asks each one what is live, and the
	rules decide what to do about it.

	A feature may emit its own event through EmitMessageEvent without appearing
	here at all. This map is the set the sweep can find unaided; it is not a
	list of permitted events.
*/
func (s *Server) knownEvents() map[string]eventFinder {
	return map[string]eventFinder{
		"student.absent": {
			Description: "A child was marked absent, within the last fortnight.",
			Facts:       "days_ago",
			Find:        s.findAbsences,
		},
		"invoice.overdue": {
			Description: "An invoice is past its due date and not settled.",
			Facts:       "days_overdue, amount_due_paise",
			Find:        s.findOverdueInvoices,
		},
		"ptm.upcoming": {
			Description: "A booked parent-teacher meeting is coming up.",
			Facts:       "days_ahead",
			Find:        s.findUpcomingMeetings,
		},
		"announcement.published": {
			Description: "A circular was published to parents in the last week.",
			Facts:       "days_ago",
			Find:        s.findAnnouncements,
		},
	}
}

func (s *Server) findAbsences(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]MessageSubject, error) {
	rows, err := tx.Query(ctx, `
		SELECT sa.id, sa.student_id, sa.on_date,
		       (CURRENT_DATE - sa.on_date) AS days_ago,
		       concat_ws(' ', st.first_name, st.last_name)
		  FROM student_attendance sa
		  JOIN students st ON st.id = sa.student_id
		 WHERE sa.institution_id = $1 AND sa.status = 'absent'
		   AND sa.on_date > CURRENT_DATE - 14
		 ORDER BY sa.on_date DESC
		 LIMIT 2000`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MessageSubject{}
	for rows.Next() {
		var id, student uuid.UUID
		var on time.Time
		var daysAgo int
		var name string
		if err := rows.Scan(&id, &student, &on, &daysAgo, &name); err != nil {
			return nil, err
		}
		sid := student
		out = append(out, MessageSubject{
			StudentID:     &sid,
			OccurrenceKey: id.String(),
			At:            on,
			Facts:         map[string]any{"days_ago": daysAgo},
			Vars: map[string]any{
				"student_name": name,
				"on_date":      on.Format("02 Jan 2006"),
			},
		})
	}
	return out, rows.Err()
}

func (s *Server) findOverdueInvoices(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]MessageSubject, error) {
	rows, err := tx.Query(ctx, `
		SELECT inv.id, inv.student_id, inv.invoice_no, inv.due_on,
		       (CURRENT_DATE - inv.due_on) AS days_overdue,
		       (inv.net_paise - inv.paid_paise) AS due_paise,
		       concat_ws(' ', st.first_name, st.last_name)
		  FROM invoices inv
		  JOIN students st ON st.id = inv.student_id
		 WHERE inv.institution_id = $1
		   AND inv.status <> 'cancelled'
		   AND inv.due_on IS NOT NULL AND inv.due_on < CURRENT_DATE
		   AND inv.net_paise > inv.paid_paise
		 ORDER BY inv.due_on
		 LIMIT 2000`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MessageSubject{}
	for rows.Next() {
		var id uuid.UUID
		var student *uuid.UUID
		var no string
		var due time.Time
		var days int
		var paise int64
		var name string
		if err := rows.Scan(&id, &student, &no, &due, &days, &paise, &name); err != nil {
			return nil, err
		}
		out = append(out, MessageSubject{
			StudentID:     student,
			OccurrenceKey: id.String(),
			At:            nowInIndia(),
			Facts:         map[string]any{"days_overdue": days, "amount_due_paise": paise},
			Vars: map[string]any{
				"student_name": name,
				"invoice_no":   no,
				"due_on":       due.Format("02 Jan 2006"),
				// Paise to rupees at the edge, never in the ledger.
				"amount_due": fmt.Sprintf("₹%.2f", float64(paise)/100),
			},
		})
	}
	return out, rows.Err()
}

func (s *Server) findUpcomingMeetings(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]MessageSubject, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id, a.student_id, a.with_employee_id, a.on_date,
		       to_char(a.starts_at, 'HH24:MI'),
		       (a.on_date - CURRENT_DATE) AS days_ahead,
		       COALESCE(concat_ws(' ', st.first_name, st.last_name), a.visitor_name)
		  FROM appointments a
		  LEFT JOIN students st ON st.id = a.student_id
		 WHERE a.institution_id = $1 AND a.status = 'booked'
		   AND a.on_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
		 ORDER BY a.on_date, a.starts_at
		 LIMIT 2000`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MessageSubject{}
	for rows.Next() {
		var id uuid.UUID
		var student, employee *uuid.UUID
		var on time.Time
		var starts string
		var ahead int
		var name string
		if err := rows.Scan(&id, &student, &employee, &on, &starts, &ahead, &name); err != nil {
			return nil, err
		}
		// Read as text and reassembled here: pgx maps a bare `time` column to
		// its own microsecond type, not to time.Time, and scanning it into one
		// fails at runtime rather than at compile time.
		mins, _ := parseClock(starts)
		at := time.Date(on.Year(), on.Month(), on.Day(), mins/60, mins%60, 0, 0, nowInIndia().Location())
		out = append(out, MessageSubject{
			StudentID:     student,
			EmployeeID:    employee,
			OccurrenceKey: id.String(),
			At:            at,
			Facts:         map[string]any{"days_ahead": ahead},
			Vars: map[string]any{
				"student_name": name,
				"on_date":      on.Format("02 Jan 2006"),
				"starts_at":    starts,
			},
		})
	}
	return out, rows.Err()
}

func (s *Server) findAnnouncements(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]MessageSubject, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id, a.title, left(a.body, 500), a.publish_at,
		       EXTRACT(day FROM now() - a.publish_at)::int AS days_ago
		  FROM announcements a
		 WHERE a.institution_id = $1
		   AND a.audience_role IN ('all','parents')
		   AND a.publish_at <= now() AND a.publish_at > now() - interval '7 days'
		 ORDER BY a.publish_at DESC
		 LIMIT 200`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MessageSubject{}
	for rows.Next() {
		var id uuid.UUID
		var title, body string
		var at time.Time
		var days int
		if err := rows.Scan(&id, &title, &body, &at, &days); err != nil {
			return nil, err
		}
		out = append(out, MessageSubject{
			OccurrenceKey: id.String(),
			At:            at,
			Facts:         map[string]any{"days_ago": days},
			Vars:          map[string]any{"title": title, "body": body},
		})
	}
	return out, rows.Err()
}

// sweepResult is one rule's share of a sweep.
type sweepResult struct {
	RuleID     string `json:"rule_id"`
	Rule       string `json:"rule"`
	Event      string `json:"event"`
	Matched    int    `json:"occurrences"`
	Queued     int    `json:"queued"`
	Duplicates int    `json:"already_sent"`
	Error      string `json:"error,omitempty"`
}

/*
runTriggerRules evaluates every active rule against what is live now.

	Each rule is recorded with what it did, including its failure. A rule
	whose channel has no provider does not abort the sweep: the school with
	SMS pending a vendor account still wants its email reminders to go out
	today, and a single loud row on the screen is how the blocked one gets
	fixed.
*/
func (s *Server) runTriggerRules(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	only *uuid.UUID) ([]sweepResult, error) {

	rules, err := s.loadRules(ctx, tx, inst, "", only)
	if err != nil {
		return nil, err
	}
	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return nil, err
	}
	finders := s.knownEvents()

	out := []sweepResult{}
	for _, rule := range rules {
		res := sweepResult{RuleID: rule.ID.String(), Rule: rule.Name, Event: rule.Event}

		finder, ok := finders[rule.Event]
		if !ok {
			// Not a fault. The rule is waiting for whichever feature emits
			// this event to call EmitMessageEvent; saying so is what stops an
			// administrator concluding the rule is broken.
			res.Error = "no sweep for this event — it fires only when a feature reports it"
			out = append(out, res)
			continue
		}
		subjects, err := finder.Find(ctx, tx, inst)
		if err != nil {
			res.Error = truncate(err.Error(), 300)
			out = append(out, res)
			continue
		}
		res.Matched = len(subjects)

		outcome, err := s.applyRule(ctx, tx, inst, set, rule, subjects)
		if err != nil {
			return out, err
		}
		res.Queued, res.Duplicates, res.Error = outcome.Queued, outcome.Duplicates, outcome.Blocked
		if e := s.recordRuleRun(ctx, tx, rule.ID, outcome); e != nil {
			return out, e
		}
		out = append(out, res)
	}
	return out, nil
}

// --- HTTP --------------------------------------------------------------------

/*
mountMessaging registers the messaging foundation.

	Called from inside the existing /admin group in api.go, which carries no
	group-level permission and therefore lets every route below name its own.
	Paths are relative, so everything here lands under /api/v1/admin/messaging.

	Every permission used is already in internal/rbac/rbac.go; none was
	invented. The split is deliberate:

	  institution.integrations.write   entering a mail server's password
	  institution.settings.write       deciding who gets messaged and when
	  comms.messages.send              actually causing messages to leave
	  institution.read                 seeing how any of it is configured

	The last two are not the same key on purpose. An administrator may set up a
	fee reminder without holding the right to fire a campaign at every parent
	in the school this afternoon.
*/
func (s *Server) mountMessaging(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	creds := httpx.RequirePermission(rbac.IntegrationsWrite)
	config := httpx.RequirePermission(rbac.SettingsWrite)
	send := httpx.RequirePermission(rbac.MessagesSend)
	// The log names recipients, so it is read by whoever runs communications
	// or whoever audits them — never by anybody who merely holds a login.
	logRead := httpx.RequireAnyPermission(rbac.MessagesSend, rbac.AuditRead)

	// Email Server (SMTP) Integration, and the provider registry behind it.
	r.With(read).Get("/messaging/providers", s.listMessagingProviders)
	r.With(creds).Put("/messaging/providers/{channel}", s.saveMessagingProvider)
	r.With(creds).Delete("/messaging/providers/{channel}", s.forgetMessagingProvider)
	r.With(creds).Post("/messaging/providers/{channel}/test", s.testMessagingProvider)
	s.mountDirectSend(r)

	// Templates. Shared by both screens and by every feature that sends.
	r.With(read).Get("/messaging/templates", s.listMessageTemplates)
	r.With(config).Put("/messaging/templates", s.saveMessageTemplate)

	// Automated Trigger Rules.
	r.With(read).Get("/messaging/triggers", s.listTriggerRules)
	r.With(config).Post("/messaging/triggers", s.saveTriggerRule)
	r.With(config).Delete("/messaging/triggers/{id}", s.deleteTriggerRule)
	r.With(send).Post("/messaging/triggers/run", s.runTriggerSweep)

	// The dispatch log, and the two verbs that move messages.
	r.With(logRead).Get("/messaging/log", s.listMessageLog)
	r.With(send).Post("/messaging/send", s.sendOneMessage)
	r.With(send).Post("/messaging/dispatch", s.dispatchMessages)
}

// providerView is one channel as the screen sees it. The password is never
// part of it: a screen that can read back what it stored is a screen that
// leaks the mail password to anybody who can open it.
type providerView struct {
	Channel     string          `json:"channel"`
	Label       string          `json:"label"`
	Provider    string          `json:"provider"`
	Configured  bool            `json:"configured"`
	Reason      string          `json:"reason,omitempty"`
	Enabled     bool            `json:"enabled"`
	HasSecret   bool            `json:"has_secret"`
	Settings    json.RawMessage `json:"settings"`
	LastOKAt    *string         `json:"last_ok_at,omitempty"`
	LastError   *string         `json:"last_error,omitempty"`
	Queued      int             `json:"queued"`
	SentToday   int             `json:"sent_today"`
	FailedToday int             `json:"failed_today"`
}

var channelLabels = map[string]string{
	"email":    "Email (SMTP)",
	"sms":      "SMS gateway",
	"whatsapp": "WhatsApp Business",
	"in_app":   "In-app notifications",
}

// listMessagingProviders answers what can and cannot send today.
//
// A bare GET with nothing configured is the normal first visit, so it returns
// all four channels with configured:false and a reason, never a 400 and never
// an empty list. That list is the Email Server screen's whole left-hand side.
func (s *Server) listMessagingProviders(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []providerView{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := s.loadProviders(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		stored := map[string]providerView{}
		rows, err := tx.Query(r.Context(), `
			SELECT provider, config, enabled, octet_length(COALESCE(credentials,''::bytea)) > 0,
			       to_char(last_ok_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), last_error
			  FROM integrations
			 WHERE institution_id = $1 AND kind = 'messaging'`, id.InstitutionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v providerView
			var cfg []byte
			if err := rows.Scan(&v.Channel, &cfg, &v.Enabled, &v.HasSecret,
				&v.LastOKAt, &v.LastError); err != nil {
				rows.Close()
				return err
			}
			v.Settings = json.RawMessage(cfg)
			stored[v.Channel] = v
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		counts, err := s.channelCounts(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}

		for _, ch := range messagingChannels {
			v := stored[ch]
			v.Channel = ch
			v.Label = channelLabels[ch]
			if len(v.Settings) == 0 {
				v.Settings = json.RawMessage(`{}`)
			}
			if p, ok := set[ch]; ok {
				v.Provider = p.Name()
				v.Configured = p.Configured()
				v.Reason = p.Why()
			}
			c := counts[ch]
			v.Queued, v.SentToday, v.FailedToday = c[0], c[1], c[2]
			items = append(items, v)
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// channelCounts is queued / sent today / failed today, per channel. Three
// numbers on one pass rather than three round trips per channel.
func (s *Server) channelCounts(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (map[string][3]int, error) {
	rows, err := tx.Query(ctx, `
		SELECT channel,
		       count(*) FILTER (WHERE status = 'queued'),
		       count(*) FILTER (WHERE status IN ('sent','delivered') AND sent_at > now() - interval '24 hours'),
		       count(*) FILTER (WHERE status = 'failed'  AND queued_at > now() - interval '24 hours')
		  FROM message_log
		 WHERE institution_id = $1
		 GROUP BY channel`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string][3]int{}
	for rows.Next() {
		var ch string
		var q, s1, f int
		if err := rows.Scan(&ch, &q, &s1, &f); err != nil {
			return nil, err
		}
		out[ch] = [3]int{q, s1, f}
	}
	return out, rows.Err()
}

type providerSaveRequest struct {
	Enabled  bool            `json:"enabled"`
	Settings json.RawMessage `json:"settings"`
	// Secret is the SMTP password or gateway API key. Absent means "leave what
	// is stored alone", which is what a screen that never reads it back has to
	// be able to say when the operator edits the host and nothing else.
	Secret *string `json:"secret,omitempty"`
}

// saveMessagingProvider stores one channel's configuration.
func (s *Server) saveMessagingProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	channel := chi.URLParam(r, "channel")
	if channel == "in_app" {
		httpx.BadRequest(w, r, "in-app delivery needs no credentials")
		return
	}
	if channel != "email" && channel != "sms" && channel != "whatsapp" {
		httpx.BadRequest(w, r, "channel must be email, sms or whatsapp")
		return
	}
	var req providerSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Settings) == 0 {
		req.Settings = json.RawMessage(`{}`)
	}
	if !json.Valid(req.Settings) {
		httpx.BadRequest(w, r, "settings must be a JSON object")
		return
	}

	var sealed []byte
	if req.Secret != nil && *req.Secret != "" {
		b, err := sealSecret(*req.Secret)
		if err != nil {
			// A refusal, not a 500: the operator can act on "the server has no
			// credential key", and storing the password in clear instead would
			// be the worse of the two ways to fail.
			httpx.Denied(w, r, err.Error())
			return
		}
		sealed = b
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// COALESCE on credentials is what makes an omitted secret mean "keep
		// the stored one" rather than "erase it": editing the port must not
		// silently clear the password and take email down at the next fee run.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
			VALUES ($1,$2,'messaging',$3,$4,$5)
			ON CONFLICT (institution_id, provider) DO UPDATE
			   SET config      = EXCLUDED.config,
			       credentials = COALESCE(EXCLUDED.credentials, integrations.credentials),
			       enabled     = EXCLUDED.enabled,
			       kind        = 'messaging'`,
			id.InstitutionID, channel, []byte(req.Settings), sealed, req.Enabled)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.listMessagingProviders(w, r)
}

// forgetMessagingProvider drops a channel's stored credentials and settings.
func (s *Server) forgetMessagingProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	channel := chi.URLParam(r, "channel")
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			DELETE FROM integrations
			 WHERE institution_id = $1 AND provider = $2 AND kind = 'messaging'`,
			id.InstitutionID, channel)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.listMessagingProviders(w, r)
}

type providerTestRequest struct {
	To string `json:"to"`
}

/*
testMessagingProvider proves the stored credentials work, against a real send.

	An operator who cannot test has only one way to find out whether the mail
	password is right, and it is a parent not receiving a fee reminder. The
	outcome is written to integrations.last_ok_at / last_error so the screen
	still shows it tomorrow, and the test message goes through the same
	provider and the same template path as a real one — a test that took a
	different route would prove nothing about the route that matters.
*/
func (s *Server) testMessagingProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	channel := chi.URLParam(r, "channel")
	var req providerTestRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.To) == "" {
		httpx.BadRequest(w, r, "an address to test against is required")
		return
	}

	var (
		p        MessagingProvider
		school   string
		notReady bool
	)
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := s.loadProviders(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		var ok bool
		if p, ok = set[channel]; !ok {
			notReady = true
			return nil
		}
		return tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, id.InstitutionID).Scan(&school)
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if notReady || p == nil {
		httpx.BadRequest(w, r, "unknown channel")
		return
	}
	if !p.Configured() {
		// 409, not 500: nothing is broken. The provider has not been set up,
		// and the operator is the one who can fix that.
		httpx.Error(w, r, http.StatusConflict, "provider_not_configured", p.Why())
		return
	}

	t := builtinTemplates["messaging.test"]
	vars := map[string]any{"school_name": school}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	_, sendErr := p.Send(ctx, OutboundMessage{
		To:      strings.TrimSpace(req.To),
		Subject: renderTemplate(t.Subject, vars),
		Body:    renderTemplate(t.Body, vars),
	})

	_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if sendErr != nil {
			_, err := tx.Exec(r.Context(), `
				UPDATE integrations SET last_error = $3
				 WHERE institution_id = $1 AND provider = $2`,
				id.InstitutionID, channel, truncate(sendErr.Error(), 500))
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE integrations SET last_ok_at = now(), last_error = NULL
			 WHERE institution_id = $1 AND provider = $2`, id.InstitutionID, channel)
		return err
	})

	if sendErr != nil {
		httpx.Error(w, r, http.StatusBadGateway, "provider_rejected", truncate(sendErr.Error(), 300))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok": true, "channel": channel, "to": req.To,
		"message": "the provider accepted the message",
	})
}

// --- templates over HTTP -----------------------------------------------------

type templateView struct {
	Code     string `json:"code"`
	Channel  string `json:"channel"`
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	DLT      string `json:"dlt_template_id"`
	Active   bool   `json:"is_active"`
	BuiltIn  bool   `json:"built_in"`
	Editable bool   `json:"editable"`
}

// listMessageTemplates returns the school's templates and the built-ins it has
// not overridden, so a trigger rule can name one on a school's first day.
func (s *Server) listMessageTemplates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []templateView{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT code, channel, COALESCE(subject,''), body,
			       COALESCE(dlt_template_id,''), is_active
			  FROM message_templates
			 WHERE institution_id = $1
			 ORDER BY code, channel`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()

		seen := map[string]bool{}
		for rows.Next() {
			var v templateView
			if err := rows.Scan(&v.Code, &v.Channel, &v.Subject, &v.Body, &v.DLT, &v.Active); err != nil {
				return err
			}
			v.Editable = true
			seen[v.Code+"|"+v.Channel] = true
			items = append(items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		codes := make([]string, 0, len(builtinTemplates))
		for code := range builtinTemplates {
			codes = append(codes, code)
		}
		sort.Strings(codes)
		for _, code := range codes {
			t := builtinTemplates[code]
			for _, ch := range []string{"email", "sms", "whatsapp", "in_app"} {
				if seen[code+"|"+ch] {
					continue
				}
				items = append(items, templateView{
					Code: code, Channel: ch, Subject: t.Subject, Body: t.Body,
					Active: true, BuiltIn: true, Editable: true,
				})
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type templateSaveRequest struct {
	Code    string `json:"code"`
	Channel string `json:"channel"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
	DLT     string `json:"dlt_template_id"`
	Active  bool   `json:"is_active"`
}

func (s *Server) saveMessageTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req templateSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Code) == "" || strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "a template needs a code and a body")
		return
	}
	if !knownChannel(req.Channel) {
		httpx.BadRequest(w, r, "channel must be email, sms, whatsapp or in_app")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO message_templates (institution_id, code, channel, subject, body,
			                               dlt_template_id, is_active)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''),$7)
			ON CONFLICT (institution_id, code, channel) DO UPDATE
			   SET subject = EXCLUDED.subject, body = EXCLUDED.body,
			       dlt_template_id = EXCLUDED.dlt_template_id,
			       is_active = EXCLUDED.is_active`,
			id.InstitutionID, strings.TrimSpace(req.Code), req.Channel,
			req.Subject, req.Body, req.DLT, req.Active)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- trigger rules over HTTP -------------------------------------------------

type triggerRuleView struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Event        string         `json:"event"`
	Condition    map[string]any `json:"condition"`
	Audience     string         `json:"audience"`
	Channel      string         `json:"channel"`
	TemplateCode string         `json:"template_code"`
	LeadMinutes  int            `json:"lead_minutes"`
	QuietFrom    string         `json:"quiet_from"`
	QuietTo      string         `json:"quiet_to"`
	Active       bool           `json:"is_active"`
	LastRunAt    *string        `json:"last_run_at,omitempty"`
	LastQueued   int            `json:"last_queued"`
	LastError    *string        `json:"last_error,omitempty"`
	// ChannelReady is why this rule cannot fire, when it cannot. A rule on a
	// channel with no provider looks live in the list and never sends, which
	// is the failure this field exists to make visible.
	ChannelReady  bool   `json:"channel_ready"`
	ChannelReason string `json:"channel_reason,omitempty"`
}

type eventView struct {
	Event       string `json:"event"`
	Description string `json:"description"`
	Facts       string `json:"facts"`
	Swept       bool   `json:"swept"`
}

/*
listTriggerRules is the Automated Trigger Rules screen in one call: the rules,
the events they may name, and whether each rule's channel can send.

	Reminder plans are excluded (plan_kind IS NOT NULL). Not to hide them, but
	because this screen's save handler writes the columns it knows about and
	leaves the plan columns alone -- so a fee chase edited here would keep its
	repeat and its cap while its event, condition and audience were rewritten
	underneath them. The plan screens in message_rules.go own those rows and
	edit them whole.
*/
func (s *Server) listTriggerRules(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []triggerRuleView{}
	events := []eventView{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := s.loadProviders(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT id, name, event, condition, audience, channel, template_code,
			       lead_minutes, COALESCE(quiet_from::text,''), COALESCE(quiet_to::text,''),
			       is_active,
			       to_char(last_run_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), last_queued, last_error
			  FROM message_trigger_rules
			 WHERE institution_id = $1 AND plan_kind IS NULL
			 ORDER BY event, name`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var v triggerRuleView
			var cond []byte
			if err := rows.Scan(&v.ID, &v.Name, &v.Event, &cond, &v.Audience, &v.Channel,
				&v.TemplateCode, &v.LeadMinutes, &v.QuietFrom, &v.QuietTo, &v.Active,
				&v.LastRunAt, &v.LastQueued, &v.LastError); err != nil {
				return err
			}
			v.Condition = map[string]any{}
			if len(cond) > 0 {
				_ = json.Unmarshal(cond, &v.Condition)
			}
			if p, ok := set[v.Channel]; ok {
				v.ChannelReady, v.ChannelReason = p.Configured(), p.Why()
			} else {
				v.ChannelReason = "unknown channel"
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	finders := s.knownEvents()
	names := make([]string, 0, len(finders))
	for name := range finders {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f := finders[name]
		events = append(events, eventView{name, f.Description, f.Facts, true})
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":     items,
		"events":    events,
		"audiences": []string{"guardians", "student", "staff"},
		"channels":  messagingChannels,
	})
}

type triggerRuleSaveRequest struct {
	ID           string         `json:"id,omitempty"`
	Name         string         `json:"name"`
	Event        string         `json:"event"`
	Condition    map[string]any `json:"condition"`
	Audience     string         `json:"audience"`
	Channel      string         `json:"channel"`
	TemplateCode string         `json:"template_code"`
	LeadMinutes  int            `json:"lead_minutes"`
	QuietFrom    string         `json:"quiet_from"`
	QuietTo      string         `json:"quiet_to"`
	Active       bool           `json:"is_active"`
}

var eventShape = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`)
var audienceShape = regexp.MustCompile(`^(guardians|student|staff|role:[a-z_]+)$`)

func (s *Server) saveTriggerRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req triggerRuleSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Event = strings.TrimSpace(req.Event)
	req.TemplateCode = strings.TrimSpace(req.TemplateCode)

	switch {
	case req.Name == "":
		httpx.BadRequest(w, r, "a rule needs a name — it is how the school finds it again")
		return
	case !eventShape.MatchString(req.Event):
		httpx.BadRequest(w, r, "event must look like student.absent")
		return
	case !audienceShape.MatchString(req.Audience):
		httpx.BadRequest(w, r, "audience must be guardians, student, staff or role:<key>")
		return
	case !knownChannel(req.Channel):
		httpx.BadRequest(w, r, "channel must be email, sms, whatsapp or in_app")
		return
	case req.TemplateCode == "":
		httpx.BadRequest(w, r, "a rule needs a template code")
		return
	case req.LeadMinutes < 0 || req.LeadMinutes > 20160:
		httpx.BadRequest(w, r, "lead time must be between zero and a fortnight")
		return
	case (req.QuietFrom == "") != (req.QuietTo == ""):
		httpx.BadRequest(w, r, "quiet hours need both a start and an end")
		return
	}
	if req.Condition == nil {
		req.Condition = map[string]any{}
	}
	cond, err := json.Marshal(req.Condition)
	if err != nil {
		httpx.BadRequest(w, r, "condition must be a flat JSON object")
		return
	}

	var ruleID uuid.UUID
	if req.ID != "" {
		parsed, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed rule id")
			return
		}
		ruleID = parsed
	}

	var clash bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if ruleID != uuid.Nil {
			tag, err := tx.Exec(r.Context(), `
				UPDATE message_trigger_rules
				   SET name = $3, event = $4, condition = $5, audience = $6, channel = $7,
				       template_code = $8, lead_minutes = $9,
				       quiet_from = NULLIF($10,'')::time, quiet_to = NULLIF($11,'')::time,
				       is_active = $12, updated_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				ruleID, id.InstitutionID, req.Name, req.Event, cond, req.Audience,
				req.Channel, req.TemplateCode, req.LeadMinutes, req.QuietFrom, req.QuietTo,
				req.Active)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO message_trigger_rules (institution_id, name, event, condition,
			                                   audience, channel, template_code,
			                                   lead_minutes, quiet_from, quiet_to, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,'')::time,NULLIF($10,'')::time,$11)
			RETURNING id`,
			id.InstitutionID, req.Name, req.Event, cond, req.Audience, req.Channel,
			req.TemplateCode, req.LeadMinutes, req.QuietFrom, req.QuietTo, req.Active).Scan(&ruleID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil && strings.Contains(err.Error(), "message_trigger_rules_one_per_name"):
		clash = true
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	if clash {
		httpx.BadRequest(w, r, "a rule with that name already exists")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": ruleID.String()})
}

func (s *Server) deleteTriggerRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ruleID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed rule id")
		return
	}
	var gone bool
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM message_trigger_rules WHERE id = $1 AND institution_id = $2`,
			ruleID, id.InstitutionID)
		gone = err == nil && tag.RowsAffected() == 0
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if gone {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

type sweepRequest struct {
	RuleID string `json:"rule_id,omitempty"`
	/* One event rather than every rule.

	   This is the push half of the contract reached over HTTP: the same route
	   a feature takes in-process when it calls EmitMessageEvent, rather than a
	   parallel one built for the screen. An operator debugging why the fee
	   chase is silent wants exactly this — run only the rules that listen for
	   invoice.overdue — and giving them a different code path from the real
	   one would mean the thing they tested is not the thing that runs. */
	Event string `json:"event,omitempty"`
	// Dispatch flushes the queue in the same call. The screen wants one button
	// that produces a visible outcome; two would mean an operator who ran the
	// sweep and never pressed the second one concluded nothing works.
	Dispatch bool `json:"dispatch"`
}

// runTriggerSweep evaluates rules now and reports, rule by rule, what happened.
func (s *Server) runTriggerSweep(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	req := sweepRequest{Dispatch: true}
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	var only *uuid.UUID
	if req.RuleID != "" {
		parsed, err := uuid.Parse(req.RuleID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed rule id")
			return
		}
		only = &parsed
	}

	if req.Event != "" {
		s.emitOneEvent(w, r, req)
		return
	}

	var results []sweepResult
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		out, err := s.runTriggerRules(r.Context(), tx, id.InstitutionID, only)
		results = out
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if results == nil {
		results = []sweepResult{}
	}

	body := map[string]any{"results": results}
	if req.Dispatch {
		// After the queue is committed, never inside the same transaction: a
		// send that succeeded against a transaction that then rolled back is a
		// message the school cannot see it sent.
		sent, failed, err := s.DispatchMessages(r.Context(), id.InstitutionID, id.PlatformAdmin, 50)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		body["sent"], body["failed"] = sent, failed
	}
	httpx.JSON(w, http.StatusOK, body)
}

/*
emitOneEvent runs the rules for a single event through EmitMessageEvent.

	Deliberately the exported function other features call rather than a copy
	of its body: this endpoint is how the push contract is exercised from
	outside the process, and if it took its own route then proving it works
	here would prove nothing about the absence-alert feature that calls the
	real one.
*/
func (s *Server) emitOneEvent(w http.ResponseWriter, r *http.Request, req sweepRequest) {
	id := httpx.IdentityFrom(r.Context())
	finder, ok := s.knownEvents()[req.Event]
	if !ok {
		// Not a 404: the event name may be perfectly valid and simply have no
		// sweep, because the feature that reports it does so from its own
		// code. Saying which events can be found unaided is the useful answer.
		httpx.BadRequest(w, r,
			"no sweep can find that event on its own — it fires when the feature that owns it reports it")
		return
	}

	var occurrences, queued int
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		subjects, err := finder.Find(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		occurrences = len(subjects)
		queued, err = s.EmitMessageEvent(r.Context(), tx, id.InstitutionID, req.Event, subjects...)
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}

	body := map[string]any{"event": req.Event, "occurrences": occurrences, "queued": queued}
	if req.Dispatch {
		sent, failed, err := s.DispatchMessages(r.Context(), id.InstitutionID, id.PlatformAdmin, 50)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		body["sent"], body["failed"] = sent, failed
	}
	httpx.JSON(w, http.StatusOK, body)
}

// --- send and dispatch over HTTP ---------------------------------------------

type sendRequestBody struct {
	Channel       string         `json:"channel"`
	TemplateCode  string         `json:"template_code"`
	To            string         `json:"to,omitempty"`
	ToUserID      string         `json:"to_user_id,omitempty"`
	StudentID     string         `json:"student_id,omitempty"`
	Vars          map[string]any `json:"vars,omitempty"`
	SourceKind    string         `json:"source_kind,omitempty"`
	SourceID      string         `json:"source_id,omitempty"`
	OccurrenceKey string         `json:"occurrence_key,omitempty"`
	Dispatch      bool           `json:"dispatch"`
}

/*
sendOneMessage is the send contract over HTTP, for a caller outside this
process.

	Inside the process, a feature calls QueueMessage directly and keeps its own
	transaction. This endpoint exists for the screen's "send a test to a real
	parent" and for anything driven from outside Go.

	409 rather than 500 when the provider is not set up: nothing is broken, the
	school has not finished configuring, and the two want different reactions
	from whoever is reading.
*/
func (s *Server) sendOneMessage(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req sendRequestBody
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !knownChannel(req.Channel) {
		httpx.BadRequest(w, r, "channel must be email, sms, whatsapp or in_app")
		return
	}
	if strings.TrimSpace(req.TemplateCode) == "" {
		httpx.BadRequest(w, r, "a template code is required")
		return
	}

	out := SendRequest{
		Channel: req.Channel, TemplateCode: strings.TrimSpace(req.TemplateCode),
		Vars: req.Vars, Recipient: strings.TrimSpace(req.To),
		SourceKind: req.SourceKind, OccurrenceKey: req.OccurrenceKey,
	}
	if req.ToUserID != "" {
		uid, err := uuid.Parse(req.ToUserID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed to_user_id")
			return
		}
		out.ToUserID = &uid
	}
	if req.StudentID != "" {
		sid, err := uuid.Parse(req.StudentID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed student_id")
			return
		}
		out.StudentID = &sid
	}
	if req.SourceID != "" {
		src, err := uuid.Parse(req.SourceID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed source_id")
			return
		}
		out.SourceID = &src
	}
	if out.Recipient == "" && out.ToUserID == nil {
		httpx.BadRequest(w, r, "name a recipient: either to or to_user_id")
		return
	}

	var res SendResult
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		res, err = s.QueueMessage(r.Context(), tx, id.InstitutionID, out)
		return err
	})
	switch {
	case errors.Is(err, ErrProviderNotConfigured):
		httpx.Error(w, r, http.StatusConflict, "provider_not_configured", err.Error())
		return
	case errors.Is(err, ErrNoRecipient):
		httpx.BadRequest(w, r, "that recipient has no address on file for this channel")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	body := map[string]any{"queued": !res.Duplicate, "duplicate": res.Duplicate}
	if res.ID != uuid.Nil {
		body["id"] = res.ID.String()
	}
	if req.Dispatch && !res.Duplicate {
		sent, failed, err := s.DispatchMessages(r.Context(), id.InstitutionID, id.PlatformAdmin, 10)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		body["sent"], body["failed"] = sent, failed
	}
	httpx.JSON(w, http.StatusAccepted, body)
}

type dispatchRequest struct {
	Limit int `json:"limit,omitempty"`
}

// dispatchMessages flushes the queue. A bare POST with no body is the normal
// call, so an absent body is a default rather than a 400.
func (s *Server) dispatchMessages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req dispatchRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	sent, failed, err := s.DispatchMessages(r.Context(), id.InstitutionID, id.PlatformAdmin, req.Limit)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sent": sent, "failed": failed})
}

// --- the log -----------------------------------------------------------------

type messageLogRow struct {
	ID         string  `json:"id"`
	Channel    string  `json:"channel"`
	Recipient  string  `json:"recipient"`
	Subject    *string `json:"subject,omitempty"`
	Status     string  `json:"status"`
	Provider   *string `json:"provider,omitempty"`
	Template   *string `json:"template_code,omitempty"`
	SourceKind *string `json:"source_kind,omitempty"`
	Rule       *string `json:"rule,omitempty"`
	Occurrence *string `json:"occurrence_key,omitempty"`
	Error      *string `json:"error,omitempty"`
	Attempts   int     `json:"attempts"`
	QueuedAt   string  `json:"queued_at"`
	SentAt     *string `json:"sent_at,omitempty"`
	SendAfter  *string `json:"send_after,omitempty"`
}

// listMessageLog is the dispatch log both screens show. Filters are optional;
// a bare GET returns the most recent two hundred, which is what an operator
// opening the screen wants to see.
func (s *Server) listMessageLog(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	channel := q.Get("channel")
	status := q.Get("status")
	limit := 200
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 500 {
		limit = n
	}

	items := []messageLogRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT m.id, m.channel, m.recipient, m.subject, m.status, m.provider,
			       m.template_code, m.source_kind, tr.name, m.occurrence_key, m.error,
			       m.attempts,
			       to_char(m.queued_at,  'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       to_char(m.sent_at,    'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       to_char(m.send_after, 'YYYY-MM-DD"T"HH24:MI:SSOF')
			  FROM message_log m
			  LEFT JOIN message_trigger_rules tr
			         ON tr.id = m.source_id AND m.source_kind = 'trigger_rule'
			 WHERE m.institution_id = $1
			   AND ($2::text IS NULL OR m.channel = $2)
			   AND ($3::text IS NULL OR m.status  = $3)
			 ORDER BY m.queued_at DESC
			 LIMIT $4`, id.InstitutionID, nullIfEmpty(channel), nullIfEmpty(status), limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v messageLogRow
			if err := rows.Scan(&v.ID, &v.Channel, &v.Recipient, &v.Subject, &v.Status,
				&v.Provider, &v.Template, &v.SourceKind, &v.Rule, &v.Occurrence, &v.Error,
				&v.Attempts, &v.QueuedAt, &v.SentAt, &v.SendAfter); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// EmailProviderReady reports whether this installation can actually send an
// email right now.
//
// Used by the pages that exist for people who cannot sign in: where the answer
// is yes they are told to check their inbox, and where it is no they are shown
// the link and told plainly that nothing was delivered. Guessing either way is
// how somebody sits waiting for a message no configured provider could send.
func (s *Server) EmailProviderReady(r *http.Request, inst uuid.UUID) bool {
	id := httpx.IdentityFrom(r.Context())
	var ready bool
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* The school that owns the account, and only that one.

		   This used to accept any institution on the installation with SMTP
		   configured, on the reasoning that nobody has signed in yet so there
		   is no tenant to ask about. By the time this is called there is one:
		   the reset handler has already found the user. The old answer was
		   wrong in the way that strands somebody — a school with no provider
		   queues a message nothing will ever send, while the page, satisfied
		   that the installation could send, hides the link. The person is
		   told a link is on its way and no link exists anywhere they can
		   reach it. */
		var cfg []byte
		var secret string
		err := tx.QueryRow(r.Context(), `
			SELECT config, COALESCE(credentials,'')
			  FROM integrations
			 WHERE institution_id = $1
			   AND kind = 'messaging' AND provider = 'email' AND enabled
			 LIMIT 1`, inst).Scan(&cfg, &secret)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		ready = buildProvider("email", cfg, secret).Configured()
		return nil
	})
	_ = id
	if err != nil {
		return false
	}
	return ready
}
