package fees

import "strconv"

// RupeesGrouped renders paise as rupees with Indian digit grouping and two
// decimal places, the way a printed receipt shows money: 1,23,456.50.
// No currency sign: the column heading carries it, and a sign in every cell
// is noise on paper. Integer arithmetic throughout.
func RupeesGrouped(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	whole := strconv.FormatInt(paise/100, 10)
	if len(whole) > 3 {
		head, tail := whole[:len(whole)-3], whole[len(whole)-3:]
		grouped := ""
		for len(head) > 2 {
			grouped = "," + head[len(head)-2:] + grouped
			head = head[:len(head)-2]
		}
		whole = head + grouped + "," + tail
	}
	out := whole + "." + pad2(paise%100)
	if neg {
		return "-" + out
	}
	return out
}
