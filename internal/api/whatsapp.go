package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* WhatsApp Business Cloud API, and the guard that stops it reaching a real family.

   Two things live in this file. They arrived together because neither is safe
   without the other, but they are separate features and are separated below.

   ---------------------------------------------------------------- WhatsApp

   messaging.go models SMS and WhatsApp as one generic templated HTTP gateway,
   which is right for a reseller and wrong for Meta. The Cloud API has a fixed
   JSON body, a fixed success shape, structured errors -- and one hard policy
   constraint that decides the whole design:

     Outside a 24-hour customer-service window, WhatsApp accepts ONLY
     pre-approved template messages. Free-form text is permitted only within
     24 hours of that user's last INBOUND message.

   Every message this product sends -- absence alerts, fee reminders, PTM
   reminders, circulars -- is outside that window, because parents do not
   message the school first. A provider that POSTs {"type":"text"} passes every
   test that can be written here and is rejected the first time it faces a real
   parent, with error 131047 and no clue on the screen.

   So this provider is built the other way round. A template send is the
   default and the supported path. Free text exists behind a setting that is
   off, is labelled unsafe, and refuses by default -- because this product has
   no inbound webhook, so it cannot demonstrate that any window is open, and
   offering a path whose precondition cannot be checked is offering a path that
   silently fails.

   An approved template is a NAME plus POSITIONAL parameters. This product's
   templates are {{placeholder}} bodies. The mapping between the two is stored
   on message_templates (00101) rather than inferred at send time, because the
   order of placeholders in a body a school may reword is not the order Meta
   approved.

   gatewayProvider is deliberately left alone. A school already sending
   WhatsApp through a reseller keeps working: buildWhatsAppProvider only takes
   over when the stored settings name a phone_number_id, which is the Cloud
   API's own identifier and nothing else's.

   ------------------------------------------------------------- the allowlist

   A guard on the dispatcher, not on one provider. The school's sentence is
   "we are testing, do not message real families", and a guard that covered
   WhatsApp while SMS went out would not be a guard at all. So it sits in
   DispatchMessages, which is the single road every queued message takes --
   including the scheduler's five-minute sweep -- and it covers every channel
   that leaves the building.

   It fails closed. An institution that has never configured it is in
   'allowlist' mode with an empty list, which sends to nobody. That is the
   right way round: a message held during setup costs an operator a puzzled
   minute, and an accidental broadcast to every family costs the school its
   parents' trust and cannot be recalled.

   A held message is visibly held. It goes to status 'suppressed' carrying the
   reason, so the screen shows what would have gone out. Dropping it silently
   is how a school concludes the product is broken and stops using it. */

// --- 1. the Cloud API provider -----------------------------------------------

// waDefaultAPIVersion is the Graph API version this provider was written
// against. Pinned rather than "latest" because Meta changes the request shape
// between versions and a silent upgrade is a silent outage; the school may
// override it on the screen when they have read the changelog.
const waDefaultAPIVersion = "v21.0"

/*
whatsappCloudSettings is one school's WhatsApp Business account.

	The phone number id and the WABA id are identifiers rather than secrets --
	they appear in Meta's own dashboards -- but they are still per-school
	configuration, so they are stored on the integrations row like everything
	else and are hardcoded nowhere. The access token is not here: it is a
	credential, and it lives sealed in integrations.credentials with the SMTP
	password, via sealSecret.
*/
type whatsappCloudSettings struct {
	// PhoneNumberID is the {phone_number_id} in the send URL. Its presence is
	// what marks this row as a Cloud API row rather than a reseller gateway.
	PhoneNumberID string `json:"phone_number_id"`
	// WABAID is the WhatsApp Business Account the number belongs to. Not used
	// to send; kept because it is what an administrator needs when Meta's
	// support asks which account a rejection came from.
	WABAID string `json:"waba_id"`
	// BusinessNumber is the number parents see, in E.164. Display only.
	BusinessNumber string `json:"business_number"`
	// APIVersion overrides waDefaultAPIVersion.
	APIVersion string `json:"api_version"`
	// DefaultLanguage is the approved-template language used when a template
	// row names none: en, en_US, te.
	DefaultLanguage string `json:"default_language"`

	/* AllowFreeText permits a {"type":"text"} send.

	   Off, and it should stay off. Meta accepts free text only inside a
	   24-hour customer-service window opened by the recipient's own inbound
	   message, and this product has no inbound webhook, so it has no way to
	   know whether any window is open. Turning this on does not open one -- it
	   only changes a refusal this side of the wire into a rejection on the
	   other side, which costs the school quality rating rather than nothing. */
	AllowFreeText bool `json:"allow_free_text"`
}

// whatsappTemplateSend is one approved template, already resolved and already
// rendered: a name, a language and the positional parameter VALUES in order.
// Post-render, exactly like the rest of OutboundMessage -- the provider still
// knows about wires and never about templates or tenancy.
type whatsappTemplateSend struct {
	Name     string   `json:"name"`
	Language string   `json:"language"`
	Params   []string `json:"params"`
}

type whatsappCloudProvider struct {
	cfg   whatsappCloudSettings
	token string
	// client is injectable so the request shape can be tested without Meta.
	client *http.Client
}

func (p whatsappCloudProvider) Channel() string { return "whatsapp" }

func (p whatsappCloudProvider) Name() string { return "whatsapp:cloud" }

func (p whatsappCloudProvider) Configured() bool { return p.Why() == "" }

func (p whatsappCloudProvider) Why() string {
	switch {
	case strings.TrimSpace(p.cfg.PhoneNumberID) == "":
		return "no WhatsApp phone number id set — copy it from Meta's WhatsApp Manager"
	case !waAllDigits(strings.TrimSpace(p.cfg.PhoneNumberID)):
		return "the WhatsApp phone number id must be the numeric id, not the phone number"
	case strings.TrimSpace(p.token) == "":
		return "no access token stored — paste a long-lived System User token"
	}
	return ""
}

// waEndpoint is the send URL for this school's number.
func (p whatsappCloudProvider) waEndpoint() string {
	v := strings.TrimSpace(p.cfg.APIVersion)
	if v == "" {
		v = waDefaultAPIVersion
	}
	return "https://graph.facebook.com/" + v + "/" +
		strings.TrimSpace(p.cfg.PhoneNumberID) + "/messages"
}

/*
Send posts one message to the Cloud API.

	Template first, and text only under protest. The ordering is the policy
	made structural: there is exactly one branch that produces a text body, it
	is reachable only when the school has switched AllowFreeText on, and it
	carries a comment saying why that is a bad idea. Everything else in the
	product reaches the template branch.
*/
func (p whatsappCloudProvider) Send(ctx context.Context, m OutboundMessage) (string, error) {
	if !p.Configured() {
		return "", fmt.Errorf("whatsapp: %w: %s", ErrProviderNotConfigured, p.Why())
	}

	to := waNormalisePhone(m.To)
	if to == "" {
		return "", fmt.Errorf("whatsapp: %w: %q is not a phone number", ErrNoRecipient, waRedact(m.To))
	}

	payload, err := p.body(to, m)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.waEndpoint(), bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.token)

	client := p.client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("whatsapp: could not reach graph.facebook.com: %w", err)
	}
	defer res.Body.Close() //nolint:errcheck

	// Capped: a proxy that answers with an HTML error page must not put a
	// megabyte of markup into message_log.error.
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 8192))

	if res.StatusCode >= 300 {
		return "", explainMetaError(res.StatusCode, answer)
	}

	var ok struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(answer, &ok); err != nil || len(ok.Messages) == 0 {
		// A 200 with nothing recognisable in it. Not treated as a success:
		// message_log would then carry 'sent' for something that may never
		// have been accepted, and the provider message id is what a delivery
		// receipt is later matched against.
		return "", errors.New("whatsapp: the API answered 200 with no message id — the send cannot be confirmed")
	}

	// The recipient is never logged in full. Last four, as banking.go does.
	slog.Info("whatsapp message accepted",
		"to_last4", lastFour(to), "wamid", ok.Messages[0].ID,
		"template", waTemplateNameOf(m))
	return ok.Messages[0].ID, nil
}

// body builds the Cloud API request. Split out from Send so a test can assert
// the exact JSON shape without a network.
func (p whatsappCloudProvider) body(to string, m OutboundMessage) (map[string]any, error) {
	if m.WA != nil && strings.TrimSpace(m.WA.Name) != "" {
		lang := strings.TrimSpace(m.WA.Language)
		if lang == "" {
			lang = strings.TrimSpace(p.cfg.DefaultLanguage)
		}
		if lang == "" {
			lang = "en"
		}
		tmpl := map[string]any{
			"name":     strings.TrimSpace(m.WA.Name),
			"language": map[string]any{"code": lang},
		}
		// components is omitted entirely for a template with no parameters.
		// Sending an empty body component is rejected with 132000, which
		// reads as "parameter count mismatch" and sends the administrator
		// looking in the wrong place.
		if len(m.WA.Params) > 0 {
			params := make([]map[string]any, 0, len(m.WA.Params))
			for _, v := range m.WA.Params {
				params = append(params, map[string]any{"type": "text", "text": v})
			}
			tmpl["components"] = []map[string]any{
				{"type": "body", "parameters": params},
			}
		}
		return map[string]any{
			"messaging_product": "whatsapp",
			"to":                to,
			"type":              "template",
			"template":          tmpl,
		}, nil
	}

	if !p.cfg.AllowFreeText {
		/* The refusal that keeps this product honest.

		   A free-text send outside the 24-hour window is not a message that
		   arrives late or imperfectly -- it is rejected, and repeated
		   rejections lower the number's quality rating until Meta throttles
		   it. Refusing here, by name, puts the fix in front of the person who
		   can apply it: map this template to an approved WhatsApp template. */
		return nil, fmt.Errorf(
			"whatsapp: %w: no approved template is mapped for this message, "+
				"and WhatsApp accepts free text only inside a 24-hour window opened by the "+
				"parent's own reply — which this product cannot observe, having no inbound "+
				"webhook. Map this template to an approved WhatsApp template name",
			ErrProviderNotConfigured)
	}

	// Reachable only when a human switched AllowFreeText on. It will be
	// rejected with 131047 for any parent who has not messaged the school in
	// the last 24 hours, which is very nearly all of them.
	return map[string]any{
		"messaging_product": "whatsapp",
		"to":                to,
		"type":              "text",
		"text":              map[string]any{"body": m.Body, "preview_url": false},
	}, nil
}

func waTemplateNameOf(m OutboundMessage) string {
	if m.WA == nil {
		return ""
	}
	return m.WA.Name
}

/*
buildWhatsAppProvider decides which WhatsApp this school has.

	Called from buildProvider. A stored row that names a phone_number_id is a
	Cloud API row and gets the provider above; anything else falls through to
	the generic gatewayProvider that 00044 shipped, so a school already sending
	through a reseller is untouched by this file existing. The alternative --
	making Cloud the only WhatsApp -- would break a working configuration on
	deploy, which is not a migration anybody signed off.
*/
func buildWhatsAppProvider(channel string, cfg []byte, secret string) MessagingProvider {
	var cloud whatsappCloudSettings
	if len(cfg) > 0 {
		if err := json.Unmarshal(cfg, &cloud); err != nil {
			return unconfiguredProvider{channel, "stored settings are not readable"}
		}
	}
	if strings.TrimSpace(cloud.PhoneNumberID) != "" {
		return whatsappCloudProvider{cfg: cloud, token: secret}
	}
	var st gatewaySettings
	if len(cfg) > 0 {
		if err := json.Unmarshal(cfg, &st); err != nil {
			return unconfiguredProvider{channel, "stored settings are not readable"}
		}
	}
	return gatewayProvider{channel: channel, cfg: st, apiKey: secret}
}

// --- 2. Meta's errors, turned into something an administrator can act on -----

// metaErrorBody is the envelope every Graph API failure arrives in.
type metaErrorBody struct {
	Error struct {
		Message   string `json:"message"`
		Type      string `json:"type"`
		Code      int    `json:"code"`
		Subcode   int    `json:"error_subcode"`
		ErrorData struct {
			Details string `json:"details"`
		} `json:"error_data"`
		FBTraceID string `json:"fbtrace_id"`
	} `json:"error"`
}

/*
metaAdvice is what to do about each error code, in a sentence.

	A rejected template, an unregistered number, a spent quota and an invalid
	token are four different problems with four different fixes and four
	different people who can apply them. "send failed" tells a school none of
	that, and the failure it hides longest is the token, because it looks
	exactly like an outage for the fortnight nobody checks.

	Codes are Meta's own. Anything unlisted falls through to the API's message
	text, which is at least the vendor's own words rather than ours.
*/
var metaAdvice = map[int]string{
	0:      "the request was malformed — this is a fault in the product, not in the account",
	4:      "the app's request quota for this hour is spent — sends will resume automatically; reduce the dispatch rate if it recurs",
	10:     "this app does not hold the whatsapp_business_messaging permission — grant it to the System User in Business Settings",
	33:     "the phone number id is not one this token can see — check the id and that the token belongs to the same business",
	100:    "a parameter was rejected — usually the phone number id or the recipient number",
	190:    "the access token is not valid or has been revoked — generate a new long-lived System User token and paste it in",
	200:    "the token lacks permission on this WhatsApp Business Account — grant the System User access to the WABA",
	368:    "the account is temporarily blocked for a policy violation — Meta's Business Support decides when it lifts",
	80007:  "the rate limit for this account has been hit — the queue will drain more slowly",
	130429: "the number's throughput limit has been hit — messages are being sent faster than the tier allows",
	131005: "access denied to this resource",
	131008: "a required parameter is missing from the request",
	131009: "a parameter value is not accepted — check the template parameter values for newlines or tabs, which WhatsApp rejects",
	131016: "the service is temporarily unavailable at Meta's end",
	131021: "the recipient number is the same as the sender number",
	131026: "the message cannot be delivered — the recipient may not have WhatsApp, or the number may be wrong",
	131031: "this WhatsApp Business Account has been locked or restricted",
	131042: "the business account has no valid payment method — add one in Business Settings or nothing will send",
	131047: "outside the 24-hour window, so free text was refused — send an approved template instead",
	131048: "the number's spam rate is too high and sending is restricted — Meta lifts this as the rating recovers",
	131049: "Meta withheld this message to protect user engagement — a marketing-category send throttled by policy",
	131051: "this message type is not supported",
	131052: "a media file could not be downloaded",
	131056: "too many messages to this same recipient in a short time",
	132000: "the number of parameters sent does not match the approved template — check the stored parameter mapping",
	132001: "no such approved template in that language — check the template name and the language code in WhatsApp Manager",
	132005: "the hydrated template text is too long — shorten the parameter values",
	132007: "the template text violates the format policy — usually a newline, tab or four consecutive spaces in a parameter",
	132012: "a template parameter format does not match what was approved",
	132015: "the template is paused for poor quality and cannot be sent until it recovers",
	132016: "the template has been disabled for quality reasons and must be re-created",
	132068: "the flow this template uses is blocked",
	133004: "the WhatsApp Business Account server is temporarily unavailable",
	133005: "the two-step verification PIN is wrong",
	133006: "the phone number needs to be verified before it can send",
	133008: "too many wrong two-step PIN attempts — wait before retrying",
	133009: "the two-step PIN was entered too quickly after the last attempt",
	133010: "this phone number is not registered on the WhatsApp Business platform — register it in WhatsApp Manager",
	133015: "the number is being deregistered or moved and cannot send",
}

/*
explainMetaError turns a Graph API rejection into one readable error.

	The vendor's own message is kept as well as the advice: the advice is what
	an administrator acts on, and the raw message is what Meta's support asks
	for. The fbtrace_id is carried for the same reason -- it is the only handle
	their support will accept, and a message_log row without it means asking
	the school to reproduce the failure.
*/
func explainMetaError(status int, raw []byte) error {
	var body metaErrorBody
	if err := json.Unmarshal(raw, &body); err != nil || body.Error.Message == "" {
		// Not JSON, or not Meta's JSON. A proxy or a captive portal, most
		// likely. Reported as what it is rather than guessed at.
		return fmt.Errorf("whatsapp: HTTP %d from the Cloud API, and the answer was not an error object: %s",
			status, truncate(string(raw), 200))
	}
	e := body.Error

	advice := metaAdvice[e.Code]
	if advice == "" {
		advice = "unrecognised error code — see Meta's cloud API error reference"
	}

	parts := []string{fmt.Sprintf("whatsapp: %s (code %d", advice, e.Code)}
	if e.Subcode != 0 {
		parts = append(parts, fmt.Sprintf("/%d", e.Subcode))
	}
	parts = append(parts, "): ", e.Message)
	if d := strings.TrimSpace(e.ErrorData.Details); d != "" && d != e.Message {
		parts = append(parts, " — ", d)
	}
	if e.FBTraceID != "" {
		parts = append(parts, " [trace ", e.FBTraceID, "]")
	}
	return errors.New(truncate(strings.Join(parts, ""), 480))
}

// waRetryable reports whether a Meta rejection is worth trying again.
//
// Not wired into retrySchedule, which is messaging.go's and is left alone --
// exposed so the screen can say which failures will clear themselves. A
// revoked token retried five times is five more rejections; a rate limit
// retried five times is a message that eventually arrives.
func waRetryable(code int) bool {
	switch code {
	case 4, 80007, 130429, 131016, 131048, 133004:
		return true
	}
	return false
}

// --- 3. resolving the approved template for a queued message -----------------

// waTemplateMapping is what 00101 stores on message_templates.
type waTemplateMapping struct {
	Name     string
	Language string
	Params   []string
}

/*
whatsappSendFor resolves the approved template for one queued message.

	Called from DispatchMessages, which already holds the transaction and the
	tenancy. It reads the mapping the school stored, then takes the parameter
	VALUES from the vars the message was rendered with -- which is why 00101
	keeps template_vars on the row. Reconstructing them from the rendered body
	would mean parsing a sentence a school is free to reword.

	A missing var becomes an empty string rather than an error, and an empty
	string is then refused below: Meta rejects an empty parameter with 131009,
	and finding that out from the log is worse than finding it out here.

	Returns nil when there is no mapping. The provider then refuses, by name,
	which is the honest outcome for a WhatsApp message with no approved
	template behind it.
*/
func (s *Server) whatsappSendFor(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	code string, vars map[string]any) (*whatsappTemplateSend, error) {

	if strings.TrimSpace(code) == "" {
		return nil, nil
	}
	m, ok, err := loadWATemplateMapping(ctx, tx, inst, code)
	if err != nil || !ok || strings.TrimSpace(m.Name) == "" {
		return nil, err
	}

	out := &whatsappTemplateSend{Name: m.Name, Language: m.Language}
	for _, name := range m.Params {
		v, present := vars[name]
		if !present {
			return nil, fmt.Errorf(
				"whatsapp template %q expects a value for %q and this message carries none — "+
					"the stored parameter mapping and the template body disagree", m.Name, name)
		}
		text := waCleanParam(fmt.Sprint(v))
		if text == "" {
			return nil, fmt.Errorf(
				"whatsapp template %q would be sent with %q empty, which WhatsApp rejects", m.Name, name)
		}
		out.Params = append(out.Params, text)
	}
	return out, nil
}

func loadWATemplateMapping(ctx context.Context, tx pgx.Tx, inst uuid.UUID, code string) (waTemplateMapping, bool, error) {
	var (
		name, lang *string
		params     []byte
	)
	err := tx.QueryRow(ctx, `
		SELECT wa_template_name, wa_language, wa_params
		  FROM message_templates
		 WHERE institution_id = $1 AND code = $2 AND channel = 'whatsapp' AND is_active`,
		inst, code).Scan(&name, &lang, &params)
	if errors.Is(err, pgx.ErrNoRows) {
		return waTemplateMapping{}, false, nil
	}
	if err != nil {
		return waTemplateMapping{}, false, err
	}
	m := waTemplateMapping{Name: deref(name), Language: deref(lang)}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &m.Params); err != nil {
			return waTemplateMapping{}, false, fmt.Errorf("template %q: stored parameter mapping is not a list", code)
		}
	}
	return m, true, nil
}

/*
waCleanParam makes a value safe to put in a template parameter.

	WhatsApp rejects a parameter containing a newline, a tab or four
	consecutive spaces with 132007, which reads as "format policy violation"
	and sends an administrator looking at the approved template rather than at
	the fee amount that happened to arrive with a line break in it.
*/
var waWhitespace = regexp.MustCompile(`[\s\p{Zs}]+`)

func waCleanParam(s string) string {
	return strings.TrimSpace(waWhitespace.ReplaceAllString(s, " "))
}

// --- 4. the recipient allowlist ----------------------------------------------

// waIndiaCC is the country code assumed for a bare ten-digit number. India is
// not a guess here: this product is an Indian school ERP, every phone column
// in it holds an Indian number, and refusing to normalise rather than
// assuming would leave the guard unable to match the numbers it is given.
const waIndiaCC = "91"

/*
recipientGuard is one school's answer to "may this message go out".

	Loaded per dispatched row, alongside the provider set, so that a school
	that turns the guard on mid-sweep is obeyed by the next message rather
	than the next restart. The cost is one small indexed read per send, which
	is nothing beside the HTTP call that follows it.
*/
type recipientGuard struct {
	// Mode is 'allowlist' or 'everyone'. A school with no row is 'allowlist'.
	Mode string
	// allowed is the normalised set: E.164 digits for phones, lowercased
	// addresses for email.
	allowed map[string]bool
}

func (s *Server) loadRecipientGuard(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (recipientGuard, error) {
	g := recipientGuard{Mode: "allowlist", allowed: map[string]bool{}}

	var mode string
	err := tx.QueryRow(ctx,
		`SELECT mode FROM messaging_recipient_policy WHERE institution_id = $1`, inst).Scan(&mode)
	switch {
	case err == nil:
		g.Mode = mode
	case errors.Is(err, pgx.ErrNoRows):
		// No row is not "unconfigured, therefore allow". It is the default,
		// and the default is the safe one.
	default:
		return recipientGuard{}, err
	}

	if g.Mode == "everyone" {
		return g, nil
	}

	rows, err := tx.Query(ctx,
		`SELECT kind, normalised FROM messaging_allowed_recipients WHERE institution_id = $1`, inst)
	if err != nil {
		return recipientGuard{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, v string
		if err := rows.Scan(&kind, &v); err != nil {
			return recipientGuard{}, err
		}
		// Keyed by kind as well as value, matching normaliseRecipient. Without
		// the prefix a stored address and a stored number would share one
		// namespace, and the guard would look up a key nothing ever wrote.
		g.allowed[kind+":"+v] = true
	}
	return g, rows.Err()
}

/*
permits decides whether one message may leave, and says why not.

	in_app is exempt and only in_app. Its "delivery" is the message_log row
	itself, read inside the product by a signed-in user of the same school --
	nothing leaves the building, no charge is incurred and no family is
	messaged. Suppressing it would break automation a school can legitimately
	run during setup, which is the one thing this guard should not do. Every
	channel that reaches a phone or a mailbox -- email, sms, whatsapp, push,
	and the phone gateway, which is the sms channel wearing a different
	provider -- is guarded.
*/
func (g recipientGuard) permits(channel, recipient string) (bool, string) {
	if channel == "in_app" {
		return true, ""
	}
	if g.Mode == "everyone" {
		return true, ""
	}
	key := normaliseRecipient(recipient)
	if key == "" {
		return false, "not on the allowlist — the recipient could not be read as a number or an address"
	}
	if g.allowed[key] {
		return true, ""
	}
	if len(g.allowed) == 0 {
		return false, "not on the allowlist — this school is in allowlist mode and the list is empty, so nothing is being sent to anybody"
	}
	return false, "not on the allowlist"
}

// normaliseRecipient turns whatever is on the message_log row into the form
// the allowlist is matched on. An address if it looks like one, an E.164
// number otherwise, so '9100575183', '+919100575183' and '919100575183' are
// the same entry rather than three that each half-work.
func normaliseRecipient(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if strings.Contains(v, "@") {
		return "email:" + strings.ToLower(v)
	}
	n := waNormalisePhone(v)
	if n == "" {
		return ""
	}
	return "phone:" + n
}

// recipientKindOf reports which column of the screen an entry belongs in.
func recipientKindOf(v string) string {
	if strings.Contains(v, "@") {
		return "email"
	}
	return "phone"
}

/*
waNormalisePhone reduces an Indian phone number to E.164 digits, no plus.

	Meta wants exactly that on the wire, and the allowlist wants exactly that
	to match on, so there is one function rather than two that drift.

	It returns "" for anything it cannot make sense of rather than guessing.
	A number this cannot read is a number that must not be sent to blind: on
	the send path it becomes ErrNoRecipient, and on the guard path it becomes
	a refusal, and both are better than a message delivered to whoever owns
	the number the guess produced.
*/
func waNormalisePhone(raw string) string {
	var d strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			d.WriteRune(r)
		}
	}
	s := d.String()
	switch {
	case s == "":
		return ""
	// 00 91 98765 43210 — the international prefix spelled out.
	case strings.HasPrefix(s, "00"):
		s = strings.TrimPrefix(s, "00")
	// 0 98765 43210 — the Indian trunk prefix.
	case len(s) == 11 && strings.HasPrefix(s, "0"):
		s = strings.TrimPrefix(s, "0")
	}
	if len(s) == 10 {
		// A bare subscriber number. Indian mobile numbers begin 6-9; a
		// ten-digit number starting otherwise is a landline written without
		// its STD code, which cannot be dialled internationally and must not
		// be silently prefixed into somebody else's number.
		if s[0] < '6' {
			return ""
		}
		return waIndiaCC + s
	}
	// Already international: 91XXXXXXXXXX, or another country's number.
	if len(s) >= 11 && len(s) <= 15 {
		return s
	}
	return ""
}

// waAllDigits reports whether every character is a digit. isDigits in
// setup_profile.go takes a fixed length, which a Meta phone number id does not
// have; this is the same question without the length.
func waAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// waRedact is what goes in an error message about a recipient. Last four
// only, as banking.go does for account numbers -- an error string ends up in
// message_log, in a log line and on a screen, and a full parent phone number
// has no business in any of them.
func waRedact(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "…" + lastFour(v)
}

// --- 5. HTTP -----------------------------------------------------------------

/*
mountWhatsApp serves the WhatsApp API Integration screen and the recipient
guard beside it.

	The guard's routes sit under /messaging rather than /whatsapp on purpose:
	it is not a WhatsApp feature, it governs every channel, and putting it
	behind a channel's path would invite the next channel to grow its own.
	They are mounted from this file only because this file is the one that was
	being written when the school asked for them.

	Permissions are messaging.go's, unchanged, and every one of them is
	institution-scoped: reading the configuration is institution.read,
	changing credentials is institution.integrations.write, editing templates
	is institution.settings.write, and the log -- which names recipients -- is
	comms.messages.send or audit.read. The allowlist is integrations.write
	rather than settings.write because turning it off is the single most
	consequential switch on this screen, and it belongs with the credentials
	rather than with the preferences.

	Nothing here is behind a platform rung. This is the school's own WhatsApp
	Business account, its own number and its own recipients, so institution_
	admin (rbac.go: keysExcept(PlatformTenantsRW, PlatformPlansRW)) reaches
	all of it and a platform operator needs no special standing to. Every
	handler writes id.InstitutionID and never a value from the request, so a
	caller cannot name another school's row even by guessing its id; the RLS
	policies in 00101 are the second line rather than the only one.

	SPLICE POINT for the integrator: internal/api/api.go line 582, inside
	r.Route("/admin", ...), immediately after s.mountMessaging(r).
*/
func (s *Server) mountWhatsApp(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	creds := httpx.RequirePermission(rbac.IntegrationsWrite)
	config := httpx.RequirePermission(rbac.SettingsWrite)
	send := httpx.RequirePermission(rbac.MessagesSend)
	logRead := httpx.RequireAnyPermission(rbac.MessagesSend, rbac.AuditRead)

	// The WhatsApp Business Cloud account.
	r.With(read).Get("/whatsapp/settings", s.getWhatsAppSettings)
	r.With(creds).Put("/whatsapp/settings", s.saveWhatsAppSettings)
	r.With(creds).Delete("/whatsapp/settings", s.forgetWhatsAppSettings)
	r.With(send).Post("/whatsapp/test", s.testWhatsApp)

	// The mapping from this product's templates to approved WhatsApp ones.
	r.With(read).Get("/whatsapp/templates", s.listWhatsAppTemplates)
	r.With(config).Put("/whatsapp/templates", s.saveWhatsAppTemplate)

	// What has gone out, and what the guard held back.
	r.With(logRead).Get("/whatsapp/log", s.listWhatsAppLog)

	// The recipient guard. Every channel, not this one.
	r.With(read).Get("/messaging/recipients", s.getRecipientPolicy)
	r.With(creds).Put("/messaging/recipients/mode", s.setRecipientMode)
	r.With(creds).Post("/messaging/recipients", s.addAllowedRecipient)
	r.With(creds).Delete("/messaging/recipients/{id}", s.removeAllowedRecipient)
}

// --- settings ---

type whatsappSettingsView struct {
	PhoneNumberID   string `json:"phone_number_id"`
	WABAID          string `json:"waba_id"`
	BusinessNumber  string `json:"business_number"`
	APIVersion      string `json:"api_version"`
	DefaultLanguage string `json:"default_language"`
	AllowFreeText   bool   `json:"allow_free_text"`

	Enabled bool `json:"enabled"`
	// HasToken says a token is stored. The token itself is never returned:
	// a screen that can read it back is a screen that leaks the school's
	// whole WhatsApp account to anyone who can open it.
	HasToken   bool   `json:"has_token"`
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`
	Endpoint   string `json:"endpoint"`
	// Mode is 'cloud' when this row is a Cloud API row, 'gateway' when the
	// school is on a reseller, 'none' when nothing is stored.
	Mode      string  `json:"mode"`
	LastOKAt  *string `json:"last_ok_at,omitempty"`
	LastError *string `json:"last_error,omitempty"`

	Queued     int `json:"queued"`
	SentToday  int `json:"sent_today"`
	Failed     int `json:"failed_today"`
	Suppressed int `json:"suppressed_today"`
}

func (s *Server) getWhatsAppSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v whatsappSettingsView

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return s.readWhatsAppSettings(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) readWhatsAppSettings(ctx context.Context, tx pgx.Tx, inst uuid.UUID, v *whatsappSettingsView) error {
	var (
		cfg     []byte
		enabled bool
	)
	err := tx.QueryRow(ctx, `
		SELECT config, enabled, octet_length(COALESCE(credentials,''::bytea)) > 0,
		       to_char(last_ok_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), last_error
		  FROM integrations
		 WHERE institution_id = $1 AND provider = 'whatsapp' AND kind = 'messaging'`,
		inst).Scan(&cfg, &enabled, &v.HasToken, &v.LastOKAt, &v.LastError)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		v.Mode = "none"
	case err != nil:
		return err
	default:
		v.Enabled = enabled
		var st whatsappCloudSettings
		if len(cfg) > 0 {
			_ = json.Unmarshal(cfg, &st)
		}
		v.PhoneNumberID = st.PhoneNumberID
		v.WABAID = st.WABAID
		v.BusinessNumber = st.BusinessNumber
		v.APIVersion = st.APIVersion
		v.DefaultLanguage = st.DefaultLanguage
		v.AllowFreeText = st.AllowFreeText
		if strings.TrimSpace(st.PhoneNumberID) != "" {
			v.Mode = "cloud"
			v.Endpoint = whatsappCloudProvider{cfg: st}.waEndpoint()
		} else {
			v.Mode = "gateway"
		}
	}
	if v.APIVersion == "" {
		v.APIVersion = waDefaultAPIVersion
	}

	// The reason comes from the provider itself rather than being written
	// twice, so the screen and the dispatcher can never disagree about
	// whether this school can send.
	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		return err
	}
	if p, ok := set["whatsapp"]; ok {
		v.Configured = p.Configured()
		v.Reason = p.Why()
	}

	return tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'queued'),
		       count(*) FILTER (WHERE status IN ('sent','delivered','read') AND sent_at > now() - interval '24 hours'),
		       count(*) FILTER (WHERE status = 'failed'    AND queued_at > now() - interval '24 hours'),
		       count(*) FILTER (WHERE status = 'suppressed' AND queued_at > now() - interval '24 hours')
		  FROM message_log
		 WHERE institution_id = $1 AND channel = 'whatsapp'`, inst).
		Scan(&v.Queued, &v.SentToday, &v.Failed, &v.Suppressed)
}

type whatsappSaveRequest struct {
	PhoneNumberID   string  `json:"phone_number_id"`
	WABAID          string  `json:"waba_id"`
	BusinessNumber  string  `json:"business_number"`
	APIVersion      string  `json:"api_version"`
	DefaultLanguage string  `json:"default_language"`
	AllowFreeText   bool    `json:"allow_free_text"`
	Enabled         bool    `json:"enabled"`
	Token           *string `json:"token"`
}

var waVersionShape = regexp.MustCompile(`^v[0-9]+\.[0-9]+$`)
var waLanguageShape = regexp.MustCompile(`^[a-z]{2,3}(_[A-Z]{2})?$`)

func (s *Server) saveWhatsAppSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req whatsappSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	st := whatsappCloudSettings{
		PhoneNumberID:   strings.TrimSpace(req.PhoneNumberID),
		WABAID:          strings.TrimSpace(req.WABAID),
		BusinessNumber:  strings.TrimSpace(req.BusinessNumber),
		APIVersion:      strings.TrimSpace(req.APIVersion),
		DefaultLanguage: strings.TrimSpace(req.DefaultLanguage),
		AllowFreeText:   req.AllowFreeText,
	}
	if st.PhoneNumberID == "" || !waAllDigits(st.PhoneNumberID) {
		httpx.BadRequest(w, r, "the phone number id is the numeric id from WhatsApp Manager, not the phone number")
		return
	}
	if st.APIVersion != "" && !waVersionShape.MatchString(st.APIVersion) {
		httpx.BadRequest(w, r, "the API version looks like v21.0")
		return
	}
	if st.DefaultLanguage != "" && !waLanguageShape.MatchString(st.DefaultLanguage) {
		httpx.BadRequest(w, r, "the language code looks like en, en_US or te")
		return
	}
	if st.BusinessNumber != "" && waNormalisePhone(st.BusinessNumber) == "" {
		httpx.BadRequest(w, r, "the business number is not a phone number this can read")
		return
	}

	var sealed []byte
	if req.Token != nil && strings.TrimSpace(*req.Token) != "" {
		b, err := sealSecret(strings.TrimSpace(*req.Token))
		if err != nil {
			// A refusal, not a 500. Storing a System User token in clear is
			// the worse of the two ways to fail: it opens the school's whole
			// WhatsApp account to anybody with a database dump.
			httpx.Denied(w, r, err.Error())
			return
		}
		sealed = b
	}

	cfg, err := json.Marshal(st)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var v whatsappSettingsView
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// COALESCE on credentials is what makes an omitted token mean "keep
		// the stored one": editing the default language must not silently
		// clear the token and stop every reminder at the next dispatch.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO integrations (institution_id, provider, kind, config, credentials, enabled)
			VALUES ($1,'whatsapp','messaging',$2,$3,$4)
			ON CONFLICT (institution_id, provider) DO UPDATE
			   SET config      = EXCLUDED.config,
			       credentials = COALESCE(EXCLUDED.credentials, integrations.credentials),
			       enabled     = EXCLUDED.enabled,
			       kind        = 'messaging'`,
			id.InstitutionID, cfg, sealed, req.Enabled); err != nil {
			return err
		}
		return s.readWhatsAppSettings(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) forgetWhatsAppSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v whatsappSettingsView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM integrations
			 WHERE institution_id = $1 AND provider = 'whatsapp' AND kind = 'messaging'`,
			id.InstitutionID); err != nil {
			return err
		}
		return s.readWhatsAppSettings(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

type whatsappTestRequest struct {
	To           string `json:"to"`
	TemplateCode string `json:"template_code"`
}

/*
testWhatsApp proves the account works, by the route a real reminder takes.

	Same provider, same template resolution, same allowlist. Especially the
	allowlist: a test that could reach a number the dispatcher would refuse
	would prove the opposite of what the school needs proved, and would be the
	one hole through which a real family could be messaged during setup.

	Without a token this cannot succeed, and it does not pretend to. It returns
	409 and the provider's own sentence about what is missing.
*/
func (s *Server) testWhatsApp(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req whatsappTestRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	to := strings.TrimSpace(req.To)
	if to == "" {
		httpx.BadRequest(w, r, "a number to test against is required")
		return
	}
	code := strings.TrimSpace(req.TemplateCode)

	var (
		p        MessagingProvider
		school   string
		out      *whatsappTemplateSend
		guardWhy string
	)
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := s.loadProviders(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		p = set["whatsapp"]

		guard, err := s.loadRecipientGuard(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if ok, why := guard.permits("whatsapp", to); !ok {
			guardWhy = why
			return nil
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, id.InstitutionID).Scan(&school); err != nil {
			return err
		}
		if code != "" {
			out, err = s.whatsappSendFor(r.Context(), tx, id.InstitutionID, code,
				map[string]any{"school_name": school})
			return err
		}
		return nil
	}); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	if guardWhy != "" {
		// 409 rather than 403: nothing is forbidden to this user, and the
		// school can change it on the same screen.
		httpx.Error(w, r, http.StatusConflict, "not_on_allowlist", guardWhy)
		return
	}
	if p == nil || !p.Configured() {
		why := "WhatsApp is not set up"
		if p != nil {
			why = p.Why()
		}
		httpx.Error(w, r, http.StatusConflict, "provider_not_configured", why)
		return
	}

	t := builtinTemplates["messaging.test"]
	vars := map[string]any{"school_name": school}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	msgID, sendErr := p.Send(ctx, OutboundMessage{
		To:      to,
		Subject: renderTemplate(t.Subject, vars),
		Body:    renderTemplate(t.Body, vars),
		WA:      out,
	})

	_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if sendErr != nil {
			_, err := tx.Exec(r.Context(), `
				UPDATE integrations SET last_error = $2
				 WHERE institution_id = $1 AND provider = 'whatsapp'`,
				id.InstitutionID, truncate(sendErr.Error(), 500))
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE integrations SET last_ok_at = now(), last_error = NULL
			 WHERE institution_id = $1 AND provider = 'whatsapp'`, id.InstitutionID)
		return err
	})

	if sendErr != nil {
		httpx.Error(w, r, http.StatusBadGateway, "provider_rejected", truncate(sendErr.Error(), 400))
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok": true, "message_id": msgID,
		"message": "WhatsApp accepted the message for " + waRedact(to),
	})
}

// --- templates ---

type whatsappTemplateView struct {
	Code string `json:"code"`
	Body string `json:"body"`
	// Placeholders are the {{names}} the body uses, in the order they appear.
	// Offered to the screen as a starting point for the mapping, never as the
	// mapping itself -- the approved template's order is Meta's, not ours.
	Placeholders []string `json:"placeholders"`
	Name         string   `json:"wa_template_name"`
	Language     string   `json:"wa_language"`
	Params       []string `json:"wa_params"`
	Active       bool     `json:"is_active"`
	BuiltIn      bool     `json:"built_in"`
	// Mapped is the only thing that decides whether this template can be sent
	// on WhatsApp at all.
	Mapped bool `json:"mapped"`
}

func (s *Server) listWhatsAppTemplates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []whatsappTemplateView{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		seen := map[string]bool{}
		rows, err := tx.Query(r.Context(), `
			SELECT code, body, wa_template_name, wa_language, wa_params, is_active
			  FROM message_templates
			 WHERE institution_id = $1 AND channel = 'whatsapp'
			 ORDER BY code`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				v          whatsappTemplateView
				name, lang *string
				params     []byte
			)
			if err := rows.Scan(&v.Code, &v.Body, &name, &lang, &params, &v.Active); err != nil {
				return err
			}
			v.Name, v.Language = deref(name), deref(lang)
			v.Params = []string{}
			if len(params) > 0 {
				_ = json.Unmarshal(params, &v.Params)
			}
			if v.Params == nil {
				v.Params = []string{}
			}
			v.Placeholders = templatePlaceholders(v.Body)
			v.Mapped = strings.TrimSpace(v.Name) != ""
			seen[v.Code] = true
			items = append(items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		/* The built-ins appear as unmapped rows rather than being hidden.

		   A school's WhatsApp reminders are the four built-in codes until
		   somebody writes their own, and a screen that showed only what had
		   been written would show nothing on the day the account is connected
		   -- leaving an administrator to guess which codes exist. Listed with
		   mapped:false, they are a to-do list instead. */
		for code, t := range builtinTemplates {
			if seen[code] {
				continue
			}
			items = append(items, whatsappTemplateView{
				Code: code, Body: t.Body, Placeholders: templatePlaceholders(t.Body),
				Params: []string{}, Active: true, BuiltIn: true, Mapped: false,
			})
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	sortWhatsAppTemplates(items)
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// sortWhatsAppTemplates puts the unmapped first: they are the work.
func sortWhatsAppTemplates(items []whatsappTemplateView) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0; j-- {
			a, b := items[j-1], items[j]
			if (a.Mapped == b.Mapped && a.Code <= b.Code) || (!a.Mapped && b.Mapped) {
				break
			}
			items[j-1], items[j] = b, a
		}
	}
}

// templatePlaceholders lists the {{names}} a body uses, in order, once each.
func templatePlaceholders(body string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, m := range templateVar.FindAllStringSubmatch(body, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

type whatsappTemplateSaveRequest struct {
	Code     string   `json:"code"`
	Body     string   `json:"body"`
	Name     string   `json:"wa_template_name"`
	Language string   `json:"wa_language"`
	Params   []string `json:"wa_params"`
	Active   bool     `json:"is_active"`
}

var waNameShape = regexp.MustCompile(`^[a-z0-9_]{1,512}$`)

func (s *Server) saveWhatsAppTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req whatsappTemplateSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		httpx.BadRequest(w, r, "a template code is required")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name != "" && !waNameShape.MatchString(name) {
		httpx.BadRequest(w, r, "an approved WhatsApp template name is lowercase letters, digits and underscores")
		return
	}
	lang := strings.TrimSpace(req.Language)
	if lang != "" && !waLanguageShape.MatchString(lang) {
		httpx.BadRequest(w, r, "the language code looks like en, en_US or te")
		return
	}
	if name != "" && lang == "" {
		// A template approved in English does not exist in Telugu. Guessing
		// the language produces 132001 at send time, which reads as "no such
		// template" and sends the administrator looking for a typo.
		httpx.BadRequest(w, r, "an approved template needs the language it was approved in")
		return
	}

	body := req.Body
	if strings.TrimSpace(body) == "" {
		if t, ok := builtinTemplates[code]; ok {
			body = t.Body
		} else {
			httpx.BadRequest(w, r, "a body is required for a template that is not a built-in")
			return
		}
	}

	params := req.Params
	if params == nil {
		params = []string{}
	}
	known := map[string]bool{}
	for _, p := range templatePlaceholders(body) {
		known[p] = true
	}
	for _, p := range params {
		if !known[p] {
			// Refused at save time rather than discovered at send time. A
			// mapping naming a placeholder the body does not carry is a
			// message that will be sent with a parameter missing, and Meta
			// answers that with 132000 four hours later.
			httpx.BadRequest(w, r, fmt.Sprintf(
				"the mapping names %q, which this template's body does not use", p))
			return
		}
	}

	raw, err := json.Marshal(params)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO message_templates
			    (institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
			VALUES ($1,$2,'whatsapp',$3,NULLIF($4,''),NULLIF($5,''),$6,$7)
			ON CONFLICT (institution_id, code, channel) DO UPDATE
			   SET body             = EXCLUDED.body,
			       wa_template_name = EXCLUDED.wa_template_name,
			       wa_language      = EXCLUDED.wa_language,
			       wa_params        = EXCLUDED.wa_params,
			       is_active        = EXCLUDED.is_active`,
			id.InstitutionID, code, body, name, lang, raw, req.Active)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.listWhatsAppTemplates(w, r)
}

// --- the log ---

type whatsappLogRow struct {
	ID        string  `json:"id"`
	Recipient string  `json:"recipient"`
	Subject   *string `json:"subject,omitempty"`
	Status    string  `json:"status"`
	Provider  *string `json:"provider,omitempty"`
	Template  *string `json:"template_code,omitempty"`
	Error     *string `json:"error,omitempty"`
	Attempts  int     `json:"attempts"`
	QueuedAt  string  `json:"queued_at"`
	SentAt    *string `json:"sent_at,omitempty"`
}

func (s *Server) listWhatsAppLog(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []whatsappLogRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id, recipient, subject, status, provider, template_code, error, attempts,
			       to_char(queued_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       to_char(sent_at,   'YYYY-MM-DD"T"HH24:MI:SSOF')
			  FROM message_log
			 WHERE institution_id = $1 AND channel = 'whatsapp'
			 ORDER BY queued_at DESC
			 LIMIT 100`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v whatsappLogRow
			if err := rows.Scan(&v.ID, &v.Recipient, &v.Subject, &v.Status, &v.Provider,
				&v.Template, &v.Error, &v.Attempts, &v.QueuedAt, &v.SentAt); err != nil {
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

// --- the recipient guard over HTTP ---

type allowedRecipientView struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Raw        string `json:"raw"`
	Normalised string `json:"normalised"`
	Label      string `json:"label"`
	CreatedAt  string `json:"created_at"`
}

type recipientPolicyView struct {
	Mode  string                 `json:"mode"`
	Note  string                 `json:"note"`
	Items []allowedRecipientView `json:"items"`
	// Sending says, in one word, whether anything can currently leave. False
	// in allowlist mode with an empty list, which is the state a school is in
	// the moment this feature is deployed.
	Sending bool `json:"sending"`
	// Explanation is the sentence the screen puts in its banner.
	Explanation string  `json:"explanation"`
	UpdatedAt   *string `json:"updated_at,omitempty"`
}

func (s *Server) getRecipientPolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v recipientPolicyView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return s.readRecipientPolicy(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) readRecipientPolicy(ctx context.Context, tx pgx.Tx, inst uuid.UUID, v *recipientPolicyView) error {
	v.Mode = "allowlist"
	v.Items = []allowedRecipientView{}

	var note *string
	err := tx.QueryRow(ctx, `
		SELECT mode, note, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM messaging_recipient_policy WHERE institution_id = $1`, inst).
		Scan(&v.Mode, &note, &v.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	v.Note = deref(note)

	rows, err := tx.Query(ctx, `
		SELECT id, kind, raw, normalised, COALESCE(label,''),
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM messaging_allowed_recipients
		 WHERE institution_id = $1
		 ORDER BY kind, normalised`, inst)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var e allowedRecipientView
		if err := rows.Scan(&e.ID, &e.Kind, &e.Raw, &e.Normalised, &e.Label, &e.CreatedAt); err != nil {
			return err
		}
		v.Items = append(v.Items, e)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	switch {
	case v.Mode == "everyone":
		v.Sending = true
		v.Explanation = "Live. Every parent, guardian and member of staff this school messages will receive it."
	case len(v.Items) == 0:
		v.Sending = false
		v.Explanation = "Nothing is being sent to anybody. This school is in allowlist mode and the list is empty — every outbound message on every channel is being recorded as suppressed instead of sent."
	default:
		v.Sending = false
		v.Explanation = fmt.Sprintf(
			"Allowlist mode. Only the %d recipient(s) below are being messaged, on every channel. Everything else is recorded as suppressed.",
			len(v.Items))
	}
	return nil
}

type recipientModeRequest struct {
	Mode string `json:"mode"`
	Note string `json:"note"`
	// Confirm has to be the literal mode being moved to. Turning the guard
	// off is the one action on this screen that can reach every family at
	// once, and a single mis-click should not be able to do it.
	Confirm string `json:"confirm"`
}

func (s *Server) setRecipientMode(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req recipientModeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	mode := strings.TrimSpace(req.Mode)
	if !oneOfStr(mode, "allowlist", "everyone") {
		httpx.BadRequest(w, r, "mode must be allowlist or everyone")
		return
	}
	if mode == "everyone" && strings.TrimSpace(req.Confirm) != "everyone" {
		httpx.BadRequest(w, r,
			"turning the guard off messages every real family — type 'everyone' to confirm")
		return
	}

	var v recipientPolicyView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO messaging_recipient_policy (institution_id, mode, note, updated_at, updated_by)
			VALUES ($1,$2,NULLIF($3,''),now(),$4)
			ON CONFLICT (institution_id) DO UPDATE
			   SET mode = EXCLUDED.mode, note = EXCLUDED.note,
			       updated_at = now(), updated_by = EXCLUDED.updated_by`,
			id.InstitutionID, mode, strings.TrimSpace(req.Note), id.UserID); err != nil {
			return err
		}
		return s.readRecipientPolicy(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	slog.Info("messaging recipient mode changed",
		"institution_id", id.InstitutionID, "mode", mode, "by", id.UserID)
	httpx.JSON(w, http.StatusOK, v)
}

type addRecipientRequest struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

func (s *Server) addAllowedRecipient(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req addRecipientRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	raw := strings.TrimSpace(req.Value)
	if raw == "" {
		httpx.BadRequest(w, r, "a number or an email address is required")
		return
	}
	kind := recipientKindOf(raw)
	var norm string
	if kind == "email" {
		norm = strings.ToLower(raw)
		if !strings.Contains(norm, ".") || strings.HasPrefix(norm, "@") || strings.HasSuffix(norm, "@") {
			httpx.BadRequest(w, r, "that does not look like an email address")
			return
		}
	} else {
		norm = waNormalisePhone(raw)
		if norm == "" {
			httpx.BadRequest(w, r,
				"that is not a phone number this can read — a ten-digit Indian mobile, or an international number")
			return
		}
	}

	var v recipientPolicyView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// DO NOTHING rather than an error: '9100575183' and '+919100575183'
		// normalise to the same entry, and an operator who types both has not
		// made a mistake worth a red box.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO messaging_allowed_recipients
			    (institution_id, kind, raw, normalised, label, created_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6)
			ON CONFLICT (institution_id, kind, normalised) DO NOTHING`,
			id.InstitutionID, kind, raw, norm, strings.TrimSpace(req.Label), id.UserID); err != nil {
			return err
		}
		return s.readRecipientPolicy(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	slog.Info("messaging allowlist entry added",
		"institution_id", id.InstitutionID, "kind", kind, "last4", lastFour(norm))
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) removeAllowedRecipient(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var v recipientPolicyView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM messaging_allowed_recipients
			 WHERE id = $1 AND institution_id = $2`, entry, id.InstitutionID); err != nil {
			return err
		}
		return s.readRecipientPolicy(r.Context(), tx, id.InstitutionID, &v)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}
