/*
Package tally renders this school's books into the XML Tally Prime imports.

	There is no Tally API here, and the honesty about that is the point of the
	package. Tally's HTTP gateway is not a cloud service: it is a listener a
	running copy of Tally opens on the school's own LAN, on a machine that is
	switched on only when the accountant is at it. A product that claimed a
	"Tally integration" and quietly meant "we generate a file you carry over"
	would be lying in the one place a school notices. So the delivery route is
	an interface with exactly one working implementation — a file the
	accountant downloads — and the gateway sits beside it refusing clearly.

	Everything in here is a pure function of its inputs. The rendering, the
	balance check and the paise-to-rupee conversion have no database, no clock
	and no request, which is what lets the two entry points that use them — the
	platform connector and the finance export screen — share one implementation
	rather than growing a second, slightly different one.
*/
package tally

import (
	"encoding/xml"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

/* --- money ------------------------------------------------------------------

   The whole codebase counts money in bigint paise. Tally counts in rupees with
   two decimals. That conversion is a division by 100 and it must not go through
   a float: 20.15 has no exact binary representation, so a run of fee receipts
   summed as float64 drifts, and a voucher that drifts by one paise is a voucher
   Tally rejects for not balancing. The arithmetic below is integer division and
   a remainder, which is exact for every value. */

// Amount renders paise as the rupee string Tally reads: -4250.00, 315.50.
//
// Sign is Tally's convention, not arithmetic's — see Entry.
func Amount(paise int64) string {
	neg := paise < 0
	// -(-9223372036854775808) overflows back to itself, so the magnitude is
	// taken on the unsigned side. No real voucher is this large; a formatter
	// that silently emits a negative rupee figure for a negative input is
	// still not a thing to leave lying about.
	var mag uint64
	if neg {
		mag = uint64(-(paise + 1)) + 1
	} else {
		mag = uint64(paise)
	}
	s := fmt.Sprintf("%d.%02d", mag/100, mag%100)
	if neg {
		return "-" + s
	}
	return s
}

/* --- the shape of a voucher -------------------------------------------------

   Tally's sign convention is the reverse of the one a spreadsheet reader
   expects and the reverse of the one journal_lines uses, so it is stated once
   here and never restated:

     debit  -> AMOUNT negative, ISDEEMEDPOSITIVE Yes
     credit -> AMOUNT positive, ISDEEMEDPOSITIVE No

   and the amounts across a voucher sum to zero. Tally validates this itself and
   rejects the entire import — not the offending voucher, the file — when it
   does not hold. That is why Validate exists and why there is a test for it: a
   file the accountant cannot import is worse than no export button, because
   they find out only after they have gone looking for it. */

// Entry is one side of one voucher line, already converted to Tally's sign.
type Entry struct {
	// LedgerName is the name as it exists in Tally, not this ERP's account
	// name. An unmapped account must never reach here; see Validate.
	LedgerName string
	// AmountPaise is signed Tally-wise: negative debit, positive credit.
	AmountPaise int64
}

// IsDebit reports the side, derived from the sign so the two can never
// disagree.
func (e Entry) IsDebit() bool { return e.AmountPaise < 0 }

// Voucher is one balanced accounting event on its way to Tally.
type Voucher struct {
	// SourceID is this ERP's journal_entries.id. Carried so the export run can
	// mark exactly what it sent without re-deriving the set.
	SourceID string
	Date     time.Time
	// VoucherType is the Tally voucher type name (Receipt, Payment, Journal,
	// Contra), already mapped from this ERP's own vocabulary.
	VoucherType string
	Number      string
	Narration   string
	Entries     []Entry
}

// Balance is the sum Tally requires to be zero.
func (v Voucher) Balance() int64 {
	var total int64
	for _, e := range v.Entries {
		total += e.AmountPaise
	}
	return total
}

// ErrUnbalanced is returned by Validate. Callers compare with errors.Is rather
// than matching the message, which names the voucher.
var ErrUnbalanced = errors.New("voucher does not balance")

// Validate refuses a voucher Tally would refuse, while the school can still be
// told which one.
func (v Voucher) Validate() error {
	if strings.TrimSpace(v.VoucherType) == "" {
		return fmt.Errorf("voucher %s has no Tally voucher type: map it on the connector", v.Number)
	}
	if len(v.Entries) < 2 {
		return fmt.Errorf("voucher %s has %d entry/entries: double entry needs at least two",
			v.Number, len(v.Entries))
	}
	for _, e := range v.Entries {
		if strings.TrimSpace(e.LedgerName) == "" {
			return fmt.Errorf("voucher %s has a line with no Tally ledger name", v.Number)
		}
		if e.AmountPaise == 0 {
			return fmt.Errorf("voucher %s has a zero line against %s", v.Number, e.LedgerName)
		}
	}
	if b := v.Balance(); b != 0 {
		return fmt.Errorf("%w: %s is out by %s rupees", ErrUnbalanced, v.Number, Amount(b))
	}
	return nil
}

/* --- the envelope -----------------------------------------------------------

   Written as encoding/xml structs rather than a string template. A template
   would be shorter and would produce a file Tally rejects the first time a
   school named "Sri Sai & Co." appears in SVCURRENTCOMPANY, because a bare &
   is not XML. Marshalling escapes it; a template does not. */

type envelope struct {
	XMLName xml.Name `xml:"ENVELOPE"`
	Header  header   `xml:"HEADER"`
	Body    body     `xml:"BODY"`
}

type header struct {
	Request string `xml:"TALLYREQUEST"`
}

type body struct {
	ImportData importData `xml:"IMPORTDATA"`
}

type importData struct {
	Desc requestDesc `xml:"REQUESTDESC"`
	Data requestData `xml:"REQUESTDATA"`
}

type requestDesc struct {
	ReportName string     `xml:"REPORTNAME"`
	Static     staticVars `xml:"STATICVARIABLES"`
}

type staticVars struct {
	// The company the vouchers land in. Wrong here and the import goes into
	// whichever company happened to be open, which is the mistake nobody
	// notices until a trial balance has two schools in it.
	Company string `xml:"SVCURRENTCOMPANY"`
}

type requestData struct {
	Messages []tallyMessage `xml:"TALLYMESSAGE"`
}

type tallyMessage struct {
	UDF     string     `xml:"xmlns:UDF,attr"`
	Voucher xmlVoucher `xml:"VOUCHER"`
}

type xmlVoucher struct {
	VchType   string     `xml:"VCHTYPE,attr"`
	Action    string     `xml:"ACTION,attr"`
	ObjView   string     `xml:"OBJVIEW,attr"`
	Date      string     `xml:"DATE"`
	Effective string     `xml:"EFFECTIVEDATE"`
	TypeName  string     `xml:"VOUCHERTYPENAME"`
	Number    string     `xml:"VOUCHERNUMBER"`
	Narration string     `xml:"NARRATION,omitempty"`
	Entries   []xmlEntry `xml:"ALLLEDGERENTRIES.LIST"`
}

type xmlEntry struct {
	LedgerName      string `xml:"LEDGERNAME"`
	DeemedPositive  string `xml:"ISDEEMEDPOSITIVE"`
	LedgerFromItem  string `xml:"LEDGERFROMITEM"`
	RemoveZeroEntry string `xml:"REMOVEZEROENTRIES"`
	IsPartyLedger   string `xml:"ISPARTYLEDGER"`
	Amount          string `xml:"AMOUNT"`
}

// TallyDate is the YYYYMMDD Tally wants. Any other format is accepted by the
// parser and then read as a different day.
func TallyDate(t time.Time) string { return t.Format("20060102") }

// Batch is a company's worth of vouchers on their way out.
type Batch struct {
	Company  string
	Vouchers []Voucher
}

// Render produces the file. It validates first: a half-written file is a file
// somebody imports.
func Render(b Batch) ([]byte, error) {
	if strings.TrimSpace(b.Company) == "" {
		return nil, errors.New("no Tally company name configured: set it on the connector before exporting")
	}
	if len(b.Vouchers) == 0 {
		return nil, errors.New("nothing to export in this period")
	}

	msgs := make([]tallyMessage, 0, len(b.Vouchers))
	for _, v := range b.Vouchers {
		if err := v.Validate(); err != nil {
			return nil, err
		}
		entries := make([]xmlEntry, 0, len(v.Entries))
		for _, e := range v.Entries {
			deemed := "No"
			if e.IsDebit() {
				deemed = "Yes"
			}
			entries = append(entries, xmlEntry{
				LedgerName:      e.LedgerName,
				DeemedPositive:  deemed,
				LedgerFromItem:  "No",
				RemoveZeroEntry: "No",
				IsPartyLedger:   "No",
				Amount:          Amount(e.AmountPaise),
			})
		}
		msgs = append(msgs, tallyMessage{
			UDF: "TallyUDF",
			Voucher: xmlVoucher{
				VchType:   v.VoucherType,
				Action:    "Create",
				ObjView:   "Accounting Voucher View",
				Date:      TallyDate(v.Date),
				Effective: TallyDate(v.Date),
				TypeName:  v.VoucherType,
				Number:    v.Number,
				Narration: v.Narration,
				Entries:   entries,
			},
		})
	}

	out, err := xml.MarshalIndent(envelope{
		Header: header{Request: "Import Data"},
		Body: body{ImportData: importData{
			Desc: requestDesc{ReportName: "Vouchers", Static: staticVars{Company: b.Company}},
			Data: requestData{Messages: msgs},
		}},
	}, "", " ")
	if err != nil {
		return nil, fmt.Errorf("render tally xml: %w", err)
	}
	// Tally reads the file as ASCII unless told otherwise, and a school name
	// with a rupee sign or a Telugu character in it arrives as mojibake without
	// the declaration.
	return append([]byte(xml.Header), out...), nil
}

/* --- mapping ----------------------------------------------------------------

   The connector's job, and the failure this whole feature exists to prevent.

   A school with one unmapped fee head does not get a partial export. It gets a
   file Tally refuses, after the accountant has downloaded it, opened Tally,
   navigated to import and waited. So the unmapped accounts are found and listed
   before a single byte is produced, and the list is the answer — not "export
   failed". */

// Unmapped is one account that has no Tally ledger name against it.
type Unmapped struct {
	AccountID string `json:"account_id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	// Vouchers is how many vouchers in the requested period touch it, so the
	// screen can put the one blocking two hundred entries at the top.
	Vouchers int `json:"vouchers"`
}

// UnmappedVoucherType is an ERP voucher type with no Tally equivalent set.
type UnmappedVoucherType struct {
	VoucherType string `json:"voucher_type"`
	Vouchers    int    `json:"vouchers"`
}

// SortUnmapped puts the most-used first, then by code, so the list is stable
// between two calls that saw the same data.
func SortUnmapped(u []Unmapped) {
	sort.SliceStable(u, func(i, j int) bool {
		if u[i].Vouchers != u[j].Vouchers {
			return u[i].Vouchers > u[j].Vouchers
		}
		return u[i].Code < u[j].Code
	})
}

/* --- delivery ---------------------------------------------------------------

   The interface exists so a gateway can be added later without the export
   handler changing. It has one honest implementation today. */

// Receipt is what a delivery produced.
type Receipt struct {
	// Filename is set by providers that hand back a file. Empty for a provider
	// that posted the batch somewhere.
	Filename string
	Body     []byte
	// Detail is shown to the accountant verbatim.
	Detail string
}

// Provider is a route from a rendered batch to Tally.
type Provider interface {
	// Key is the stored identifier. Do not rename one that is in use.
	Key() string
	Label() string
	// LivePush reports whether this provider reaches a running Tally. The
	// screen reads this to decide what it is allowed to promise.
	LivePush() bool
	Deliver(b Batch) (Receipt, error)
}

// FileProvider renders a batch to a file the accountant downloads and imports
// by hand. This is the one that works.
type FileProvider struct{}

func (FileProvider) Key() string    { return "file" }
func (FileProvider) Label() string  { return "Download XML file" }
func (FileProvider) LivePush() bool { return false }

func (FileProvider) Deliver(b Batch) (Receipt, error) {
	out, err := Render(b)
	if err != nil {
		return Receipt{}, err
	}
	return Receipt{
		Filename: "tally-vouchers.xml",
		Body:     out,
		Detail:   "Import into Tally Prime: Gateway of Tally, then Import, then Vouchers.",
	}, nil
}

// ErrGatewayUnavailable is what the gateway route returns, always, until
// somebody implements it against a real Tally on a real LAN.
var ErrGatewayUnavailable = errors.New(
	"live push needs Tally Prime running on the school's own network with its " +
		"ODBC/HTTP gateway enabled; this server cannot reach it. Download the " +
		"XML and import it in Tally instead")

// GatewayProvider is a placeholder that refuses rather than pretending.
//
// It is deliberately not wired to a URL. Tally's gateway listens on the
// accountant's desktop, reachable from the school's LAN and from nowhere else;
// a hosted server calling it would time out, and a feature that times out
// silently is worse than one that says what it needs.
type GatewayProvider struct{ URL string }

func (GatewayProvider) Key() string    { return "gateway" }
func (GatewayProvider) Label() string  { return "Push to Tally on the LAN (not available)" }
func (GatewayProvider) LivePush() bool { return false }

func (GatewayProvider) Deliver(Batch) (Receipt, error) {
	return Receipt{}, ErrGatewayUnavailable
}

// Providers is the delivery routes the screen may offer.
func Providers() []Provider { return []Provider{FileProvider{}, GatewayProvider{}} }

// ProviderFor returns the delivery route for a stored key, defaulting to the
// file. An unknown key must not fall through to something that claims to push.
func ProviderFor(key string) Provider {
	if key == "gateway" {
		return GatewayProvider{}
	}
	return FileProvider{}
}
