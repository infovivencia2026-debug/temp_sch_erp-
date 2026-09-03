package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* PAYMENT GATEWAYS AND THE READER FLEET, FOR THE PLATFORM OWNER.

   Two rows of the Payments & Devices section, both platform scope, both read
   across every school through AsPlatform and both gated twice: the vendor
   permission on the route and platformOnly in the handler, the way the Tally
   gateway and the CRM keys are.

   The gateway half is a record of merchant keys and not a checkout. Nothing
   in this product charges a card — portal_pay.go says so in its first
   paragraph — so every response here carries live_checkout_available = false
   off the server. A screen that hardcoded "connected" would go on promising
   after somebody changed the backend; one that reads the flag cannot.

   The reader half is the fleet view of biometric_devices: the same table the
   school's own screen edits, read for every school at once, so the person who
   supports thirty campuses can see which readers went quiet without opening
   thirty tabs. Read-only from here — registering a reader is the school's
   act, done inside the school where its audit trail lives. */

// gatewayProviders is the list the migration's CHECK constraint carries. The
// handler refuses first so the error is a sentence rather than a constraint
// name.
var gatewayProviders = map[string]string{
	"razorpay": "Razorpay",
	"paytm":    "Paytm",
	"ccavenue": "CCAvenue",
	"billdesk": "BillDesk",
	"easebuzz": "Easebuzz",
}

func (s *Server) mountPlatformDevices(r chi.Router) {
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)
	r.With(vendor).Get("/connectors/payment-gateways", s.listPaymentGateways)
	r.With(vendor).Put("/connectors/payment-gateways", s.savePaymentGateway)
	r.With(vendor).Delete("/connectors/payment-gateways/{id}", s.deletePaymentGateway)
	r.With(vendor).Get("/biometric-devices", s.listBiometricFleet)
}

type paymentGatewayRow struct {
	ID               string  `json:"id"`
	InstitutionID    *string `json:"institution_id"`
	School           string  `json:"school"`
	Provider         string  `json:"provider"`
	ProviderLabel    string  `json:"provider_label"`
	Mode             string  `json:"mode"`
	KeyID            string  `json:"key_id"`
	HasSecret        bool    `json:"has_secret"`
	HasWebhookSecret bool    `json:"has_webhook_secret"`
	IsEnabled        bool    `json:"is_enabled"`
	Notes            string  `json:"notes"`
	UpdatedAt        *string `json:"updated_at,omitempty"`
}

type paymentGatewayList struct {
	Items                []paymentGatewayRow `json:"items"`
	Providers            []providerOption    `json:"providers"`
	Schools              []providerOption    `json:"schools"`
	LiveCheckoutAvail    bool                `json:"live_checkout_available"`
	Note                 string              `json:"note"`
	CredentialKeyPresent bool                `json:"credential_key_present"`
}

type providerOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

func (s *Server) listPaymentGateways(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	out := paymentGatewayList{
		Items:   []paymentGatewayRow{},
		Schools: []providerOption{},
		Providers: []providerOption{
			{"razorpay", "Razorpay"}, {"paytm", "Paytm"}, {"ccavenue", "CCAvenue"},
			{"billdesk", "BillDesk"}, {"easebuzz", "Easebuzz"},
		},
		Note: "Keys are recorded for the day an online checkout is wired. No payment " +
			"is taken through this product today, and nothing here is sent to a gateway.",
		CredentialKeyPresent: credentialKeyPresent(),
	}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.institution_id::text, COALESCE(i.name, 'Every school'),
			       g.provider, g.mode, COALESCE(g.key_id, ''),
			       g.key_secret IS NOT NULL AND length(g.key_secret) > 0,
			       g.webhook_secret IS NOT NULL AND length(g.webhook_secret) > 0,
			       g.is_enabled, COALESCE(g.notes, ''), g.updated_at
			  FROM payment_gateway_credentials g
			  LEFT JOIN institutions i ON i.id = g.institution_id
			 ORDER BY g.institution_id IS NOT NULL, i.name, g.provider`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v paymentGatewayRow
			var updated time.Time
			if err := rows.Scan(&v.ID, &v.InstitutionID, &v.School, &v.Provider, &v.Mode,
				&v.KeyID, &v.HasSecret, &v.HasWebhookSecret, &v.IsEnabled, &v.Notes,
				&updated); err != nil {
				return err
			}
			v.ProviderLabel = gatewayProviders[v.Provider]
			v.UpdatedAt = nullTime(&updated)
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		srows, err := tx.Query(r.Context(),
			`SELECT id::text, name FROM institutions WHERE status = 'active' ORDER BY name`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			var o providerOption
			if err := srows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Schools = append(out.Schools, o)
		}
		return srows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type savePaymentGatewayRequest struct {
	// Empty means the installation-wide default.
	InstitutionID string `json:"institution_id"`
	Provider      string `json:"provider"`
	Mode          string `json:"mode"`
	KeyID         string `json:"key_id"`
	// Absent leaves the stored secret alone; an empty string clears it. A
	// screen that reloads and saves must not wipe a credential it was never
	// shown.
	Secret        *string `json:"secret"`
	WebhookSecret *string `json:"webhook_secret"`
	IsEnabled     bool    `json:"is_enabled"`
	Notes         string  `json:"notes"`
}

func (s *Server) savePaymentGateway(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req savePaymentGatewayRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Provider = strings.ToLower(strings.TrimSpace(req.Provider))
	if _, ok := gatewayProviders[req.Provider]; !ok {
		httpx.BadRequest(w, r, "choose one of Razorpay, Paytm, CCAvenue, BillDesk or Easebuzz")
		return
	}
	if req.Mode == "" {
		req.Mode = "test"
	}
	if req.Mode != "test" && req.Mode != "live" {
		httpx.BadRequest(w, r, "mode is test or live")
		return
	}
	var inst any
	if strings.TrimSpace(req.InstitutionID) != "" {
		u, err := uuid.Parse(req.InstitutionID)
		if err != nil {
			httpx.BadRequest(w, r, "institution_id must be a uuid")
			return
		}
		inst = u
	}
	sealedKey, clearKey, ok := sealedSecretFrom(w, r, req.Secret)
	if !ok {
		return
	}
	sealedHook, clearHook, ok := sealedSecretFrom(w, r, req.WebhookSecret)
	if !ok {
		return
	}
	/* Switching a gateway on with no secret behind it would make the row
	   look ready when the first real request could only fail. Saved, left
	   off, and said so — rather than silently saved off. */
	var newID string
	leftOff := false
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var hasSecret bool
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO payment_gateway_credentials
			    (institution_id, provider, mode, key_id, key_secret, webhook_secret,
			     is_enabled, notes, updated_by)
			VALUES ($1, $2, $3, nullif(btrim($4), ''), $5, $6, $7, nullif(btrim($8), ''), $9)
			ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
			DO UPDATE SET
			    mode           = EXCLUDED.mode,
			    key_id         = EXCLUDED.key_id,
			    key_secret     = CASE WHEN $10 THEN NULL
			                          ELSE COALESCE(EXCLUDED.key_secret,
			                                        payment_gateway_credentials.key_secret) END,
			    webhook_secret = CASE WHEN $11 THEN NULL
			                          ELSE COALESCE(EXCLUDED.webhook_secret,
			                                        payment_gateway_credentials.webhook_secret) END,
			    is_enabled     = EXCLUDED.is_enabled,
			    notes          = EXCLUDED.notes,
			    updated_at     = now(),
			    updated_by     = EXCLUDED.updated_by
			RETURNING id::text, key_secret IS NOT NULL AND length(key_secret) > 0`,
			inst, req.Provider, req.Mode, req.KeyID, sealedKey, sealedHook,
			req.IsEnabled, req.Notes, id.UserID, clearKey, clearHook).Scan(&newID, &hasSecret); err != nil {
			return err
		}
		if req.IsEnabled && !hasSecret {
			leftOff = true
			_, err := tx.Exec(r.Context(),
				`UPDATE payment_gateway_credentials SET is_enabled = false WHERE id = $1`, newID)
			return err
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := map[string]any{"id": newID, "is_enabled": req.IsEnabled && !leftOff}
	if leftOff {
		out["note"] = "Saved, but left switched off: there is no secret behind this key yet."
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) deletePaymentGateway(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	rowID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM payment_gateway_credentials WHERE id = $1`, rowID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// credentialKeyPresent says whether a secret can be sealed at all. The screen
// disables the secret fields rather than letting a save fail on submit.
func credentialKeyPresent() bool {
	_, err := sealSecret("probe")
	return err == nil
}

// --- the reader fleet -------------------------------------------------------

type fleetDevice struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	Campus        *string `json:"campus"`
	ID            string  `json:"id"`
	Serial        string  `json:"serial"`
	Name          string  `json:"name"`
	IsActive      bool    `json:"is_active"`
	LastSeenAt    *string `json:"last_seen_at,omitempty"`
	LastPushAt    *string `json:"last_push_at,omitempty"`
	Firmware      *string `json:"firmware,omitempty"`
	PunchesToday  int     `json:"punches_today"`
	Unresolved    int     `json:"unresolved"`
	// Quiet is the fleet's one derived judgement: active, has been seen, and
	// silent for more than a day. A reader that was never seen is not quiet,
	// it is not yet pointed at us — a different problem with a different fix.
	Quiet bool `json:"quiet"`
}

type fleetSummary struct {
	Devices   int `json:"devices"`
	Active    int `json:"active"`
	SeenToday int `json:"seen_today"`
	Quiet     int `json:"quiet"`
	NeverSeen int `json:"never_seen"`
	Schools   int `json:"schools"`
}

func (s *Server) listBiometricFleet(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	items := []fleetDevice{}
	var sum fleetSummary
	schools := map[string]bool{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT d.institution_id::text, i.name, c.name, d.id::text, d.serial, d.name,
			       d.is_active, d.last_seen_at, d.last_push_at, d.firmware,
			       (SELECT count(*) FROM biometric_punches p
			         WHERE p.device_id = d.id
			           AND p.punched_at >= CURRENT_DATE)::int,
			       (SELECT count(*) FROM biometric_punches p
			         WHERE p.device_id = d.id AND p.employee_id IS NULL)::int
			  FROM biometric_devices d
			  JOIN institutions i ON i.id = d.institution_id
			  LEFT JOIN campuses c ON c.id = d.campus_id
			 ORDER BY i.name, d.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v fleetDevice
			var seen, push *time.Time
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Campus, &v.ID, &v.Serial,
				&v.Name, &v.IsActive, &seen, &push, &v.Firmware, &v.PunchesToday,
				&v.Unresolved); err != nil {
				return err
			}
			v.LastSeenAt = nullTime(seen)
			v.LastPushAt = nullTime(push)
			sum.Devices++
			schools[v.InstitutionID] = true
			if v.IsActive {
				sum.Active++
			}
			switch {
			case seen == nil:
				sum.NeverSeen++
			case time.Since(*seen) < 24*time.Hour:
				sum.SeenToday++
			case v.IsActive:
				v.Quiet = true
				sum.Quiet++
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	sum.Schools = len(schools)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":   items,
		"summary": sum,
		// Said by the server: this is the ADMS push protocol and nothing else.
		// A reader that does not speak it — a face camera on RTSP, an RFID
		// gate on a serial line — has no way in here.
		"protocol": "ADMS push over HTTP (ZKTeco-compatible readers). The device dials this host at /iclock; no polling, no webhook.",
	})
}
