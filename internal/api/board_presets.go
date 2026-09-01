package api

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a school's board actually implies, and saying so before it happens.

   The board was a label. It was stored, shown on the setup form, counted
   towards "is setup finished" — and nothing in the product branched on it. A
   school picked CBSE and got exactly what a school picking Kerala SSLC got:
   an empty grading scale to build by hand, a 33% pass mark nobody set, and a
   report card whose internals assume CBSE regardless of the answer.

   So this does two things and refuses a third.

   IT LISTS THE BOARDS. Properly — the national ones, the international ones,
   and the state and intermediate boards, because "Other state board" as the
   only option outside CBSE and CISCE is the product telling two thirds of
   India's schools that their board is an exception.

   IT SAYS WHAT CHOOSING ONE WILL DO, in advance, in a sentence a registrar
   can check: the grade bands, the pass mark, how the year is assessed, what
   the leaving certificate is called. Applying it is a separate, explicit act.

   IT DOES NOT DECIDE ANYTHING. A preset is a STARTING POINT the school edits,
   never a rule the product enforces. Two reasons, and both are the kind that
   bite eighteen months later:

     a product that hardcodes what it believes a board requires is wrong the
     year the board changes it, and the school cannot correct it;

     and boards themselves differ by class, by stream and by year — CBSE
     grades Class 10 and Class 12 on different scales — so any single answer
     stored as law would be untrue for some of the school it governs.

   Nothing here is applied silently. Choosing a board never rewrites a scale
   the school has already built; the screen offers, names what it would change,
   and waits.
*/

type gradeBandPreset struct {
	Grade      string  `json:"grade"`
	MinPercent float64 `json:"min_percent"`
	MaxPercent float64 `json:"max_percent"`
	GradePoint float64 `json:"grade_point,omitempty"`
}

type boardPreset struct {
	Value string `json:"value"`
	Label string `json:"label"`
	// Where the board sits, so the list can be grouped rather than presented
	// as forty flat rows a registrar has to read end to end.
	Group string `json:"group"`

	// The sentence shown before anything is applied.
	ScaleName  string            `json:"scale_name"`
	PassMark   float64           `json:"pass_mark"`
	Assessment string            `json:"assessment"`
	LeavingDoc string            `json:"leaving_doc"`
	Notes      string            `json:"notes,omitempty"`
	Bands      []gradeBandPreset `json:"bands"`
}

/* The nine-point scale CBSE uses at Secondary, and a great many schools use
   because CBSE does. Bands are inclusive of min and max; 100 is the top of the
   first band rather than 100.01, because a mark cannot exceed the paper. */
var cbseNinePoint = []gradeBandPreset{
	{"A1", 91, 100, 10}, {"A2", 81, 90.99, 9}, {"B1", 71, 80.99, 8},
	{"B2", 61, 70.99, 7}, {"C1", 51, 60.99, 6}, {"C2", 41, 50.99, 5},
	{"D", 33, 40.99, 4}, {"E", 0, 32.99, 0},
}

// The five-band letter scale most state boards and the ICSE stream report in.
var letterFive = []gradeBandPreset{
	{"A", 75, 100, 0}, {"B", 60, 74.99, 0}, {"C", 45, 59.99, 0},
	{"D", 35, 44.99, 0}, {"E", 0, 34.99, 0},
}

// Distinction / First / Second / Pass, which is how an Indian state marksheet
// has read for fifty years and what a parent recognises.
var divisionScale = []gradeBandPreset{
	{"Distinction", 75, 100, 0}, {"First", 60, 74.99, 0},
	{"Second", 50, 59.99, 0}, {"Pass", 35, 49.99, 0}, {"Fail", 0, 34.99, 0},
}

/* Every board a school in India is likely to be affiliated to, plus the
   international ones that operate here.

   The state list is the one that matters. A school in Kerala choosing "Other
   state board" loses the only fact this field could have carried, and every
   report grouping by board then has one enormous bucket. */
var boardPresets = []boardPreset{
	{
		Value: "CBSE", Label: "CBSE", Group: "National",
		ScaleName: "CBSE nine-point", PassMark: 33,
		Assessment: "Two terms, each with internal assessment and a term examination",
		LeavingDoc: "Transfer Certificate (TC)",
		Notes:      "CBSE grades Class 10 and Class 12 differently. This sets the Secondary scale; change it for the senior classes if your school reports them separately.",
		Bands:      cbseNinePoint,
	},
	{
		Value: "CISCE", Label: "CISCE (ICSE / ISC)", Group: "National",
		ScaleName: "ICSE letter", PassMark: 35,
		Assessment: "Internal assessment across the year with a final examination",
		LeavingDoc: "Transfer Certificate (TC)",
		Bands:      letterFive,
	},
	{
		Value: "NIOS", Label: "NIOS (Open Schooling)", Group: "National",
		ScaleName: "NIOS letter", PassMark: 33,
		Assessment: "Continuous, with examinations on demand",
		LeavingDoc: "Transfer Certificate (TC)",
		Bands:      letterFive,
	},
	{
		Value: "IB", Label: "International Baccalaureate", Group: "International",
		ScaleName: "IB 1–7", PassMark: 40,
		Assessment: "Continuous internal assessment against criteria",
		LeavingDoc: "School Leaving Certificate",
		Notes:      "IB reports 1–7 against criteria rather than a percentage. The bands below are an approximation for schools that also keep a percentage; edit them to your own conversion.",
		Bands: []gradeBandPreset{
			{"7", 85, 100, 7}, {"6", 75, 84.99, 6}, {"5", 65, 74.99, 5},
			{"4", 55, 64.99, 4}, {"3", 45, 54.99, 3}, {"2", 35, 44.99, 2},
			{"1", 0, 34.99, 1},
		},
	},
	{
		Value: "CAIE", Label: "Cambridge (CAIE)", Group: "International",
		ScaleName: "Cambridge A*–G", PassMark: 40,
		Assessment: "Examination series, with coursework where the syllabus sets it",
		LeavingDoc: "School Leaving Certificate",
		Bands: []gradeBandPreset{
			{"A*", 90, 100, 0}, {"A", 80, 89.99, 0}, {"B", 70, 79.99, 0},
			{"C", 60, 69.99, 0}, {"D", 50, 59.99, 0}, {"E", 40, 49.99, 0},
			{"U", 0, 39.99, 0},
		},
	},

	// --- State and intermediate boards -----------------------------------
	{Value: "BSE Telangana", Label: "BSE Telangana (SSC)", Group: "Telangana",
		ScaleName: "Telangana SSC grades", PassMark: 35,
		Assessment: "Formative and summative assessment across the year",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "TSBIE", Label: "TSBIE (Telangana Intermediate)", Group: "Telangana",
		ScaleName: "Intermediate divisions", PassMark: 35,
		Assessment: "First and second year public examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "BSEAP", Label: "BSEAP (Andhra Pradesh SSC)", Group: "Andhra Pradesh",
		ScaleName: "AP SSC grades", PassMark: 35,
		Assessment: "Formative and summative assessment across the year",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "BIEAP", Label: "BIEAP (AP Intermediate)", Group: "Andhra Pradesh",
		ScaleName: "Intermediate divisions", PassMark: 35,
		Assessment: "First and second year public examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "KSEAB", Label: "KSEAB (Karnataka SSLC / PUC)", Group: "Karnataka",
		ScaleName: "Karnataka divisions", PassMark: 35,
		Assessment: "Internal assessment with a public examination",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "TN State Board", Label: "Tamil Nadu State Board", Group: "Tamil Nadu",
		ScaleName: "Tamil Nadu grades", PassMark: 35,
		Assessment: "Quarterly, half-yearly and annual examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "Kerala SSLC", Label: "Kerala (SSLC / DHSE)", Group: "Kerala",
		ScaleName: "Kerala A+ to E", PassMark: 30,
		Assessment: "Continuous evaluation with terminal examinations",
		LeavingDoc: "Transfer Certificate (TC)",
		Bands: []gradeBandPreset{
			{"A+", 90, 100, 9}, {"A", 80, 89.99, 8}, {"B+", 70, 79.99, 7},
			{"B", 60, 69.99, 6}, {"C+", 50, 59.99, 5}, {"C", 40, 49.99, 4},
			{"D+", 30, 39.99, 3}, {"D", 20, 29.99, 2}, {"E", 0, 19.99, 1},
		}},
	{Value: "Maharashtra State Board", Label: "Maharashtra (MSBSHSE)", Group: "Maharashtra",
		ScaleName: "Maharashtra divisions", PassMark: 35,
		Assessment: "Terminal examinations with internal marks",
		LeavingDoc: "Leaving Certificate (LC)",
		Notes:      "Maharashtra calls it a Leaving Certificate rather than a Transfer Certificate.",
		Bands:      divisionScale},
	{Value: "GSEB", Label: "Gujarat (GSEB)", Group: "Gujarat",
		ScaleName: "Gujarat grades", PassMark: 33,
		Assessment: "Terminal examinations with internal marks",
		LeavingDoc: "Leaving Certificate (LC)", Bands: letterFive},
	{Value: "RBSE", Label: "Rajasthan (RBSE)", Group: "Rajasthan",
		ScaleName: "Rajasthan divisions", PassMark: 33,
		Assessment: "Half-yearly and annual examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "UP Board", Label: "Uttar Pradesh (UPMSP)", Group: "Uttar Pradesh",
		ScaleName: "UP divisions", PassMark: 33,
		Assessment: "Half-yearly and annual examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "MP Board", Label: "Madhya Pradesh (MPBSE)", Group: "Madhya Pradesh",
		ScaleName: "MP divisions", PassMark: 33,
		Assessment: "Half-yearly and annual examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "WBBSE", Label: "West Bengal (WBBSE / WBCHSE)", Group: "West Bengal",
		ScaleName: "West Bengal grades", PassMark: 25,
		Assessment: "Continuous evaluation with an annual examination",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "BSEB", Label: "Bihar (BSEB)", Group: "Bihar",
		ScaleName: "Bihar divisions", PassMark: 33,
		Assessment: "Annual examination with internal marks",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "PSEB", Label: "Punjab (PSEB)", Group: "Punjab",
		ScaleName: "Punjab grades", PassMark: 33,
		Assessment: "Terminal examinations with internal marks",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "HBSE", Label: "Haryana (HBSE)", Group: "Haryana",
		ScaleName: "Haryana grades", PassMark: 33,
		Assessment: "Terminal examinations with internal marks",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "CGBSE", Label: "Chhattisgarh (CGBSE)", Group: "Chhattisgarh",
		ScaleName: "Chhattisgarh divisions", PassMark: 33,
		Assessment: "Half-yearly and annual examinations",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "BSEO", Label: "Odisha (BSE Odisha / CHSE)", Group: "Odisha",
		ScaleName: "Odisha grades", PassMark: 33,
		Assessment: "Continuous evaluation with an annual examination",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "JAC", Label: "Jharkhand (JAC)", Group: "Jharkhand",
		ScaleName: "Jharkhand divisions", PassMark: 33,
		Assessment: "Annual examination with internal marks",
		LeavingDoc: "Transfer Certificate (TC)", Bands: divisionScale},
	{Value: "SEBA", Label: "Assam (SEBA / AHSEC)", Group: "Assam",
		ScaleName: "Assam grades", PassMark: 30,
		Assessment: "Terminal examinations with internal marks",
		LeavingDoc: "Transfer Certificate (TC)", Bands: letterFive},
	{Value: "Other State Board", Label: "Another board — set the grading yourself",
		Group:      "Other",
		ScaleName:  "School grading scale", PassMark: 35,
		Assessment: "As your school sets it",
		LeavingDoc: "Transfer Certificate (TC)",
		Notes:      "Nothing is assumed. Build the grade bands your board uses, and add your board by name at the bottom of the list so reports can tell it apart.",
		Bands:      letterFive},
}

// listBoardPresets says what each board is and what choosing it would set,
// BEFORE anything is chosen.
func (s *Server) listBoardPresets(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{"items": boardPresets})
}

type applyBoardRequest struct {
	Board string `json:"board"`
}

/* applyBoardPreset creates the grading scale a board reports in.

   EXPLICIT, and never a side effect of choosing a board on the setup form.
   The school reads what it would do and presses a button; a field that
   silently rewrote a grading scale somebody had spent an afternoon building
   would be the worst kind of helpfulness.

   It also never overwrites. A scale of the same name already present means
   this has been done, or the school has built its own and named it the same,
   and in both cases theirs wins — the endpoint says so rather than merging two
   sets of bands into a scale that means neither.
*/
func (s *Server) applyBoardPreset(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req applyBoardRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	want := strings.TrimSpace(req.Board)
	var preset *boardPreset
	for i := range boardPresets {
		if strings.EqualFold(boardPresets[i].Value, want) {
			preset = &boardPresets[i]
			break
		}
	}
	if preset == nil {
		/* A board the school added themselves. There is nothing to preset —
		   that is the honest answer, not an error — so say what to do instead
		   of failing at them. */
		httpx.BadRequest(w, r,
			"there is no ready-made grading scale for that board. Build the "+
				"bands your board uses under Academics → Grading, and they will "+
				"be used everywhere marks are graded")
		return
	}

	var scaleID string
	var existed bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(),
			`SELECT id::text FROM grading_scales WHERE name = $1`,
			preset.ScaleName).Scan(&scaleID)
		if err == nil {
			existed = true
			return nil
		}
		if err != pgx.ErrNoRows {
			return err
		}
		/* Default only if the school has none. A school that has already
		   nominated a default has made a decision, and quietly moving it
		   because somebody opened the setup page would change how every
		   report card grades without anybody choosing that. */
		var haveDefault bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM grading_scales WHERE is_default)`).
			Scan(&haveDefault); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO grading_scales (institution_id, name, is_default)
			VALUES ($1, $2, $3) RETURNING id::text`,
			id.InstitutionID, preset.ScaleName, !haveDefault).Scan(&scaleID); err != nil {
			return err
		}
		for _, b := range preset.Bands {
			var gp any
			if b.GradePoint > 0 {
				gp = b.GradePoint
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO grade_bands (institution_id, grading_scale_id, grade,
				                         min_percent, max_percent, grade_point)
				VALUES ($1,$2::uuid,$3,$4,$5,$6)`,
				id.InstitutionID, scaleID, b.Grade,
				b.MinPercent, b.MaxPercent, gp); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"scale_id":   scaleID,
		"scale_name": preset.ScaleName,
		"bands":      len(preset.Bands),
		// So the screen can say "you already had this" rather than claiming to
		// have made something it did not.
		"already_existed": existed,
	})
}
