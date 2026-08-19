package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/connectors"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Two platform connectors whose far end does not exist here.

	The Meritto / LeadSquared sync and the virtual classroom integration are
	built the way the Tally bridge was built, because they are the same problem:
	an integration a school genuinely wants, against a system this deployment
	holds no credential for. internal/tally established the answer and
	internal/connectors follows it — a provider interface with one honest
	implementation and live implementations that refuse by name, with tests
	pinning the refusal so a later edit cannot turn it into a fabricated
	success.

	Three rules, all of them the same rule.

	The screen is told what is possible, it does not decide. Every response
	below carries live_sync_available or live_create_available off the server.
	A UI that hardcoded "connected" would be promising something the product
	cannot do, and it would go on promising it after somebody changed the
	backend.

	Credentials are the vendor's, not the school's. crm_api_credentials and
	virtual_meeting_platform_providers both carry an RLS policy of
	app_is_platform_admin() with no tenant limb, so an institution admin cannot
	read them even for their own school. The handlers add
	RequirePermission(PlatformTenantsRW) and platformOnly on top: the policy is
	the guarantee, the middleware is the readable statement of intent, and
	neither is trusted to be the only one. No sealed secret is ever returned —
	a screen needs to know whether one is set, which is a boolean.

	Syncing twice must not create two leads. That is not a matter of care at
	the call site: it is crm_lead_links keyed on a stable external id, two
	UNIQUE indexes, and connectors.DecideImport reaching "skip" before anything
	is written. A school with duplicate leads has two counsellors ringing the
	same parent, which is worse than having no integration.

	What is NOT here, deliberately: a second live-class model. Sessions are
	virtual_class_sessions (00041), the teacher's screen is the existing
	launcher, and the manually pasted join URL keeps working exactly as it did.
	This adds the platform half — which provider, whose account, which schools,
	and the seam a real "create meeting" call would slot into.
*/

// --- mounting ----------------------------------------------------------------

/*
mountConnectors registers both connectors under /admin.

	One mount function, not two: both features are platform scope
	(super_admin.payments_devices.*), so they belong under the same prefix with
	the same gate. mountTally/mountTallyConnector had to split only because its
	two halves live under /finance and /admin respectively; nothing here does.

	SPLICE POINT: internal/api/api.go, inside r.Route("/admin", ...), beside
	s.mountTallyConnector(r).

	/admin carries no group-level permission, so every route names its own. The
	gate is platform.tenants.write throughout: institution_admin holds every
	other key in this product and deliberately not this one (rbac.keysExcept),
	which is what keeps a school out of the CRM keys and the meeting account.
*/
func (s *Server) mountConnectors(r chi.Router) {
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)

	// --- Meritto / LeadSquared ---
	r.With(vendor).Get("/connectors/crm", s.getCRMConnector)
	r.With(vendor).Put("/connectors/crm", s.saveCRMConnector)
	r.With(vendor).Put("/connectors/crm/mappings", s.saveCRMMappings)

	// What a push would send, decided by the same rules the push uses. A read:
	// it writes no run, so the screen may call it freely.
	r.With(vendor).Get("/connectors/crm/queue", s.listCRMQueue)

	// POST because it records a run. A download that mutates must never be a
	// GET — a link prefetch would file a phantom sync.
	r.With(vendor).Post("/connectors/crm/export", s.exportCRMLeads)
	// The file itself, by run, as an idempotent GET: a lost file can be
	// fetched again without recording a second export of the same leads.
	r.With(vendor).Get("/connectors/crm/runs/{id}/file", s.downloadCRMExport)
	r.With(vendor).Post("/connectors/crm/import", s.importCRMLeads)

	r.With(vendor).Get("/connectors/crm/runs", s.listCRMRuns)
	r.With(vendor).Get("/connectors/crm/runs/{id}/items", s.listCRMRunItems)
	r.With(vendor).Get("/connectors/crm/conflicts", s.listCRMConflicts)
	r.With(vendor).Post("/connectors/crm/conflicts/{id}/resolve", s.resolveCRMConflict)

	/* The API keys. Platform admin only, and doubly so: the RLS policy on
	   crm_api_credentials is app_is_platform_admin() with no tenant escape, so
	   even a handler that forgot this middleware would read nothing for an
	   institution admin. */
	r.With(vendor).Get("/connectors/crm/credentials", s.getCRMCredentials)
	r.With(vendor).Put("/connectors/crm/credentials", s.saveCRMCredentials)

	// --- virtual classroom ---
	r.With(vendor).Get("/connectors/meetings", s.getMeetingConnector)
	r.With(vendor).Put("/connectors/meetings/providers", s.saveMeetingProvider)
	r.With(vendor).Delete("/connectors/meetings/providers/{id}", s.deleteMeetingProvider)
	r.With(vendor).Get("/connectors/meetings/requests", s.listMeetingRequests)
	r.With(vendor).Post("/connectors/meetings/sessions/{id}/meeting", s.requestMeeting)
}

// --- shared plumbing ---------------------------------------------------------

/*
connectorInstitution is the school being configured.

	A platform operator holds no institution of their own; the one they are
	working on travels with the request as X-Acting-Institution and arrives on
	the identity (see acting.go). Everything that touches a school's leads or
	sessions needs it, and a handler that silently defaulted to "all schools"
	would export one trust's enquiries into another's CRM.

	Credentials are the exception and take the nil uuid on purpose: NULL there
	means the installation-wide default, which is the normal arrangement for a
	group with one CRM licence.
*/
func connectorInstitution(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure first")
		return uuid.Nil, false
	}
	return id.InstitutionID, true
}

// crmTransportRow describes one route to a CRM. The screen must not hardcode
// these: whether a live sync exists is a fact about the server.
type crmTransportRow struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	LiveSync bool   `json:"live_sync"`
}

func crmTransports() []crmTransportRow {
	out := []crmTransportRow{}
	for _, p := range connectors.CRMProviders() {
		out = append(out, crmTransportRow{Key: p.Key(), Label: p.Label(), LiveSync: p.LiveSync()})
	}
	return out
}

// crmSettingsRow is the connector configuration as the screen reads it.
type crmSettingsRow struct {
	Provider       string  `json:"provider"`
	Direction      string  `json:"direction"`
	ConflictPolicy string  `json:"conflict_policy"`
	Transport      string  `json:"transport"`
	Enabled        bool    `json:"is_enabled"`
	LastSyncedAt   *string `json:"last_synced_at,omitempty"`
	UpdatedAt      *string `json:"updated_at,omitempty"`
}

// crmFieldRow is one field of ours, its label, and the CRM field it maps to.
type crmFieldRow struct {
	LocalField string `json:"local_field"`
	Label      string `json:"label"`
	CRMField   string `json:"crm_field"`
	Direction  string `json:"direction"`
	Required   bool   `json:"is_required"`
	// Mapped is false for a field nobody has mapped yet. Kept explicit rather
	// than inferred from an empty crm_field, so the screen never has to guess.
	Mapped bool `json:"mapped"`
}

const crmLiveNote = "No CRM API key is configured on this installation, and no request " +
	"is made to Meritto or LeadSquared. The CSV route is the working one: export " +
	"here, import in the CRM's own bulk upload, and bring the file back the same way."

/*
getCRMConnector is everything the CRM screen needs to draw itself.

	Every field is returned, mapped or not, because an unmapped field must stay
	visibly unmapped: nothing is defaulted from the field name, for the reason
	tally_ledger_mappings gives — a plausible auto-mapping writes the wrong data
	into a real CRM and nobody notices until a counsellor rings the wrong
	number.
*/
func (s *Server) getCRMConnector(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}

	set := crmSettingsRow{Direction: "push", ConflictPolicy: "flag", Transport: "csv"}
	mapped := map[string]crmFieldRow{}
	var linked, conflicts, leads int

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var provider *string
		var lastSynced, updated *time.Time
		err := tx.QueryRow(r.Context(), `
			SELECT provider, direction, conflict_policy, transport, is_enabled,
			       last_synced_at, updated_at
			  FROM crm_connector_settings WHERE institution_id = $1`, inst).
			Scan(&provider, &set.Direction, &set.ConflictPolicy, &set.Transport,
				&set.Enabled, &lastSynced, &updated)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		set.Provider = strFromPtr(provider)
		set.LastSyncedAt = nullTime(lastSynced)
		set.UpdatedAt = nullTime(updated)

		rows, err := tx.Query(r.Context(), `
			SELECT local_field, crm_field, direction, is_required
			  FROM crm_field_mappings WHERE institution_id = $1`, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var f crmFieldRow
			if err := rows.Scan(&f.LocalField, &f.CRMField, &f.Direction, &f.Required); err != nil {
				return err
			}
			f.Mapped = true
			mapped[f.LocalField] = f
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE conflict_at IS NULL),
			       count(*) FILTER (WHERE conflict_at IS NOT NULL)
			  FROM crm_lead_links WHERE institution_id = $1`, inst).
			Scan(&linked, &conflicts); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT count(*) FROM enquiries WHERE institution_id = $1`, inst).Scan(&leads)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	fields := []crmFieldRow{}
	for _, f := range connectors.LeadFields {
		if m, ok := mapped[f]; ok {
			m.Label = connectors.LeadFieldLabels[f]
			fields = append(fields, m)
			continue
		}
		fields = append(fields, crmFieldRow{
			LocalField: f, Label: connectors.LeadFieldLabels[f], Direction: "both"})
	}

	systems := []map[string]string{}
	for k, name := range connectors.CRMSystems {
		systems = append(systems, map[string]string{"key": k, "name": name})
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"settings":            set,
		"fields":              fields,
		"systems":             systems,
		"transports":          crmTransports(),
		"mapped_fields":       len(mapped),
		"total_fields":        len(connectors.LeadFields),
		"linked_leads":        linked,
		"conflicts":           conflicts,
		"enquiries":           leads,
		"live_sync_available": false,
		"live_sync_note":      crmLiveNote,
	})
}

type saveCRMConnectorRequest struct {
	Provider       string `json:"provider"`
	Direction      string `json:"direction"`
	ConflictPolicy string `json:"conflict_policy"`
	Transport      string `json:"transport"`
	Enabled        bool   `json:"is_enabled"`
}

func (s *Server) saveCRMConnector(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req saveCRMConnectorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	req.Provider = strings.TrimSpace(req.Provider)
	if req.Provider != "" && !connectors.IsCRMSystem(req.Provider) {
		httpx.BadRequest(w, r, "the CRM must be Meritto or LeadSquared")
		return
	}
	if !oneOfStr(req.Direction, "push", "pull", "both") {
		httpx.BadRequest(w, r, "direction must be push, pull or both")
		return
	}
	if !oneOfStr(req.ConflictPolicy, "ours", "theirs", "newest", "flag") {
		httpx.BadRequest(w, r, "the conflict rule must be ours, theirs, newest or flag")
		return
	}
	if !oneOfStr(req.Transport, "csv", "api") {
		httpx.BadRequest(w, r, "transport must be csv or api")
		return
	}
	/* Enabling against a CRM nobody chose produces a file with no destination.
	   Refused here rather than at the first export, when the person has gone. */
	if req.Enabled && req.Provider == "" {
		httpx.BadRequest(w, r, "choose the CRM before switching the connector on")
		return
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO crm_connector_settings
			    (institution_id, provider, direction, conflict_policy, transport,
			     is_enabled, updated_by)
			VALUES ($1, nullif(btrim($2), ''), $3, $4, $5, $6, $7)
			ON CONFLICT (institution_id) DO UPDATE SET
			    provider        = EXCLUDED.provider,
			    direction       = EXCLUDED.direction,
			    conflict_policy = EXCLUDED.conflict_policy,
			    transport       = EXCLUDED.transport,
			    is_enabled      = EXCLUDED.is_enabled,
			    updated_at      = now(),
			    updated_by      = EXCLUDED.updated_by`,
			inst, req.Provider, req.Direction, req.ConflictPolicy, req.Transport,
			req.Enabled, id.UserID)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

type saveCRMMappingsRequest struct {
	Mappings []struct {
		LocalField string `json:"local_field"`
		CRMField   string `json:"crm_field"`
		Direction  string `json:"direction"`
		Required   bool   `json:"is_required"`
	} `json:"mappings"`
}

/*
saveCRMMappings replaces the whole mapping in one transaction.

	Replace rather than patch: the screen edits the table as a whole, and a
	per-row PUT would leave a half-saved mapping behind whenever a browser lost
	its connection mid-edit — which is exactly the state that produces a file
	the CRM half-accepts.
*/
func (s *Server) saveCRMMappings(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	var req saveCRMMappingsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	type row struct {
		local, crm, dir string
		required        bool
	}
	keep := []row{}
	seen := map[string]bool{}
	for _, m := range req.Mappings {
		local := strings.TrimSpace(m.LocalField)
		crm := strings.TrimSpace(m.CRMField)
		if crm == "" {
			// An emptied CRM name is how the screen unmaps a field.
			continue
		}
		if !connectors.IsLeadField(local) {
			httpx.BadRequest(w, r, fmt.Sprintf("%q is not a lead field this connector can read", local))
			return
		}
		if seen[local] {
			httpx.BadRequest(w, r, fmt.Sprintf(
				"%s is mapped twice; one field maps to one CRM field",
				connectors.LeadFieldLabels[local]))
			return
		}
		dir := m.Direction
		if dir == "" {
			dir = "both"
		}
		if !oneOfStr(dir, "push", "pull", "both") {
			httpx.BadRequest(w, r, "a mapping's direction must be push, pull or both")
			return
		}
		seen[local] = true
		keep = append(keep, row{local, crm, dir, m.Required})
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM crm_field_mappings WHERE institution_id = $1`, inst); err != nil {
			return err
		}
		for _, m := range keep {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO crm_field_mappings
				    (institution_id, local_field, crm_field, direction, is_required)
				VALUES ($1, $2, $3, $4, $5)`,
				inst, m.local, m.crm, m.dir, m.required); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "mapped": len(keep)})
}

// --- reading the leads -------------------------------------------------------

// loadCRMMappings reads the field mapping for one school.
func loadCRMMappings(ctx context.Context, tx pgx.Tx, inst uuid.UUID) ([]connectors.Mapping, error) {
	rows, err := tx.Query(ctx, `
		SELECT local_field, crm_field, direction, is_required
		  FROM crm_field_mappings WHERE institution_id = $1`, inst)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []connectors.Mapping{}
	for rows.Next() {
		var m connectors.Mapping
		if err := rows.Scan(&m.LocalField, &m.CRMField, &m.Direction, &m.Required); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

/*
loadCRMLeads reads the enquiry book as leads, with whatever link each one
already has.

	One query rather than a join per field, and every value comes back as text
	because that is what a CSV cell and a CRM custom field both are. The LEFT
	JOIN on crm_lead_links is what makes the second run a no-op: a lead that has
	been out before arrives here carrying its external id.
*/
func loadCRMLeads(ctx context.Context, tx pgx.Tx, inst uuid.UUID, provider string, limit int,
) ([]connectors.Lead, map[string]*connectors.Link, error) {
	rows, err := tx.Query(ctx, `
		SELECT e.id::text,
		       COALESCE(k.external_id, ''),
		       e.updated_at,
		       e.student_name,
		       COALESCE(e.parent_name, ''),
		       e.phone,
		       COALESCE(e.email::text, ''),
		       COALESCE(c.name, ''),
		       e.source,
		       COALESCE(e.campaign, ''),
		       e.status,
		       COALESCE(u.full_name, ''),
		       COALESCE(to_char(e.next_follow_up, 'YYYY-MM-DD'), ''),
		       COALESCE(e.notes, ''),
		       COALESCE(e.utm_source, ''),
		       COALESCE(e.utm_medium, ''),
		       COALESCE(e.utm_campaign, ''),
		       COALESCE(e.referred_by, ''),
		       to_char(e.created_at, 'YYYY-MM-DD'),
		       k.last_pushed_at, k.local_updated_at
		  FROM enquiries e
		  LEFT JOIN classes c ON c.id = e.class_sought AND c.institution_id = e.institution_id
		  LEFT JOIN users   u ON u.id = e.assigned_to
		  LEFT JOIN crm_lead_links k
		         ON k.enquiry_id = e.id AND k.institution_id = e.institution_id
		        AND k.provider = $2
		 WHERE e.institution_id = $1
		 ORDER BY e.created_at DESC
		 LIMIT $3`, inst, provider, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	leads := []connectors.Lead{}
	links := map[string]*connectors.Link{}
	for rows.Next() {
		var l connectors.Lead
		var name, parent, phone, email, class, source, campaign, status,
			counsellor, followUp, notes, us, um, uc, ref, created string
		var pushed, localUpdated *time.Time
		if err := rows.Scan(&l.EnquiryID, &l.ExternalID, &l.UpdatedAt,
			&name, &parent, &phone, &email, &class, &source, &campaign, &status,
			&counsellor, &followUp, &notes, &us, &um, &uc, &ref, &created,
			&pushed, &localUpdated); err != nil {
			return nil, nil, err
		}
		l.Values = map[string]string{
			"student_name": name, "parent_name": parent, "phone": phone,
			"email": email, "class_sought": class, "source": source,
			"campaign": campaign, "status": status, "assigned_to": counsellor,
			"next_follow_up": followUp, "notes": notes, "utm_source": us,
			"utm_medium": um, "utm_campaign": uc, "referred_by": ref,
			"created_at": created,
		}
		if l.ExternalID != "" {
			links[l.EnquiryID] = &connectors.Link{
				EnquiryID: l.EnquiryID, LastSynced: pushed, LocalUpdated: localUpdated}
		}
		leads = append(leads, l)
	}
	return leads, links, rows.Err()
}

// crmQueueRow is one lead and what a push would do with it.
type crmQueueRow struct {
	EnquiryID  string `json:"enquiry_id"`
	ExternalID string `json:"external_id,omitempty"`
	Name       string `json:"student_name"`
	Phone      string `json:"phone"`
	Status     string `json:"status"`
	Action     string `json:"action"`
	Why        string `json:"why,omitempty"`
}

/*
listCRMQueue is what a push would send, decided by the rules the push uses.

	The point of the screen is the "skipped" count. A school looking at a
	connector wants to know it will not duplicate their leads, and the honest
	way to show that is to run the same decision the export runs and display the
	answer before anything moves.
*/
func (s *Server) listCRMQueue(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}

	out := []crmQueueRow{}
	counts := map[string]int{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		provider, _, _, _, err := crmSettings(r, tx, inst)
		if err != nil {
			return err
		}
		leads, links, err := loadCRMLeads(r.Context(), tx, inst, provider, 500)
		if err != nil {
			return err
		}
		for _, l := range leads {
			action, why := connectors.DecidePush(l, links[l.EnquiryID])
			counts[string(action)]++
			out = append(out, crmQueueRow{
				EnquiryID: l.EnquiryID, ExternalID: l.ExternalID,
				Name:   l.Values["student_name"],
				Phone:  l.Values["phone"],
				Status: l.Values["status"],
				Action: string(action), Why: why,
			})
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out, "counts": counts})
}

// crmSettings reads the configuration a run needs, refusing rather than
// guessing when the school has not chosen a CRM.
func crmSettings(r *http.Request, tx pgx.Tx, inst uuid.UUID) (
	provider, direction, policy, transport string, err error) {
	var p *string
	err = tx.QueryRow(r.Context(), `
		SELECT provider, direction, conflict_policy, transport
		  FROM crm_connector_settings WHERE institution_id = $1`, inst).
		Scan(&p, &direction, &policy, &transport)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "push", "flag", "csv", refusef(
			"this school has no CRM connector configured yet")
	}
	if err != nil {
		return "", "", "", "", err
	}
	if p == nil || *p == "" {
		return "", direction, policy, transport, refusef(
			"choose the CRM (Meritto or LeadSquared) before syncing")
	}
	return *p, direction, policy, transport, nil
}

/*
exportCRMLeads records a run and stages the file.

	The run is written before the file is fetched, and the link rows are written
	with it. That order is the idempotency: a school that exports twice in a
	panic gets the second run reporting every lead as "skipped", because the
	first run already claimed them.

	Nothing is sent anywhere. The provider seam decides that, and the only
	provider that returns a receipt is the CSV one.
*/
func (s *Server) exportCRMLeads(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var runID uuid.UUID
	counts := map[string]int{}
	var considered int

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		provider, _, _, transport, err := crmSettings(r, tx, inst)
		if err != nil {
			return err
		}
		ms, err := loadCRMMappings(r.Context(), tx, inst)
		if err != nil {
			return err
		}
		if len(connectors.ForDirection(ms, "push")) == 0 {
			return refusef("no field is mapped for pushing; map at least the child's name and phone")
		}
		leads, links, err := loadCRMLeads(r.Context(), tx, inst, provider, 5000)
		if err != nil {
			return err
		}

		send := []connectors.Lead{}
		type outcome struct {
			lead   connectors.Lead
			action connectors.Action
			why    string
		}
		outcomes := []outcome{}
		for _, l := range leads {
			action, why := connectors.DecidePush(l, links[l.EnquiryID])
			outcomes = append(outcomes, outcome{l, action, why})
			counts[string(action)]++
			if action != connectors.ActionSkip {
				send = append(send, l)
			}
		}
		considered = len(leads)

		/* Rendered through the provider rather than by calling RenderLeadCSV
		   here. The interface is the seam a real API push would slot into, and
		   a handler that bypassed it would be the reason that never happened. */
		if _, err := connectors.CRMProviderFor(transport, provider).Push(connectors.Batch{
			Provider: provider, Mappings: ms, Leads: send}); err != nil {
			return refusef("%s", err.Error())
		}

		status := "ok"
		if counts[string(connectors.ActionFail)] > 0 {
			status = "partial"
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO crm_sync_runs
			    (institution_id, provider, direction, transport, status, considered,
			     created_count, updated_count, skipped_count, failed_count,
			     detail, finished_at, run_by)
			VALUES ($1,$2,'push',$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)
			RETURNING id`,
			inst, provider, transport, status, considered,
			counts[string(connectors.ActionCreate)],
			counts[string(connectors.ActionUpdate)],
			counts[string(connectors.ActionSkip)],
			counts[string(connectors.ActionFail)],
			"Exported as CSV for the CRM's bulk import. Nothing was sent over the network.",
			id.UserID).Scan(&runID); err != nil {
			return err
		}

		for _, o := range outcomes {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO crm_sync_run_items
				    (institution_id, run_id, enquiry_id, external_id, action, message)
				VALUES ($1,$2,$3, nullif($4,''), $5, nullif($6,''))`,
				inst, runID, o.lead.EnquiryID, o.lead.ExternalID,
				string(o.action), o.why); err != nil {
				return err
			}
			/* The claim. A lead that has gone out is marked as having gone out,
			   against its external id where it has one — which is what makes
			   the next run skip it rather than send it again.

			   A lead with no external id yet gets no link: the CRM has not told
			   us its id, and inventing one here would break the match when the
			   file comes back with the real one. */
			if o.action != connectors.ActionSkip && o.lead.ExternalID != "" {
				if _, err := tx.Exec(r.Context(), `
					UPDATE crm_lead_links
					   SET last_pushed_at = now(), local_updated_at = $4
					 WHERE institution_id = $1 AND provider = $2 AND enquiry_id = $3`,
					inst, provider, o.lead.EnquiryID, o.lead.UpdatedAt); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"run_id":       runID.String(),
		"considered":   considered,
		"counts":       counts,
		"download_url": "/api/v1/admin/connectors/crm/runs/" + runID.String() + "/file",
		"note": "Upload this file in the CRM's bulk import screen. Keep the " +
			connectors.ExternalIDColumn + " column: it is what stops the next " +
			"import creating a second lead for the same child.",
	})
}

// downloadCRMExport re-renders the file for a recorded run.
func (s *Server) downloadCRMExport(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid run id")
		return
	}

	var body []byte
	var filename string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var provider, transport string
		var startedAt time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT provider, transport, started_at FROM crm_sync_runs
			 WHERE id = $1 AND institution_id = $2`, runID, inst).
			Scan(&provider, &transport, &startedAt); err != nil {
			return err
		}
		ms, err := loadCRMMappings(r.Context(), tx, inst)
		if err != nil {
			return err
		}

		// Exactly the rows the run acted on, not "the leads as they are now".
		// A file that changes between the export and the download is a file
		// whose run record is a lie.
		rows, err := tx.Query(r.Context(), `
			SELECT i.enquiry_id::text FROM crm_sync_run_items i
			 WHERE i.run_id = $1 AND i.institution_id = $2
			   AND i.action <> 'skipped' AND i.enquiry_id IS NOT NULL`, runID, inst)
		if err != nil {
			return err
		}
		wanted := map[string]bool{}
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				rows.Close()
				return err
			}
			wanted[s] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		all, _, err := loadCRMLeads(r.Context(), tx, inst, provider, 5000)
		if err != nil {
			return err
		}
		send := []connectors.Lead{}
		for _, l := range all {
			if wanted[l.EnquiryID] {
				send = append(send, l)
			}
		}

		receipt, err := connectors.CSVProvider{}.Push(connectors.Batch{
			Provider: provider, Mappings: ms, Leads: send})
		if err != nil {
			return refusef("%s", err.Error())
		}
		body = receipt.Body
		filename = fmt.Sprintf("%s-leads-%s.csv", provider, startedAt.Format(time.DateOnly))
		return nil
	})
	if err != nil {
		// Bail before a header is written: once the attachment headers are out,
		// the only thing left to send is a corrupt file.
		ledgerFail(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	_, _ = w.Write(body)
}

type importCRMRequest struct {
	// The file's contents. Sent as a JSON string rather than multipart because
	// a CRM lead export is a few hundred kilobytes and every other endpoint in
	// this product speaks JSON.
	CSV string `json:"csv"`
}

/*
importCRMLeads applies a file the CRM produced.

	The upsert keys on external_id and is idempotent by construction: the same
	file applied twice reports every row as "skipped" the second time, because
	crm_lead_links already carries the id and DecideImport reaches skip before
	anything is written.

	Nothing creates an enquiry. A pulled row that matches nothing here is
	recorded as failed with the reason, and left for a human — because a CRM
	export contains leads for other campuses, other years and other products,
	and a connector that created a child record for each of them would fill the
	admissions book with strangers.
*/
func (s *Server) importCRMLeads(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req importCRMRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.CSV) == "" {
		httpx.BadRequest(w, r, "upload the file the CRM exported")
		return
	}

	var runID uuid.UUID
	counts := map[string]int{}
	var considered int

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		provider, _, policy, transport, err := crmSettings(r, tx, inst)
		if err != nil {
			return err
		}
		ms, err := loadCRMMappings(r.Context(), tx, inst)
		if err != nil {
			return err
		}
		rows, err := connectors.CRMProviderFor(transport, provider).Pull(connectors.PullRequest{
			Provider: provider, Mappings: ms, File: []byte(req.CSV)})
		if err != nil {
			return refusef("%s", err.Error())
		}
		considered = len(rows)

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO crm_sync_runs
			    (institution_id, provider, direction, transport, considered, run_by)
			VALUES ($1,$2,'pull',$3,$4,$5) RETURNING id`,
			inst, provider, transport, considered, id.UserID).Scan(&runID); err != nil {
			return err
		}

		for _, row := range rows {
			// What we already know about this external id, if anything.
			var link *connectors.Link
			var linkID uuid.UUID
			var enquiryID string
			var lastPulled, localUpdated *time.Time
			err := tx.QueryRow(r.Context(), `
				SELECT id, enquiry_id::text, last_pulled_at, local_updated_at
				  FROM crm_lead_links
				 WHERE institution_id = $1 AND provider = $2 AND external_id = $3`,
				inst, provider, row.ExternalID).
				Scan(&linkID, &enquiryID, &lastPulled, &localUpdated)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
			case err != nil:
				return err
			default:
				link = &connectors.Link{EnquiryID: enquiryID,
					LastSynced: lastPulled, LocalUpdated: localUpdated}
			}

			action, why := connectors.DecideImport(row, link, policy)

			// A create needs an enquiry of ours to attach to. The file carries
			// one when it came from our own export; anything else is a lead
			// this school does not have and must not have invented.
			if action == connectors.ActionCreate {
				match := row.EnquiryID
				if match == "" {
					action, why = connectors.ActionFail,
						fmt.Sprintf("row %d matches no enquiry here: it has no %s and is not linked",
							row.Line, connectors.EnquiryIDColumn)
				} else {
					var exists bool
					if err := tx.QueryRow(r.Context(),
						`SELECT true FROM enquiries WHERE id = $1::uuid AND institution_id = $2`,
						match, inst).Scan(&exists); err != nil {
						if !errors.Is(err, pgx.ErrNoRows) {
							// A malformed uuid in a spreadsheet cell is a row
							// problem, not a run problem.
							action, why = connectors.ActionFail,
								fmt.Sprintf("row %d: %s is not an enquiry in this school",
									row.Line, connectors.EnquiryIDColumn)
						} else {
							action, why = connectors.ActionFail,
								fmt.Sprintf("row %d: no enquiry here with that id", row.Line)
						}
					} else {
						if _, err := tx.Exec(r.Context(), `
							INSERT INTO crm_lead_links
							    (institution_id, provider, enquiry_id, external_id,
							     external_status, remote_updated_at, last_pulled_at)
							VALUES ($1,$2,$3::uuid,$4, nullif($5,''), $6, now())
							ON CONFLICT (institution_id, provider, external_id)
							DO UPDATE SET last_pulled_at = now()`,
							inst, provider, match, row.ExternalID,
							row.Values["status"], row.RemoteUpdated); err != nil {
							return err
						}
					}
				}
			}

			if action == connectors.ActionUpdate {
				if _, err := tx.Exec(r.Context(), `
					UPDATE crm_lead_links
					   SET external_status   = nullif($4,''),
					       remote_updated_at = $5,
					       last_pulled_at    = now(),
					       conflict_at       = NULL,
					       conflict_note     = NULL
					 WHERE institution_id = $1 AND provider = $2 AND external_id = $3`,
					inst, provider, row.ExternalID, row.Values["status"],
					row.RemoteUpdated); err != nil {
					return err
				}
			}

			if action == connectors.ActionConflict {
				if _, err := tx.Exec(r.Context(), `
					UPDATE crm_lead_links
					   SET conflict_at = now(), conflict_note = $4,
					       external_status = nullif($5,''),
					       remote_updated_at = $6
					 WHERE institution_id = $1 AND provider = $2 AND external_id = $3`,
					inst, provider, row.ExternalID, why,
					row.Values["status"], row.RemoteUpdated); err != nil {
					return err
				}
			}

			counts[string(action)]++
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO crm_sync_run_items
				    (institution_id, run_id, enquiry_id, external_id, action, message)
				VALUES ($1,$2, nullif($3,'')::uuid, $4, $5, nullif($6,''))`,
				inst, runID, linkEnquiry(link, row), row.ExternalID,
				string(action), why); err != nil {
				return err
			}
		}

		status := "ok"
		if counts[string(connectors.ActionFail)] > 0 || counts[string(connectors.ActionConflict)] > 0 {
			status = "partial"
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE crm_sync_runs
			   SET status = $3, created_count = $4, updated_count = $5,
			       skipped_count = $6, conflict_count = $7, failed_count = $8,
			       finished_at = now()
			 WHERE id = $1 AND institution_id = $2`,
			runID, inst, status,
			counts[string(connectors.ActionCreate)],
			counts[string(connectors.ActionUpdate)],
			counts[string(connectors.ActionSkip)],
			counts[string(connectors.ActionConflict)],
			counts[string(connectors.ActionFail)]); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE crm_connector_settings SET last_synced_at = now() WHERE institution_id = $1`,
			inst)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"run_id": runID.String(), "considered": considered, "counts": counts,
	})
}

// linkEnquiry is the enquiry a run item belongs to: the linked one, or the one
// the file named.
func linkEnquiry(link *connectors.Link, row connectors.ImportRow) string {
	if link != nil {
		return link.EnquiryID
	}
	return row.EnquiryID
}

// crmRunRow is one sync that happened.
type crmRunRow struct {
	ID         string  `json:"id"`
	Provider   string  `json:"provider"`
	Direction  string  `json:"direction"`
	Transport  string  `json:"transport"`
	Status     string  `json:"status"`
	Considered int     `json:"considered"`
	Created    int     `json:"created_count"`
	Updated    int     `json:"updated_count"`
	Skipped    int     `json:"skipped_count"`
	Conflicts  int     `json:"conflict_count"`
	Failed     int     `json:"failed_count"`
	Detail     *string `json:"detail,omitempty"`
	StartedAt  string  `json:"started_at"`
}

func (s *Server) listCRMRuns(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	items := []crmRunRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, provider, direction, transport, status, considered,
			       created_count, updated_count, skipped_count, conflict_count,
			       failed_count, detail, started_at
			  FROM crm_sync_runs WHERE institution_id = $1
			 ORDER BY started_at DESC LIMIT 100`, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v crmRunRow
			var started time.Time
			if err := rows.Scan(&v.ID, &v.Provider, &v.Direction, &v.Transport,
				&v.Status, &v.Considered, &v.Created, &v.Updated, &v.Skipped,
				&v.Conflicts, &v.Failed, &v.Detail, &started); err != nil {
				return err
			}
			v.StartedAt = started.Format(time.RFC3339)
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

// crmRunItemRow is one record within one run.
type crmRunItemRow struct {
	Action     string  `json:"action"`
	ExternalID *string `json:"external_id,omitempty"`
	EnquiryID  *string `json:"enquiry_id,omitempty"`
	Name       *string `json:"student_name,omitempty"`
	Message    *string `json:"message,omitempty"`
}

func (s *Server) listCRMRunItems(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid run id")
		return
	}
	items := []crmRunItemRow{}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.action, i.external_id, i.enquiry_id::text, e.student_name, i.message
			  FROM crm_sync_run_items i
			  LEFT JOIN enquiries e
			         ON e.id = i.enquiry_id AND e.institution_id = i.institution_id
			 WHERE i.run_id = $1 AND i.institution_id = $2
			 ORDER BY i.action, e.student_name NULLS LAST
			 LIMIT 1000`, runID, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v crmRunItemRow
			if err := rows.Scan(&v.Action, &v.ExternalID, &v.EnquiryID,
				&v.Name, &v.Message); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

// crmConflictRow is one lead that moved on both sides.
type crmConflictRow struct {
	ID             string  `json:"id"`
	EnquiryID      string  `json:"enquiry_id"`
	ExternalID     string  `json:"external_id"`
	Name           string  `json:"student_name"`
	Phone          string  `json:"phone"`
	OurStatus      string  `json:"our_status"`
	TheirStatus    *string `json:"their_status,omitempty"`
	ConflictAt     string  `json:"conflict_at"`
	ConflictNote   *string `json:"conflict_note,omitempty"`
	RemoteUpdated  *string `json:"remote_updated_at,omitempty"`
	LocalUpdatedAt *string `json:"local_updated_at,omitempty"`
}

func (s *Server) listCRMConflicts(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	items := []crmConflictRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT k.id::text, k.enquiry_id::text, k.external_id, e.student_name,
			       e.phone, e.status, k.external_status, k.conflict_at,
			       k.conflict_note, k.remote_updated_at, k.local_updated_at
			  FROM crm_lead_links k
			  JOIN enquiries e ON e.id = k.enquiry_id AND e.institution_id = k.institution_id
			 WHERE k.institution_id = $1 AND k.conflict_at IS NOT NULL
			 ORDER BY k.conflict_at DESC LIMIT 200`, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v crmConflictRow
			var conflictAt time.Time
			var remote, local *time.Time
			if err := rows.Scan(&v.ID, &v.EnquiryID, &v.ExternalID, &v.Name,
				&v.Phone, &v.OurStatus, &v.TheirStatus, &conflictAt,
				&v.ConflictNote, &remote, &local); err != nil {
				return err
			}
			v.ConflictAt = conflictAt.Format(time.RFC3339)
			v.RemoteUpdated = nullTime(remote)
			v.LocalUpdatedAt = nullTime(local)
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

type resolveCRMConflictRequest struct {
	// keep is 'ours' or 'theirs'. Recorded rather than applied to the enquiry:
	// deciding which status wins is an admissions decision, and this connector
	// does not hold admissions.write.
	Keep string `json:"keep"`
}

/*
resolveCRMConflict clears the flag after a human has decided.

	Nothing is resolved automatically and nothing clears itself over time. A
	sync that quietly resolves its own conflicts is the failure the flag exists
	to prevent — the school finds out when a counsellor's notes are gone.
*/
func (s *Server) resolveCRMConflict(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	linkID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid link id")
		return
	}
	var req resolveCRMConflictRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !oneOfStr(req.Keep, "ours", "theirs") {
		httpx.BadRequest(w, r, "say which side to keep: ours or theirs")
		return
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE crm_lead_links
			   SET conflict_at = NULL, conflict_note = NULL,
			       last_pulled_at = CASE WHEN $3 = 'theirs' THEN now() ELSE last_pulled_at END,
			       last_pushed_at = CASE WHEN $3 = 'ours'   THEN now() ELSE last_pushed_at END
			 WHERE id = $1 AND institution_id = $2 AND conflict_at IS NOT NULL`,
			linkID, inst, req.Keep)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- the CRM keys ------------------------------------------------------------

/*
getCRMCredentials reads the API key's metadata, for platform staff only.

	Through AsPlatform, gated on platform.tenants.write above and on
	platformOnly here. All three, deliberately: the RLS policy is the guarantee,
	the middleware is the readable statement of intent, and platformOnly is the
	line between "may configure a school" and "may see across schools".

	The key itself is never returned. A screen needs to know whether one is set,
	which is a boolean; returning the value would put it in a response body, a
	browser cache and whatever proxy sits between — for a credential the
	school's own administrator is not allowed to see.
*/
func (s *Server) getCRMCredentials(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	items := []map[string]any{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT provider, base_url, notes,
			       credentials IS NOT NULL AND length(credentials) > 0,
			       institution_id IS NULL, updated_at
			  FROM crm_api_credentials
			 WHERE COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid)
			     = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
			 ORDER BY provider`, nullUUIDArg(id.InstitutionID))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var provider string
			var baseURL, notes *string
			var hasSecret, isDefault bool
			var updated time.Time
			if err := rows.Scan(&provider, &baseURL, &notes, &hasSecret,
				&isDefault, &updated); err != nil {
				return err
			}
			items = append(items, map[string]any{
				"provider":                provider,
				"base_url":                strFromPtr(baseURL),
				"notes":                   strFromPtr(notes),
				"has_credentials":         hasSecret,
				"is_installation_default": isDefault,
				"updated_at":              updated.Format(time.RFC3339),
			})
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":               items,
		"live_sync_available": false,
		"note":                crmLiveNote,
	})
}

type saveCRMCredentialsRequest struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
	// Absent leaves the stored key alone; an empty string clears it. The
	// distinction matters: a screen that reloads and saves must not wipe a
	// credential it was never shown.
	Secret *string `json:"secret"`
	Notes  string  `json:"notes"`
}

func (s *Server) saveCRMCredentials(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req saveCRMCredentialsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !connectors.IsCRMSystem(req.Provider) {
		httpx.BadRequest(w, r, "the CRM must be Meritto or LeadSquared")
		return
	}

	sealed, clear, ok := sealedSecretFrom(w, r, req.Secret)
	if !ok {
		return
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO crm_api_credentials
			    (institution_id, provider, base_url, credentials, notes, updated_by)
			VALUES ($1, $2, nullif(btrim($3), ''), $4, nullif(btrim($5), ''), $6)
			ON CONFLICT (provider, COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET
			    base_url    = EXCLUDED.base_url,
			    credentials = CASE WHEN $7 THEN NULL
			                       ELSE COALESCE(EXCLUDED.credentials,
			                                     crm_api_credentials.credentials) END,
			    notes       = EXCLUDED.notes,
			    updated_at  = now(),
			    updated_by  = EXCLUDED.updated_by`,
			nullUUIDArg(id.InstitutionID), req.Provider, req.BaseURL, sealed,
			req.Notes, id.UserID, clear)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

/*
sealedSecretFrom turns an optional plaintext into the sealed bytes and the
clear flag both credential tables here take.

	Absent means leave what is stored; empty means wipe it. Written once because
	getting that distinction wrong in one of two places is how a screen silently
	erases a key on an unrelated save.
*/
func sealedSecretFrom(w http.ResponseWriter, r *http.Request, secret *string) ([]byte, bool, bool) {
	if secret == nil {
		return nil, false, true
	}
	if strings.TrimSpace(*secret) == "" {
		return nil, true, true
	}
	sealed, err := sealSecret(*secret)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return nil, false, false
	}
	return sealed, false, true
}

// --- the virtual classroom ---------------------------------------------------

// meetingRouteRow is one route from a scheduled session to a real meeting.
// live_create comes off the server for the same reason live_sync does.
type meetingRouteRow struct {
	Key        string `json:"key"`
	Label      string `json:"label"`
	LiveCreate bool   `json:"live_create"`
}

// meetingAccountRow is one configured meeting account. The sealed credential is
// never in it; whether one exists is.
type meetingAccountRow struct {
	ID             string  `json:"id"`
	Provider       string  `json:"provider"`
	DisplayName    string  `json:"display_name"`
	AccountRef     *string `json:"account_ref,omitempty"`
	AuthStyle      string  `json:"auth_style"`
	BaseURL        *string `json:"base_url,omitempty"`
	HasCredentials bool    `json:"has_credentials"`
	Enabled        bool    `json:"is_enabled"`
	// InstallationDefault marks the row every school falls back to.
	InstallationDefault bool    `json:"is_installation_default"`
	Notes               *string `json:"notes,omitempty"`
	UpdatedAt           string  `json:"updated_at"`
}

const meetingLiveNote = "No meeting provider credential is configured on this " +
	"installation, so no meeting is created automatically. Teachers paste the join " +
	"link into the session as they do today, and the launcher works exactly as before."

/*
getMeetingConnector is the platform half of a live-class model that already
exists.

	It reports the accounts configured, the routes available, and how many
	sessions are still waiting for somewhere to happen. It does not schedule
	classes, list them, or duplicate anything the launcher does:
	virtual_class_sessions is the model and this is its configuration.
*/
func (s *Server) getMeetingConnector(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	accounts := []meetingAccountRow{}
	var pending, joinable, schoolsUsing int

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* Rows for the school being acted on, plus the installation-wide
		   defaults, because the defaults are what that school falls back to and
		   a screen that hid them would show an operator "nothing configured"
		   for a campus that works perfectly. */
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, provider, display_name, account_ref, auth_style, base_url,
			       credentials IS NOT NULL AND length(credentials) > 0,
			       is_enabled, institution_id IS NULL, notes, updated_at
			  FROM virtual_meeting_platform_providers
			 WHERE institution_id IS NULL OR institution_id = $1
			 ORDER BY institution_id IS NULL DESC, provider`,
			nullUUIDArg(id.InstitutionID))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v meetingAccountRow
			var updated time.Time
			if err := rows.Scan(&v.ID, &v.Provider, &v.DisplayName, &v.AccountRef,
				&v.AuthStyle, &v.BaseURL, &v.HasCredentials, &v.Enabled,
				&v.InstallationDefault, &v.Notes, &updated); err != nil {
				return err
			}
			v.UpdatedAt = updated.Format(time.RFC3339)
			accounts = append(accounts, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if id.InstitutionID != uuid.Nil {
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*) FILTER (WHERE join_url IS NULL),
				       count(*) FILTER (WHERE join_url IS NOT NULL)
				  FROM virtual_class_sessions
				 WHERE institution_id = $1 AND status <> 'cancelled'`,
				id.InstitutionID).Scan(&pending, &joinable); err != nil {
				return err
			}
		}
		return tx.QueryRow(r.Context(),
			`SELECT count(DISTINCT institution_id) FROM virtual_class_providers
			  WHERE is_active`).Scan(&schoolsUsing)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	routes := []meetingRouteRow{}
	for _, p := range connectors.MeetingProviders() {
		routes = append(routes, meetingRouteRow{
			Key: p.Key(), Label: p.Label(), LiveCreate: p.LiveCreate()})
	}
	systems := []map[string]string{}
	for k, name := range connectors.MeetingSystems {
		systems = append(systems, map[string]string{"key": k, "name": name})
	}
	styles := []map[string]string{}
	for k, name := range connectors.AuthStyles {
		styles = append(styles, map[string]string{"key": k, "name": name})
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"accounts":              accounts,
		"routes":                routes,
		"systems":               systems,
		"auth_styles":           styles,
		"sessions_awaiting_url": pending,
		"sessions_joinable":     joinable,
		"schools_using":         schoolsUsing,
		"live_create_available": false,
		"live_create_note":      meetingLiveNote,
	})
}

type saveMeetingProviderRequest struct {
	Provider    string  `json:"provider"`
	DisplayName string  `json:"display_name"`
	AccountRef  string  `json:"account_ref"`
	AuthStyle   string  `json:"auth_style"`
	BaseURL     string  `json:"base_url"`
	Secret      *string `json:"secret"`
	Enabled     bool    `json:"is_enabled"`
	Notes       string  `json:"notes"`
	// InstallationDefault writes the row with a NULL institution_id: one
	// account serving every campus. Without it the row belongs to the school
	// being acted on.
	InstallationDefault bool `json:"is_installation_default"`
}

func (s *Server) saveMeetingProvider(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req saveMeetingProviderRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !connectors.IsMeetingSystem(req.Provider) {
		httpx.BadRequest(w, r, "the provider must be Zoom, Google Meet or Microsoft Teams")
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		httpx.BadRequest(w, r, "name the account, so support knows which one this is")
		return
	}
	if req.AuthStyle == "" {
		req.AuthStyle = "oauth_s2s"
	}
	if !connectors.IsAuthStyle(req.AuthStyle) {
		httpx.BadRequest(w, r, "unknown authentication style")
		return
	}
	if !req.InstallationDefault && id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r,
			"choose the school this account belongs to, or mark it the installation default")
		return
	}

	sealed, clear, ok := sealedSecretFrom(w, r, req.Secret)
	if !ok {
		return
	}

	var scope any
	if !req.InstallationDefault {
		scope = id.InstitutionID
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO virtual_meeting_platform_providers
			    (institution_id, provider, display_name, account_ref, auth_style,
			     base_url, credentials, is_enabled, notes, updated_by)
			VALUES ($1,$2,$3, nullif(btrim($4),''), $5, nullif(btrim($6),''),
			        $7,$8, nullif(btrim($9),''), $10)
			ON CONFLICT (provider, COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET
			    display_name = EXCLUDED.display_name,
			    account_ref  = EXCLUDED.account_ref,
			    auth_style   = EXCLUDED.auth_style,
			    base_url     = EXCLUDED.base_url,
			    credentials  = CASE WHEN $11 THEN NULL
			                        ELSE COALESCE(EXCLUDED.credentials,
			                             virtual_meeting_platform_providers.credentials) END,
			    is_enabled   = EXCLUDED.is_enabled,
			    notes        = EXCLUDED.notes,
			    updated_at   = now(),
			    updated_by   = EXCLUDED.updated_by`,
			scope, req.Provider, req.DisplayName, req.AccountRef, req.AuthStyle,
			req.BaseURL, sealed, req.Enabled, req.Notes, id.UserID, clear)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) deleteMeetingProvider(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	rowID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid provider id")
		return
	}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM virtual_meeting_platform_providers WHERE id = $1`, rowID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// meetingRequestRow is one attempt to give a session somewhere to happen.
type meetingRequestRow struct {
	ID          string  `json:"id"`
	SessionID   string  `json:"session_id"`
	Topic       string  `json:"topic"`
	ScheduledAt string  `json:"scheduled_at"`
	Provider    string  `json:"provider"`
	Status      string  `json:"status"`
	Detail      *string `json:"detail,omitempty"`
	JoinURL     *string `json:"join_url,omitempty"`
	RequestedAt string  `json:"requested_at"`
}

/*
listMeetingRequests is the queue: what was asked for, and what came of it.

	Every row on this deployment resolves to 'manual', which is the point. A
	product that refuses and forgets cannot tell anybody how often the feature
	was wanted, and this is the backlog to drain on the day a credential
	arrives.
*/
func (s *Server) listMeetingRequests(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	items := []meetingRequestRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT q.id::text, q.session_id::text, v.topic, v.scheduled_at,
			       q.provider, q.status, q.detail, q.join_url, q.requested_at
			  FROM virtual_meeting_requests q
			  JOIN virtual_class_sessions v
			    ON v.id = q.session_id AND v.institution_id = q.institution_id
			 WHERE q.institution_id = $1
			 ORDER BY q.requested_at DESC LIMIT 200`, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v meetingRequestRow
			var scheduled, requested time.Time
			if err := rows.Scan(&v.ID, &v.SessionID, &v.Topic, &scheduled,
				&v.Provider, &v.Status, &v.Detail, &v.JoinURL, &requested); err != nil {
				return err
			}
			v.ScheduledAt = scheduled.Format(time.RFC3339)
			v.RequestedAt = requested.Format(time.RFC3339)
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

type requestMeetingRequest struct {
	// Provider is the route to try. Anything but 'manual' refuses today, by
	// design, and the refusal is recorded rather than swallowed.
	Provider string `json:"provider"`
	// JoinURL is the link a human pasted, for the manual route.
	JoinURL string `json:"join_url"`
}

/*
requestMeeting asks for a session to be given somewhere to happen.

	The whole point of the endpoint is the seam. Today the manual route is the
	only one that returns a meeting, and it returns the link somebody typed; the
	three real providers refuse by name and the refusal is written to
	virtual_meeting_requests so the school can see what it asked for.

	The session's join_url is written only when a meeting genuinely exists. A
	refusal leaves it NULL and the status at 'provider_pending', which is what
	00041 built that status for: a launcher that invents a plausible URL sends
	thirty children to a room that is not there.
*/
func (s *Server) requestMeeting(w http.ResponseWriter, r *http.Request) {
	inst, ok := connectorInstitution(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	sessionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid session id")
		return
	}
	var req requestMeetingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Provider == "" {
		req.Provider = "manual"
	}
	if req.Provider != "manual" && !connectors.IsMeetingSystem(req.Provider) {
		httpx.BadRequest(w, r, "unknown meeting provider")
		return
	}

	var status, detail, joinURL string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var topic, agenda string
		var startsAt time.Time
		var minutes int
		if err := tx.QueryRow(r.Context(), `
			SELECT topic, COALESCE(agenda,''), scheduled_at, duration_minutes
			  FROM virtual_class_sessions WHERE id = $1 AND institution_id = $2`,
			sessionID, inst).Scan(&topic, &agenda, &startsAt, &minutes); err != nil {
			return err
		}

		meeting, createErr := connectors.MeetingProviderFor(req.Provider).Create(
			connectors.MeetingRequest{
				SessionID: sessionID.String(), Topic: topic, Agenda: agenda,
				StartsAt: startsAt, Minutes: minutes, ManualJoinURL: req.JoinURL,
			})

		switch {
		case createErr != nil && errors.Is(createErr, connectors.ErrManualJoinURLRequired):
			// Nothing was attempted and nothing is recorded: the person is
			// looking at the form, and a queue full of "they left the box
			// empty" tells nobody anything.
			return refusef("%s", createErr.Error())
		case createErr != nil:
			status, detail = "manual", createErr.Error()
		default:
			status, detail, joinURL = meeting.Status, meeting.Detail, meeting.JoinURL
		}

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO virtual_meeting_requests
			    (institution_id, session_id, provider, status, detail, join_url,
			     meeting_ref, requested_by, resolved_at)
			VALUES ($1,$2,$3,$4, nullif($5,''), nullif($6,''), nullif($7,''), $8,
			        CASE WHEN $4 = 'queued' THEN NULL ELSE now() END)`,
			inst, sessionID, req.Provider, statusForQueue(status), detail,
			joinURL, meeting.MeetingRef, id.UserID); err != nil {
			return err
		}

		// Written only when there is somewhere to go. 'manual' here means the
		// teacher supplied the link, which is a real meeting.
		if joinURL != "" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE virtual_class_sessions
				   SET join_url = $3,
				       meeting_ref = COALESCE(nullif($4,''), meeting_ref),
				       status = CASE WHEN status = 'provider_pending'
				                     THEN 'scheduled' ELSE status END,
				       updated_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				sessionID, inst, joinURL, meeting.MeetingRef); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"status":                status,
		"detail":                detail,
		"join_url":              joinURL,
		"live_create_available": false,
	})
}

// statusForQueue maps a provider's own status onto the column's vocabulary. A
// provider that returned a URL is 'created' as far as the queue is concerned,
// however that URL was come by.
func statusForQueue(s string) string {
	switch s {
	case "manual", "created":
		return s
	case "":
		return "manual"
	default:
		return "failed"
	}
}
