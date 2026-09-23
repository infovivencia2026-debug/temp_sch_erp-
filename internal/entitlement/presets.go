package entitlement

/* Starting points for a vendor writing a plan.

   A plan is eleven yes/no decisions, and the eleven are not independent: a
   school that buys Hostel without Students has bought a boarding register
   with nobody in it. Left to a blank form, the first plan anybody writes is
   either everything (which is not a tier) or a set nobody can sell.

   So the price list opens on three shapes that match how Indian schools
   actually buy, and each is a starting point rather than a product: the
   vendor picks one, changes what they like and names it. Nothing here is
   written to the database and no school is on a "preset" -- these fill a
   form, and what gets saved is an ordinary plan.

   Three, not ten, because a list long enough to need reading is a list
   somebody scrolls past. */

// Preset is one starting point for a new plan.
type Preset struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	// Why a vendor would pick this one, in the words a vendor thinks in.
	Blurb string `json:"blurb"`
	// Modules is the selection it fills in; a suggested cap and price are
	// deliberately absent, because those are the two things a vendor must
	// decide for their own market rather than accept from us.
	Modules []string `json:"modules"`
}

// Presets are the three shapes offered when a plan is created.
var Presets = []Preset{
	{
		Key:  "office",
		Name: "Office essentials",
		Blurb: "The register, the money and telling parents. What a small " +
			"low-fee school will pay for in its first year, before it trusts " +
			"software with marks.",
		Modules: []string{Students, Fees, Communication},
	},
	{
		Key:  "academic",
		Name: "Full academics",
		Blurb: "Adds the timetable, attendance and the exam and report-card " +
			"run. The ordinary CBSE or state-board day school that owns no " +
			"buses and no hostel.",
		Modules: []string{Students, Academics, Attendance, Fees, Communication, Exams},
	},
	{
		Key:  "campus",
		Name: "Residential campus",
		Blurb: "Everything, including transport, hostel, library, stores and " +
			"payroll. The boarding school, and the large day school that runs " +
			"its own fleet.",
		// Written out rather than left empty. An empty modules array means
		// "every module there will ever be", which is the right thing to
		// STORE for an unlimited plan and the wrong thing to show somebody
		// who is about to edit the list: they would see nothing ticked.
		Modules: append([]string(nil), All...),
	},
}
