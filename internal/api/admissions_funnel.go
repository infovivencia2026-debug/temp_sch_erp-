package api

import (
	"encoding/csv"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The admissions funnel.

   The product could record an enquiry, record an application, and move one to
   the other. What it could not answer is anything the admissions head is
   measured on: which advertisement worked, which counsellor is sitting on
   forty untouched leads, who is next on the waiting list, and whether the RTE
   register would survive an inspection. */

// --- where leads come from -------------------------------------------------

type sourceRow struct {
	Source string `json:"source"`
	// The four numbers a funnel is judged by. Counted from the same rows so
	// they always add up, which a dashboard assembled from separate queries
	// famously does not.
	Enquiries int `json:"enquiries"`
	Applied   int `json:"applied"`
	Offered   int `json:"offered"`
	Admitted  int `json:"admitted"`
	// Enquiry to admission, as a percentage. Null rather than zero when there
	// is nothing to divide by: one enquiry from a newspaper is not a 0%
	// conversion rate, it is not yet a rate at all.
	ConversionPct *float64 `json:"conversion_percent,omitempty"`
}

func (s *Server) getLeadSources(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT COALESCE(NULLIF(btrim(e.source), ''), 'Not recorded'),
		       count(*)::int,
		       count(a.id)::int,
		       count(*) FILTER (WHERE a.status IN ('offered','accepted'))::int,
		       count(*) FILTER (WHERE a.status = 'accepted')::int
		  FROM enquiries e
		  LEFT JOIN applications a ON a.enquiry_id = e.id
		 WHERE e.created_at::date BETWEEN $1::date AND $2::date
		 GROUP BY 1
		 ORDER BY 2 DESC`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (sourceRow, error) {
			var v sourceRow
			err := rows.Scan(&v.Source, &v.Enquiries, &v.Applied, &v.Offered, &v.Admitted)
			if v.Enquiries >= 5 {
				p := 100 * float64(v.Admitted) / float64(v.Enquiries)
				v.ConversionPct = &p
			}
			return v, err
		})
	respond(w, r, items, err)
}

type leadRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	ParentName  *string `json:"parent_name,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	ClassSought *string `json:"class_sought,omitempty"`
	Source      *string `json:"source,omitempty"`
	Campaign    *string `json:"campaign,omitempty"`
	UTM         *string `json:"utm,omitempty"`
	Status      string  `json:"status"`
	AssignedTo  *string `json:"assigned_to,omitempty"`
	NextFollow  *string `json:"next_follow_up,omitempty"`
	CreatedAt   string  `json:"created_at"`
	// Days since anyone last spoke to them. The number the admissions head
	// actually manages by, and the reason assigned_at and last_contacted_at
	// exist as separate columns.
	DaysSilent int  `json:"days_silent"`
	Overdue    bool `json:"follow_up_overdue"`
}

func (s *Server) listLeads(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT e.id::text, e.student_name, e.parent_name, e.phone, c.name,
		       e.source, e.campaign,
		       NULLIF(concat_ws('/', e.utm_source, e.utm_medium, e.utm_campaign), ''),
		       e.status, u.full_name,
		       to_char(e.next_follow_up,'YYYY-MM-DD'),
		       to_char(e.created_at,'YYYY-MM-DD'),
		       EXTRACT(day FROM now() - COALESCE(e.last_contacted_at, e.created_at))::int,
		       e.next_follow_up IS NOT NULL AND e.next_follow_up < current_date
		         AND e.status NOT IN ('converted','lost')
		  FROM enquiries e
		  LEFT JOIN classes c ON c.id = e.class_sought
		  LEFT JOIN users u ON u.id = e.assigned_to
		 WHERE ($1::text IS NULL OR e.status = $1)
		   AND ($2::uuid IS NULL OR e.assigned_to = $2::uuid)
		   AND ($3::bool IS NOT TRUE OR e.assigned_to IS NULL)
		 -- Overdue follow-ups first, then whoever has been ignored longest.
		 ORDER BY (e.next_follow_up IS NOT NULL AND e.next_follow_up < current_date) DESC,
		          COALESCE(e.last_contacted_at, e.created_at)
		 LIMIT 400`,
		[]any{nullString(q.Get("status")), nullString(q.Get("assigned_to")),
			q.Get("unassigned") == "true"},
		func(rows pgx.Rows) (leadRow, error) {
			var v leadRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.ParentName, &v.Phone,
				&v.ClassSought, &v.Source, &v.Campaign, &v.UTM, &v.Status,
				&v.AssignedTo, &v.NextFollow, &v.CreatedAt, &v.DaysSilent, &v.Overdue)
		})
	respond(w, r, items, err)
}

type leadAssignRequest struct {
	IDs        []string `json:"ids"`
	AssignedTo string   `json:"assigned_to,omitempty"`
	NextFollow string   `json:"next_follow_up,omitempty"`
	Contacted  bool     `json:"contacted,omitempty"`
	Status     string   `json:"status,omitempty"`
	Notes      string   `json:"notes,omitempty"`
}

/*
assignLeads hands a batch of enquiries to a counsellor.

	A batch rather than one at a time because that is how the work arrives: a
	morning's forty web enquiries get split between three people at once, and
	doing it singly is the reason nobody does it.
*/
func (s *Server) assignLeads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req leadAssignRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.IDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one enquiry")
		return
	}
	ids := make([]uuid.UUID, 0, len(req.IDs))
	for _, raw := range req.IDs {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "every id must be a uuid")
			return
		}
		ids = append(ids, v)
	}

	var affected int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE enquiries
			   SET assigned_to = COALESCE(NULLIF($2,'')::uuid, assigned_to),
			       -- Stamped only when the owner actually changes, so
			       -- "untouched for nine days" survives a bulk re-save.
			       assigned_at = CASE
			           WHEN NULLIF($2,'')::uuid IS DISTINCT FROM assigned_to
			                AND NULLIF($2,'') IS NOT NULL THEN now()
			           ELSE assigned_at END,
			       next_follow_up = COALESCE(NULLIF($3,'')::date, next_follow_up),
			       last_contacted_at = CASE WHEN $4 THEN now() ELSE last_contacted_at END,
			       status = COALESCE(NULLIF($5,''), status),
			       notes = CASE WHEN $6 = '' THEN notes
			                    ELSE concat_ws(E'\n', notes, $6) END,
			       updated_at = now()
			 WHERE id = ANY($1)`,
			ids, req.AssignedTo, req.NextFollow, req.Contacted, req.Status, req.Notes)
		if err != nil {
			return err
		}
		affected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": affected})
}

// --- quota, siblings and the waiting list ----------------------------------

type quotaRow struct {
	Quota    string `json:"quota"`
	Applied  int    `json:"applied"`
	Offered  int    `json:"offered"`
	Admitted int    `json:"admitted"`
}

type rteRow struct {
	ID          string  `json:"id"`
	AppNo       string  `json:"application_no"`
	Name        string  `json:"full_name"`
	ClassSought *string `json:"class_sought,omitempty"`
	Category    *string `json:"category,omitempty"`
	Quota       string  `json:"quota"`
	RTEStatus   *string `json:"rte_status,omitempty"`
	Status      string  `json:"status"`
	Aadhaar     bool    `json:"aadhaar_consent"`
	APAAR       *string `json:"apaar_id,omitempty"`
	PriorUDISE  *string `json:"prior_udise_code,omitempty"`
	Sibling     *string `json:"sibling,omitempty"`
	Alumni      *string `json:"alumni_parent_name,omitempty"`
	WaitRank    *int    `json:"waitlist_rank,omitempty"`
	// What an inspection would find missing on this row. Named rather than
	// counted, because "three fields short" is not something a clerk can act
	// on at four in the afternoon.
	Missing []string `json:"missing"`
}

/*
getAdmissionRegister is the quota register, RTE included.

	One query for every quota rather than a separate RTE screen: a school
	defends its intake as a whole, and the reconciliation an inspector asks for
	is between the quotas, not within one of them.
*/
func (s *Server) getAdmissionRegister(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT a.id::text, a.application_no,
		       concat_ws(' ', a.first_name, a.last_name), c.name,
		       a.category, a.quota, a.rte_status, a.status,
		       a.aadhaar_consent, a.apaar_id, a.prior_udise_code,
		       NULLIF(concat_ws(' ', sib.first_name, sib.last_name), ''),
		       a.alumni_parent_name, a.waitlist_rank
		  FROM applications a
		  LEFT JOIN classes c ON c.id = a.class_sought
		  LEFT JOIN students sib ON sib.id = a.sibling_student_id
		 WHERE ($1::text IS NULL OR a.quota = $1)
		   AND ($2::text IS NULL OR a.status = $2)
		 ORDER BY a.quota, a.waitlist_rank NULLS LAST, a.application_no
		 LIMIT 500`,
		[]any{nullString(q.Get("quota")), nullString(q.Get("status"))},
		func(rows pgx.Rows) (rteRow, error) {
			var v rteRow
			err := rows.Scan(&v.ID, &v.AppNo, &v.Name, &v.ClassSought, &v.Category,
				&v.Quota, &v.RTEStatus, &v.Status, &v.Aadhaar, &v.APAAR,
				&v.PriorUDISE, &v.Sibling, &v.Alumni, &v.WaitRank)
			v.Missing = []string{}
			// Only judge what the quota actually requires. An RTE seat without
			// its own paperwork is the finding; a general seat without an
			// alumni name is not.
			if v.Quota == "rte" && (v.RTEStatus == nil || *v.RTEStatus == "") {
				v.Missing = append(v.Missing, "RTE status")
			}
			if v.Quota == "sibling" && v.Sibling == nil {
				v.Missing = append(v.Missing, "the sibling")
			}
			if v.Quota == "alumni" && v.Alumni == nil {
				v.Missing = append(v.Missing, "the alumnus")
			}
			if !v.Aadhaar {
				v.Missing = append(v.Missing, "Aadhaar consent")
			}
			if v.APAAR == nil || *v.APAAR == "" {
				v.Missing = append(v.Missing, "APAAR")
			}
			return v, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var quotas []quotaRow
	var total, rteAdmitted int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT quota, count(*)::int,
			       count(*) FILTER (WHERE status IN ('offered','accepted'))::int,
			       count(*) FILTER (WHERE status = 'accepted')::int
			  FROM applications GROUP BY quota ORDER BY quota`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v quotaRow
			if err := rows.Scan(&v.Quota, &v.Applied, &v.Offered, &v.Admitted); err != nil {
				return err
			}
			total += v.Admitted
			if v.Quota == "rte" {
				rteAdmitted = v.Admitted
			}
			quotas = append(quotas, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if quotas == nil {
		quotas = []quotaRow{}
	}

	// The one number the RTE Act is actually about, stated rather than left
	// for somebody to work out: a quarter of the intake, or the shortfall.
	var rtePct float64
	if total > 0 {
		rtePct = 100 * float64(rteAdmitted) / float64(total)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "quotas": quotas,
		"admitted_total": total, "rte_admitted": rteAdmitted,
		"rte_percent":  rtePct,
		"rte_short_by": maxInt(0, (total+3)/4-rteAdmitted),
	})
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

type applicationPatch struct {
	ID           string `json:"id"`
	Quota        string `json:"quota,omitempty"`
	RTEStatus    string `json:"rte_status,omitempty"`
	AadhaarOK    *bool  `json:"aadhaar_consent,omitempty"`
	AadhaarLast4 string `json:"aadhaar_last4,omitempty"`
	APAAR        string `json:"apaar_id,omitempty"`
	PriorUDISE   string `json:"prior_udise_code,omitempty"`
	SiblingID    string `json:"sibling_student_id,omitempty"`
	AlumniName   string `json:"alumni_parent_name,omitempty"`
	Medical      string `json:"medical_conditions,omitempty"`
	Allergies    string `json:"allergies,omitempty"`
	Immunised    string `json:"immunisation_upto,omitempty"`
	BloodGroup   string `json:"blood_group,omitempty"`
	Nationality  string `json:"nationality,omitempty"`
	Passport     string `json:"passport_no,omitempty"`
	VisaType     string `json:"visa_type,omitempty"`
	VisaExpiry   string `json:"visa_expiry,omitempty"`
	WaitRank     *int   `json:"waitlist_rank,omitempty"`
}

func (s *Server) patchApplication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req applicationPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	appID, err := uuid.Parse(req.ID)
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	if req.Quota != "" && !oneOfStr(req.Quota, "general", "rte", "ews", "sibling",
		"alumni", "staff", "sports", "management") {
		httpx.BadRequest(w, r, "unknown quota "+req.Quota)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE applications SET
			    quota = COALESCE(NULLIF($2,''), quota),
			    rte_status = COALESCE(NULLIF($3,''), rte_status),
			    aadhaar_consent = COALESCE($4, aadhaar_consent),
			    aadhaar_last4 = COALESCE(NULLIF($5,''), aadhaar_last4),
			    apaar_id = COALESCE(NULLIF($6,''), apaar_id),
			    prior_udise_code = COALESCE(NULLIF($7,''), prior_udise_code),
			    sibling_student_id = COALESCE(NULLIF($8,'')::uuid, sibling_student_id),
			    alumni_parent_name = COALESCE(NULLIF($9,''), alumni_parent_name),
			    medical_conditions = COALESCE(NULLIF($10,''), medical_conditions),
			    allergies = COALESCE(NULLIF($11,''), allergies),
			    immunisation_upto = COALESCE(NULLIF($12,''), immunisation_upto),
			    blood_group = COALESCE(NULLIF($13,''), blood_group),
			    nationality = COALESCE(NULLIF($14,''), nationality),
			    passport_no = COALESCE(NULLIF($15,''), passport_no),
			    visa_type = COALESCE(NULLIF($16,''), visa_type),
			    visa_expiry = COALESCE(NULLIF($17,'')::date, visa_expiry),
			    waitlist_rank = COALESCE($18, waitlist_rank),
			    updated_at = now()
			 WHERE id = $1`,
			appID, req.Quota, req.RTEStatus, req.AadhaarOK, req.AadhaarLast4,
			req.APAAR, req.PriorUDISE, req.SiblingID, req.AlumniName,
			req.Medical, req.Allergies, req.Immunised, req.BloodGroup,
			req.Nationality, req.Passport, req.VisaType, req.VisaExpiry, req.WaitRank)
		return err
	})
	if err != nil {
		if strings.Contains(err.Error(), "applications_visa_dated") {
			httpx.BadRequest(w, r,
				"a foreign applicant with a passport on file needs the visa expiry too")
			return
		}
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "rank_taken",
				"another applicant already holds that place on the waiting list")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
}

/*
findSiblings looks for a child of the same family already in the school.

	Matched on the guardian's phone number rather than the surname: surnames
	repeat constantly in an Indian school roll and a phone number is what the
	family actually gave twice. Returned as candidates for a human to confirm,
	never applied automatically — a wrongly granted sibling seat is a place
	taken from somebody else.
*/
func (s *Server) findSiblings(w http.ResponseWriter, r *http.Request) {
	appID, err := uuid.Parse(r.URL.Query().Get("application_id"))
	if err != nil {
		httpx.BadRequest(w, r, "application_id must be a uuid")
		return
	}
	items, err := collect(s, r, `
		SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, COALESCE(c.name, '—'),
		       CASE WHEN g.phone = a.parent_phone THEN 'same guardian phone'
		            ELSE 'same parent name' END
		  FROM applications a
		  JOIN students st ON st.institution_id = a.institution_id AND st.status = 'active'
		  LEFT JOIN student_guardians sg ON sg.student_id = st.id
		  LEFT JOIN guardians g ON g.id = sg.guardian_id
		  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN classes c ON c.id = sec.class_id
		 WHERE a.id = $1
		   AND (
		     (a.parent_phone IS NOT NULL AND g.phone = a.parent_phone)
		     OR (a.parent_name IS NOT NULL AND g.full_name IS NOT NULL
		         AND lower(g.full_name) = lower(a.parent_name))
		   )
		 GROUP BY st.id, st.first_name, st.last_name, st.admission_no, c.name,
		          g.phone, a.parent_phone
		 LIMIT 20`, []any{appID},
		func(rows pgx.Rows) (struct {
			ID     string `json:"student_id"`
			Name   string `json:"full_name"`
			AdmNo  string `json:"admission_no"`
			Class  string `json:"class_name"`
			Reason string `json:"matched_on"`
		}, error) {
			var v struct {
				ID     string `json:"student_id"`
				Name   string `json:"full_name"`
				AdmNo  string `json:"admission_no"`
				Class  string `json:"class_name"`
				Reason string `json:"matched_on"`
			}
			return v, rows.Scan(&v.ID, &v.Name, &v.AdmNo, &v.Class, &v.Reason)
		})
	respond(w, r, items, err)
}

/*
promoteWaitlist moves the next waitlisted applicant into an offer.

	Takes the lowest rank rather than the earliest application, because a
	school that ranks its waiting list has already decided the order and
	promoting by date would quietly overrule it.
*/
func (s *Server) promoteWaitlist(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		ClassID string `json:"class_id"`
		Seats   int    `json:"seats"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Seats <= 0 {
		req.Seats = 1
	}
	class, err := uuid.Parse(req.ClassID)
	if err != nil {
		httpx.BadRequest(w, r, "class_id must be a uuid")
		return
	}

	var promoted []string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			UPDATE applications SET status = 'offered', waitlist_rank = NULL,
			       decided_by = $3, decided_at = now(), updated_at = now()
			 WHERE id IN (
			     SELECT id FROM applications
			      WHERE class_sought = $1 AND status = 'waitlisted'
			      ORDER BY waitlist_rank NULLS LAST, created_at
			      LIMIT $2
			 )
			 RETURNING concat_ws(' ', first_name, last_name)`,
			class, req.Seats, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			promoted = append(promoted, name)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if promoted == nil {
		promoted = []string{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"promoted": promoted, "count": len(promoted)})
}

/*
importRTELottery takes the state's allotment list and marks the winners.

	Matched on application number, because that is what the state list carries
	back. Rows it cannot match are returned rather than skipped: a lottery
	import that silently drops four children is the worst possible failure of
	this feature, and the office needs to see the four.
*/
func (s *Server) importRTELottery(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	file, _, err := r.FormFile("file")
	if err != nil {
		httpx.BadRequest(w, r, "attach the state's allotment list as a CSV")
		return
	}
	defer file.Close()

	records, err := csv.NewReader(file).ReadAll()
	if err != nil {
		httpx.BadRequest(w, r, "could not read that CSV: "+err.Error())
		return
	}
	if len(records) < 2 {
		httpx.BadRequest(w, r, "that file has no rows under its header")
		return
	}

	var matched int
	unmatched := []string{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for i, rec := range records {
			if i == 0 || len(rec) == 0 {
				continue // header
			}
			appNo := strings.TrimSpace(rec[0])
			if appNo == "" {
				continue
			}
			status := "selected"
			if len(rec) > 1 && strings.TrimSpace(rec[1]) != "" {
				status = strings.ToLower(strings.TrimSpace(rec[1]))
			}
			if !oneOfStr(status, "applied", "eligible", "selected", "rejected") {
				status = "selected"
			}
			tag, err := tx.Exec(r.Context(), `
				UPDATE applications
				   SET rte_status = $2, quota = 'rte', is_rte = true, updated_at = now()
				 WHERE application_no = $1`, appNo, status)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				unmatched = append(unmatched, appNo)
			} else {
				matched++
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"matched": matched, "unmatched": unmatched,
		"rows": len(records) - 1,
	})
}

// --- open days -------------------------------------------------------------

type openDayRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	OnDate    string  `json:"on_date"`
	Venue     *string `json:"venue,omitempty"`
	Published bool    `json:"is_published"`
	Slots     int     `json:"slots"`
	Capacity  int     `json:"capacity"`
	Booked    int     `json:"booked"`
	Attended  int     `json:"attended"`
	Families  int     `json:"parents"`
}

func (s *Server) listOpenDays(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ev.id::text, ev.name, to_char(ev.on_date,'YYYY-MM-DD'), ev.venue,
		       ev.is_published,
		       COALESCE(sl.slots, 0), COALESCE(sl.capacity, 0),
		       COALESCE(bk.booked, 0), COALESCE(bk.attended, 0), COALESCE(bk.families, 0)
		  FROM admission_events ev
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS slots, sum(capacity)::int AS capacity
		        FROM admission_event_slots s2 WHERE s2.event_id = ev.id
		  ) sl ON TRUE
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS booked,
		             count(*) FILTER (WHERE b.attended_at IS NOT NULL)::int AS attended,
		             sum(b.children)::int AS families
		        FROM admission_event_bookings b
		        JOIN admission_event_slots s3 ON s3.id = b.slot_id
		       WHERE s3.event_id = ev.id
		  ) bk ON TRUE
		 ORDER BY ev.on_date DESC LIMIT 50`, nil,
		func(rows pgx.Rows) (openDayRow, error) {
			var v openDayRow
			return v, rows.Scan(&v.ID, &v.Name, &v.OnDate, &v.Venue, &v.Published,
				&v.Slots, &v.Capacity, &v.Booked, &v.Attended, &v.Families)
		})
	respond(w, r, items, err)
}

type openDayRequest struct {
	Name      string   `json:"name"`
	OnDate    string   `json:"on_date"`
	Venue     string   `json:"venue,omitempty"`
	Publish   bool     `json:"is_published,omitempty"`
	SlotTimes []string `json:"slot_times,omitempty"`
	Capacity  int      `json:"capacity,omitempty"`
}

func (s *Server) createOpenDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req openDayRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || req.OnDate == "" {
		httpx.BadRequest(w, r, "an open day needs a name and a date")
		return
	}
	if req.Capacity <= 0 {
		req.Capacity = 25
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO admission_events (institution_id, name, on_date, venue, is_published)
			VALUES ($1,$2,$3::date,NULLIF($4,''),$5)
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.OnDate, req.Venue, req.Publish).Scan(&newID); err != nil {
			return err
		}
		for _, t := range req.SlotTimes {
			if strings.TrimSpace(t) == "" {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO admission_event_slots (institution_id, event_id, starts_at, capacity)
				VALUES ($1,$2,$3::time,$4)
				ON CONFLICT (event_id, starts_at) DO NOTHING`,
				id.InstitutionID, newID, t, req.Capacity); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

type slotRow struct {
	ID       string `json:"id"`
	StartsAt string `json:"starts_at"`
	Minutes  int    `json:"minutes"`
	Capacity int    `json:"capacity"`
	Booked   int    `json:"booked"`
	Left     int    `json:"places_left"`
}

func (s *Server) listOpenDaySlots(w http.ResponseWriter, r *http.Request) {
	eventID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid event id")
		return
	}
	items, err := collect(s, r, `
		SELECT sl.id::text, to_char(sl.starts_at,'HH24:MI'), sl.minutes, sl.capacity,
		       COALESCE(b.n, 0), GREATEST(0, sl.capacity - COALESCE(b.n, 0))
		  FROM admission_event_slots sl
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS n FROM admission_event_bookings bb
		       WHERE bb.slot_id = sl.id
		  ) b ON TRUE
		 WHERE sl.event_id = $1
		 ORDER BY sl.starts_at`, []any{eventID},
		func(rows pgx.Rows) (slotRow, error) {
			var v slotRow
			return v, rows.Scan(&v.ID, &v.StartsAt, &v.Minutes, &v.Capacity, &v.Booked, &v.Left)
		})
	respond(w, r, items, err)
}

var errSlotFull = errors.New("slot is full")

func (s *Server) bookOpenDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		SlotID     string `json:"slot_id"`
		ParentName string `json:"parent_name"`
		Phone      string `json:"phone"`
		Children   int    `json:"children,omitempty"`
		EnquiryID  string `json:"enquiry_id,omitempty"`
		Attended   bool   `json:"attended,omitempty"`
		BookingID  string `json:"booking_id,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}

	// Marking arrival is the other half of this endpoint: booked and turned up
	// are different facts, and the ratio is the only honest measure of an open
	// day.
	if req.BookingID != "" {
		bookingID, err := uuid.Parse(req.BookingID)
		if err != nil {
			httpx.BadRequest(w, r, "booking_id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`UPDATE admission_event_bookings SET attended_at = now() WHERE id = $1`,
				bookingID)
			return err
		})
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"attended": true})
		return
	}

	slot, err := uuid.Parse(req.SlotID)
	if err != nil {
		httpx.BadRequest(w, r, "slot_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.ParentName) == "" || strings.TrimSpace(req.Phone) == "" {
		httpx.BadRequest(w, r, "a booking needs a name and a phone number")
		return
	}
	if req.Children <= 0 {
		req.Children = 1
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Capacity checked inside the transaction against the row it is about
		// to write, so two families cannot take the last place at once.
		var full bool
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM admission_event_bookings b
			         WHERE b.slot_id = $1) >= sl.capacity
			  FROM admission_event_slots sl WHERE sl.id = $1
			   FOR UPDATE`, slot).Scan(&full); err != nil {
			return err
		}
		if full {
			return errSlotFull
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO admission_event_bookings
			    (institution_id, slot_id, enquiry_id, parent_name, phone, children)
			VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5,$6)
			RETURNING id::text`,
			id.InstitutionID, slot, req.EnquiryID, req.ParentName, req.Phone,
			req.Children).Scan(&newID)
	})
	if errors.Is(err, errSlotFull) {
		httpx.Error(w, r, http.StatusConflict, "slot_full",
			"that slot is full — offer them another time")
		return
	}
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "already_booked",
				"that number is already booked into this slot")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

func (s *Server) listOpenDayBookings(w http.ResponseWriter, r *http.Request) {
	eventID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid event id")
		return
	}
	items, err := collect(s, r, `
		SELECT b.id::text, to_char(sl.starts_at,'HH24:MI'), b.parent_name, b.phone,
		       b.children, b.attended_at IS NOT NULL
		  FROM admission_event_bookings b
		  JOIN admission_event_slots sl ON sl.id = b.slot_id
		 WHERE sl.event_id = $1
		 ORDER BY sl.starts_at, b.created_at`, []any{eventID},
		func(rows pgx.Rows) (struct {
			ID       string `json:"id"`
			StartsAt string `json:"starts_at"`
			Parent   string `json:"parent_name"`
			Phone    string `json:"phone"`
			Children int    `json:"children"`
			Attended bool   `json:"attended"`
		}, error) {
			var v struct {
				ID       string `json:"id"`
				StartsAt string `json:"starts_at"`
				Parent   string `json:"parent_name"`
				Phone    string `json:"phone"`
				Children int    `json:"children"`
				Attended bool   `json:"attended"`
			}
			return v, rows.Scan(&v.ID, &v.StartsAt, &v.Parent, &v.Phone, &v.Children, &v.Attended)
		})
	respond(w, r, items, err)
}

// --- prospectus ------------------------------------------------------------

type prospectusRow struct {
	ID        string  `json:"id"`
	ReceiptNo string  `json:"receipt_no"`
	OnDate    string  `json:"on_date"`
	Buyer     string  `json:"buyer_name"`
	Phone     *string `json:"phone,omitempty"`
	Class     *string `json:"class_sought,omitempty"`
	Kind      string  `json:"kind"`
	Quantity  int     `json:"quantity"`
	Amount    int64   `json:"amount_paise"`
	Mode      string  `json:"mode"`
	SoldBy    *string `json:"sold_by,omitempty"`
}

func (s *Server) listProspectusSales(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT p.id::text, p.receipt_no, to_char(p.on_date,'YYYY-MM-DD'),
		       p.buyer_name, p.phone, c.name, p.kind, p.quantity, p.amount_paise,
		       p.mode, u.full_name
		  FROM prospectus_sales p
		  LEFT JOIN classes c ON c.id = p.class_sought
		  LEFT JOIN users u ON u.id = p.sold_by
		 WHERE p.on_date BETWEEN $1::date AND $2::date
		 ORDER BY p.on_date DESC, p.receipt_no DESC
		 LIMIT 400`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (prospectusRow, error) {
			var v prospectusRow
			return v, rows.Scan(&v.ID, &v.ReceiptNo, &v.OnDate, &v.Buyer, &v.Phone,
				&v.Class, &v.Kind, &v.Quantity, &v.Amount, &v.Mode, &v.SoldBy)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Stock against sales, so the cupboard and the cash book can be reconciled
	// — which is the only reason a school keeps this register on paper today.
	id := httpx.IdentityFrom(r.Context())
	var received, sold int
	var takings int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT COALESCE((SELECT sum(quantity) FROM prospectus_stock), 0)::int,
			       COALESCE((SELECT sum(quantity) FROM prospectus_sales), 0)::int,
			       COALESCE((SELECT sum(amount_paise) FROM prospectus_sales
			                  WHERE on_date BETWEEN $1::date AND $2::date), 0)`,
			rng.From, rng.To).Scan(&received, &sold, &takings)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "received": received, "sold": sold,
		"in_stock": received - sold, "takings_paise": takings,
	})
}

func (s *Server) sellProspectus(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		Buyer     string `json:"buyer_name"`
		Phone     string `json:"phone,omitempty"`
		ClassID   string `json:"class_sought,omitempty"`
		EnquiryID string `json:"enquiry_id,omitempty"`
		Kind      string `json:"kind,omitempty"`
		Quantity  int    `json:"quantity,omitempty"`
		Amount    int64  `json:"amount_paise"`
		Mode      string `json:"mode,omitempty"`
		// Adding stock rather than selling it.
		StockQty int   `json:"stock_quantity,omitempty"`
		UnitCost int64 `json:"unit_cost_paise,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Kind == "" {
		req.Kind = "prospectus"
	}

	if req.StockQty > 0 {
		err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				INSERT INTO prospectus_stock (institution_id, kind, quantity, unit_cost_paise)
				VALUES ($1,$2,$3,$4)`,
				id.InstitutionID, req.Kind, req.StockQty, nullInt64(req.UnitCost))
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusCreated, map[string]any{"received": req.StockQty})
		return
	}

	if strings.TrimSpace(req.Buyer) == "" {
		httpx.BadRequest(w, r, "who bought it")
		return
	}
	if req.Quantity <= 0 {
		req.Quantity = 1
	}
	if req.Mode == "" {
		req.Mode = "cash"
	}

	var receipt string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO prospectus_sales
			    (institution_id, receipt_no, buyer_name, phone, class_sought,
			     enquiry_id, kind, quantity, amount_paise, mode, sold_by)
			SELECT $1,
			       -- Gapless within the year, allocated inside the transaction:
			       -- a cash book with a hole in its numbering is a cash book
			       -- somebody has to explain.
			       'PR/' || to_char(current_date,'YYYY') || '/' ||
			       lpad((COALESCE(max(substring(p.receipt_no from '[0-9]+$')::int), 0) + 1)::text, 4, '0'),
			       $2, NULLIF($3,''), NULLIF($4,'')::uuid, NULLIF($5,'')::uuid,
			       $6, $7, $8, $9, $10
			  FROM prospectus_sales p
			 WHERE p.institution_id = $1
			   AND p.receipt_no LIKE 'PR/' || to_char(current_date,'YYYY') || '/%'
			RETURNING receipt_no`,
			id.InstitutionID, req.Buyer, req.Phone, req.ClassID, req.EnquiryID,
			req.Kind, req.Quantity, req.Amount, req.Mode, id.UserID).Scan(&receipt)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"receipt_no": receipt})
}

func nullInt64(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}

// --- applicant communication ----------------------------------------------

/*
messageApplicants records what the office told a batch of applicants.

	The sending itself goes through the existing notification pipeline; what
	this adds is the record against each application, because "we told you on
	the ninth" is a claim an admissions office has to be able to support.
*/
func (s *Server) messageApplicants(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		IDs     []string `json:"ids"`
		Message string   `json:"message"`
		Status  string   `json:"status,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		httpx.BadRequest(w, r, "say what they are being told")
		return
	}
	ids := make([]uuid.UUID, 0, len(req.IDs))
	for _, raw := range req.IDs {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "every id must be a uuid")
			return
		}
		ids = append(ids, v)
	}
	if len(ids) == 0 {
		httpx.BadRequest(w, r, "choose at least one applicant")
		return
	}

	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE applications
			   SET remarks = concat_ws(E'\n',
			           remarks,
			           to_char(now(),'YYYY-MM-DD') || ': ' || $2),
			       status = COALESCE(NULLIF($3,''), status),
			       updated_at = now()
			 WHERE id = ANY($1)`, ids, req.Message, req.Status)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"messaged": n})
}
