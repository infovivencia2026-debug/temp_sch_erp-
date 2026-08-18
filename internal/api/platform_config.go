package api

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The platform tier: the vendor's console and the school's own configuration.

   Two audiences share this file because they share the tables. The vendor
   prices, entitles, watches and supports; the school configures its board
   rules, its branding, its calendar and its numbering. Splitting them by file
   would put the franchise roster and the franchise membership in different
   places, and the two are one screen apart.

   What separates them is the permission on each route, never the path:

     platform.tenants.write / platform.plans.write   the vendor only. No school
                                                     role holds either, which
                                                     is what makes the
                                                     cross-tenant reads safe.
     institution.* / access.*                        the school's own, and a
                                                     platform operator reaches
                                                     them by naming a school
                                                     through X-Acting-Institution.

   Cross-tenant reads go through DB.AsPlatform and are kept aggregate wherever
   a name would otherwise leak: the adoption and health screens count people
   and never list them. Everything school-scoped goes through DB.InTenant so
   row-level security does the narrowing, including for a platform operator —
   an operator acting inside a school reads that school and no other. */

// mountPlatformConfig registers the platform tier.
//
// Called from inside the existing /admin group in api.go, which carries no
// group-level permission and therefore lets every route below name its own.
// There is no /platform group in api.go to mount into; see the handover.
// Paths are relative, so everything here lands under /api/v1/admin/platform.
//
// Every permission used is already in internal/rbac/rbac.go. Nothing new was
// invented: the vendor's routes reuse platform.tenants.write and
// platform.plans.write, and the school's reuse the institution, settings,
// access and audit keys their administrator already holds.
func (s *Server) mountPlatformConfig(r chi.Router) {
	// The vendor. institution_admin holds neither key — see rbac.keysExcept —
	// so these are the boundary that keeps a school out of the commercial and
	// cross-tenant screens.
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)
	plans := httpx.RequirePermission(rbac.PlatformPlansRW)

	// The school's own configuration.
	read := httpx.RequirePermission(rbac.InstitutionRead)
	settings := httpx.RequirePermission(rbac.SettingsWrite)
	profile := httpx.RequirePermission(rbac.InstitutionWrite)

	// The impersonation register has two readers who reach it differently: the
	// school's administrator through admin.audit.read, the vendor through
	// platform.tenants.write. Neither holds the other's key.
	register := httpx.RequireAnyPermission(rbac.AuditRead, rbac.PlatformTenantsRW)

	// --- statutory: district and mandal master -----------------------------
	//
	// Reads are open to any signed-in user. The district list is what every
	// address form and every government return picks from, and gating it would
	// mean a clerk filling in a student's address needs a platform permission.
	r.Get("/platform/locations", s.listLocationCodes)
	r.With(vendor).Post("/platform/locations", s.saveLocationCode)
	r.With(vendor).Delete("/platform/locations/{id}", s.retireLocationCode)

	// --- statutory: board affiliation and public disclosure ----------------
	r.With(read).Get("/platform/board-affiliation", s.getBoardAffiliation)
	r.With(profile).Put("/platform/board-affiliation", s.setBoardAffiliation)
	r.With(profile).Post("/platform/board-affiliation/documents", s.saveBoardDisclosure)
	r.With(profile).Delete("/platform/board-affiliation/documents/{id}", s.deleteBoardDisclosure)

	// --- statutory: state board rules --------------------------------------
	r.With(read).Get("/platform/board-config", s.listBoardConfigurations)
	r.With(settings).Post("/platform/board-config", s.saveBoardConfiguration)
	r.With(settings).Delete("/platform/board-config/{id}", s.deleteBoardConfiguration)

	// --- statutory: SQAA framework -----------------------------------------
	r.Get("/platform/sqaa", s.getSQAAFramework)
	r.With(vendor).Post("/platform/sqaa/frameworks", s.saveSQAAFramework)
	r.With(vendor).Post("/platform/sqaa/standards", s.saveSQAAStandard)
	r.With(vendor).Delete("/platform/sqaa/standards/{id}", s.deleteSQAAStandard)

	// --- statutory: management type, per campus ----------------------------
	r.With(read).Get("/platform/campus-classification", s.listCampusClassification)
	r.With(httpx.RequirePermission(rbac.CampusesWrite)).
		Put("/platform/campus-classification/{id}", s.setCampusClassification)

	// --- campuses and the year: the calendar model -------------------------
	r.With(read).Get("/platform/calendar-model", s.getCalendarModel)
	r.With(settings).Put("/platform/calendar-model", s.setCalendarModel)

	// --- campuses and the year: branding and white-label -------------------
	r.With(read).Get("/platform/branding", s.listBrandingProfiles)
	r.With(settings).Put("/platform/branding", s.saveBrandingProfile)
	// Only the vendor can confirm a custom host actually reaches this
	// installation, because only the vendor operates the ingress. A school
	// marking its own domain verified would put an unreachable host live.
	r.With(vendor).Post("/platform/branding/{id}/verify-domain", s.verifyBrandingDomain)

	// --- campuses and the year: franchise chains ---------------------------
	r.With(vendor).Get("/platform/franchises", s.listFranchises)
	r.With(vendor).Post("/platform/franchises", s.saveFranchise)
	r.With(vendor).Post("/platform/franchises/members", s.saveFranchiseMember)
	r.With(vendor).Delete("/platform/franchises/members/{id}", s.removeFranchiseMember)
	// A member school reads its own obligations without seeing the roster.
	r.With(read).Get("/platform/franchise", s.getOwnFranchise)

	// --- platform configuration: numbering and templates -------------------
	r.With(read).Get("/platform/numbering", s.getNumberingAndTemplates)
	r.With(settings).Post("/platform/numbering", s.saveNumberingScheme)
	r.With(settings).Delete("/platform/numbering/{id}", s.deleteNumberingScheme)
	r.With(settings).Post("/platform/templates", s.saveCertificateTemplate)

	// --- access and security: SSO and MFA ----------------------------------
	r.With(httpx.RequirePermission(rbac.RolesRead)).Get("/platform/auth-policy", s.getAuthPolicy)
	r.With(httpx.RequirePermission(rbac.RolesWrite)).Put("/platform/auth-policy", s.setAuthPolicy)

	// --- operations: backup and restore ------------------------------------
	r.With(read).Get("/platform/backups", s.getBackupPosture)
	r.With(settings).Put("/platform/backups", s.setBackupPolicy)
	// Written by the operator's backup pipeline, not by a person. Gated on the
	// vendor key because the pipeline runs with vendor credentials and a school
	// must not be able to invent a backup it never took.
	r.With(vendor).Post("/platform/backups/runs", s.recordBackupRun)
	r.With(vendor).Get("/platform/backups/fleet", s.getBackupFleet)

	// --- seller: support tickets -------------------------------------------
	r.With(vendor).Get("/platform/seller/tickets", s.listVendorTickets)
	r.With(vendor).Post("/platform/seller/tickets/{id}", s.updateVendorTicket)
	// The school's side of the same queue: what it has reported to the vendor.
	r.With(read).Get("/platform/support/tickets", s.listOwnVendorTickets)
	r.With(settings).Post("/platform/support/tickets", s.raiseVendorTicket)

	// --- seller: impersonation and audit -----------------------------------
	r.With(register).Get("/platform/impersonation", s.listImpersonationGrants)
	r.With(register).Get("/platform/impersonation/{id}/activity", s.getImpersonationActivity)
	r.With(vendor).Post("/platform/impersonation", s.openImpersonation)
	// A school may end a session running inside it. That is the point of
	// showing them the register at all.
	r.With(register).Post("/platform/impersonation/{id}/end", s.endImpersonation)

	// --- seller: adoption, health, entitlements ----------------------------
	r.With(vendor).Get("/platform/adoption", s.getAdoptionMetrics)
	r.With(vendor).Get("/platform/health", s.getInstanceHealth)
	r.With(plans).Get("/platform/entitlements", s.getEntitlementMatrix)
	r.With(plans).Put("/platform/entitlements", s.setEntitlement)
}

// --- shared plumbing ---------------------------------------------------------

// platformOnly refuses a caller who is not platform staff.
//
// Belt to RequirePermission's braces, and not redundant: the permission says
// what a caller may do, PlatformAdmin says how far they can see. A handler that
// reads across tenants needs both, and a grant added to the wrong role later
// should not silently turn a school administrator into a fleet operator.
func platformOnly(w http.ResponseWriter, r *http.Request) bool {
	id := httpx.IdentityFrom(r.Context())
	if id != nil && id.PlatformAdmin {
		return true
	}
	httpx.Denied(w, r, "only platform staff can read across schools")
	return false
}

// nullTime renders a timestamp the way every other endpoint here does, or nil.
func nullTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.RFC3339)
	return &s
}

// --- district and mandal master ----------------------------------------------

type platLocation struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parent_id,omitempty"`
	Level    string  `json:"level"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Active   bool    `json:"active"`
	// How many rows sit directly beneath this one. A district with no mandals
	// is the row somebody still has to fill in, and a count is the only way the
	// screen can say so without loading the whole tree.
	Children int `json:"children"`
}

/*
listLocationCodes returns one level of the tree.

	A bare GET with no parameters answers with the states rather than 400. The
	screen opens on it, and an empty first request is the normal case, not a
	mistake the caller made.
*/
func (s *Server) listLocationCodes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parent := strings.TrimSpace(q.Get("parent_id"))

	var parentArg any
	if parent != "" {
		id, err := uuid.Parse(parent)
		if err != nil {
			httpx.BadRequest(w, r, "parent_id must be a uuid")
			return
		}
		parentArg = id
	}

	items := []platLocation{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT l.id::text, l.parent_id::text, l.level, l.code, l.name, l.active,
			       (SELECT count(*) FROM location_codes c WHERE c.parent_id = l.id)::int
			  FROM location_codes l
			 WHERE ($1::uuid IS NULL AND l.parent_id IS NULL)
			    OR l.parent_id = $1
			 ORDER BY l.code`, parentArg)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platLocation
			if err := rows.Scan(&v.ID, &v.ParentID, &v.Level, &v.Code, &v.Name,
				&v.Active, &v.Children); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

type platLocationRequest struct {
	ID       string `json:"id,omitempty"`
	ParentID string `json:"parent_id,omitempty"`
	Level    string `json:"level"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Active   *bool  `json:"active,omitempty"`
}

// saveLocationCode creates or renames one node.
func (s *Server) saveLocationCode(w http.ResponseWriter, r *http.Request) {
	var req platLocationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Name = strings.TrimSpace(req.Name)
	if req.Code == "" || req.Name == "" {
		httpx.BadRequest(w, r, "code and name are required")
		return
	}

	var parentArg any
	if req.ParentID != "" {
		id, err := uuid.Parse(req.ParentID)
		if err != nil {
			httpx.BadRequest(w, r, "parent_id must be a uuid")
			return
		}
		parentArg = id
	}

	active := true
	if req.Active != nil {
		active = *req.Active
	}

	var out string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if req.ID != "" {
			id, err := uuid.Parse(req.ID)
			if err != nil {
				return errBadLocationID
			}
			// The level and the parent are structural. Renaming a mandal is an
			// edit; moving it between districts is a different operation with
			// different consequences for returns already filed, so this does
			// not offer it by accident.
			return tx.QueryRow(r.Context(), `
				UPDATE location_codes SET code = $2, name = $3, active = $4
				 WHERE id = $1 RETURNING id::text`,
				id, req.Code, req.Name, active).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO location_codes (parent_id, level, code, name, active)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
			             level, code)
			DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active
			RETURNING id::text`,
			parentArg, req.Level, req.Code, req.Name, active).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

var errBadLocationID = fmt.Errorf("id must be a uuid")

/*
retireLocationCode marks a code inactive rather than deleting it.

	A mandal that merged into another still appears on every return filed
	against it. Deleting the row would break those; hiding it stops it being
	chosen again, which is the whole requirement.
*/
func (s *Server) retireLocationCode(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var tag int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(),
			`UPDATE location_codes SET active = false WHERE id = $1`, id)
		tag = ct.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if tag == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"retired": true})
}

// --- board affiliation and mandatory public disclosure -----------------------

// platDisclosureKinds is what the mandatory public disclosure rule asks for.
//
// Published as a vocabulary rather than left free text: a school that types
// "Fire NOC" and another that types "Fire safety certificate" cannot be
// reported on together, and the renewal alert is the whole point of the screen.
var platDisclosureKinds = []option{
	{"affiliation_certificate", "Affiliation / recognition certificate"},
	{"trust_deed", "Trust, society or company registration"},
	{"noc_state", "State government NOC"},
	{"recognition_certificate", "Recognition certificate under RTE"},
	{"building_safety", "Building safety certificate"},
	{"fire_safety", "Fire safety certificate"},
	{"water_sanitation", "Water, health and sanitation certificate"},
	{"deo_certificate", "DEO certificate"},
	{"land_certificate", "Land certificate"},
	{"fee_structure", "Fee structure as published"},
	{"managing_committee", "Managing committee / SMC composition"},
	{"annual_report", "Annual report and audited accounts"},
}

type platDisclosure struct {
	ID        string  `json:"id"`
	CampusID  *string `json:"campus_id,omitempty"`
	Campus    *string `json:"campus,omitempty"`
	Document  string  `json:"document"`
	Title     string  `json:"title"`
	Reference *string `json:"reference_no,omitempty"`
	Authority *string `json:"issuing_authority,omitempty"`
	IssuedOn  *string `json:"issued_on,omitempty"`
	ValidTo   *string `json:"valid_to,omitempty"`
	FileKey   *string `json:"file_key,omitempty"`
	PublicURL *string `json:"public_url,omitempty"`
	Notes     *string `json:"notes,omitempty"`
	// Days until expiry. Negative means expired; null means the document does
	// not expire, which is a different thing from "expires today".
	DaysToExpiry *int `json:"days_to_expiry,omitempty"`
}

type platAffiliation struct {
	Board     *string `json:"affiliation_board,omitempty"`
	Number    *string `json:"affiliation_no,omitempty"`
	ValidTo   *string `json:"affiliation_valid_to,omitempty"`
	UDISECode *string `json:"udise_code,omitempty"`
	// Days until the affiliation itself lapses. The number the correspondent
	// is actually chasing, and the reason this screen exists separately from
	// the school profile.
	DaysToRenewal *int `json:"days_to_renewal,omitempty"`

	Documents []platDisclosure `json:"documents"`
	Kinds     []option         `json:"document_kinds"`
	Boards    []option         `json:"boards"`
	// How many of the catalogued documents have been recorded at all, and how
	// many have lapsed. A school reads these two numbers and nothing else.
	Recorded int `json:"recorded"`
	Expired  int `json:"expired"`
	Expiring int `json:"expiring_90_days"`
}

func (s *Server) getBoardAffiliation(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	today := nowInIndia()

	out := platAffiliation{
		Documents: []platDisclosure{},
		Kinds:     platDisclosureKinds,
		Boards:    affiliationBoards,
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT affiliation_board, affiliation_no,
			       to_char(affiliation_valid_to,'YYYY-MM-DD'),
			       udise_code,
			       (affiliation_valid_to - $2::date)::int
			  FROM institutions WHERE id = $1`,
			id.InstitutionID, today.Format(time.DateOnly)).
			Scan(&out.Board, &out.Number, &out.ValidTo, &out.UDISECode,
				&out.DaysToRenewal); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.campus_id::text, c.name, d.document, d.title,
			       d.reference_no, d.issuing_authority,
			       to_char(d.issued_on,'YYYY-MM-DD'), to_char(d.valid_to,'YYYY-MM-DD'),
			       d.file_key, d.public_url, d.notes,
			       (d.valid_to - $1::date)::int
			  FROM board_disclosures d
			  LEFT JOIN campuses c ON c.id = d.campus_id
			 ORDER BY d.valid_to NULLS LAST, d.document`,
			today.Format(time.DateOnly))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platDisclosure
			if err := rows.Scan(&v.ID, &v.CampusID, &v.Campus, &v.Document, &v.Title,
				&v.Reference, &v.Authority, &v.IssuedOn, &v.ValidTo, &v.FileKey,
				&v.PublicURL, &v.Notes, &v.DaysToExpiry); err != nil {
				return err
			}
			out.Documents = append(out.Documents, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out.Recorded = len(out.Documents)
	for _, d := range out.Documents {
		if d.DaysToExpiry == nil {
			continue
		}
		switch {
		case *d.DaysToExpiry < 0:
			out.Expired++
		case *d.DaysToExpiry <= 90:
			out.Expiring++
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platAffiliationUpdate struct {
	Board   string `json:"affiliation_board"`
	Number  string `json:"affiliation_no"`
	ValidTo string `json:"affiliation_valid_to"`
}

/*
setBoardAffiliation records the affiliation and, crucially, its expiry.

	The school profile screen already edits the board and the number. It has
	never been able to record affiliation_valid_to, so the one date the
	correspondent has to act on was unreachable through the product and lived in
	a diary.
*/
func (s *Server) setBoardAffiliation(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platAffiliationUpdate
	if !httpx.Decode(w, r, &req) {
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE institutions
			   SET affiliation_board = $2,
			       affiliation_no = $3,
			       affiliation_valid_to = NULLIF($4,'')::date,
			       updated_at = now()
			 WHERE id = $1`,
			id.InstitutionID, nullString(strings.TrimSpace(req.Board)),
			nullString(strings.TrimSpace(req.Number)), strings.TrimSpace(req.ValidTo))
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	s.getBoardAffiliation(w, r)
}

type platDisclosureRequest struct {
	ID        string `json:"id,omitempty"`
	CampusID  string `json:"campus_id,omitempty"`
	Document  string `json:"document"`
	Title     string `json:"title"`
	Reference string `json:"reference_no,omitempty"`
	Authority string `json:"issuing_authority,omitempty"`
	IssuedOn  string `json:"issued_on,omitempty"`
	ValidTo   string `json:"valid_to,omitempty"`
	FileKey   string `json:"file_key,omitempty"`
	PublicURL string `json:"public_url,omitempty"`
	Notes     string `json:"notes,omitempty"`
}

func (s *Server) saveBoardDisclosure(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platDisclosureRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Document = strings.TrimSpace(req.Document)
	req.Title = strings.TrimSpace(req.Title)
	if req.Document == "" || req.Title == "" {
		httpx.BadRequest(w, r, "document and title are required")
		return
	}

	var campus any
	if req.CampusID != "" {
		cid, err := uuid.Parse(req.CampusID)
		if err != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campus = cid
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO board_disclosures
			    (institution_id, campus_id, document, title, reference_no,
			     issuing_authority, issued_on, valid_to, file_key, public_url, notes)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::date,NULLIF($8,'')::date,
			        NULLIF($9,''),NULLIF($10,''),NULLIF($11,''))
			ON CONFLICT (institution_id,
			             COALESCE(campus_id,'00000000-0000-0000-0000-000000000000'::uuid),
			             document)
			DO UPDATE SET title = EXCLUDED.title,
			              reference_no = EXCLUDED.reference_no,
			              issuing_authority = EXCLUDED.issuing_authority,
			              issued_on = EXCLUDED.issued_on,
			              valid_to = EXCLUDED.valid_to,
			              file_key = EXCLUDED.file_key,
			              public_url = EXCLUDED.public_url,
			              notes = EXCLUDED.notes,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, campus, req.Document, req.Title,
			nullString(strings.TrimSpace(req.Reference)),
			nullString(strings.TrimSpace(req.Authority)),
			strings.TrimSpace(req.IssuedOn), strings.TrimSpace(req.ValidTo),
			strings.TrimSpace(req.FileKey), strings.TrimSpace(req.PublicURL),
			strings.TrimSpace(req.Notes)).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteBoardDisclosure(w http.ResponseWriter, r *http.Request) {
	s.deleteOwnedRow(w, r, "board_disclosures")
}

/*
deleteOwnedRow removes one row of a tenant-scoped table by id.

	Shared because four screens here delete a row they own and the only thing
	that differs is the table name. The name is never taken from the request —
	it is a constant at each call site — so there is no injection surface, and
	row-level security is what actually stops a delete crossing tenants.
*/
func (s *Server) deleteOwnedRow(w http.ResponseWriter, r *http.Request, table string) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	rowID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var affected int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(),
			`DELETE FROM `+table+` WHERE id = $1 AND institution_id = $2`,
			rowID, id.InstitutionID)
		affected = ct.RowsAffected()
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- state board configuration -----------------------------------------------

// platBoards is the board vocabulary this screen configures against.
//
// Distinct from affiliationBoards in setup_profile.go, which records what the
// school is affiliated to. This is which rule set the exam and report-card
// logic follows, and Telangana's two state boards are separate answers.
var platBoards = []option{
	{"bse_ts_ssc", "BSE Telangana — SSC (class X)"},
	{"tsbie", "TSBIE — Intermediate (classes XI–XII)"},
	{"cbse", "CBSE"},
	{"icse", "CISCE — ICSE / ISC"},
	{"igcse", "Cambridge IGCSE"},
	{"ib", "International Baccalaureate"},
	{"other", "Other"},
}

var platStages = []option{
	{"primary", "Primary (I–V)"},
	{"upper_primary", "Upper primary (VI–VIII)"},
	{"secondary", "Secondary (IX–X)"},
	{"higher_secondary", "Higher secondary (XI–XII)"},
}

var platExamPatterns = []option{
	{"formative_summative", "Formative and summative (FA/SA)"},
	{"term_annual", "Term tests and an annual examination"},
	{"continuous", "Continuous and comprehensive"},
	{"semester", "Semester"},
}

type platBoardConfig struct {
	ID             string  `json:"id"`
	Board          string  `json:"board"`
	Stage          string  `json:"stage"`
	PassPercent    int     `json:"pass_percent"`
	MaxMarks       int     `json:"max_marks"`
	InternalWeight int     `json:"internal_weight_percent"`
	AttendanceMin  int     `json:"attendance_min_percent"`
	ExamPattern    string  `json:"exam_pattern"`
	GradingScaleID *string `json:"grading_scale_id,omitempty"`
	GradingScale   *string `json:"grading_scale,omitempty"`
	Medium         *string `json:"medium,omitempty"`
	IsDefault      bool    `json:"is_default"`
}

type platBoardConfigResponse struct {
	Items    []platBoardConfig `json:"items"`
	Boards   []option          `json:"boards"`
	Stages   []option          `json:"stages"`
	Patterns []option          `json:"exam_patterns"`
	Scales   []option          `json:"grading_scales"`
}

func (s *Server) listBoardConfigurations(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := platBoardConfigResponse{
		Items: []platBoardConfig{}, Boards: platBoards,
		Stages: platStages, Patterns: platExamPatterns, Scales: []option{},
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT b.id::text, b.board, b.stage, b.pass_percent, b.max_marks,
			       b.internal_weight_percent, b.attendance_min_percent,
			       b.exam_pattern, b.grading_scale_id::text, g.name, b.medium,
			       b.is_default
			  FROM board_configurations b
			  LEFT JOIN grading_scales g ON g.id = b.grading_scale_id
			 ORDER BY b.stage, b.board`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platBoardConfig
			if err := rows.Scan(&v.ID, &v.Board, &v.Stage, &v.PassPercent, &v.MaxMarks,
				&v.InternalWeight, &v.AttendanceMin, &v.ExamPattern,
				&v.GradingScaleID, &v.GradingScale, &v.Medium, &v.IsDefault); err != nil {
				return err
			}
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// The scales the school actually has, so the form offers a choice
		// rather than asking for a uuid.
		srows, err := tx.Query(r.Context(),
			`SELECT id::text, name FROM grading_scales ORDER BY name`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			var o option
			if err := srows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Scales = append(out.Scales, o)
		}
		return srows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platBoardConfigRequest struct {
	Board          string `json:"board"`
	Stage          string `json:"stage"`
	PassPercent    int    `json:"pass_percent"`
	MaxMarks       int    `json:"max_marks"`
	InternalWeight int    `json:"internal_weight_percent"`
	AttendanceMin  int    `json:"attendance_min_percent"`
	ExamPattern    string `json:"exam_pattern"`
	GradingScaleID string `json:"grading_scale_id,omitempty"`
	Medium         string `json:"medium,omitempty"`
	IsDefault      bool   `json:"is_default"`
}

func (s *Server) saveBoardConfiguration(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platBoardConfigRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Board) == "" || strings.TrimSpace(req.Stage) == "" {
		httpx.BadRequest(w, r, "board and stage are required")
		return
	}
	if req.MaxMarks == 0 {
		req.MaxMarks = 100
	}

	var scale any
	if req.GradingScaleID != "" {
		sid, err := uuid.Parse(req.GradingScaleID)
		if err != nil {
			httpx.BadRequest(w, r, "grading_scale_id must be a uuid")
			return
		}
		scale = sid
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Clear the old default first. The partial unique index refuses two,
		// so without this the second save fails with a constraint name the
		// admin cannot act on.
		if req.IsDefault {
			if _, err := tx.Exec(r.Context(), `
				UPDATE board_configurations SET is_default = false
				 WHERE institution_id = $1 AND is_default
				   AND NOT (board = $2 AND stage = $3)`,
				id.InstitutionID, req.Board, req.Stage); err != nil {
				return err
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO board_configurations
			    (institution_id, board, stage, pass_percent, max_marks,
			     internal_weight_percent, attendance_min_percent, exam_pattern,
			     grading_scale_id, medium, is_default)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''),$11)
			ON CONFLICT (institution_id, board, stage) DO UPDATE
			   SET pass_percent = EXCLUDED.pass_percent,
			       max_marks = EXCLUDED.max_marks,
			       internal_weight_percent = EXCLUDED.internal_weight_percent,
			       attendance_min_percent = EXCLUDED.attendance_min_percent,
			       exam_pattern = EXCLUDED.exam_pattern,
			       grading_scale_id = EXCLUDED.grading_scale_id,
			       medium = EXCLUDED.medium,
			       is_default = EXCLUDED.is_default,
			       updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, req.Board, req.Stage, req.PassPercent, req.MaxMarks,
			req.InternalWeight, req.AttendanceMin, req.ExamPattern, scale,
			strings.TrimSpace(req.Medium), req.IsDefault).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteBoardConfiguration(w http.ResponseWriter, r *http.Request) {
	s.deleteOwnedRow(w, r, "board_configurations")
}

// --- SQAA framework ----------------------------------------------------------

type platSQAAStandard struct {
	ID          string  `json:"id"`
	ParentID    *string `json:"parent_id,omitempty"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	WeightBP    int     `json:"weight_bp"`
	Evidence    bool    `json:"evidence_required"`
	Sequence    int     `json:"sequence"`
}

type platSQAAFramework struct {
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Authority     string  `json:"authority"`
	Version       string  `json:"version"`
	EffectiveFrom *string `json:"effective_from,omitempty"`
	Status        string  `json:"status"`
	Standards     int     `json:"standards"`
	// Whether the domain weights add to 100%. A framework that does not sum is
	// unusable for scoring and the screen must say so before anyone assesses
	// against it.
	WeightBP int `json:"weight_bp"`
}

type platSQAAResponse struct {
	Frameworks []platSQAAFramework `json:"frameworks"`
	Standards  []platSQAAStandard  `json:"standards"`
	Selected   string              `json:"selected,omitempty"`
}

/*
getSQAAFramework returns the frameworks and, for one of them, its standards.

	A bare GET picks the newest published framework rather than answering 400.
	The screen's first request carries no parameter and there is an obviously
	right default.
*/
func (s *Server) getSQAAFramework(w http.ResponseWriter, r *http.Request) {
	want := strings.TrimSpace(r.URL.Query().Get("framework"))
	out := platSQAAResponse{
		Frameworks: []platSQAAFramework{}, Standards: []platSQAAStandard{},
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT f.code, f.name, f.authority, f.version,
			       to_char(f.effective_from,'YYYY-MM-DD'), f.status,
			       (SELECT count(*) FROM sqaa_standards t
			         WHERE t.framework_code = f.code)::int,
			       COALESCE((SELECT sum(t.weight_bp) FROM sqaa_standards t
			                  WHERE t.framework_code = f.code
			                    AND t.parent_id IS NULL), 0)::int
			  FROM sqaa_frameworks f
			 ORDER BY f.status, f.effective_from DESC NULLS LAST, f.code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platSQAAFramework
			if err := rows.Scan(&v.Code, &v.Name, &v.Authority, &v.Version,
				&v.EffectiveFrom, &v.Status, &v.Standards, &v.WeightBP); err != nil {
				return err
			}
			out.Frameworks = append(out.Frameworks, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if want == "" {
			for _, f := range out.Frameworks {
				if f.Status == "published" {
					want = f.Code
					break
				}
			}
			if want == "" && len(out.Frameworks) > 0 {
				want = out.Frameworks[0].Code
			}
		}
		out.Selected = want
		if want == "" {
			return nil
		}

		srows, err := tx.Query(r.Context(), `
			SELECT id::text, parent_id::text, code, name, description,
			       weight_bp, evidence_required, sequence
			  FROM sqaa_standards
			 WHERE framework_code = $1
			 ORDER BY sequence, code`, want)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			var v platSQAAStandard
			if err := srows.Scan(&v.ID, &v.ParentID, &v.Code, &v.Name, &v.Description,
				&v.WeightBP, &v.Evidence, &v.Sequence); err != nil {
				return err
			}
			out.Standards = append(out.Standards, v)
		}
		return srows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platSQAAFrameworkRequest struct {
	Code          string `json:"code"`
	Name          string `json:"name"`
	Authority     string `json:"authority"`
	Version       string `json:"version"`
	EffectiveFrom string `json:"effective_from,omitempty"`
	Status        string `json:"status,omitempty"`
}

func (s *Server) saveSQAAFramework(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platSQAAFrameworkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" || strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "code and name are required")
		return
	}
	if req.Status == "" {
		req.Status = "draft"
	}
	if req.Version == "" {
		req.Version = "1"
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO sqaa_frameworks (code, name, authority, version, effective_from, status)
			VALUES ($1,$2,$3,$4,NULLIF($5,'')::date,$6)
			ON CONFLICT (code) DO UPDATE
			   SET name = EXCLUDED.name, authority = EXCLUDED.authority,
			       version = EXCLUDED.version,
			       effective_from = EXCLUDED.effective_from,
			       status = EXCLUDED.status`,
			req.Code, strings.TrimSpace(req.Name), strings.TrimSpace(req.Authority),
			req.Version, strings.TrimSpace(req.EffectiveFrom), req.Status)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"code": req.Code})
}

type platSQAAStandardRequest struct {
	ID          string `json:"id,omitempty"`
	Framework   string `json:"framework_code"`
	ParentID    string `json:"parent_id,omitempty"`
	Code        string `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	WeightBP    int    `json:"weight_bp"`
	Evidence    bool   `json:"evidence_required"`
	Sequence    int    `json:"sequence"`
}

func (s *Server) saveSQAAStandard(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platSQAAStandardRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Framework) == "" || strings.TrimSpace(req.Code) == "" ||
		strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "framework_code, code and name are required")
		return
	}

	var parent any
	if req.ParentID != "" {
		pid, err := uuid.Parse(req.ParentID)
		if err != nil {
			httpx.BadRequest(w, r, "parent_id must be a uuid")
			return
		}
		parent = pid
	}

	var out string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO sqaa_standards
			    (framework_code, parent_id, code, name, description,
			     weight_bp, evidence_required, sequence)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8)
			ON CONFLICT (framework_code,
			             COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),
			             code)
			DO UPDATE SET name = EXCLUDED.name,
			              description = EXCLUDED.description,
			              weight_bp = EXCLUDED.weight_bp,
			              evidence_required = EXCLUDED.evidence_required,
			              sequence = EXCLUDED.sequence
			RETURNING id::text`,
			strings.TrimSpace(req.Framework), parent, strings.TrimSpace(req.Code),
			strings.TrimSpace(req.Name), strings.TrimSpace(req.Description),
			req.WeightBP, req.Evidence, req.Sequence).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteSQAAStandard(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var affected int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `DELETE FROM sqaa_standards WHERE id = $1`, id)
		affected = ct.RowsAffected()
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- school management type, per campus --------------------------------------

type platCampusClass struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Code           string  `json:"code"`
	City           *string `json:"city,omitempty"`
	Status         string  `json:"status"`
	ManagementType *string `json:"management_type,omitempty"`
	SchoolCategory *string `json:"school_category,omitempty"`
	UDISECode      *string `json:"udise_code,omitempty"`
	Students       int     `json:"students"`
}

type platCampusClassResponse struct {
	Items []platCampusClass `json:"items"`
	// The school's own classification, shown beside the campuses so an
	// operator can see which campus departs from it.
	InstitutionManagement *string  `json:"institution_management_type,omitempty"`
	InstitutionCategory   *string  `json:"institution_school_category,omitempty"`
	ManagementTypes       []option `json:"management_types"`
	SchoolCategories      []option `json:"school_categories"`
	Unclassified          int      `json:"unclassified"`
}

func (s *Server) listCampusClassification(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := platCampusClassResponse{
		Items: []platCampusClass{}, ManagementTypes: managementTypes,
		SchoolCategories: schoolCategories,
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT management_type, school_category FROM institutions WHERE id = $1`,
			id.InstitutionID).Scan(&out.InstitutionManagement, &out.InstitutionCategory); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, c.name, c.code, c.city, c.status,
			       c.management_type, c.school_category, c.udise_code,
			       (SELECT count(*) FROM students st
			         WHERE st.campus_id = c.id AND st.status = 'active')::int
			  FROM campuses c ORDER BY c.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platCampusClass
			if err := rows.Scan(&v.ID, &v.Name, &v.Code, &v.City, &v.Status,
				&v.ManagementType, &v.SchoolCategory, &v.UDISECode, &v.Students); err != nil {
				return err
			}
			out.Items = append(out.Items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	for _, c := range out.Items {
		if c.ManagementType == nil {
			out.Unclassified++
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platCampusClassRequest struct {
	ManagementType string `json:"management_type,omitempty"`
	SchoolCategory string `json:"school_category,omitempty"`
	UDISECode      string `json:"udise_code,omitempty"`
}

func (s *Server) setCampusClassification(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	campus, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req platCampusClassRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var affected int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE campuses
			   SET management_type = NULLIF($3,''),
			       school_category = NULLIF($4,''),
			       udise_code = NULLIF($5,''),
			       updated_at = now()
			 WHERE id = $1 AND institution_id = $2`,
			campus, id.InstitutionID, strings.TrimSpace(req.ManagementType),
			strings.TrimSpace(req.SchoolCategory), strings.TrimSpace(req.UDISECode))
		affected = ct.RowsAffected()
		return err
	})
	if err != nil {
		// A check constraint here is a real answer: an eleven-digit rule and a
		// closed vocabulary are things the person filling the form must know.
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": true})
}

// --- the academic calendar model ---------------------------------------------

type platCalendarModel struct {
	SchoolYearStartMonth    int    `json:"school_year_start_month"`
	SchoolYearEndMonth      int    `json:"school_year_end_month"`
	FinancialYearStartMonth int    `json:"financial_year_start_month"`
	TermCount               int    `json:"term_count"`
	WeekStartDay            int    `json:"week_start_day"`
	WorkingDaysPerWeek      int    `json:"working_days_per_week"`
	SaturdayPattern         string `json:"saturday_pattern"`
	RequiredWorkingDays     int    `json:"required_working_days"`

	// The two years side by side, as a person would say them. The whole reason
	// this screen exists: a receipt dated 5 June belongs to school year 2026-27
	// and financial year 2026-27, and on 5 March those two disagree.
	SchoolYearLabel    string `json:"school_year_label"`
	FinancialYearLabel string `json:"financial_year_label"`

	// What the school has actually created, so the model can be checked
	// against reality rather than admired on its own.
	Years []platAcademicYear `json:"academic_years"`
	// Terms defined for the current year, against term_count.
	CurrentTerms int `json:"current_terms"`
}

type platAcademicYear struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	StartsOn  string `json:"starts_on"`
	EndsOn    string `json:"ends_on"`
	IsCurrent bool   `json:"is_current"`
	Terms     int    `json:"terms"`
	// Whether the year's dates match the configured model. A year running
	// April to March in a June-to-April school is the mistake this catches.
	MatchesModel bool `json:"matches_model"`
}

// platSchoolYearLabel renders the school year containing t under a model that
// starts in startMonth, as "2026-27".
//
// Separate arithmetic from fees.FinancialYear on purpose. They agree for a
// school that opens in April and differ for one that opens in June, and
// collapsing them is exactly the bug this screen was built to end.
func platSchoolYearLabel(t time.Time, startMonth int) string {
	y := t.Year()
	if int(t.Month()) < startMonth {
		y--
	}
	return fmt.Sprintf("%d-%02d", y, (y+1)%100)
}

func (s *Server) getCalendarModel(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	// The defaults are the schema's, restated here so a school that has never
	// opened this screen gets a usable answer instead of an empty body.
	out := platCalendarModel{
		SchoolYearStartMonth: 6, SchoolYearEndMonth: 4, FinancialYearStartMonth: 4,
		TermCount: 3, WeekStartDay: 1, WorkingDaysPerWeek: 6,
		SaturdayPattern: "all", RequiredWorkingDays: 220,
		Years: []platAcademicYear{},
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT school_year_start_month, school_year_end_month,
			       financial_year_start_month, term_count, week_start_day,
			       working_days_per_week, saturday_pattern, required_working_days
			  FROM academic_calendar_models WHERE institution_id = $1`,
			id.InstitutionID).
			Scan(&out.SchoolYearStartMonth, &out.SchoolYearEndMonth,
				&out.FinancialYearStartMonth, &out.TermCount, &out.WeekStartDay,
				&out.WorkingDaysPerWeek, &out.SaturdayPattern, &out.RequiredWorkingDays)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT y.id::text, y.name, to_char(y.starts_on,'YYYY-MM-DD'),
			       to_char(y.ends_on,'YYYY-MM-DD'), y.is_current,
			       (SELECT count(*) FROM terms t WHERE t.academic_year_id = y.id)::int,
			       extract(month FROM y.starts_on)::int
			  FROM academic_years y ORDER BY y.starts_on DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platAcademicYear
			var startMonth int
			if err := rows.Scan(&v.ID, &v.Name, &v.StartsOn, &v.EndsOn,
				&v.IsCurrent, &v.Terms, &startMonth); err != nil {
				return err
			}
			v.MatchesModel = startMonth == out.SchoolYearStartMonth
			if v.IsCurrent {
				out.CurrentTerms = v.Terms
			}
			out.Years = append(out.Years, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	now := nowInIndia()
	out.SchoolYearLabel = platSchoolYearLabel(now, out.SchoolYearStartMonth)
	out.FinancialYearLabel = fees.FinancialYear(now)
	httpx.JSON(w, http.StatusOK, out)
}

type platCalendarRequest struct {
	SchoolYearStartMonth int    `json:"school_year_start_month"`
	SchoolYearEndMonth   int    `json:"school_year_end_month"`
	TermCount            int    `json:"term_count"`
	WeekStartDay         int    `json:"week_start_day"`
	WorkingDaysPerWeek   int    `json:"working_days_per_week"`
	SaturdayPattern      string `json:"saturday_pattern"`
	RequiredWorkingDays  int    `json:"required_working_days"`
}

/*
setCalendarModel stores the school year, and deliberately not the financial one.

	April to March is the Income Tax Act's, not the school's, and a field that
	lets somebody set it to July produces receipts filed under a year that does
	not exist. It stays at the column default and the screen shows it as fixed.
*/
func (s *Server) setCalendarModel(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platCalendarRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO academic_calendar_models
			    (institution_id, school_year_start_month, school_year_end_month,
			     term_count, week_start_day, working_days_per_week,
			     saturday_pattern, required_working_days)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (institution_id) DO UPDATE
			   SET school_year_start_month = EXCLUDED.school_year_start_month,
			       school_year_end_month = EXCLUDED.school_year_end_month,
			       term_count = EXCLUDED.term_count,
			       week_start_day = EXCLUDED.week_start_day,
			       working_days_per_week = EXCLUDED.working_days_per_week,
			       saturday_pattern = EXCLUDED.saturday_pattern,
			       required_working_days = EXCLUDED.required_working_days,
			       updated_at = now()`,
			id.InstitutionID, req.SchoolYearStartMonth, req.SchoolYearEndMonth,
			req.TermCount, req.WeekStartDay, req.WorkingDaysPerWeek,
			req.SaturdayPattern, req.RequiredWorkingDays)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	s.getCalendarModel(w, r)
}

// --- branding and white-label ------------------------------------------------

type platBranding struct {
	ID       string  `json:"id"`
	CampusID *string `json:"campus_id,omitempty"`
	Campus   *string `json:"campus,omitempty"`

	DisplayName  *string `json:"display_name,omitempty"`
	Tagline      *string `json:"tagline,omitempty"`
	LogoKey      *string `json:"logo_key,omitempty"`
	WordmarkKey  *string `json:"wordmark_key,omitempty"`
	FaviconKey   *string `json:"favicon_key,omitempty"`
	PrimaryColor *string `json:"primary_color,omitempty"`
	AccentColor  *string `json:"accent_color,omitempty"`

	CustomDomain     *string `json:"custom_domain,omitempty"`
	DomainVerifiedAt *string `json:"domain_verified_at,omitempty"`
	LoginHeadline    *string `json:"login_headline,omitempty"`
	LoginMessage     *string `json:"login_message,omitempty"`
	LoginBannerKey   *string `json:"login_banner_key,omitempty"`
	EmailHeaderKey   *string `json:"email_header_key,omitempty"`
	EmailFooterHTML  *string `json:"email_footer_html,omitempty"`
	EmailFromName    *string `json:"email_from_name,omitempty"`
	SupportEmail     *string `json:"support_email,omitempty"`
	SupportPhone     *string `json:"support_phone,omitempty"`
}

type platBrandingResponse struct {
	Items []platBranding `json:"items"`
	// The institution row, which stays authoritative for the app header. Shown
	// so an operator can see what a profile is overriding rather than guessing.
	InstitutionName  string   `json:"institution_name"`
	InstitutionLogo  *string  `json:"institution_logo_key,omitempty"`
	InstitutionColor string   `json:"institution_primary_color"`
	Campuses         []option `json:"campuses"`
	// Storage is unconfigured on this installation until R2 credentials are
	// real, so a logo cannot actually be uploaded. Stated rather than
	// discovered when the upload button returns 503.
	UploadsAvailable bool `json:"uploads_available"`
}

func (s *Server) listBrandingProfiles(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := platBrandingResponse{
		Items: []platBranding{}, Campuses: []option{},
		UploadsAvailable: s.Storage != nil,
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT name, logo_key, primary_color FROM institutions WHERE id = $1`,
			id.InstitutionID).
			Scan(&out.InstitutionName, &out.InstitutionLogo, &out.InstitutionColor); err != nil {
			return err
		}

		crows, err := tx.Query(r.Context(),
			`SELECT id::text, name FROM campuses ORDER BY name`)
		if err != nil {
			return err
		}
		defer crows.Close()
		for crows.Next() {
			var o option
			if err := crows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Campuses = append(out.Campuses, o)
		}
		if err := crows.Err(); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT b.id::text, b.campus_id::text, c.name,
			       b.display_name, b.tagline, b.logo_key, b.wordmark_key, b.favicon_key,
			       b.primary_color, b.accent_color,
			       b.custom_domain, b.domain_verified_at,
			       b.login_headline, b.login_message, b.login_banner_key,
			       b.email_header_key, b.email_footer_html, b.email_from_name,
			       b.support_email, b.support_phone
			  FROM branding_profiles b
			  LEFT JOIN campuses c ON c.id = b.campus_id
			 ORDER BY b.campus_id NULLS FIRST`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platBranding
			var verified *time.Time
			if err := rows.Scan(&v.ID, &v.CampusID, &v.Campus, &v.DisplayName,
				&v.Tagline, &v.LogoKey, &v.WordmarkKey, &v.FaviconKey,
				&v.PrimaryColor, &v.AccentColor, &v.CustomDomain, &verified,
				&v.LoginHeadline, &v.LoginMessage, &v.LoginBannerKey,
				&v.EmailHeaderKey, &v.EmailFooterHTML, &v.EmailFromName,
				&v.SupportEmail, &v.SupportPhone); err != nil {
				return err
			}
			v.DomainVerifiedAt = nullTime(verified)
			out.Items = append(out.Items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platBrandingRequest struct {
	CampusID string `json:"campus_id,omitempty"`

	DisplayName  string `json:"display_name,omitempty"`
	Tagline      string `json:"tagline,omitempty"`
	LogoKey      string `json:"logo_key,omitempty"`
	WordmarkKey  string `json:"wordmark_key,omitempty"`
	FaviconKey   string `json:"favicon_key,omitempty"`
	PrimaryColor string `json:"primary_color,omitempty"`
	AccentColor  string `json:"accent_color,omitempty"`

	CustomDomain    string `json:"custom_domain,omitempty"`
	LoginHeadline   string `json:"login_headline,omitempty"`
	LoginMessage    string `json:"login_message,omitempty"`
	LoginBannerKey  string `json:"login_banner_key,omitempty"`
	EmailHeaderKey  string `json:"email_header_key,omitempty"`
	EmailFooterHTML string `json:"email_footer_html,omitempty"`
	EmailFromName   string `json:"email_from_name,omitempty"`
	SupportEmail    string `json:"support_email,omitempty"`
	SupportPhone    string `json:"support_phone,omitempty"`
}

/*
saveBrandingProfile upserts the school-wide profile or one campus's.

	Changing the custom domain clears its verification. A host that was proven
	to reach this installation last month says nothing about the one typed
	today, and leaving the flag set is how an unreachable domain goes live.
*/
func (s *Server) saveBrandingProfile(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platBrandingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var campus any
	if req.CampusID != "" {
		cid, err := uuid.Parse(req.CampusID)
		if err != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campus = cid
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO branding_profiles
			    (institution_id, campus_id, display_name, tagline, logo_key,
			     wordmark_key, favicon_key, primary_color, accent_color,
			     custom_domain, login_headline, login_message, login_banner_key,
			     email_header_key, email_footer_html, email_from_name,
			     support_email, support_phone)
			VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),
			        NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF(lower($10),''),
			        NULLIF($11,''),NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),
			        NULLIF($15,''),NULLIF($16,''),NULLIF($17,''),NULLIF($18,''))
			ON CONFLICT (institution_id,
			             COALESCE(campus_id,'00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET display_name = EXCLUDED.display_name,
			              tagline = EXCLUDED.tagline,
			              logo_key = EXCLUDED.logo_key,
			              wordmark_key = EXCLUDED.wordmark_key,
			              favicon_key = EXCLUDED.favicon_key,
			              primary_color = EXCLUDED.primary_color,
			              accent_color = EXCLUDED.accent_color,
			              custom_domain = EXCLUDED.custom_domain,
			              domain_verified_at = CASE
			                  WHEN branding_profiles.custom_domain IS DISTINCT FROM EXCLUDED.custom_domain
			                  THEN NULL ELSE branding_profiles.domain_verified_at END,
			              login_headline = EXCLUDED.login_headline,
			              login_message = EXCLUDED.login_message,
			              login_banner_key = EXCLUDED.login_banner_key,
			              email_header_key = EXCLUDED.email_header_key,
			              email_footer_html = EXCLUDED.email_footer_html,
			              email_from_name = EXCLUDED.email_from_name,
			              support_email = EXCLUDED.support_email,
			              support_phone = EXCLUDED.support_phone,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, campus, strings.TrimSpace(req.DisplayName),
			strings.TrimSpace(req.Tagline), strings.TrimSpace(req.LogoKey),
			strings.TrimSpace(req.WordmarkKey), strings.TrimSpace(req.FaviconKey),
			strings.TrimSpace(req.PrimaryColor), strings.TrimSpace(req.AccentColor),
			strings.TrimSpace(req.CustomDomain), strings.TrimSpace(req.LoginHeadline),
			strings.TrimSpace(req.LoginMessage), strings.TrimSpace(req.LoginBannerKey),
			strings.TrimSpace(req.EmailHeaderKey), strings.TrimSpace(req.EmailFooterHTML),
			strings.TrimSpace(req.EmailFromName), strings.TrimSpace(req.SupportEmail),
			strings.TrimSpace(req.SupportPhone)).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

/*
verifyBrandingDomain records that a custom host reaches this installation.

	The check itself is not made here and must not be: the only proof that
	school.example.edu resolves to this box is that the operator has added it
	to the ingress and to the certificate. This endpoint records that decision
	so the sign-in page has a flag to consult, and it is the vendor's to make.
*/
func (s *Server) verifyBrandingDomain(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	rowID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var domain *string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE branding_profiles
			   SET domain_verified_at = now(), updated_at = now()
			 WHERE id = $1 AND custom_domain IS NOT NULL
			RETURNING custom_domain`, rowID).Scan(&domain)
	})
	if err == pgx.ErrNoRows {
		httpx.BadRequest(w, r, "no such profile, or it has no custom domain to verify")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"custom_domain": domain, "verified": true})
}

// --- franchise chains --------------------------------------------------------

type platFranchiseMember struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	District      *string `json:"district,omitempty"`
	Status        string  `json:"status"`
	AgreementNo   *string `json:"agreement_no,omitempty"`
	JoinedOn      string  `json:"joined_on"`
	RenewsOn      *string `json:"renews_on,omitempty"`
	AnnualFee     int64   `json:"annual_fee_paise"`
	Compliance    *int    `json:"compliance_percent,omitempty"`
	LastAudited   *string `json:"last_audited_on,omitempty"`
	Students      int     `json:"students"`
}

type platFranchise struct {
	ID             string  `json:"id"`
	Code           string  `json:"code"`
	Name           string  `json:"name"`
	BrandOwner     *string `json:"brand_owner,omitempty"`
	RoyaltyBP      int     `json:"royalty_bp"`
	ContactName    *string `json:"contact_name,omitempty"`
	ContactEmail   *string `json:"contact_email,omitempty"`
	ContactPhone   *string `json:"contact_phone,omitempty"`
	BrandStandards *string `json:"brand_standards,omitempty"`
	Status         string  `json:"status"`

	Members  int   `json:"members"`
	Students int   `json:"students"`
	FeePaise int64 `json:"annual_fee_paise"`
	// Mean brand-audit score across members that have been audited. Null when
	// none has been, which is not the same as zero.
	Compliance *int `json:"compliance_percent,omitempty"`
	// Members never audited. The number a brand manager works from.
	NeverAudited int `json:"never_audited"`
}

type platFranchiseResponse struct {
	Items   []platFranchise       `json:"items"`
	Members []platFranchiseMember `json:"members"`
	// Schools on the installation not attached to any chain, so a chain can be
	// built without leaving the screen.
	Unattached []option `json:"unattached"`
	Selected   string   `json:"selected,omitempty"`
}

func (s *Server) listFranchises(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	want := strings.TrimSpace(r.URL.Query().Get("franchise_id"))
	out := platFranchiseResponse{
		Items: []platFranchise{}, Members: []platFranchiseMember{},
		Unattached: []option{},
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT f.id::text, f.code, f.name, f.brand_owner, f.royalty_bp,
			       f.contact_name, f.contact_email, f.contact_phone,
			       f.brand_standards, f.status,
			       (SELECT count(*) FROM franchise_members m
			         WHERE m.franchise_id = f.id)::int,
			       COALESCE((SELECT count(*) FROM franchise_members m
			                   JOIN students st ON st.institution_id = m.institution_id
			                                   AND st.status = 'active'
			                  WHERE m.franchise_id = f.id), 0)::int,
			       COALESCE((SELECT sum(m.annual_fee_paise) FROM franchise_members m
			                  WHERE m.franchise_id = f.id), 0),
			       (SELECT avg(m.compliance_percent)::int FROM franchise_members m
			         WHERE m.franchise_id = f.id AND m.compliance_percent IS NOT NULL),
			       (SELECT count(*) FROM franchise_members m
			         WHERE m.franchise_id = f.id AND m.last_audited_on IS NULL)::int
			  FROM franchises f ORDER BY f.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platFranchise
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.BrandOwner, &v.RoyaltyBP,
				&v.ContactName, &v.ContactEmail, &v.ContactPhone, &v.BrandStandards,
				&v.Status, &v.Members, &v.Students, &v.FeePaise, &v.Compliance,
				&v.NeverAudited); err != nil {
				return err
			}
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if want == "" && len(out.Items) > 0 {
			want = out.Items[0].ID
		}
		out.Selected = want

		if want != "" {
			fid, err := uuid.Parse(want)
			if err != nil {
				return errBadLocationID
			}
			mrows, err := tx.Query(r.Context(), `
				SELECT m.institution_id::text, i.name, i.district, i.status,
				       m.agreement_no, to_char(m.joined_on,'YYYY-MM-DD'),
				       to_char(m.renews_on,'YYYY-MM-DD'), m.annual_fee_paise,
				       m.compliance_percent, to_char(m.last_audited_on,'YYYY-MM-DD'),
				       (SELECT count(*) FROM students st
				         WHERE st.institution_id = i.id AND st.status = 'active')::int
				  FROM franchise_members m
				  JOIN institutions i ON i.id = m.institution_id
				 WHERE m.franchise_id = $1
				 ORDER BY i.name`, fid)
			if err != nil {
				return err
			}
			defer mrows.Close()
			for mrows.Next() {
				var v platFranchiseMember
				if err := mrows.Scan(&v.InstitutionID, &v.School, &v.District, &v.Status,
					&v.AgreementNo, &v.JoinedOn, &v.RenewsOn, &v.AnnualFee,
					&v.Compliance, &v.LastAudited, &v.Students); err != nil {
					return err
				}
				out.Members = append(out.Members, v)
			}
			if err := mrows.Err(); err != nil {
				return err
			}
		}

		urows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name
			  FROM institutions i
			 WHERE i.status = 'active'
			   AND NOT EXISTS (SELECT 1 FROM franchise_members m
			                    WHERE m.institution_id = i.id)
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer urows.Close()
		for urows.Next() {
			var o option
			if err := urows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Unattached = append(out.Unattached, o)
		}
		return urows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platFranchiseRequest struct {
	ID             string `json:"id,omitempty"`
	Code           string `json:"code"`
	Name           string `json:"name"`
	BrandOwner     string `json:"brand_owner,omitempty"`
	RoyaltyBP      int    `json:"royalty_bp"`
	ContactName    string `json:"contact_name,omitempty"`
	ContactEmail   string `json:"contact_email,omitempty"`
	ContactPhone   string `json:"contact_phone,omitempty"`
	BrandStandards string `json:"brand_standards,omitempty"`
	Status         string `json:"status,omitempty"`
}

func (s *Server) saveFranchise(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platFranchiseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Name = strings.TrimSpace(req.Name)
	if req.Code == "" || req.Name == "" {
		httpx.BadRequest(w, r, "code and name are required")
		return
	}
	if req.Status == "" {
		req.Status = "active"
	}

	var out string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO franchises (code, name, brand_owner, royalty_bp, contact_name,
			                        contact_email, contact_phone, brand_standards, status)
			VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),NULLIF($6,''),
			        NULLIF($7,''),NULLIF($8,''),$9)
			ON CONFLICT (code) DO UPDATE
			   SET name = EXCLUDED.name, brand_owner = EXCLUDED.brand_owner,
			       royalty_bp = EXCLUDED.royalty_bp,
			       contact_name = EXCLUDED.contact_name,
			       contact_email = EXCLUDED.contact_email,
			       contact_phone = EXCLUDED.contact_phone,
			       brand_standards = EXCLUDED.brand_standards,
			       status = EXCLUDED.status
			RETURNING id::text`,
			req.Code, req.Name, strings.TrimSpace(req.BrandOwner), req.RoyaltyBP,
			strings.TrimSpace(req.ContactName), strings.TrimSpace(req.ContactEmail),
			strings.TrimSpace(req.ContactPhone), strings.TrimSpace(req.BrandStandards),
			req.Status).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

type platFranchiseMemberRequest struct {
	FranchiseID   string `json:"franchise_id"`
	InstitutionID string `json:"institution_id"`
	AgreementNo   string `json:"agreement_no,omitempty"`
	JoinedOn      string `json:"joined_on,omitempty"`
	RenewsOn      string `json:"renews_on,omitempty"`
	AnnualFee     int64  `json:"annual_fee_paise"`
	Compliance    *int   `json:"compliance_percent,omitempty"`
	LastAudited   string `json:"last_audited_on,omitempty"`
	Notes         string `json:"notes,omitempty"`
}

func (s *Server) saveFranchiseMember(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platFranchiseMemberRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	fid, err := uuid.Parse(strings.TrimSpace(req.FranchiseID))
	if err != nil {
		httpx.BadRequest(w, r, "franchise_id must be a uuid")
		return
	}
	iid, err := uuid.Parse(strings.TrimSpace(req.InstitutionID))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id must be a uuid")
		return
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO franchise_members
			    (institution_id, franchise_id, agreement_no, joined_on, renews_on,
			     annual_fee_paise, compliance_percent, last_audited_on, notes)
			VALUES ($1,$2,NULLIF($3,''),COALESCE(NULLIF($4,'')::date, CURRENT_DATE),
			        NULLIF($5,'')::date,$6,$7,NULLIF($8,'')::date,NULLIF($9,''))
			ON CONFLICT (institution_id) DO UPDATE
			   SET franchise_id = EXCLUDED.franchise_id,
			       agreement_no = EXCLUDED.agreement_no,
			       joined_on = EXCLUDED.joined_on,
			       renews_on = EXCLUDED.renews_on,
			       annual_fee_paise = EXCLUDED.annual_fee_paise,
			       compliance_percent = EXCLUDED.compliance_percent,
			       last_audited_on = EXCLUDED.last_audited_on,
			       notes = EXCLUDED.notes,
			       updated_at = now()`,
			iid, fid, strings.TrimSpace(req.AgreementNo), strings.TrimSpace(req.JoinedOn),
			strings.TrimSpace(req.RenewsOn), req.AnnualFee, req.Compliance,
			strings.TrimSpace(req.LastAudited), strings.TrimSpace(req.Notes))
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"institution_id": iid.String()})
}

func (s *Server) removeFranchiseMember(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	iid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be an institution uuid")
		return
	}
	var affected int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(),
			`DELETE FROM franchise_members WHERE institution_id = $1`, iid)
		affected = ct.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
}

type platOwnFranchise struct {
	Member *platFranchiseMember `json:"membership,omitempty"`
	Chain  *platFranchise       `json:"chain,omitempty"`
}

/*
getOwnFranchise is a member school's view of the chain it belongs to.

	Deliberately its own endpoint rather than a filter on the roster: a school
	is entitled to know its brand obligations and its royalty, and entitled to
	know nothing about the other twelve schools in the chain. Reading the
	membership through row-level security and then fetching only that one chain
	is what keeps the second half true.
*/
func (s *Server) getOwnFranchise(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := platOwnFranchise{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var m platFranchiseMember
		var chainID string
		err := tx.QueryRow(r.Context(), `
			SELECT m.franchise_id::text, m.institution_id::text, i.name, i.district,
			       i.status, m.agreement_no, to_char(m.joined_on,'YYYY-MM-DD'),
			       to_char(m.renews_on,'YYYY-MM-DD'), m.annual_fee_paise,
			       m.compliance_percent, to_char(m.last_audited_on,'YYYY-MM-DD')
			  FROM franchise_members m
			  JOIN institutions i ON i.id = m.institution_id
			 WHERE m.institution_id = $1`, id.InstitutionID).
			Scan(&chainID, &m.InstitutionID, &m.School, &m.District, &m.Status,
				&m.AgreementNo, &m.JoinedOn, &m.RenewsOn, &m.AnnualFee,
				&m.Compliance, &m.LastAudited)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		out.Member = &m

		var c platFranchise
		if err := tx.QueryRow(r.Context(), `
			SELECT id::text, code, name, brand_owner, royalty_bp, contact_name,
			       contact_email, contact_phone, brand_standards, status
			  FROM franchises WHERE id = $1`, chainID).
			Scan(&c.ID, &c.Code, &c.Name, &c.BrandOwner, &c.RoyaltyBP,
				&c.ContactName, &c.ContactEmail, &c.ContactPhone,
				&c.BrandStandards, &c.Status); err != nil {
			return err
		}
		out.Chain = &c
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- numbering and templates -------------------------------------------------

// platNumberingKinds is what a school actually issues a series for.
//
// receipt and invoice are what internal/fees already creates on demand; the
// rest exist because a school issues them by hand today and the series drifts.
var platNumberingKinds = []option{
	{"receipt", "Fee receipt"},
	{"invoice", "Fee invoice"},
	{"admission", "Admission number"},
	{"student_id", "Student ID card"},
	{"employee", "Employee code"},
	{"certificate", "Certificate serial"},
	{"transfer_certificate", "Transfer certificate"},
	{"voucher", "Accounting voucher"},
}

type platNumberingScheme struct {
	ID          string  `json:"id"`
	CampusID    *string `json:"campus_id,omitempty"`
	Campus      *string `json:"campus,omitempty"`
	Kind        string  `json:"kind"`
	Prefix      string  `json:"prefix"`
	Suffix      string  `json:"suffix"`
	Padding     int     `json:"padding"`
	NextValue   int64   `json:"next_value"`
	ResetYearly bool    `json:"reset_yearly"`
	// What the next document will actually be called. The only way to check a
	// prefix change before a cashier issues four hundred receipts with it.
	Preview string `json:"preview"`
}

type platTemplate struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Approval bool   `json:"requires_approval"`
	// Whether a body has been written at all. The HTML itself is not returned
	// in the list: it is long, and a list of eight templates would carry
	// several hundred kilobytes nobody reads.
	HasTemplate bool `json:"has_template"`
	Length      int  `json:"template_length"`
}

type platNumberingResponse struct {
	Items     []platNumberingScheme `json:"items"`
	Templates []platTemplate        `json:"templates"`
	Kinds     []option              `json:"kinds"`
	Campuses  []option              `json:"campuses"`
	// The financial year the yearly reset is currently issuing under, so the
	// preview above can be read without knowing the rule.
	FinancialYear string `json:"financial_year"`
}

// platPreviewNumber renders what the next document will be called.
//
// The same arithmetic as internal/fees.NextNumber, which is the risk: two
// copies drift. It is repeated rather than exported because NextNumber
// consumes the number as it formats it, and a preview that burns a receipt
// serial every time somebody opens a settings screen would put gaps in the
// series an auditor asks about.
func platPreviewNumber(prefix, suffix string, padding int, next int64, resetYearly bool, now time.Time) string {
	if resetYearly {
		return fmt.Sprintf("%s%s/%0*d%s", prefix, fees.FinancialYear(now), padding, next, suffix)
	}
	return fmt.Sprintf("%s%0*d%s", prefix, padding, next, suffix)
}

func (s *Server) getNumberingAndTemplates(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	now := nowInIndia()
	out := platNumberingResponse{
		Items: []platNumberingScheme{}, Templates: []platTemplate{},
		Kinds: platNumberingKinds, Campuses: []option{},
		FinancialYear: fees.FinancialYear(now),
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT n.id::text, n.campus_id::text, c.name, n.kind, n.prefix, n.suffix,
			       n.padding, n.next_value, n.reset_yearly
			  FROM numbering_schemes n
			  LEFT JOIN campuses c ON c.id = n.campus_id
			 ORDER BY n.kind, n.campus_id NULLS FIRST`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platNumberingScheme
			if err := rows.Scan(&v.ID, &v.CampusID, &v.Campus, &v.Kind, &v.Prefix,
				&v.Suffix, &v.Padding, &v.NextValue, &v.ResetYearly); err != nil {
				return err
			}
			v.Preview = platPreviewNumber(v.Prefix, v.Suffix, v.Padding,
				v.NextValue, v.ResetYearly, now)
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		trows, err := tx.Query(r.Context(), `
			SELECT id::text, code, name, requires_approval,
			       template_html IS NOT NULL AND template_html <> '',
			       COALESCE(length(template_html),0)
			  FROM certificate_types ORDER BY name`)
		if err != nil {
			return err
		}
		defer trows.Close()
		for trows.Next() {
			var v platTemplate
			if err := trows.Scan(&v.ID, &v.Code, &v.Name, &v.Approval,
				&v.HasTemplate, &v.Length); err != nil {
				return err
			}
			out.Templates = append(out.Templates, v)
		}
		if err := trows.Err(); err != nil {
			return err
		}

		crows, err := tx.Query(r.Context(), `SELECT id::text, name FROM campuses ORDER BY name`)
		if err != nil {
			return err
		}
		defer crows.Close()
		for crows.Next() {
			var o option
			if err := crows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Campuses = append(out.Campuses, o)
		}
		return crows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platNumberingRequest struct {
	CampusID    string `json:"campus_id,omitempty"`
	Kind        string `json:"kind"`
	Prefix      string `json:"prefix"`
	Suffix      string `json:"suffix,omitempty"`
	Padding     int    `json:"padding"`
	NextValue   int64  `json:"next_value"`
	ResetYearly bool   `json:"reset_yearly"`
}

/*
saveNumberingScheme creates or amends a series.

	next_value may only move forward. Rewinding it re-issues receipt numbers
	that are already printed and in a parent's hand, and a duplicate receipt
	number is the single hardest thing to explain to an auditor.
*/
func (s *Server) saveNumberingScheme(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platNumberingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Kind = strings.TrimSpace(req.Kind)
	if req.Kind == "" {
		httpx.BadRequest(w, r, "kind is required")
		return
	}
	if req.Padding <= 0 {
		req.Padding = 5
	}
	if req.NextValue <= 0 {
		req.NextValue = 1
	}

	var campus any
	if req.CampusID != "" {
		cid, err := uuid.Parse(req.CampusID)
		if err != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campus = cid
	}

	var out platNumberingScheme
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// GREATEST rather than a plain assignment: the counter is the one
		// column here that must never go backwards, and enforcing it in the
		// UPDATE means a concurrent cashier cannot lose their serial either.
		return tx.QueryRow(r.Context(), `
			INSERT INTO numbering_schemes
			    (institution_id, campus_id, kind, prefix, suffix, padding,
			     next_value, reset_yearly)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (institution_id, campus_id, kind) DO UPDATE
			   SET prefix = EXCLUDED.prefix,
			       suffix = EXCLUDED.suffix,
			       padding = EXCLUDED.padding,
			       next_value = GREATEST(numbering_schemes.next_value, EXCLUDED.next_value),
			       reset_yearly = EXCLUDED.reset_yearly
			RETURNING id::text, kind, prefix, suffix, padding, next_value, reset_yearly`,
			id.InstitutionID, campus, req.Kind, req.Prefix, req.Suffix,
			req.Padding, req.NextValue, req.ResetYearly).
			Scan(&out.ID, &out.Kind, &out.Prefix, &out.Suffix, &out.Padding,
				&out.NextValue, &out.ResetYearly)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	out.Preview = platPreviewNumber(out.Prefix, out.Suffix, out.Padding,
		out.NextValue, out.ResetYearly, nowInIndia())
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) deleteNumberingScheme(w http.ResponseWriter, r *http.Request) {
	s.deleteOwnedRow(w, r, "numbering_schemes")
}

type platTemplateRequest struct {
	Code     string `json:"code"`
	Name     string `json:"name"`
	HTML     string `json:"template_html,omitempty"`
	Approval bool   `json:"requires_approval"`
}

func (s *Server) saveCertificateTemplate(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platTemplateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Name = strings.TrimSpace(req.Name)
	if req.Code == "" || req.Name == "" {
		httpx.BadRequest(w, r, "code and name are required")
		return
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO certificate_types
			    (institution_id, code, name, template_html, requires_approval)
			VALUES ($1,$2,$3,NULLIF($4,''),$5)
			ON CONFLICT (institution_id, code) DO UPDATE
			   SET name = EXCLUDED.name,
			       template_html = EXCLUDED.template_html,
			       requires_approval = EXCLUDED.requires_approval
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.HTML, req.Approval).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

// --- SSO and MFA -------------------------------------------------------------

type platAuthPolicy struct {
	MFARequiredRoles    []string `json:"mfa_required_roles"`
	MFAGraceDays        int      `json:"mfa_grace_days"`
	PasswordMinLength   int      `json:"password_min_length"`
	PasswordExpiryDays  int      `json:"password_expiry_days"`
	SessionIdleMinutes  int      `json:"session_idle_minutes"`
	AllowedEmailDomains []string `json:"allowed_email_domains"`

	SSOEnabled     bool    `json:"sso_enabled"`
	SSOProtocol    *string `json:"sso_protocol,omitempty"`
	SSOProvider    *string `json:"sso_provider,omitempty"`
	SSOEntityID    *string `json:"sso_entity_id,omitempty"`
	SSOMetadataURL *string `json:"sso_metadata_url,omitempty"`
	SSOVerifiedAt  *string `json:"sso_verified_at,omitempty"`

	// What the school looks like against the policy, not what it has typed.
	Users          int `json:"users"`
	MFAEnrolled    int `json:"mfa_enrolled"`
	CoveredByRule  int `json:"users_covered_by_rule"`
	CoveredMissing int `json:"users_covered_without_mfa"`

	Roles []option `json:"roles"`

	/* Single sign-on is configuration only on this installation.

	   There is no SAML or OIDC adapter in internal/auth and no identity
	   provider to talk to, so nothing here changes how anyone signs in. The
	   client must say so plainly rather than showing a switch that appears to
	   work; a school that believes single sign-on is on and stops managing
	   passwords is worse off than one that knows it is not. */
	SSOAvailable bool   `json:"sso_available"`
	SSOBlockedBy string `json:"sso_blocked_by"`
}

func (s *Server) getAuthPolicy(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	out := platAuthPolicy{
		MFARequiredRoles: []string{}, AllowedEmailDomains: []string{},
		MFAGraceDays: 7, PasswordMinLength: 10, SessionIdleMinutes: 120,
		Roles: []option{}, SSOAvailable: false,
		SSOBlockedBy: "No SAML or OIDC adapter is built and no identity provider " +
			"is connected. The configuration below is stored and will be read by " +
			"the sign-in page once an adapter exists; it does not change how " +
			"anyone signs in today.",
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var verified *time.Time
		err := tx.QueryRow(r.Context(), `
			SELECT mfa_required_roles, mfa_grace_days, password_min_length,
			       password_expiry_days, session_idle_minutes, allowed_email_domains,
			       sso_enabled, sso_protocol, sso_provider, sso_entity_id,
			       sso_metadata_url, sso_verified_at
			  FROM auth_policies WHERE institution_id = $1`, id.InstitutionID).
			Scan(&out.MFARequiredRoles, &out.MFAGraceDays, &out.PasswordMinLength,
				&out.PasswordExpiryDays, &out.SessionIdleMinutes,
				&out.AllowedEmailDomains, &out.SSOEnabled, &out.SSOProtocol,
				&out.SSOProvider, &out.SSOEntityID, &out.SSOMetadataURL, &verified)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		out.SSOVerifiedAt = nullTime(verified)

		// Enrolment measured against the rule, not in the abstract. "412 of 800
		// have MFA" is noise; "3 of the 5 people the policy covers do not" is
		// a morning's work.
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int,
			       count(*) FILTER (WHERE u.mfa_secret IS NOT NULL)::int,
			       count(*) FILTER (WHERE covered)::int,
			       count(*) FILTER (WHERE covered AND u.mfa_secret IS NULL)::int
			  FROM (
			    SELECT u.id, u.mfa_secret,
			           EXISTS (SELECT 1 FROM user_roles ur
			                     JOIN roles rr ON rr.id = ur.role_id
			                    WHERE ur.user_id = u.id
			                      AND rr.key = ANY($1::text[])) AS covered
			      FROM users u
			     WHERE u.institution_id = $2 AND u.status = 'active'
			  ) u`, out.MFARequiredRoles, id.InstitutionID).
			Scan(&out.Users, &out.MFAEnrolled, &out.CoveredByRule,
				&out.CoveredMissing); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `SELECT key, name FROM roles ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var o option
			if err := rows.Scan(&o.Value, &o.Label); err != nil {
				return err
			}
			out.Roles = append(out.Roles, o)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type platAuthPolicyRequest struct {
	MFARequiredRoles    []string `json:"mfa_required_roles"`
	MFAGraceDays        int      `json:"mfa_grace_days"`
	PasswordMinLength   int      `json:"password_min_length"`
	PasswordExpiryDays  int      `json:"password_expiry_days"`
	SessionIdleMinutes  int      `json:"session_idle_minutes"`
	AllowedEmailDomains []string `json:"allowed_email_domains"`

	SSOEnabled     bool   `json:"sso_enabled"`
	SSOProtocol    string `json:"sso_protocol,omitempty"`
	SSOProvider    string `json:"sso_provider,omitempty"`
	SSOEntityID    string `json:"sso_entity_id,omitempty"`
	SSOMetadataURL string `json:"sso_metadata_url,omitempty"`
}

/*
setAuthPolicy stores the school's authentication requirements.

	It does not, and must not, weaken the password path. There is no field here
	that shortens a session below the schema's floor, none that disables the
	password check, and sso_verified_at is never set from a request — only a
	proven connection may set it, and no code path can prove one yet.
*/
func (s *Server) setAuthPolicy(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platAuthPolicyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.MFARequiredRoles == nil {
		req.MFARequiredRoles = []string{}
	}
	if req.AllowedEmailDomains == nil {
		req.AllowedEmailDomains = []string{}
	}
	if req.PasswordMinLength == 0 {
		req.PasswordMinLength = 10
	}
	if req.SessionIdleMinutes == 0 {
		req.SessionIdleMinutes = 120
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO auth_policies
			    (institution_id, mfa_required_roles, mfa_grace_days,
			     password_min_length, password_expiry_days, session_idle_minutes,
			     allowed_email_domains, sso_enabled, sso_protocol, sso_provider,
			     sso_entity_id, sso_metadata_url)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),
			        NULLIF($11,''),NULLIF($12,''))
			ON CONFLICT (institution_id) DO UPDATE
			   SET mfa_required_roles = EXCLUDED.mfa_required_roles,
			       mfa_grace_days = EXCLUDED.mfa_grace_days,
			       password_min_length = EXCLUDED.password_min_length,
			       password_expiry_days = EXCLUDED.password_expiry_days,
			       session_idle_minutes = EXCLUDED.session_idle_minutes,
			       allowed_email_domains = EXCLUDED.allowed_email_domains,
			       sso_enabled = EXCLUDED.sso_enabled,
			       sso_protocol = EXCLUDED.sso_protocol,
			       sso_provider = EXCLUDED.sso_provider,
			       sso_entity_id = EXCLUDED.sso_entity_id,
			       sso_metadata_url = EXCLUDED.sso_metadata_url,
			       updated_at = now()`,
			id.InstitutionID, req.MFARequiredRoles, req.MFAGraceDays,
			req.PasswordMinLength, req.PasswordExpiryDays, req.SessionIdleMinutes,
			req.AllowedEmailDomains, req.SSOEnabled,
			strings.TrimSpace(req.SSOProtocol), strings.TrimSpace(req.SSOProvider),
			strings.TrimSpace(req.SSOEntityID), strings.TrimSpace(req.SSOMetadataURL))
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	s.getAuthPolicy(w, r)
}

// --- backup and restore ------------------------------------------------------

type platBackupRun struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	StartedAt    string  `json:"started_at"`
	FinishedAt   *string `json:"finished_at,omitempty"`
	Status       string  `json:"status"`
	SizeBytes    *int64  `json:"size_bytes,omitempty"`
	ObjectKey    *string `json:"object_key,omitempty"`
	RestorePoint *string `json:"restore_point,omitempty"`
	Error        *string `json:"error,omitempty"`
}

type platBackupPosture struct {
	Enabled        bool   `json:"enabled"`
	Frequency      string `json:"frequency"`
	RunAtHour      int    `json:"run_at_hour"`
	RetentionDays  int    `json:"retention_days"`
	PITRWindowDays int    `json:"pitr_window_days"`
	Destination    string `json:"destination"`

	Runs []platBackupRun `json:"runs"`
	// The newest restore point that actually exists, and how old it is. The
	// only two numbers that answer "are we covered".
	LastGoodAt    *string `json:"last_good_at,omitempty"`
	LastGoodHours *int    `json:"last_good_hours,omitempty"`
	// True when the newest good backup is older than the policy allows. Null
	// last_good_at is also lapsed: no backup at all is the worst case, not an
	// unknown one.
	Lapsed bool `json:"lapsed"`
	Failed int  `json:"failed_runs_30_days"`

	/* Taking the backup is the operator's pipeline, not this process.

	   A web handler that shells out to pg_dump competes for the same disk the
	   database is writing to, at whatever hour a person happens to click. The
	   pipeline reports each run through POST /platform/backups/runs and this
	   screen holds it to the policy. */
	CanRunFromHere bool   `json:"can_run_from_here"`
	RunsBlockedBy  string `json:"runs_blocked_by"`
}

func (s *Server) getBackupPosture(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := platBackupPosture{
		Enabled: true, Frequency: "daily", RunAtHour: 1, RetentionDays: 30,
		PITRWindowDays: 7, Destination: "object_store",
		Runs: []platBackupRun{}, CanRunFromHere: false,
		RunsBlockedBy: "Backups are taken by the operator's pipeline and reported " +
			"here. This process does not run pg_dump: a web request competing " +
			"with the database for the same disk, at whatever hour somebody " +
			"clicks, is how a backup becomes an outage.",
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT enabled, frequency, run_at_hour, retention_days,
			       pitr_window_days, destination
			  FROM backup_policies WHERE institution_id = $1`, id.InstitutionID).
			Scan(&out.Enabled, &out.Frequency, &out.RunAtHour, &out.RetentionDays,
				&out.PITRWindowDays, &out.Destination)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}

		var lastGood *time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT max(restore_point) FILTER (WHERE status = 'succeeded'),
			       count(*) FILTER (WHERE status = 'failed'
			                          AND started_at >= now() - interval '30 days')::int
			  FROM backup_runs WHERE institution_id = $1`, id.InstitutionID).
			Scan(&lastGood, &out.Failed); err != nil {
			return err
		}
		if lastGood != nil {
			out.LastGoodAt = nullTime(lastGood)
			hours := int(nowInIndia().Sub(*lastGood).Hours())
			out.LastGoodHours = &hours
		}

		rows, err := tx.Query(r.Context(), `
			SELECT id::text, kind,
			       to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       to_char(finished_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       status, size_bytes, object_key,
			       to_char(restore_point,'YYYY-MM-DD"T"HH24:MI:SSOF'), error
			  FROM backup_runs
			 ORDER BY started_at DESC LIMIT 50`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platBackupRun
			if err := rows.Scan(&v.ID, &v.Kind, &v.StartedAt, &v.FinishedAt,
				&v.Status, &v.SizeBytes, &v.ObjectKey, &v.RestorePoint,
				&v.Error); err != nil {
				return err
			}
			out.Runs = append(out.Runs, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Lapsed = out.Enabled && platBackupLapsed(out.Frequency, out.LastGoodHours)
	httpx.JSON(w, http.StatusOK, out)
}

// platBackupLapsed decides whether the newest good backup is too old.
//
// Twice the interval, not one: a daily backup that ran at 01:00 is 23 hours old
// at midnight and perfectly healthy, and alerting on that trains everyone to
// ignore the alert.
func platBackupLapsed(frequency string, ageHours *int) bool {
	if ageHours == nil {
		return true
	}
	switch frequency {
	case "hourly":
		return *ageHours > 2
	case "weekly":
		return *ageHours > 24*14
	default:
		return *ageHours > 48
	}
}

type platBackupPolicyRequest struct {
	Enabled        bool   `json:"enabled"`
	Frequency      string `json:"frequency"`
	RunAtHour      int    `json:"run_at_hour"`
	RetentionDays  int    `json:"retention_days"`
	PITRWindowDays int    `json:"pitr_window_days"`
	Destination    string `json:"destination"`
}

func (s *Server) setBackupPolicy(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platBackupPolicyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Frequency == "" {
		req.Frequency = "daily"
	}
	if req.Destination == "" {
		req.Destination = "object_store"
	}
	if req.RetentionDays == 0 {
		req.RetentionDays = 30
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO backup_policies
			    (institution_id, enabled, frequency, run_at_hour, retention_days,
			     pitr_window_days, destination)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (institution_id) DO UPDATE
			   SET enabled = EXCLUDED.enabled,
			       frequency = EXCLUDED.frequency,
			       run_at_hour = EXCLUDED.run_at_hour,
			       retention_days = EXCLUDED.retention_days,
			       pitr_window_days = EXCLUDED.pitr_window_days,
			       destination = EXCLUDED.destination,
			       updated_at = now()`,
			id.InstitutionID, req.Enabled, req.Frequency, req.RunAtHour,
			req.RetentionDays, req.PITRWindowDays, req.Destination)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	s.getBackupPosture(w, r)
}

type platBackupRunRequest struct {
	InstitutionID string `json:"institution_id"`
	Kind          string `json:"kind,omitempty"`
	Status        string `json:"status"`
	StartedAt     string `json:"started_at,omitempty"`
	FinishedAt    string `json:"finished_at,omitempty"`
	RestorePoint  string `json:"restore_point,omitempty"`
	SizeBytes     *int64 `json:"size_bytes,omitempty"`
	ObjectKey     string `json:"object_key,omitempty"`
	Checksum      string `json:"checksum,omitempty"`
	Error         string `json:"error,omitempty"`
}

/*
recordBackupRun is how the operator's pipeline reports what it did.

	The schema refuses a run marked succeeded that carries no restore point,
	which is the guarantee this endpoint exists to enforce: a pipeline that
	reports success without saying what can be restored to has told nobody
	anything, and the screen above would show a green tick over nothing.
*/
func (s *Server) recordBackupRun(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platBackupRunRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	iid, err := uuid.Parse(strings.TrimSpace(req.InstitutionID))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id must be a uuid")
		return
	}
	if req.Kind == "" {
		req.Kind = "scheduled"
	}
	if req.Status == "" {
		req.Status = "running"
	}

	var out string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO backup_runs
			    (institution_id, kind, started_at, finished_at, status,
			     size_bytes, object_key, restore_point, checksum, error)
			VALUES ($1,$2,COALESCE(NULLIF($3,'')::timestamptz, now()),
			        NULLIF($4,'')::timestamptz,$5,$6,NULLIF($7,''),
			        NULLIF($8,'')::timestamptz,NULLIF($9,''),NULLIF($10,''))
			RETURNING id::text`,
			iid, req.Kind, strings.TrimSpace(req.StartedAt),
			strings.TrimSpace(req.FinishedAt), req.Status, req.SizeBytes,
			strings.TrimSpace(req.ObjectKey), strings.TrimSpace(req.RestorePoint),
			strings.TrimSpace(req.Checksum), strings.TrimSpace(req.Error)).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

type platBackupFleetRow struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	Enabled       bool    `json:"enabled"`
	Frequency     string  `json:"frequency"`
	LastGoodAt    *string `json:"last_good_at,omitempty"`
	LastGoodHours *int    `json:"last_good_hours,omitempty"`
	Lapsed        bool    `json:"lapsed"`
	Failed30      int     `json:"failed_runs_30_days"`
	Students      int     `json:"students"`
}

// getBackupFleet answers the only question worth asking across tenants: which
// schools are not actually being backed up.
func (s *Server) getBackupFleet(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	items := []platBackupFleetRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name,
			       COALESCE(p.enabled, true), COALESCE(p.frequency, 'daily'),
			       to_char(g.last_good,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       CASE WHEN g.last_good IS NULL THEN NULL
			            ELSE extract(epoch FROM now() - g.last_good)::int / 3600 END,
			       COALESCE(g.failed30, 0)::int,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int
			  FROM institutions i
			  LEFT JOIN backup_policies p ON p.institution_id = i.id
			  LEFT JOIN LATERAL (
			      SELECT max(restore_point) FILTER (WHERE status = 'succeeded') AS last_good,
			             count(*) FILTER (WHERE status = 'failed'
			                                AND started_at >= now() - interval '30 days') AS failed30
			        FROM backup_runs b WHERE b.institution_id = i.id
			  ) g ON true
			 WHERE i.status = 'active'
			 ORDER BY g.last_good NULLS FIRST, i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platBackupFleetRow
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Enabled, &v.Frequency,
				&v.LastGoodAt, &v.LastGoodHours, &v.Failed30, &v.Students); err != nil {
				return err
			}
			v.Lapsed = v.Enabled && platBackupLapsed(v.Frequency, v.LastGoodHours)
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

// --- support tickets ---------------------------------------------------------

type platVendorTicket struct {
	ID       string  `json:"id"`
	School   *string `json:"school,omitempty"`
	Subject  string  `json:"subject"`
	Category string  `json:"category"`
	Priority string  `json:"priority"`
	Status   string  `json:"status"`
	RaisedBy *string `json:"raised_by,omitempty"`
	Assigned *string `json:"assigned_to,omitempty"`
	Created  string  `json:"created_at"`
	OpenDays int     `json:"open_days"`
	// The body is returned only on the vendor's own queue, where every row is
	// a fault report the school addressed to the vendor. It is never returned
	// for a ticket the school raised with itself, because those are the ones
	// that carry a family's words.
	Body *string `json:"body,omitempty"`
}

/*
listVendorTickets is the vendor's support queue, and it is narrow on purpose.

	support_tickets carries two utterly different things: a school reporting a
	fault to the vendor, and a parent raising a concern with the school about a
	named teacher, a child's discipline record or a safety incident. The seller
	console read every row on the installation with no filter at all, so the
	second kind was on the vendor's screen with the school's name, the parent's
	name and whatever they wrote in the subject line.

	audience = 'vendor' is the whole filter, and it is not a convention: the
	schema refuses to mark a ticket vendor-visible while it names a child.

	NOTE: listTickets in internal/api/seller.go, behind GET /api/v1/seller/tickets,
	still reads every row. That file is outside this change's ownership; the
	one-line fix is in the handover.
*/
func (s *Server) listVendorTickets(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))

	items := []platVendorTicket{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text, i.name, t.subject, t.category, t.priority, t.status,
			       u.full_name, a.full_name,
			       to_char(t.created_at,'YYYY-MM-DD'),
			       EXTRACT(day FROM now() - t.created_at)::int, t.body
			  FROM support_tickets t
			  LEFT JOIN institutions i ON i.id = t.institution_id
			  LEFT JOIN users u ON u.id = t.raised_by
			  LEFT JOIN users a ON a.id = t.assigned_to
			 WHERE t.audience = 'vendor'
			   AND ($1::text IS NULL OR t.status = $1)
			   AND ($1::text IS NOT NULL OR t.status <> 'closed')
			 ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
			                          WHEN 'normal' THEN 2 ELSE 3 END,
			          t.created_at`, nullString(status))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platVendorTicket
			if err := rows.Scan(&v.ID, &v.School, &v.Subject, &v.Category, &v.Priority,
				&v.Status, &v.RaisedBy, &v.Assigned, &v.Created, &v.OpenDays,
				&v.Body); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

type platTicketUpdate struct {
	Status     string `json:"status,omitempty"`
	Priority   string `json:"priority,omitempty"`
	AssignTo   string `json:"assigned_to,omitempty"`
	Resolution string `json:"resolution,omitempty"`
}

func (s *Server) updateVendorTicket(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	tid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req platTicketUpdate
	if !httpx.Decode(w, r, &req) {
		return
	}

	var assign any
	if req.AssignTo != "" {
		aid, err := uuid.Parse(req.AssignTo)
		if err != nil {
			httpx.BadRequest(w, r, "assigned_to must be a uuid")
			return
		}
		assign = aid
	}

	var affected int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// The audience clause is the guard, not a filter: without it this
		// endpoint would let the vendor edit a parent's grievance.
		ct, err := tx.Exec(r.Context(), `
			UPDATE support_tickets
			   SET status = COALESCE(NULLIF($2,''), status),
			       priority = COALESCE(NULLIF($3,''), priority),
			       assigned_to = COALESCE($4, assigned_to),
			       resolution = COALESCE(NULLIF($5,''), resolution),
			       resolved_at = CASE WHEN $2 IN ('resolved','closed')
			                          THEN COALESCE(resolved_at, now())
			                          ELSE resolved_at END
			 WHERE id = $1 AND audience = 'vendor'`,
			tid, strings.TrimSpace(req.Status), strings.TrimSpace(req.Priority),
			assign, strings.TrimSpace(req.Resolution))
		affected = ct.RowsAffected()
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": true})
}

// listOwnVendorTickets is what this school has reported to the vendor.
func (s *Server) listOwnVendorTickets(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT t.id::text, t.subject, t.category, t.priority, t.status,
		       u.full_name, a.full_name, to_char(t.created_at,'YYYY-MM-DD'),
		       EXTRACT(day FROM now() - t.created_at)::int, t.body
		  FROM support_tickets t
		  LEFT JOIN users u ON u.id = t.raised_by
		  LEFT JOIN users a ON a.id = t.assigned_to
		 WHERE t.audience = 'vendor'
		 ORDER BY t.created_at DESC LIMIT 200`, nil,
		func(rows pgx.Rows) (platVendorTicket, error) {
			var v platVendorTicket
			return v, rows.Scan(&v.ID, &v.Subject, &v.Category, &v.Priority,
				&v.Status, &v.RaisedBy, &v.Assigned, &v.Created, &v.OpenDays, &v.Body)
		})
	respond(w, r, items, err)
}

type platRaiseTicketRequest struct {
	Category string `json:"category"`
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	Priority string `json:"priority,omitempty"`
}

// platVendorCategories are the things a school reports to a software vendor.
//
// Deliberately disjoint from concernCategories in portal_requests.go, which is
// what a family reports to a school. Sharing one vocabulary is how a grievance
// about a teacher ends up filed under something the vendor's queue displays.
var platVendorCategories = map[string]bool{
	"fault": true, "data": true, "performance": true, "integration": true,
	"training": true, "billing": true, "feature_request": true, "other": true,
}

/*
raiseVendorTicket is the school reporting a fault to the vendor.

	student_id is not a field here and never will be. The schema refuses a
	vendor ticket that names a child, so a support desk debugging a fee
	calculation gets the invoice number and not the family.
*/
func (s *Server) raiseVendorTicket(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platRaiseTicketRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Subject = strings.TrimSpace(req.Subject)
	req.Body = strings.TrimSpace(req.Body)
	if req.Subject == "" || req.Body == "" {
		httpx.BadRequest(w, r, "subject and body are required")
		return
	}
	if req.Category == "" {
		req.Category = "other"
	}
	if !platVendorCategories[req.Category] {
		httpx.BadRequest(w, r, "unknown category for a vendor ticket")
		return
	}
	if req.Priority == "" {
		req.Priority = "normal"
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO support_tickets
			    (institution_id, raised_by, category, subject, body, priority, audience)
			VALUES ($1,$2,$3,$4,$5,$6,'vendor')
			RETURNING id::text`,
			id.InstitutionID, id.UserID, req.Category, req.Subject,
			req.Body, req.Priority).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

// --- impersonation and audit -------------------------------------------------

type platGrant struct {
	ID            string  `json:"id"`
	InstitutionID string  `json:"institution_id"`
	School        *string `json:"school,omitempty"`
	Operator      string  `json:"operator"`
	Reason        string  `json:"reason"`
	TicketID      *string `json:"ticket_id,omitempty"`
	StartedAt     string  `json:"started_at"`
	ExpiresAt     string  `json:"expires_at"`
	EndedAt       *string `json:"ended_at,omitempty"`
	EndedBy       *string `json:"ended_by,omitempty"`
	EndedReason   *string `json:"ended_reason,omitempty"`
	// Live means not ended and not yet expired. Computed in SQL against the
	// database's clock so two readers cannot disagree about it.
	Live bool `json:"live"`
	// How many audited changes the operator made inside the school during the
	// window. Zero is a normal answer for a session that only read.
	Changes int `json:"changes"`
}

/*
platGrantSelect reads the register.

	The operator's and the closer's names come from the grant's own columns and
	not from a join to users. A school reading this in its own tenant cannot see
	a platform account — those rows belong to no institution and row-level
	security hides them — so a join would answer "somebody entered your school",
	which is worse than not showing the register at all.
*/
const platGrantSelect = `
	SELECT g.id::text, g.institution_id::text, i.name, g.operator_name, g.reason,
	       g.ticket_id::text,
	       to_char(g.started_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
	       to_char(g.expires_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
	       to_char(g.ended_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
	       g.ended_by_name, g.ended_reason,
	       (g.ended_at IS NULL AND g.expires_at > now()),
	       (SELECT count(*) FROM audit_log a
	         WHERE a.actor_user_id = g.operator_user_id
	           AND a.institution_id = g.institution_id
	           AND a.created_at BETWEEN g.started_at
	                                AND COALESCE(g.ended_at, g.expires_at))::int
	  FROM impersonation_grants g
	  LEFT JOIN institutions i ON i.id = g.institution_id`

func platScanGrant(rows pgx.Rows) (platGrant, error) {
	var v platGrant
	return v, rows.Scan(&v.ID, &v.InstitutionID, &v.School, &v.Operator, &v.Reason,
		&v.TicketID, &v.StartedAt, &v.ExpiresAt, &v.EndedAt, &v.EndedBy,
		&v.EndedReason, &v.Live, &v.Changes)
}

/*
listImpersonationGrants is the register, and it has two readers.

	The vendor sees every session on the installation. A school's own
	administrator sees the sessions inside their school and nothing else — not
	by a filter written here, but because the query runs in their tenant and
	row-level security answers with their rows. That is the point of putting
	the table in the tenant rather than in the vendor's own space: the school
	does not have to trust a log the vendor renders for them.
*/
func (s *Server) listImpersonationGrants(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	limit := clampInt(r.URL.Query().Get("limit"), 100, 1, 500)

	items := []platGrant{}
	scan := func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(),
			platGrantSelect+` ORDER BY g.started_at DESC LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			v, err := platScanGrant(rows)
			if err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	}

	var err error
	// A platform operator who has not named a school is asking about the
	// fleet; one who has, and every school user, is asking about that school.
	if id.PlatformAdmin && id.InstitutionID == uuid.Nil {
		err = s.DB.AsPlatform(r.Context(), scan)
	} else {
		err = s.DB.InTenant(r.Context(), tenantScope(id), scan)
	}
	respond(w, r, items, err)
}

type platOpenGrantRequest struct {
	InstitutionID string `json:"institution_id"`
	Reason        string `json:"reason"`
	TicketID      string `json:"ticket_id,omitempty"`
	// Minutes, capped at the schema's four hours. Defaults to one, because a
	// support session is usually one reproduction and a screenshot.
	Minutes int `json:"minutes,omitempty"`
}

/*
openImpersonation puts a support session on the record before it starts.

	Three properties, and the schema holds all three so a later handler cannot
	quietly drop one:

	  * a reason, at least eight characters, mandatory
	  * an end time, never more than four hours out
	  * a row in the school's own tenant, which the school's administrator
	    reads and may end

	Any live session this operator already holds is closed first. An engineer
	with two open sessions in two schools is an engineer whose audit trail
	cannot say which school they were in.

	This does not itself grant access — X-Acting-Institution in
	internal/api/acting.go still does that, and that file is outside this
	change. What the grant makes possible is the check acting.go must make; see
	the handover for the exact amendment.
*/
func (s *Server) openImpersonation(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req platOpenGrantRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	iid, err := uuid.Parse(strings.TrimSpace(req.InstitutionID))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id must be a uuid")
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) < 8 {
		httpx.BadRequest(w, r,
			"say why you are entering this school — at least a few words, "+
				"because the school's administrator reads this")
		return
	}
	if req.Minutes <= 0 {
		req.Minutes = 60
	}
	if req.Minutes > 240 {
		httpx.BadRequest(w, r, "a support session may not exceed four hours")
		return
	}

	var ticket any
	if req.TicketID != "" {
		tid, err := uuid.Parse(req.TicketID)
		if err != nil {
			httpx.BadRequest(w, r, "ticket_id must be a uuid")
			return
		}
		ticket = tid
	}

	var out platGrant
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// The school must exist and be live. Opening a session against a
		// suspended tenant is either a mistake or the thing nobody wants to
		// find in the register afterwards.
		var live bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM institutions WHERE id = $1 AND status = 'active'`,
			iid).Scan(&live); err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE impersonation_grants
			   SET ended_at = now(), ended_by = $1, ended_by_name = $2,
			       ended_reason = 'superseded by a new session'
			 WHERE operator_user_id = $1 AND ended_at IS NULL`,
			id.UserID, id.FullName); err != nil {
			return err
		}

		var newID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO impersonation_grants
			    (institution_id, operator_user_id, operator_name, reason,
			     ticket_id, expires_at)
			VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))
			RETURNING id::text`,
			iid, id.UserID, id.FullName, req.Reason, ticket,
			req.Minutes).Scan(&newID); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), platGrantSelect+` WHERE g.id = $1`, newID)
		if err != nil {
			return err
		}
		defer rows.Close()
		if !rows.Next() {
			return rows.Err()
		}
		out, err = platScanGrant(rows)
		return err
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

type platEndGrantRequest struct {
	Reason string `json:"reason,omitempty"`
}

/*
endImpersonation closes a session, from either side.

	The vendor closes their own when they are done. The school closes one
	running inside it, which is why this route admits admin.audit.read as well
	as the vendor key — a register the school can read but not act on is a
	notification, not a control.
*/
func (s *Server) endImpersonation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req platEndGrantRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "ended by " + id.FullName
	}

	var affected int64
	run := func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE impersonation_grants
			   SET ended_at = now(), ended_by = $2, ended_by_name = $3,
			       ended_reason = $4
			 WHERE id = $1 AND ended_at IS NULL`,
			gid, id.UserID, id.FullName, reason)
		affected = ct.RowsAffected()
		return err
	}

	// A school ending a session inside itself runs in its own tenant, so
	// row-level security refuses an id belonging to another school before this
	// handler has to think about it.
	if id.PlatformAdmin && id.InstitutionID == uuid.Nil {
		err = s.DB.AsPlatform(r.Context(), run)
	} else {
		err = s.DB.InTenant(r.Context(), tenantScope(id), run)
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ended": true})
}

type platGrantActivity struct {
	Grant platGrant  `json:"grant"`
	Items []auditRow `json:"items"`
	// AuditMiddleware records changes and not reads. Said here rather than
	// left to be inferred from a short list: "the engineer changed nothing" and
	// "we do not record what the engineer looked at" are different assurances,
	// and only one of them is true.
	Covers string `json:"covers"`

	/* Changes this operator made during the window that landed in no school.

	   Not a curiosity — it is a live defect, measured. AuditMiddleware is
	   mounted above the router in cmd/web/main.go and reads the identity from
	   its own request, while ActingInstitution amends the identity only for the
	   handlers downstream of it. So every mutation a platform operator makes
	   inside a school is written with institution_id NULL, and the school's own
	   audit viewer — which is tenant-scoped — can never show it.

	   Counted and named here rather than folded into the list above, because
	   including rows that claim no school would tell this school about actions
	   that may have been taken in another. See the handover for the one-line
	   amendment to internal/api/acting.go that fixes it. */
	Unattributed     int    `json:"unattributed_changes"`
	UnattributedNote string `json:"unattributed_note,omitempty"`
}

// getImpersonationActivity is what actually happened during one session.
func (s *Server) getImpersonationActivity(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	out := platGrantActivity{
		Items: []auditRow{},
		Covers: "Changes made during the session. Reads are not recorded: the " +
			"audit middleware records state-changing requests only, so an empty " +
			"list means nothing was altered, not that nothing was seen.",
	}

	run := func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), platGrantSelect+` WHERE g.id = $1`, gid)
		if err != nil {
			return err
		}
		defer rows.Close()
		if !rows.Next() {
			if err := rows.Err(); err != nil {
				return err
			}
			return pgx.ErrNoRows
		}
		out.Grant, err = platScanGrant(rows)
		if err != nil {
			return err
		}
		rows.Close()

		// COALESCE for the same reason platGrantSelect avoids the join
		// entirely: inside the school's tenant the operator's users row is
		// invisible, and an audit line with a blank actor is not an audit line.
		arows, err := tx.Query(r.Context(), `
			SELECT a.id, to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       COALESCE(u.full_name, g.operator_name),
			       a.action, a.entity_type, host(a.ip), a.before, a.after
			  FROM audit_log a
			  LEFT JOIN users u ON u.id = a.actor_user_id
			  JOIN impersonation_grants g ON g.id = $1
			 WHERE a.actor_user_id = g.operator_user_id
			   AND a.institution_id = g.institution_id
			   AND a.created_at BETWEEN g.started_at
			                        AND COALESCE(g.ended_at, g.expires_at)
			 ORDER BY a.id DESC LIMIT 500`, gid)
		if err != nil {
			return err
		}
		defer arows.Close()
		for arows.Next() {
			var v auditRow
			if err := arows.Scan(&v.ID, &v.At, &v.Actor, &v.Action, &v.Entity,
				&v.IP, &v.Request, &v.Response); err != nil {
				return err
			}
			out.Items = append(out.Items, v)
		}
		if err := arows.Err(); err != nil {
			return err
		}

		// Unattributed rows are read as platform, deliberately: they carry no
		// institution_id, so the tenant policy hides them from the school whose
		// register this is, and a count is all that can honestly be shown.
		return s.DB.AsPlatform(r.Context(), func(ptx pgx.Tx) error {
			return ptx.QueryRow(r.Context(), `
				SELECT count(*)::int
				  FROM audit_log a
				  JOIN impersonation_grants g ON g.id = $1
				 WHERE a.actor_user_id = g.operator_user_id
				   AND a.institution_id IS NULL
				   AND a.created_at BETWEEN g.started_at
				                        AND COALESCE(g.ended_at, g.expires_at)`,
				gid).Scan(&out.Unattributed)
		})
	}

	if id.PlatformAdmin && id.InstitutionID == uuid.Nil {
		err = s.DB.AsPlatform(r.Context(), run)
	} else {
		err = s.DB.InTenant(r.Context(), tenantScope(id), run)
	}
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if out.Unattributed > 0 {
		out.UnattributedNote = "This operator made changes during the session that were " +
			"recorded against no school and so cannot be listed here. The audit " +
			"middleware runs above the acting-institution middleware and never sees " +
			"the school the operator named; until that is corrected, a platform " +
			"operator's edits inside a school do not reach that school's audit trail."
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- adoption metrics --------------------------------------------------------

type platAdoptionWeek struct {
	WeekStart string `json:"week_start"`
	SignIns   int    `json:"sign_ins"`
	Users     int    `json:"active_users"`
	Changes   int    `json:"changes"`
}

type platAdoptionRow struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	Plan          *string `json:"plan,omitempty"`
	Students      int     `json:"students"`
	Staff         int     `json:"staff"`
	Accounts      int     `json:"accounts"`

	// The four weeks this screen is about, most recent first.
	SignIns28 int `json:"sign_ins_28_days"`
	Active28  int `json:"active_users_28_days"`
	Changes28 int `json:"changes_28_days"`
	// Active accounts as a share of accounts that exist. The renewal number: a
	// school with 90 accounts and 6 people using them is churning already.
	ActivePercent int     `json:"active_percent"`
	LastSignIn    *string `json:"last_sign_in,omitempty"`
	// Days since anybody signed in. Null for a school where nobody ever has.
	QuietDays *int `json:"quiet_days,omitempty"`
}

type platAdoptionResponse struct {
	Items []platAdoptionRow  `json:"items"`
	Weeks []platAdoptionWeek `json:"weeks"`
	// Schools where nobody has signed in for a fortnight. The call list.
	AtRisk int `json:"at_risk"`
}

/*
getAdoptionMetrics counts people and never names them.

	The vendor needs to know that a school has stopped using the software, not
	who in it stopped. Every column below is an aggregate, and the only names
	returned are the schools' own.
*/
func (s *Server) getAdoptionMetrics(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	out := platAdoptionResponse{
		Items: []platAdoptionRow{}, Weeks: []platAdoptionWeek{},
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, sub.plan_code,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int,
			       (SELECT count(*) FROM employees e
			         WHERE e.institution_id = i.id AND e.status = 'active')::int,
			       (SELECT count(*) FROM users u
			         WHERE u.institution_id = i.id AND u.status = 'active')::int,
			       (SELECT count(*) FROM sessions se
			         WHERE se.institution_id = i.id
			           AND se.created_at >= now() - interval '28 days')::int,
			       (SELECT count(DISTINCT se.user_id) FROM sessions se
			         WHERE se.institution_id = i.id
			           AND se.created_at >= now() - interval '28 days')::int,
			       (SELECT count(*) FROM audit_log a
			         WHERE a.institution_id = i.id
			           AND a.created_at >= now() - interval '28 days')::int,
			       to_char((SELECT max(u.last_login_at) FROM users u
			                 WHERE u.institution_id = i.id), 'YYYY-MM-DD'),
			       (SELECT extract(day FROM now() - max(u.last_login_at))::int
			          FROM users u WHERE u.institution_id = i.id)
			  FROM institutions i
			  LEFT JOIN subscriptions sub ON sub.institution_id = i.id
			 WHERE i.status = 'active'
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platAdoptionRow
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Plan, &v.Students,
				&v.Staff, &v.Accounts, &v.SignIns28, &v.Active28, &v.Changes28,
				&v.LastSignIn, &v.QuietDays); err != nil {
				return err
			}
			if v.Accounts > 0 {
				v.ActivePercent = v.Active28 * 100 / v.Accounts
			}
			if v.QuietDays == nil || *v.QuietDays >= 14 {
				out.AtRisk++
			}
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// The installation's own trend, by week. date_trunc rather than a
		// generated series: a week with nothing in it is a week the vendor
		// wants to see as a gap, and inventing a zero row hides it.
		//
		// Two aggregates joined on the week rather than one correlated
		// subquery, which is not merely tidier — a subquery reaching for
		// se.created_at inside a GROUP BY is ungrouped and Postgres refuses it.
		wrows, err := tx.Query(r.Context(), `
			WITH signins AS (
			    SELECT date_trunc('week', created_at) AS wk,
			           count(*)::int AS sign_ins,
			           count(DISTINCT user_id)::int AS users
			      FROM sessions
			     WHERE created_at >= now() - interval '12 weeks'
			     GROUP BY 1
			), changes AS (
			    SELECT date_trunc('week', created_at) AS wk, count(*)::int AS n
			      FROM audit_log
			     WHERE created_at >= now() - interval '12 weeks'
			     GROUP BY 1
			)
			SELECT to_char(s.wk,'YYYY-MM-DD'), s.sign_ins, s.users,
			       COALESCE(c.n, 0)
			  FROM signins s LEFT JOIN changes c ON c.wk = s.wk
			 ORDER BY s.wk DESC`)
		if err != nil {
			return err
		}
		defer wrows.Close()
		for wrows.Next() {
			var v platAdoptionWeek
			if err := wrows.Scan(&v.WeekStart, &v.SignIns, &v.Users, &v.Changes); err != nil {
				return err
			}
			out.Weeks = append(out.Weeks, v)
		}
		return wrows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- instance health ---------------------------------------------------------

type platHealthRow struct {
	InstitutionID string `json:"institution_id"`
	School        string `json:"school"`

	// Integrations that are configured, switched on and failing. The most
	// common way a school's day breaks without the vendor hearing about it: a
	// payment gateway that stopped answering three days ago.
	IntegrationsOn     int      `json:"integrations_enabled"`
	IntegrationsFailed int      `json:"integrations_failing"`
	FailingProviders   []string `json:"failing_providers"`

	MessagesFailed24 int `json:"messages_failed_24h"`
	PaymentsFailed24 int `json:"payments_failed_24h"`
	OpenTickets      int `json:"open_vendor_tickets"`

	// Whether the register was marked today. A school where nobody has taken
	// attendance by mid-morning is a school with a problem, and it is the one
	// signal that reliably precedes a support call.
	AttendanceMarkedToday int `json:"attendance_marked_today"`

	Sessions24 int `json:"sessions_24h"`
	// Worst first: a simple count of the things above that are wrong.
	Concerns int `json:"concerns"`
}

type platHealthResponse struct {
	Items []platHealthRow `json:"items"`
	// Queue depth is per installation, not per school: one Redis serves them
	// all and a job carries no tenant in its name.
	Queues map[string]any `json:"queues"`
	// Request error rates and slow endpoints are not persisted anywhere — they
	// go to the structured log and nothing reads them back. Said plainly so
	// the screen does not imply a number it has not got.
	Missing string `json:"not_measured"`
}

func (s *Server) getInstanceHealth(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	out := platHealthResponse{
		Items: []platHealthRow{}, Queues: map[string]any{},
		Missing: "Per-endpoint error rates and response times are written to the " +
			"structured log and are not stored, so they cannot be reported here. " +
			"What is below is measured from the database: failing integrations, " +
			"undelivered messages, failed payments and whether the register was " +
			"taken.",
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name,
			       (SELECT count(*) FROM integrations g
			         WHERE g.institution_id = i.id AND g.enabled)::int,
			       (SELECT count(*) FROM integrations g
			         WHERE g.institution_id = i.id AND g.enabled
			           AND g.last_error IS NOT NULL
			           AND (g.last_ok_at IS NULL
			                OR g.last_ok_at < now() - interval '24 hours'))::int,
			       COALESCE((SELECT array_agg(g.provider ORDER BY g.provider)
			                   FROM integrations g
			                  WHERE g.institution_id = i.id AND g.enabled
			                    AND g.last_error IS NOT NULL
			                    AND (g.last_ok_at IS NULL
			                         OR g.last_ok_at < now() - interval '24 hours')),
			                ARRAY[]::text[]),
			       (SELECT count(*) FROM message_log m
			         WHERE m.institution_id = i.id AND m.status = 'failed'
			           AND m.queued_at >= now() - interval '24 hours')::int,
			       (SELECT count(*) FROM payments p
			         WHERE p.institution_id = i.id AND p.status = 'failed'
			           AND p.created_at >= now() - interval '24 hours')::int,
			       (SELECT count(*) FROM support_tickets t
			         WHERE t.institution_id = i.id AND t.audience = 'vendor'
			           AND t.status NOT IN ('resolved','closed'))::int,
			       (SELECT count(*) FROM student_attendance sa
			         WHERE sa.institution_id = i.id AND sa.on_date = CURRENT_DATE)::int,
			       (SELECT count(*) FROM sessions se
			         WHERE se.institution_id = i.id
			           AND se.created_at >= now() - interval '24 hours')::int
			  FROM institutions i
			 WHERE i.status = 'active'
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platHealthRow
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.IntegrationsOn,
				&v.IntegrationsFailed, &v.FailingProviders, &v.MessagesFailed24,
				&v.PaymentsFailed24, &v.OpenTickets, &v.AttendanceMarkedToday,
				&v.Sessions24); err != nil {
				return err
			}
			if v.IntegrationsFailed > 0 {
				v.Concerns++
			}
			if v.MessagesFailed24 > 0 {
				v.Concerns++
			}
			if v.PaymentsFailed24 > 0 {
				v.Concerns++
			}
			if v.OpenTickets > 0 {
				v.Concerns++
			}
			out.Items = append(out.Items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Redis being unreachable must not blank the whole screen: the database
	// half of it is still true and still useful.
	if s.Inspector != nil {
		if stats, qerr := s.Inspector.Stats(r.Context()); qerr == nil {
			for name, q := range stats {
				out.Queues[name] = map[string]any{
					"size": q.Size, "pending": q.Pending, "active": q.Active,
					"retry": q.Retry, "failed": q.Failed, "paused": q.Paused,
				}
			}
		} else {
			out.Queues["error"] = qerr.Error()
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- module entitlement matrix -----------------------------------------------

type platEntitlementSchool struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	Plan          *string `json:"plan,omitempty"`
	PlanName      *string `json:"plan_name,omitempty"`
	// Modules the plan includes. Empty means every module, which is how the
	// top plan avoids being edited each time one is added.
	PlanModules []string `json:"plan_modules"`
	// What the school actually has switched on.
	Enabled []string `json:"enabled"`
	// Switched on without the plan covering it. The conversation the account
	// manager has at renewal, and the reason this screen is not two screens.
	BeyondPlan []string `json:"beyond_plan"`
}

type platPlanRow struct {
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Price    int64    `json:"price_paise"`
	Modules  []string `json:"modules"`
	Schools  int      `json:"schools"`
	Sequence int      `json:"sequence"`
}

type platEntitlementResponse struct {
	Plans   []platPlanRow           `json:"plans"`
	Schools []platEntitlementSchool `json:"schools"`
	// Every module name in use anywhere, so the matrix has columns even for a
	// school that has switched none on.
	Modules []string `json:"modules"`
}

func (s *Server) getEntitlementMatrix(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	out := platEntitlementResponse{
		Plans: []platPlanRow{}, Schools: []platEntitlementSchool{},
		Modules: []string{},
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		prows, err := tx.Query(r.Context(), `
			SELECT p.code, p.name, p.price_paise, p.modules, p.sequence,
			       (SELECT count(*) FROM subscriptions s
			         WHERE s.plan_code = p.code)::int
			  FROM plans p ORDER BY p.sequence, p.code`)
		if err != nil {
			return err
		}
		defer prows.Close()
		for prows.Next() {
			var v platPlanRow
			if err := prows.Scan(&v.Code, &v.Name, &v.Price, &v.Modules,
				&v.Sequence, &v.Schools); err != nil {
				return err
			}
			out.Plans = append(out.Plans, v)
		}
		if err := prows.Err(); err != nil {
			return err
		}

		mrows, err := tx.Query(r.Context(), `
			SELECT DISTINCT m FROM (
			    SELECT module AS m FROM module_settings
			    UNION SELECT unnest(modules) FROM plans
			) x ORDER BY m`)
		if err != nil {
			return err
		}
		defer mrows.Close()
		for mrows.Next() {
			var m string
			if err := mrows.Scan(&m); err != nil {
				return err
			}
			out.Modules = append(out.Modules, m)
		}
		if err := mrows.Err(); err != nil {
			return err
		}

		srows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, sub.plan_code, p.name,
			       COALESCE(p.modules, ARRAY[]::text[]),
			       COALESCE((SELECT array_agg(ms.module ORDER BY ms.module)
			                   FROM module_settings ms
			                  WHERE ms.institution_id = i.id AND ms.enabled),
			                ARRAY[]::text[])
			  FROM institutions i
			  LEFT JOIN subscriptions sub ON sub.institution_id = i.id
			  LEFT JOIN plans p ON p.code = sub.plan_code
			 WHERE i.status = 'active'
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			var v platEntitlementSchool
			if err := srows.Scan(&v.InstitutionID, &v.School, &v.Plan, &v.PlanName,
				&v.PlanModules, &v.Enabled); err != nil {
				return err
			}
			v.BeyondPlan = platBeyondPlan(v.PlanModules, v.Enabled)
			out.Schools = append(out.Schools, v)
		}
		return srows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// platBeyondPlan lists modules a school uses that its plan does not include.
//
// An empty plan module list means everything, per the convention 00011_seller.sql
// established, so it yields nothing rather than flagging every module at once.
func platBeyondPlan(planModules, enabled []string) []string {
	out := []string{}
	if len(planModules) == 0 {
		return out
	}
	included := make(map[string]struct{}, len(planModules))
	for _, m := range planModules {
		included[m] = struct{}{}
	}
	for _, m := range enabled {
		if _, ok := included[m]; !ok {
			out = append(out, m)
		}
	}
	return out
}

type platEntitlementRequest struct {
	InstitutionID string `json:"institution_id"`
	Module        string `json:"module"`
	Enabled       bool   `json:"enabled"`
}

/*
setEntitlement switches one module on or off for one school.

	Distinct from PUT /admin/modules, which does the same thing for the caller's
	own school. This one names the school, because the vendor is not in one —
	and it is gated on platform.plans.write, which no school role holds, so a
	school cannot use it to grant itself a module it has not bought.
*/
func (s *Server) setEntitlement(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var req platEntitlementRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	iid, err := uuid.Parse(strings.TrimSpace(req.InstitutionID))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id must be a uuid")
		return
	}
	req.Module = strings.TrimSpace(req.Module)
	if req.Module == "" {
		httpx.BadRequest(w, r, "module is required")
		return
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO module_settings (institution_id, module, enabled)
			VALUES ($1,$2,$3)
			ON CONFLICT (institution_id, module)
			DO UPDATE SET enabled = EXCLUDED.enabled`,
			iid, req.Module, req.Enabled)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}
