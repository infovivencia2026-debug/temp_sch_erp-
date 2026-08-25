package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What each school uses, and what that costs to provide.

   A vendor could see what every school pays and nothing about what any of them
   costs, which makes revenue half a sentence: ₹8,000 a month is a good customer
   or a bad one depending on a figure nobody had written down.

   Two halves, and they are honest about being different in kind.

   What is measured is measured. Stored bytes are a sum over files.size_bytes,
   which carries institution_id, so storage per school is a fact rather than an
   estimate. Rows are counted per school across the tables that actually grow —
   attendance, marks, invoices, notifications — because those are what a
   database bill is made of.

   What is not measured is not invented. Per-school CPU, memory and bandwidth do
   not exist in this product: one process serves every school and nothing
   attributes a request to a tenant. Reporting a made-up split would be worse
   than reporting nothing, because a vendor would price against it. So the fixed
   monthly bill is apportioned — openly, by a rule the screen states — and the
   screen says that is what it is doing.

   Apportioned by students rather than evenly, because that is the axis the
   vendor already sells on: a school with 1,200 children is doing roughly twelve
   times the work of one with 100, and splitting a server bill equally between
   them would tell the vendor their smallest customer is their least profitable
   when the opposite is true. */

type costSettings struct {
	InfraPaise        int64  `json:"infra_paise"`
	StoragePaisePerGB int64  `json:"storage_paise_per_gb"`
	SMSPaise          int64  `json:"sms_paise"`
	EmailPaise        int64  `json:"email_paise"`
	WhatsAppPaise     int64  `json:"whatsapp_paise"`
	Notes             string `json:"notes,omitempty"`
	UpdatedAt         string `json:"updated_at,omitempty"`
	UpdatedBy         string `json:"updated_by,omitempty"`
}

type schoolUsage struct {
	InstitutionID string `json:"institution_id"`
	School        string `json:"school"`
	Status        string `json:"status"`
	Students      int    `json:"students"`
	Staff         int    `json:"staff"`

	// Measured.
	StoredBytes int64 `json:"stored_bytes"`
	FileCount   int   `json:"file_count"`
	Rows        int64 `json:"rows"`
	Messages    int   `json:"messages"`

	// Derived, and labelled as such on the screen.
	SharePct        float64 `json:"share_pct"`
	InfraPaise      int64   `json:"infra_paise"`
	StoragePaise    int64   `json:"storage_paise"`
	CostPaise       int64   `json:"cost_paise"`
	RevenuePaise    int64   `json:"revenue_paise"`
	MarginPaise     int64   `json:"margin_paise"`
}

type usageResponse struct {
	Costs  costSettings  `json:"costs"`
	Items  []schoolUsage `json:"items"`
	Totals schoolUsage   `json:"totals"`
	// What this screen cannot tell you, in its own words rather than by
	// omission — the same admission Instance Health makes about error rates.
	NotMeasured string `json:"not_measured"`
}

// getPlatformUsage reports storage and volume per school against the costs.
func (s *Server) getPlatformUsage(w http.ResponseWriter, r *http.Request) {
	var out usageResponse
	out.NotMeasured = "CPU, memory and bandwidth are not attributed per school: " +
		"one process serves every tenant and nothing tags a request with the school " +
		"it was for. The fixed monthly bill below is therefore apportioned by roll, " +
		"not measured — it is an allocation, and a school doing nothing this month " +
		"still carries its share."

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT infra_paise, storage_paise_per_gb, sms_paise, email_paise,
			       whatsapp_paise, notes,
			       to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI'),
			       COALESCE((SELECT full_name FROM users u WHERE u.id = updated_by), '')
			  FROM platform_costs WHERE id`).Scan(
			&out.Costs.InfraPaise, &out.Costs.StoragePaisePerGB, &out.Costs.SMSPaise,
			&out.Costs.EmailPaise, &out.Costs.WhatsAppPaise, &out.Costs.Notes,
			&out.Costs.UpdatedAt, &out.Costs.UpdatedBy); err != nil {
			return err
		}

		/* One pass per school over the things that actually grow.

		   Not every table — a count over sixty tables to produce one number is
		   a query a vendor waits on, and the four below are where the volume
		   is. Deleted files are excluded: a school that cleared its uploads
		   should see that reflected in what it is charged. */
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, i.status,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int,
			       (SELECT count(*) FROM employees e
			         WHERE e.institution_id = i.id AND e.status = 'active')::int,
			       COALESCE((SELECT sum(f.size_bytes) FROM files f
			         WHERE f.institution_id = i.id AND f.deleted_at IS NULL), 0),
			       COALESCE((SELECT count(*) FROM files f
			         WHERE f.institution_id = i.id AND f.deleted_at IS NULL), 0)::int,
			       COALESCE((SELECT count(*) FROM student_attendance a
			         WHERE a.institution_id = i.id), 0)
			     + COALESCE((SELECT count(*) FROM marks m
			         WHERE m.institution_id = i.id), 0)
			     + COALESCE((SELECT count(*) FROM invoices inv
			         WHERE inv.institution_id = i.id), 0)
			     + COALESCE((SELECT count(*) FROM notifications n
			         WHERE n.institution_id = i.id), 0),
			       COALESCE((SELECT count(*) FROM message_log ml
			         WHERE ml.institution_id = i.id), 0)::int
			  FROM institutions i
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v schoolUsage
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Status,
				&v.Students, &v.Staff, &v.StoredBytes, &v.FileCount,
				&v.Rows, &v.Messages); err != nil {
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
	if out.Items == nil {
		out.Items = []schoolUsage{}
	}

	/* The allocation.

	   Roll is the denominator, and a school with nobody on it still gets a
	   floor of one — otherwise a newly provisioned school divides by zero and
	   appears to cost nothing at all, which is the opposite of true. */
	var totalRoll int
	for _, it := range out.Items {
		totalRoll += max(it.Students, 1)
	}
	const bytesPerGB = 1024 * 1024 * 1024
	for i := range out.Items {
		it := &out.Items[i]
		share := float64(max(it.Students, 1)) / float64(max(totalRoll, 1))
		it.SharePct = share * 100
		it.InfraPaise = int64(float64(out.Costs.InfraPaise) * share)
		it.StoragePaise = it.StoredBytes * out.Costs.StoragePaisePerGB / bytesPerGB
		it.CostPaise = it.InfraPaise + it.StoragePaise

		out.Totals.Students += it.Students
		out.Totals.Staff += it.Staff
		out.Totals.StoredBytes += it.StoredBytes
		out.Totals.FileCount += it.FileCount
		out.Totals.Rows += it.Rows
		out.Totals.Messages += it.Messages
		out.Totals.CostPaise += it.CostPaise
		out.Totals.StoragePaise += it.StoragePaise
		out.Totals.InfraPaise += it.InfraPaise
	}
	out.Totals.School = "All schools"

	httpx.JSON(w, http.StatusOK, out)
}

// setPlatformCosts records what the installation costs the vendor to run.
func (s *Server) setPlatformCosts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req costSettings
	if !httpx.Decode(w, r, &req) {
		return
	}
	for _, v := range []int64{req.InfraPaise, req.StoragePaisePerGB, req.SMSPaise,
		req.EmailPaise, req.WhatsAppPaise} {
		if v < 0 {
			httpx.BadRequest(w, r, "costs cannot be negative")
			return
		}
	}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE platform_costs
			   SET infra_paise = $1, storage_paise_per_gb = $2, sms_paise = $3,
			       email_paise = $4, whatsapp_paise = $5, notes = $6,
			       updated_by = $7, updated_at = now()
			 WHERE id`,
			req.InfraPaise, req.StoragePaisePerGB, req.SMSPaise,
			req.EmailPaise, req.WhatsAppPaise, req.Notes, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}
