package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

/* Buying without being sold to.

   /buy takes an enquiry and provisions nothing, on the reasoning that a
   self-service trial which mints a live tenant from an unverified form fills a
   database with "asdf School". That reasoning is sound about a *form*. It is
   not sound about a *payment*: a school that has put ₹90,000 through a card is
   not a drive-by, and making them wait for a salesperson to ring back is how a
   decided customer becomes an undecided one.

   So both doors stay open. The enquiry form is for schools that want to talk;
   this is for schools that have finished talking. The gate is the payment, not
   a telephone call — nobody types a card number into a form to create junk.

   The flow, four screens:

     /signup?plan=…            what we need to know, and what it costs
     /signup/pay/{order}       the gateway
     POST /signup/pay/{order}  the callback: verify, provision, deliver
     /signup/welcome/{order}   the credentials, shown once

   ---------------------------------------------------------------------------
   THE GATEWAY IS SIMULATED.

   There are no Razorpay API keys on this installation, so nothing here talks
   to Razorpay. What it does instead is implement Razorpay's *shape* exactly:
   an order created server-side before the customer sees a payment screen, an
   order_/pay_ identifier pair, and an HMAC-SHA256 signature over
   "order_id|payment_id" which the server recomputes and compares in constant
   time before it trusts a single rupee.

   That is the whole of Razorpay's integration contract. Swapping the
   simulation for the real thing is two changes — call their Orders API in
   createOrder, and let their checkout.js post the callback — and crucially
   verifySignature does not change, because it is already the real algorithm
   against a real secret. A simulation that skipped verification would teach
   the codebase a habit it would keep after the keys arrived.

   The simulated payment screen is marked as simulated on its face. A fake
   payment page that looks genuine is the one thing here that could actually
   hurt somebody. */

// SignupPages is the public self-service purchase flow.
type SignupPages struct {
	DB     *database.DB
	Tpl    *template.Template
	Hasher *auth.Hasher
	// GatewaySecret stands in for the Razorpay key secret. Signatures are
	// computed and verified against it exactly as they would be in production.
	GatewaySecret string
}

type signupView struct {
	AssetVersion string
	Error        string

	// The plan being bought, and the others, so the customer can change their
	// mind without going back to the pricing page.
	Plan  buyPlan
	Plans []buyPlan

	// Sticky form values, so a validation error does not cost the school
	// everything it just typed.
	School   string
	Contact  string
	Email    string
	Phone    string
	District string
	State    string
	Board    string
	Students string
	Username string

	// Billing period the school chose on the pricing page.
	Billing string
	Period  string
	// Gateway screen.
	OrderRef string
	Amount   string
	Prefill  string

	// Welcome screen.
	SignInAs string
	Password string
	PaidRef  string
}

// --- screen one: what we need to know ---------------------------------------

func (sp *SignupPages) Show(w http.ResponseWriter, r *http.Request) {
	plans, err := sp.plans(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	code := r.URL.Query().Get("plan")
	plan, ok := findPlan(plans, code)
	if !ok {
		// No plan, or one that does not exist: send them to choose rather than
		// guessing on their behalf what they meant to buy.
		http.Redirect(w, r, "/buy", http.StatusSeeOther)
		return
	}
	billing := billingPeriod(r.URL.Query().Get("billing"), plan)
	sp.render(w, r, "signup.gohtml", http.StatusOK, signupView{
		Plan: plan, Plans: plans, Billing: billing, Period: periodLabel(billing),
	})
}

// Start validates the school's details and opens an order.
//
// Nothing is provisioned here. The order is a row saying what this school
// intends to buy and for how much, which is what the gateway needs to quote
// and what reconciliation needs afterwards if the payment goes astray.
func (sp *SignupPages) Start(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	plans, err := sp.plans(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	v := signupView{
		Plans:    plans,
		School:   strings.TrimSpace(r.PostFormValue("school_name")),
		Contact:  strings.TrimSpace(r.PostFormValue("contact_name")),
		Email:    strings.TrimSpace(r.PostFormValue("email")),
		Phone:    strings.TrimSpace(r.PostFormValue("phone")),
		District: strings.TrimSpace(r.PostFormValue("district")),
		State:    strings.TrimSpace(r.PostFormValue("state")),
		Board:    strings.TrimSpace(r.PostFormValue("board")),
		Students: strings.TrimSpace(r.PostFormValue("students")),
		Username: strings.ToLower(strings.TrimSpace(r.PostFormValue("admin_username"))),
	}
	v.Billing = billingPeriod(r.PostFormValue("billing"), buyPlan{})
	plan, ok := findPlan(plans, strings.TrimSpace(r.PostFormValue("plan_code")))
	if !ok {
		http.Redirect(w, r, "/buy", http.StatusSeeOther)
		return
	}
	v.Plan = plan
	// Re-resolved against the plan now that we have it: a monthly choice on a
	// plan sold only by the year must not survive into the order.
	v.Billing = billingPeriod(v.Billing, plan)
	v.Period = periodLabel(v.Billing)

	switch {
	case v.School == "":
		v.Error = "Please tell us the name of your school."
	case v.Contact == "":
		v.Error = "Please tell us who will administer the system."
	case !looksLikeEmail(v.Email):
		v.Error = "Please give a working email address. The sign-in details go there."
	case v.Username != "" && !validUsername(v.Username):
		v.Error = "A username may use letters, numbers, dots and underscores, and must be at least four characters."
	}
	if v.Error != "" {
		sp.render(w, r, "signup.gohtml", http.StatusBadRequest, v)
		return
	}

	orderRef, err := gatewayRef("order")
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var students *int
	if n, err := strconv.Atoi(v.Students); err == nil && n > 0 {
		students = &n
	}

	err = sp.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO signup_orders (school_name, contact_name, email, phone,
			                           district, state, board, students,
			                           admin_username, plan_code, amount_paise,
			                           order_ref, billing_period)
			VALUES ($1,$2,$3::citext,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),
			        NULLIF($7,''),$8,NULLIF($9,'')::citext,$10,$11,$12,$13)`,
			v.School, v.Contact, v.Email, v.Phone, v.District, v.State, v.Board,
			students, v.Username, plan.Code, amountFor(plan, v.Billing), orderRef, v.Billing)
		return err
	})
	if err != nil {
		httpx.LogError(r, err)
		v.Error = "Something went wrong at our end. Nothing has been charged. Please try again."
		sp.render(w, r, "signup.gohtml", http.StatusInternalServerError, v)
		return
	}

	http.Redirect(w, r, "/signup/pay/"+orderRef, http.StatusSeeOther)
}

// --- screen two: the gateway ------------------------------------------------

// Pay renders the simulated checkout for an order that has not been paid.
func (sp *SignupPages) Pay(w http.ResponseWriter, r *http.Request) {
	o, err := sp.order(r, chiURLParam(r, "order"))
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// An order already paid must not be payable twice. Send them to what they
	// bought instead of taking a second payment for it.
	if o.Status == "provisioned" || o.Status == "paid" {
		http.Redirect(w, r, "/signup/welcome/"+o.OrderRef, http.StatusSeeOther)
		return
	}

	sp.render(w, r, "pay.gohtml", http.StatusOK, signupView{
		School:   o.School,
		Contact:  o.Contact,
		Email:    o.Email,
		Phone:    o.Phone,
		OrderRef: o.OrderRef,
		Amount:   indianRupees(o.AmountPaise / 100),
		Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		Prefill:  o.Email,
	})
}

// Callback is what the gateway posts back when the customer finishes.
//
// In production this is Razorpay's handler.js posting razorpay_order_id,
// razorpay_payment_id and razorpay_signature. Here the payment id and the
// signature are minted a few lines up instead of arriving over the wire — but
// they are minted the same way Razorpay mints them, and then verified as if
// they were a stranger's, because the verification is the part that has to be
// right.
func (sp *SignupPages) Callback(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	ref := chiURLParam(r, "order")

	o, err := sp.order(r, ref)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if o.Status == "provisioned" || o.Status == "paid" {
		http.Redirect(w, r, "/signup/welcome/"+ref, http.StatusSeeOther)
		return
	}

	// The customer abandoned the payment, or the bank declined it. Recorded
	// rather than discarded: a school that failed to pay twice and gave up is
	// something the seller should be able to see and telephone about.
	if r.PostFormValue("outcome") != "success" {
		reason := strings.TrimSpace(r.PostFormValue("reason"))
		if reason == "" {
			reason = "Payment was not completed."
		}
		_ = sp.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE signup_orders SET status='failed', failure_reason=$2
				 WHERE order_ref=$1 AND status='created'`, ref, reason)
			return err
		})
		sp.render(w, r, "pay.gohtml", http.StatusOK, signupView{
			Error:    reason + " Nothing has been charged.",
			School:   o.School,
			OrderRef: o.OrderRef,
			Amount:   indianRupees(o.AmountPaise / 100),
			Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
			Prefill:  o.Email,
		})
		return
	}

	paymentRef, err := gatewayRef("pay")
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	signature := sp.sign(ref, paymentRef)

	// The check that matters. In production the signature arrives from the
	// browser, where anyone can edit it; recomputing and comparing it here is
	// the only thing standing between a real payment and a claimed one.
	if !sp.verifySignature(ref, paymentRef, signature) {
		httpx.LogError(r, errors.New("signup: signature verification failed for "+ref))
		sp.render(w, r, "pay.gohtml", http.StatusBadRequest, signupView{
			Error:    "We could not verify that payment with the gateway. Nothing has been charged.",
			School:   o.School,
			OrderRef: o.OrderRef,
			Amount:   indianRupees(o.AmountPaise / 100),
			Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		})
		return
	}

	// Payment recorded and school built in one transaction. Splitting them
	// would eventually produce the worst row in the system: money taken, no
	// school, and nobody watching a self-service path to notice.
	var res provisionResult
	err = sp.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(r.Context(), `
			SELECT status FROM signup_orders
			 WHERE order_ref = $1 FOR UPDATE`, ref).Scan(&locked); err != nil {
			return err
		}
		if locked != "created" && locked != "failed" {
			return errAlreadyPaid
		}

		var perr error
		res, perr = provisionSchool(r.Context(), tx, sp.Hasher, provisionParams{
			SchoolName:    o.School,
			District:      o.District,
			State:         o.State,
			Board:         o.Board,
			PlanCode:      o.PlanCode,
			AdminName:     o.Contact,
			AdminEmail:    o.Email,
			AdminPhone:    o.Phone,
			AdminUsername: o.Username,
			Paid:          true,
		})
		if perr != nil {
			return perr
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE signup_orders
			   SET status='provisioned', payment_ref=$2, signature=$3,
			       paid_at=now(), institution_id=$4, admin_user_id=$5,
			       credentials_sent_at=now(), failure_reason=NULL
			 WHERE order_ref=$1`,
			ref, paymentRef, signature, res.InstitutionID, res.UserID); err != nil {
			return err
		}

		// The notification. There is no SMTP on this installation, so the
		// message is written to the tenant's own message_log — the same place
		// every other outbound message lands — and rendered on the welcome
		// screen. The password is not in the logged body: a credential sitting
		// in a queryable table outlives the reason it was put there.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO message_log (institution_id, channel, template_code,
			                         recipient, user_id, subject, body, status,
			                         provider, provider_msg_id, sent_at)
			VALUES ($1,'email','signup_welcome',$2,$3,$4,$5,'sent','simulated',$6,now())`,
			res.InstitutionID, o.Email, res.UserID,
			"Your school is ready - "+o.School,
			welcomeBody(o.School, o.Contact, res.SignInAs),
			paymentRef)
		return err
	})
	switch {
	case errors.Is(err, errAlreadyPaid):
		http.Redirect(w, r, "/signup/welcome/"+ref, http.StatusSeeOther)
		return
	case errors.Is(err, errNameTaken), errors.Is(err, errContactTaken):
		// The payment did not happen — the transaction rolled back — so the
		// school is not out of pocket, and saying so is the first thing they
		// need to hear.
		sp.render(w, r, "pay.gohtml", http.StatusConflict, signupView{
			Error: err.Error() + " Nothing has been charged. " +
				"If your school is already with us, sign in instead, or write to us and we will sort it out.",
			School:   o.School,
			OrderRef: o.OrderRef,
			Amount:   indianRupees(o.AmountPaise / 100),
			Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		})
		return
	case err != nil:
		httpx.LogError(r, err)
		sp.render(w, r, "pay.gohtml", http.StatusInternalServerError, signupView{
			Error:    "Something went wrong setting up your school. Nothing has been charged. Please try again.",
			School:   o.School,
			OrderRef: o.OrderRef,
			Amount:   indianRupees(o.AmountPaise / 100),
			Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		})
		return
	}

	// The password exists in memory and nowhere else — it is not in the order
	// row, not in the message log, and only its hash is in users. Handing it
	// over through a redirect would put it in a URL, and URLs are logged by
	// every proxy between here and the school, so the welcome screen is
	// rendered directly on the POST.
	sp.render(w, r, "welcome.gohtml", http.StatusOK, signupView{
		School:   o.School,
		Contact:  o.Contact,
		Email:    o.Email,
		Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		Amount:   indianRupees(o.AmountPaise / 100),
		OrderRef: ref,
		PaidRef:  paymentRef,
		SignInAs: res.SignInAs,
		Password: res.Password,
	})
}

// Welcome is the page a school lands on if it returns to the link later.
//
// It deliberately cannot show the password: the password was never stored.
// Saying so plainly is more useful than an apology, because the recovery is
// the ordinary "forgotten password" one they will use for the rest of the
// relationship.
func (sp *SignupPages) Welcome(w http.ResponseWriter, r *http.Request) {
	o, err := sp.order(r, chiURLParam(r, "order"))
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if o.Status != "provisioned" {
		http.Redirect(w, r, "/signup/pay/"+o.OrderRef, http.StatusSeeOther)
		return
	}
	sp.render(w, r, "welcome.gohtml", http.StatusOK, signupView{
		School:   o.School,
		Contact:  o.Contact,
		Email:    o.Email,
		Plan:     buyPlan{Code: o.PlanCode, Name: o.PlanName},
		Amount:   indianRupees(o.AmountPaise / 100),
		OrderRef: o.OrderRef,
		PaidRef:  o.PaymentRef,
		SignInAs: o.SignInAs,
	})
}

// --- the gateway contract ---------------------------------------------------

// sign produces the signature Razorpay would return for this payment:
// HMAC-SHA256 of "order_id|payment_id" under the key secret.
func (sp *SignupPages) sign(orderRef, paymentRef string) string {
	mac := hmac.New(sha256.New, []byte(sp.GatewaySecret))
	mac.Write([]byte(orderRef + "|" + paymentRef))
	return hex.EncodeToString(mac.Sum(nil))
}

// verifySignature recomputes the signature and compares it in constant time.
//
// hmac.Equal rather than ==: string comparison returns early on the first
// differing byte, and the time it takes leaks how much of a forged signature
// was correct.
func (sp *SignupPages) verifySignature(orderRef, paymentRef, got string) bool {
	want := sp.sign(orderRef, paymentRef)
	return hmac.Equal([]byte(want), []byte(got))
}

// gatewayRef mints an identifier in Razorpay's format: a prefix and 14
// lowercase alphanumerics.
func gatewayRef(prefix string) (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 14)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i, v := range b {
		b[i] = alphabet[int(v)%len(alphabet)]
	}
	return prefix + "_" + string(b), nil
}

var errAlreadyPaid = errors.New("this order has already been paid")

// --- reading an order -------------------------------------------------------

type signupOrder struct {
	OrderRef    string
	School      string
	Contact     string
	Email       string
	Phone       string
	District    string
	State       string
	Board       string
	Username    string
	PlanCode    string
	PlanName    string
	AmountPaise int64
	Status      string
	PaymentRef  string
	SignInAs    string
}

func (sp *SignupPages) order(r *http.Request, ref string) (signupOrder, error) {
	var o signupOrder
	err := sp.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT s.order_ref, s.school_name, s.contact_name, s.email::text,
			       COALESCE(s.phone,''), COALESCE(s.district,''),
			       COALESCE(s.state,''), COALESCE(s.board,''),
			       COALESCE(s.admin_username::text,''), s.plan_code,
			       COALESCE(p.name, s.plan_code), s.amount_paise, s.status,
			       COALESCE(s.payment_ref,''),
			       COALESCE(u.username::text, u.email::text, u.phone, '')
			  FROM signup_orders s
			  LEFT JOIN plans p ON p.code = s.plan_code
			  LEFT JOIN users u ON u.id = s.admin_user_id
			 WHERE s.order_ref = $1`, ref).
			Scan(&o.OrderRef, &o.School, &o.Contact, &o.Email, &o.Phone,
				&o.District, &o.State, &o.Board, &o.Username, &o.PlanCode,
				&o.PlanName, &o.AmountPaise, &o.Status, &o.PaymentRef, &o.SignInAs)
	})
	return o, err
}

// --- plumbing ---------------------------------------------------------------

func (sp *SignupPages) plans(r *http.Request) ([]buyPlan, error) {
	b := &BuyPage{DB: sp.DB, Tpl: sp.Tpl}
	return b.plans(r)
}

func (sp *SignupPages) render(w http.ResponseWriter, r *http.Request, name string, status int, v signupView) {
	v.AssetVersion = static.Version()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// A credential on the page must not sit in a shared cache.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := sp.Tpl.ExecuteTemplate(w, name, v); err != nil {
		httpx.Internal(w, r, err)
	}
}

func findPlan(plans []buyPlan, code string) (buyPlan, bool) {
	for _, p := range plans {
		if p.Code == code {
			return p, true
		}
	}
	return buyPlan{}, false
}

// looksLikeEmail is a shape check, not a validity check. The address is proved
// by the credentials arriving at it; anything stricter here only rejects the
// unusual-but-real addresses that Indian schools genuinely use.
func looksLikeEmail(s string) bool {
	at := strings.IndexByte(s, '@')
	if at <= 0 || at == len(s)-1 || strings.Count(s, "@") != 1 {
		return false
	}
	dot := strings.LastIndexByte(s, '.')
	return dot > at+1 && dot < len(s)-1 && !strings.ContainsAny(s, " \t\r\n")
}

func validUsername(s string) bool {
	if len(s) < 4 || len(s) > 32 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_':
		default:
			return false
		}
	}
	return true
}

func welcomeBody(school, contact, signInAs string) string {
	return "Dear " + contact + ",\n\n" +
		school + " is set up and ready to use.\n\n" +
		"Sign in as: " + signInAs + "\n" +
		"Password: (sent separately, shown once on screen at the time of purchase)\n\n" +
		"You will be asked to change the password when you first sign in.\n" +
		"Your next step is the setup wizard, which walks you through the " +
		"academic year, classes, sections, subjects, staff and students.\n"
}

// billingPeriod resolves what the school chose, refusing monthly on a plan
// that is not sold monthly.
//
// Checked here rather than trusted from the query string: the pricing page
// writes it into the link, and a link is the easiest thing in the world to
// edit. A school must not reach checkout holding a monthly price for a plan
// that has none.
func billingPeriod(v string, plan buyPlan) string {
	if strings.EqualFold(strings.TrimSpace(v), "monthly") {
		if plan.Code == "" || plan.MonthlyPaise > 0 {
			return "monthly"
		}
	}
	return "yearly"
}

func periodLabel(billing string) string {
	if billing == "monthly" {
		return "per month"
	}
	return "per year"
}

// amountFor is what this order is actually for. The order carries the figure
// rather than joining to the plan, because a plan's price changes and a
// receipt must not silently reprice itself.
func amountFor(plan buyPlan, billing string) int64 {
	if billing == "monthly" && plan.MonthlyPaise > 0 {
		return plan.MonthlyPaise
	}
	return plan.PricePaise
}
