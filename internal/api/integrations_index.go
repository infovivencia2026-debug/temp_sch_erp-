package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
One honest index over every connector this deployment already has.

	This file adds no machinery and stores nothing. Every connector below
	already knows whether it is usable and already says why not in a sentence
	somebody wrote to be acted on; the index asks each one and lays the answers
	side by side. It deliberately does not form a second opinion. Where a
	connector answers "I cannot tell you whether I am working", that is what
	appears — see integrationsCannotJudge below, which is the honest half of
	this screen and the half most likely to be quietly deleted by a later edit.

	The reasoning is the one written above MessagingProvider in messaging.go:
	the honest answer to "can this school send an SMS" has to be available
	before anybody asks it to. An index over eight connectors is the same
	claim made eight times, and the failure it exists to prevent is the
	specific one where a school believes Tally exports are going across when
	they stopped a fortnight ago. So a connector with nothing recent is loud,
	not a grey dot, and a failed fetch is never drawn as "all healthy".

	Where each answer comes from, and who computes it:

	  email / sms / whatsapp   s.loadProviders (messaging.go) — Configured()
	                           and Why() off the provider itself. The phone
	                           handset is inside this: loadProviders swaps in
	                           s.loadPhoneGateway for an SMS row configured as
	                           a phone, and that provider already folds the
	                           missed-heartbeat window into its own Why(). This
	                           index must not re-judge the heartbeat.
	  tally                    tally_connector_settings + tally_export_runs.
	  crm                      crm_api_credentials, crm_sync_runs, crmLiveNote.
	  meetings                 virtual_meeting_platform_providers,
	                           virtual_meeting_requests, meetingLiveNote.
	  child info               childInfoProviderFor(...).Ready(), which returns
	                           the blocker sentence verbatim.

	Three channels, not five rows. The brief for this screen listed SMTP, the
	vendor SMS/WhatsApp gateway, the WhatsApp Cloud API and the paired handset
	as four separate connectors. The codebase does not store them that way:
	there are three messaging channels in `integrations`, and which concrete
	provider serves a channel is decided per school by loadProviders. Emitting
	four fixed rows would mean inventing state for the three a given school is
	not using. One row per channel, naming the provider that school actually
	has, is the same information without the invention.

	NOT here, and reported rather than faked: the catalogue summary for this
	feature also names a payment gateway and biometric devices. Neither exists
	— no table, no route, no handler, in any migration. There is nothing to
	index, and a row saying "not configured" would imply a screen to go and
	configure, which there isn't.
*/

// --- what an entry is --------------------------------------------------------

// Health values. Deliberately few: an operator triaging this screen is sorting
// into "leave alone", "somebody must look now" and "nobody has set this up",
// and a finer vocabulary only makes that sort slower.
const (
	integrationHealthOK        = "ok"
	integrationHealthFailing   = "failing"
	integrationHealthStale     = "stale"
	integrationHealthIdle      = "idle"
	integrationHealthNotSetUp  = "not_configured"
	integrationHealthUnknowing = "unknown"
)

/*
integrationEntry is one connector as this screen sees it.

	Reason, LiveNote and LastError are carried verbatim. They are not
	reformatted, truncated or turned into a code: each was written where the
	connector lives, by somebody who knew which credential was missing, and
	rephrasing them here is how an actionable sentence becomes a shrug.

	No entry ever carries a credential, a token, an endpoint password or an
	account identifier. Whether a secret is stored is a boolean; the secret is
	not the screen's business, and banking.go's rule — mask to last four —
	applies to anything that ever became more than a boolean.
*/
type integrationEntry struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Group string `json:"group"`
	// Scope is "institution" or "platform" and is the tenancy fact this screen
	// turns on. A platform row is never present in an institution admin's
	// response at all — not hidden, not blanked, absent.
	Scope string `json:"scope"`
	// Provider is what this school actually has behind the channel, when the
	// connector reports one. Empty is normal and means "nothing chosen yet".
	Provider string `json:"provider,omitempty"`

	// --- switched on, and set up. Two different questions, both the
	// connector's own answer.
	Enabled    bool   `json:"enabled"`
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`

	// --- working. A third question again, and the one this screen is for.
	Health     string `json:"health"`
	HealthNote string `json:"health_note,omitempty"`

	LastOKAt *string `json:"last_ok_at,omitempty"`
	// LastOKLabel says what LastOKAt is the time OF. This matters more than it
	// looks: for the three messaging channels, integrations.last_ok_at is
	// written only by the Test connection button and by nothing else — not by
	// a real send. A screen that printed it as "last delivered" would be
	// making exactly the false promise this index exists to stop.
	LastOKLabel string  `json:"last_ok_label,omitempty"`
	LastError   *string `json:"last_error,omitempty"`
	LastErrorAt *string `json:"last_error_at,omitempty"`

	// SilentDays is whole days since the last recorded success, present only
	// where a success is recorded at all. StaleAfterDays is the threshold the
	// server applied, published so the screen states the rule rather than
	// asking the reader to infer it from a colour. Both nil means no run is
	// scheduled for this connector, so there is nothing for it to be late for.
	SilentDays     *int `json:"silent_days,omitempty"`
	StaleAfterDays *int `json:"stale_after_days,omitempty"`

	// FailedRecently is the connector's own count of failures in the last 24
	// hours where it keeps one. Nil where it keeps none.
	FailedRecently *int `json:"failed_recently,omitempty"`

	// LiveAvailable is the connector's own live_push/live_sync/live_create
	// flag, off the server exactly as those endpoints publish it. Nil where
	// the connector has no such concept. Never computed here.
	LiveAvailable *bool  `json:"live_available,omitempty"`
	LiveNote      string `json:"live_note,omitempty"`

	// FixKey is the catalogue key of the screen that configures this. The
	// screen turns it into a route; this file does not know about routes.
	FixKey   string `json:"fix_key"`
	FixLabel string `json:"fix_label"`
}

/*
integrationsCannotJudge is the sentence a connector gets when it records no
success and no failure anywhere.

	Tally is the reason this exists. It has no last_ok_at, no last_error and no
	failure row at all — a failed render rolls the run back, so the export log
	only ever contains successes. The truthful thing to say about a Tally
	connector that has never exported is "nothing has been recorded", not
	"working". Saying "working" is the fortnight-of-silence failure with extra
	steps.
*/
const integrationsCannotJudge = "This connector records no success or failure of its own. " +
	"What is shown is the last run it filed; an empty history means nothing has run, " +
	"not that everything is well."

/*
tallyStaleAfterDays is the only staleness clock on this screen.

	Fourteen days because a school exports to Tally on a monthly or fortnightly
	book-closing rhythm, and the brief for this screen names a fortnight of
	unnoticed silence as the failure it is built to prevent.

	Every other connector here is deliberately given no clock. CRM, meetings
	and Child Info all publish live_*_available = false — nothing is scheduled,
	nothing polls, and a school is not late for a sync that does not run. The
	three messaging channels are given none because their provider already
	judges its own liveness (the paired handset's missed-heartbeat window is
	inside loadPhoneGateway), and a second window here would be the second
	opinion this file is not allowed to hold.
*/
const tallyStaleAfterDays = 14

// --- mounting ----------------------------------------------------------------

/*
mountIntegrationsIndex registers the read-only index.

	SPLICE POINT: internal/api/api.go, inside r.Route("/admin", ...), beside
	s.mountConnectors(r) (currently line 587). Nothing else. It registers one
	GET; it defines no new prefix that could collide with a chi Route.

	The gate is institution.read, which messaging.go names as exactly this
	rung: "seeing how any of it is configured". Every fact this endpoint
	returns is already readable by that permission through
	GET /admin/messaging/providers, which returns more (stored settings,
	message counts) than the index does.

	institution.read is not sufficient for the platform half and is not asked
	to be. The three platform connectors are added only for a caller who is
	both PlatformAdmin (reach) and holds platform.tenants.write (capability) —
	the same doubling mountConnectors and mountTallyConnector use, and for the
	same reason: institution_admin holds every other key in this product and
	deliberately not that one.
*/
func (s *Server) mountIntegrationsIndex(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.InstitutionRead)).
		Get("/integrations/index", s.listIntegrationsIndex)
}

// --- the index ---------------------------------------------------------------

/*
listIntegrationsIndex answers "what is switched on, what is working, and where
do I go to fix it" for every connector at once.

	resolveScope is called and honoured. It is the authority for two decisions:
	whether the platform section exists in the response at all, and which
	institution the per-school rows are read for. Neither is left to the
	client. Compare hr_lifecycle.go, which gates at the group and never
	resolves — that is how a head of department ended up reading every
	colleague's bank account, and this endpoint reports connector state for a
	whole school, so the same mistake here shows one school another's.
*/
func (s *Server) listIntegrationsIndex(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	id := httpx.IdentityFrom(r.Context())

	/* The platform half needs reach AND capability. res.PlatformAdmin is the
	   reach; Can(PlatformTenantsRW) is the capability, and it is asked
	   separately because a restricted platform account — a vendor's billing
	   administrator — has the first without the second (see httpx.Identity's
	   Restricted field). Without this second limb, that account would read the
	   CRM and meeting connector state for every school on the installation. */
	platformView := res.PlatformAdmin && id.Can(rbac.PlatformTenantsRW)

	/* Which school the per-institution rows describe. For school staff it is
	   their own and cannot be anything else. For platform staff it is the one
	   they are acting on (X-Acting-Institution, see acting.go); with none
	   chosen, the per-school rows are omitted and the response says so, rather
	   than being silently drawn from whichever tenant RLS would have let
	   through. */
	inst := res.InstitutionID
	haveInstitution := inst != uuid.Nil

	items := []integrationEntry{}

	if haveInstitution {
		rows, err := s.institutionIntegrations(r, inst)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		items = append(items, rows...)
	}

	if platformView {
		rows, err := s.platformIntegrations(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		items = append(items, rows...)
	}

	working, attention, notSetUp := 0, 0, 0
	for _, it := range items {
		switch it.Health {
		case integrationHealthOK:
			working++
		case integrationHealthFailing, integrationHealthStale:
			attention++
		case integrationHealthNotSetUp:
			notSetUp++
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":                items,
		"institution_selected": haveInstitution,
		"platform_view":        platformView,
		"counts": map[string]int{
			"working":        working,
			"attention":      attention,
			"not_configured": notSetUp,
			"total":          len(items),
		},
		/* Said by the server so the screen cannot soften it. The count of
		   "working" above is a count of connectors that report themselves
		   working, which for several of them means "has not filed a failure",
		   and those are not the same sentence. */
		"note": "Each connector reports its own state. Nothing on this screen is a " +
			"second opinion, and a connector that keeps no record of success or " +
			"failure says so rather than being counted as healthy.",
	})
}

// --- the per-school connectors -----------------------------------------------

/*
institutionIntegrations reads the four connectors a school owns.

	One transaction, through InTenant, and every query names institution_id
	explicitly even so. RLS is the guarantee for school staff; the explicit
	predicate is what stops a platform admin — for whom the tenant policy is
	wide open — reading the union of every school on the installation into one
	school's row. listMessagingProviders takes the same belt-and-braces shape.
*/
func (s *Server) institutionIntegrations(r *http.Request, inst uuid.UUID) ([]integrationEntry, error) {
	out := []integrationEntry{}

	err := s.DB.InTenant(r.Context(), tenantScope(httpx.IdentityFrom(r.Context())), func(tx pgx.Tx) error {
		// --- the three messaging channels ------------------------------
		//
		// loadProviders is the whole of the configured/why logic for email,
		// SMS (vendor gateway or paired handset) and WhatsApp (Meta Cloud API
		// or reseller). It is called, not reimplemented.
		set, err := s.loadProviders(r.Context(), tx, inst)
		if err != nil {
			return err
		}

		stored := map[string]struct {
			enabled   bool
			lastOK    *time.Time
			lastError *string
		}{}
		rows, err := tx.Query(r.Context(), `
			SELECT provider, enabled, last_ok_at, last_error
			  FROM integrations
			 WHERE institution_id = $1 AND kind = 'messaging'`, inst)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ch string
			var v struct {
				enabled   bool
				lastOK    *time.Time
				lastError *string
			}
			if err := rows.Scan(&ch, &v.enabled, &v.lastOK, &v.lastError); err != nil {
				rows.Close()
				return err
			}
			stored[ch] = v
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		counts, err := s.channelCounts(r.Context(), tx, inst)
		if err != nil {
			return err
		}

		for _, ch := range []struct{ key, label, fixKey, fixLabel string }{
			{"email", "Email (SMTP)",
				"super_admin.messaging.email_server_smtp_integration", "Email Server (SMTP)"},
			{"sms", "SMS",
				"super_admin.messaging.sms_gateway_integration", "SMS gateway"},
			{"whatsapp", "WhatsApp",
				"super_admin.messaging.whatsapp_api_integration", "WhatsApp API"},
		} {
			e := integrationEntry{
				Key: "messaging." + ch.key, Label: ch.label,
				Group: "Messaging", Scope: "institution",
				FixKey: ch.fixKey, FixLabel: ch.fixLabel,
			}
			st := stored[ch.key]
			e.Enabled = st.enabled
			if p, ok := set[ch.key]; ok {
				// The connector's own answer, both halves, verbatim.
				e.Provider = p.Name()
				e.Configured = p.Configured()
				e.Reason = p.Why()
			}
			if st.lastOK != nil {
				v := st.lastOK.Format(time.RFC3339)
				e.LastOKAt = &v
			}
			e.LastError = st.lastError
			// Named for what it is. integrations.last_ok_at is written by
			// testMessagingProvider and by nothing else in this codebase.
			e.LastOKLabel = "last successful Test connection — not a delivery receipt"

			failed := counts[ch.key][2]
			e.FailedRecently = &failed

			switch {
			case !e.Configured:
				e.Health = integrationHealthNotSetUp
			case st.lastError != nil:
				e.Health = integrationHealthFailing
			case failed > 0:
				// The provider says it can send and the log says sends are
				// failing. That disagreement is the connector's own evidence,
				// not a judgement added here, and it is the loudest thing on
				// the row.
				e.Health = integrationHealthFailing
				e.HealthNote = "the provider reports itself ready, but messages failed in the last 24 hours"
			case st.lastOK == nil:
				e.Health = integrationHealthIdle
				e.HealthNote = "set up, but the connection has never been tested"
			default:
				e.Health = integrationHealthOK
			}
			out = append(out, e)
		}

		// --- Tally -----------------------------------------------------
		e, err := tallyIndexEntry(r, tx, inst)
		if err != nil {
			return err
		}
		out = append(out, e)
		return nil
	})
	return out, err
}

/*
tallyIndexEntry is the Tally export connector, and the one honest "I cannot
tell you" on this screen.

	Tally records no last_ok_at, no last_error and no failed run — a render
	that fails rolls the whole run back, so tally_export_runs contains
	successes only. The only evidence that anything is working is that a run
	was filed recently, which is why this is the one row with a staleness
	clock, and why it carries integrationsCannotJudge when it has no runs at
	all rather than defaulting to green.

	The gateway credential (tally_gateway_credentials, platform-only RLS) is
	deliberately not read here — not even as a boolean. This row is in the
	per-school half of the response, and reaching a platform-only credential
	table from it is exactly the leak the tenancy test pins.
*/
func tallyIndexEntry(r *http.Request, tx pgx.Tx, inst uuid.UUID) (integrationEntry, error) {
	e := integrationEntry{
		Key: "tally", Label: "Tally ERP / Prime", Group: "Finance", Scope: "institution",
		FixKey:   "super_admin.payments_devices.tally_erp_prime_connector",
		FixLabel: "Tally connector",
	}

	set, err := tallyLoadSettings(r, tx, inst)
	if err != nil {
		return e, err
	}
	e.Enabled = set.Enabled
	e.Provider = set.Delivery

	// The same test getTallyExportSettings publishes as "configured".
	e.Configured = set.CompanyName != ""
	if !e.Configured {
		e.Reason = "No Tally company is configured. Set it on the Tally connector before exporting."
	} else if !set.Enabled {
		e.Reason = "configured but switched off"
	}

	/* Stated by the server, exactly as getTallyConnector states it. There is
	   no Tally API: the gateway is a listener a running copy of Tally opens on
	   the school's own LAN, and a hosted server cannot reach it. */
	live := false
	e.LiveAvailable = &live
	e.LiveNote = "Tally Prime has no cloud API. Export the XML and import it in Tally: " +
		"Gateway of Tally, then Import, then Vouchers."

	var lastExport *time.Time
	if err := tx.QueryRow(r.Context(), `
		SELECT max(exported_at) FROM tally_export_runs WHERE institution_id = $1`,
		inst).Scan(&lastExport); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return e, err
	}

	stale := tallyStaleAfterDays
	e.LastOKLabel = "last export filed"

	switch {
	case !e.Configured || !set.Enabled:
		e.Health = integrationHealthNotSetUp
	case lastExport == nil:
		e.Health = integrationHealthUnknowing
		e.HealthNote = "switched on, but no export has ever been filed. " + integrationsCannotJudge
		e.StaleAfterDays = &stale
	default:
		v := lastExport.Format(time.RFC3339)
		e.LastOKAt = &v
		silent := int(nowInIndia().Sub(*lastExport).Hours() / 24)
		e.SilentDays = &silent
		e.StaleAfterDays = &stale
		if silent >= stale {
			e.Health = integrationHealthStale
			e.HealthNote = "no export has been filed in " + humanIntegrationDays(silent) +
				". " + integrationsCannotJudge
		} else {
			e.Health = integrationHealthOK
			e.HealthNote = integrationsCannotJudge
		}
	}
	return e, nil
}

// --- the platform connectors -------------------------------------------------

/*
platformIntegrations reads the three connectors whose credentials belong to the
vendor rather than to any school.

	Through AsPlatform, and reached only after listIntegrationsIndex has
	established both PlatformAdmin and platform.tenants.write. The RLS policies
	on crm_api_credentials, virtual_meeting_platform_providers and
	child_info_portal_connectors are app_is_platform_admin() with no tenant
	limb, so a handler that lost the caller check would still read nothing for
	an institution admin — the policy is the guarantee, this function is the
	readable statement of intent, and neither is trusted to be the only one.

	What is returned is a boolean and a count. No base URL, no account
	reference, no endpoint, no notes, no institution name. Whether a credential
	exists is what the screen needs; the credential is not, and neither is the
	shape of it.
*/
func (s *Server) platformIntegrations(r *http.Request) ([]integrationEntry, error) {
	out := []integrationEntry{}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// --- Meritto / LeadSquared -------------------------------------
		crm := integrationEntry{
			Key: "crm", Label: "Meritto / LeadSquared", Group: "Admissions", Scope: "platform",
			FixKey:   "super_admin.payments_devices.meritto_leadsquared_sync",
			FixLabel: "CRM sync",
		}
		var crmKeys int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM crm_api_credentials
			  WHERE credentials IS NOT NULL AND length(credentials) > 0`).Scan(&crmKeys); err != nil {
			return err
		}
		crm.Configured = crmKeys > 0
		crm.Enabled = crmKeys > 0
		if !crm.Configured {
			crm.Reason = "no CRM API key is recorded on this installation"
		}
		crmLive := false
		crm.LiveAvailable = &crmLive
		crm.LiveNote = crmLiveNote

		var crmOK *time.Time
		var crmFailAt *time.Time
		var crmFailDetail *string
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT max(finished_at) FROM crm_sync_runs WHERE status = 'ok'),
			       (SELECT started_at FROM crm_sync_runs
			         WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1),
			       (SELECT detail     FROM crm_sync_runs
			         WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1)`).
			Scan(&crmOK, &crmFailAt, &crmFailDetail); err != nil {
			return err
		}
		crm.LastOKLabel = "last completed sync run"
		if crmOK != nil {
			v := crmOK.Format(time.RFC3339)
			crm.LastOKAt = &v
		}
		if crmFailAt != nil {
			v := crmFailAt.Format(time.RFC3339)
			crm.LastErrorAt = &v
			crm.LastError = crmFailDetail
		}
		/* No staleness clock: live_sync_available is false, so nothing polls
		   and a run only happens when somebody presses the button. A school is
		   not late for a sync that is not scheduled. */
		switch {
		case !crm.Configured:
			crm.Health = integrationHealthNotSetUp
		case crmFailAt != nil && (crmOK == nil || crmFailAt.After(*crmOK)):
			crm.Health = integrationHealthFailing
		case crmOK == nil:
			crm.Health = integrationHealthIdle
			crm.HealthNote = "a key is recorded, but no sync run has completed"
		default:
			crm.Health = integrationHealthOK
		}
		out = append(out, crm)

		// --- Zoom / Meet / Teams ---------------------------------------
		meet := integrationEntry{
			Key: "meetings", Label: "Zoom / Meet / Teams", Group: "Teaching", Scope: "platform",
			FixKey:   "super_admin.payments_devices.virtual_classroom_integration",
			FixLabel: "Virtual classroom",
		}
		var meetAccounts int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM virtual_meeting_platform_providers
			 WHERE is_enabled AND credentials IS NOT NULL AND length(credentials) > 0`).
			Scan(&meetAccounts); err != nil {
			return err
		}
		meet.Configured = meetAccounts > 0
		meet.Enabled = meetAccounts > 0
		if !meet.Configured {
			meet.Reason = "no meeting provider account with a credential is switched on"
		}
		meetLive := false
		meet.LiveAvailable = &meetLive
		meet.LiveNote = meetingLiveNote

		var meetOK, meetFailAt *time.Time
		var meetDetail *string
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT max(resolved_at) FROM virtual_meeting_requests WHERE status = 'created'),
			       (SELECT requested_at FROM virtual_meeting_requests
			         WHERE status = 'failed' ORDER BY requested_at DESC LIMIT 1),
			       (SELECT detail       FROM virtual_meeting_requests
			         WHERE status = 'failed' ORDER BY requested_at DESC LIMIT 1)`).
			Scan(&meetOK, &meetFailAt, &meetDetail); err != nil {
			return err
		}
		meet.LastOKLabel = "last meeting created automatically"
		if meetOK != nil {
			v := meetOK.Format(time.RFC3339)
			meet.LastOKAt = &v
		}
		if meetFailAt != nil {
			v := meetFailAt.Format(time.RFC3339)
			meet.LastErrorAt = &v
			meet.LastError = meetDetail
		}
		switch {
		case !meet.Configured:
			meet.Health = integrationHealthNotSetUp
		case meetFailAt != nil && (meetOK == nil || meetFailAt.After(*meetOK)):
			meet.Health = integrationHealthFailing
		case meetOK == nil:
			meet.Health = integrationHealthIdle
			meet.HealthNote = "an account is recorded, but no meeting has been created automatically"
		default:
			meet.Health = integrationHealthOK
		}
		out = append(out, meet)

		// --- Child Info state portals ----------------------------------
		//
		// One row per state connector, because they genuinely are separate
		// far ends with separate credentials and separate deadlines. Ready
		// and Blocker come straight from childInfoProviderFor(...).Ready(),
		// the same call listChildInfoConnectors makes.
		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, c.state_code, c.name, c.provider, c.endpoint_url,
			       (c.credentials IS NOT NULL AND length(c.credentials) > 0),
			       c.is_enabled, c.last_sync_at, c.last_status, c.last_error
			  FROM child_info_portal_connectors c
			 ORDER BY c.state_code, c.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row childInfoConnectorRow
			var lastSync *time.Time
			if err := rows.Scan(&row.ID, &row.StateCode, &row.Name, &row.Provider,
				&row.EndpointURL, &row.HasSecret, &row.IsEnabled,
				&lastSync, &row.LastStatus, &row.LastError); err != nil {
				return err
			}
			row.Ready, row.Blocker = childInfoProviderFor(row.Provider).Ready(row)

			e := integrationEntry{
				Key:   "child_info." + row.ID,
				Label: "Child Info — " + row.StateCode + " · " + row.Name,
				Group: "Statutory", Scope: "platform",
				Provider:   row.Provider,
				Enabled:    row.IsEnabled,
				Configured: row.Ready,
				// Verbatim. The API provider's blocker is three sentences long
				// and tells the operator to use the file exchange instead;
				// shortening it would remove the instruction.
				Reason:      row.Blocker,
				LastError:   row.LastError,
				LastOKLabel: "last portal sync",
				FixKey:      "super_admin.statutory_boards.child_info_portal_sync",
				FixLabel:    "Child Info portal sync",
			}
			if lastSync != nil {
				v := lastSync.Format(time.RFC3339)
				if row.LastStatus != nil && *row.LastStatus == "failed" {
					e.LastErrorAt = &v
				} else {
					e.LastOKAt = &v
				}
			}
			switch {
			case row.LastStatus != nil && *row.LastStatus == "failed":
				e.Health = integrationHealthFailing
			case !row.Ready:
				e.Health = integrationHealthNotSetUp
			case lastSync == nil:
				e.Health = integrationHealthIdle
				e.HealthNote = "ready, but no sync has been recorded"
			default:
				e.Health = integrationHealthOK
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}

// humanIntegrationDays renders a silence the way an administrator would say it.
// Rounded down and never to the hour: this screen is about fortnights, and
// "13 days" reads as a fact where "13.4 days" reads as instrumentation.
func humanIntegrationDays(days int) string {
	switch {
	case days <= 1:
		return "a day"
	case days < 14:
		return strconv.Itoa(days) + " days"
	case days < 60:
		return strconv.Itoa(days/7) + " weeks"
	default:
		return strconv.Itoa(days/30) + " months"
	}
}
