package api

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/* The UPI code a family scans, made by the server.

   The address and payee name come from the school's profile, never from the
   caller: a QR whose payee the browser chose is a QR a tampered page could
   point at a stranger. The caller says only how much and what to write in
   the note, which is the admission number and invoice the office matches
   the transfer against.

   The answer carries both forms of the same intent -- the upi://pay link a
   phone opens directly, and a PNG of it for a desk to show or a phone to
   scan -- so the page draws nothing itself. See fees.UPIQRPNG for why. */

type upiCode struct {
	VPA         string `json:"vpa"`
	PayeeName   string `json:"payee_name"`
	AmountPaise int64  `json:"amount_paise"`
	Note        string `json:"note,omitempty"`
	// The upi://pay URI. On a phone, an <a href> to it opens whichever UPI
	// app holds the OS default -- which is why Apps exists beside it.
	Intent string `json:"intent"`
	/* One entry per payment app, so the parent picks rather than the phone.
	   A bare upi:// link goes to the default handler with no chooser, and on
	   a great many phones that is WhatsApp: a parent whose money is in
	   Google Pay tapped "pay" and landed somewhere they had never funded.
	   See fees.UPIAppLinks. */
	Apps []fees.UPIApp `json:"apps,omitempty"`
	// A data: URI of the PNG, ready for an <img src>.
	Image string `json:"image"`
}

// getUPICode answers GET /fees/upi-code?amount_paise=&note=&size=.
// 404 when the school has set no UPI address: there is no code to draw, and
// the screens already say where to set one.
func (s *Server) getUPICode(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	amount, err := strconv.ParseInt(strings.TrimSpace(q.Get("amount_paise")), 10, 64)
	if err != nil || amount <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be a whole number of paise greater than zero")
		return
	}
	size := 440
	if v := q.Get("size"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			size = n
		}
	}

	var vpa, payee, merchantCode string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT COALESCE(upi_vpa,''), COALESCE(NULLIF(upi_payee_name,''), name),
			       COALESCE(upi_merchant_code,'')
			  FROM institutions WHERE id = $1`, id.InstitutionID).
			Scan(&vpa, &payee, &merchantCode)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if vpa == "" {
		httpx.NotFound(w, r)
		return
	}

	note := fees.UPINote(q.Get("note"))
	/* The reference the office matches a transfer against, carried only on a
	   merchant code (see fees.UPIIntent). The caller passes the invoice
	   number; absent one, the note stands in, which is still better for
	   reconciliation than an empty tr. */
	ref := strings.TrimSpace(q.Get("ref"))
	if ref == "" {
		ref = note
	}
	pay := fees.Payment{
		VPA: vpa, PayeeName: payee, AmountPaise: amount, Note: note,
		MerchantCode: merchantCode, Ref: ref,
	}
	intent := fees.UPIIntent(pay)
	png, err := fees.UPIQRPNG(intent, size)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// The code for a given amount and note never changes; let the browser
	// keep it for the day so tapping between invoices does not redraw.
	w.Header().Set("Cache-Control", "private, max-age=86400")
	httpx.JSON(w, http.StatusOK, upiCode{
		VPA:         vpa,
		PayeeName:   payee,
		AmountPaise: amount,
		Note:        note,
		Intent:      intent,
		Apps:        fees.UPIAppLinks(pay),
		Image:       "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	})
}
