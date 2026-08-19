package templates

import (
	"strings"
	"testing"
)

// Every page is server-rendered from an embedded template, so a template that
// does not parse is a page that 500s in production and nowhere else — the
// compiler cannot see inside these files.
func TestAllTemplatesParse(t *testing.T) {
	tpl, err := Parse()
	if err != nil {
		t.Fatalf("templates do not parse: %v", err)
	}
	for _, name := range []string{
		"login.gohtml", "buy.gohtml",
		"signup.gohtml", "pay.gohtml", "welcome.gohtml",
	} {
		if tpl.Lookup(name) == nil {
			t.Errorf("%s is not defined", name)
		}
	}
}

// The purchase screens are rendered from one view struct, and a field renamed
// on the Go side shows up here rather than as a blank page.
func TestPurchaseScreensRender(t *testing.T) {
	tpl, err := Parse()
	if err != nil {
		t.Fatal(err)
	}

	// Mirrors api.signupView. Kept as an anonymous struct rather than imported
	// to avoid a cycle; a field the templates need and this lacks fails the
	// test, which is the point.
	view := struct {
		AssetVersion string
		Error        string
		Plan         struct {
			Code, Name, Rupees, MaxStudents string
			PricePaise                      int64
			Monthly                         string
			MonthlyPaise                    int64
			SavingPct                       int
			Modules                         []string
			Featured                        bool
		}
		Billing                                                          string
		Period                                                           string
		Plans                                                            []any
		School, Contact, Email, Phone, District, State, Board, Students  string
		Username, OrderRef, Amount, Prefill, SignInAs, Password, PaidRef string
	}{}
	view.School = "Sunrise Vidya Niketan"
	view.Email = "principal@sunrise.in"
	view.OrderRef = "order_abc123def456"
	view.Amount = "90,000"
	view.SignInAs = "principal"
	view.Password = "HAJW-55M7-MEQX"
	view.Plan.Name = "Standard"
	view.Plan.Code = "standard"
	view.Plan.Rupees = "90,000"
	view.Plan.MaxStudents = "Up to 1,200 students"
	view.Plan.Monthly = "10,000"
	view.Plan.SavingPct = 25
	view.Billing = "yearly"
	view.Period = "per year"

	for _, name := range []string{"signup.gohtml", "pay.gohtml", "welcome.gohtml"} {
		var sb strings.Builder
		if err := tpl.ExecuteTemplate(&sb, name, view); err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if sb.Len() < 500 {
			t.Errorf("%s rendered %d bytes — suspiciously empty", name, sb.Len())
		}
		if !strings.Contains(sb.String(), "Sunrise Vidya Niketan") {
			t.Errorf("%s did not render the school name", name)
		}
	}
}

// A payment screen that does not say it is a simulation is the one page in
// this codebase capable of misleading somebody about money.
func TestGatewayScreenDeclaresItselfSimulated(t *testing.T) {
	tpl, err := Parse()
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	if err := tpl.ExecuteTemplate(&sb, "pay.gohtml", struct {
		AssetVersion, Error, School, OrderRef, Amount, Prefill string
		Plan                                                   struct{ Code, Name string }
	}{OrderRef: "order_abc123def456", Amount: "90,000"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToUpper(sb.String()), "SIMULATION") {
		t.Error("the payment screen does not declare itself a simulation")
	}
}

// The credentials page must not be cacheable or indexable.
func TestCredentialPagesAreNoindex(t *testing.T) {
	tpl, err := Parse()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"signup.gohtml", "pay.gohtml", "welcome.gohtml"} {
		var sb strings.Builder
		if err := tpl.ExecuteTemplate(&sb, name, struct {
			AssetVersion, Error, School, Contact, Email, Phone, District string
			State, Board, Students, Username, OrderRef, Amount, Prefill  string
			SignInAs, Password, PaidRef, Billing, Period                 string
			Plan                                                         struct{ Code, Name, Rupees, MaxStudents, Monthly string }
			Plans                                                        []any
		}{}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(sb.String(), `name="robots" content="noindex"`) {
			t.Errorf("%s is missing its noindex", name)
		}
	}
}
