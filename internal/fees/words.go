package fees

import (
	"fmt"
	"strings"
)

// RupeesInWords renders paise as an Indian-format amount in words.
//
// Receipts carry the amount in words as a tamper check, and Indian receipts use
// the lakh/crore grouping — ₹12,34,567 is "Twelve Lakh Thirty Four Thousand
// Five Hundred Sixty Seven", not "One Million Two Hundred...". Getting this
// wrong is immediately obvious to anyone reading the receipt.
func RupeesInWords(paise int64) string {
	if paise < 0 {
		return "Minus " + RupeesInWords(-paise)
	}
	rupees := paise / 100
	remainder := paise % 100

	var b strings.Builder
	if rupees == 0 {
		b.WriteString("Zero")
	} else {
		b.WriteString(indianWords(rupees))
	}
	b.WriteString(" Rupees")
	if remainder > 0 {
		b.WriteString(" and ")
		b.WriteString(indianWords(remainder))
		b.WriteString(" Paise")
	}
	b.WriteString(" Only")
	return b.String()
}

var ones = []string{
	"", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
	"Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
	"Seventeen", "Eighteen", "Nineteen",
}

var tens = []string{
	"", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
}

// twoDigits handles 0-99, where 11-19 are irregular and must not be composed.
func twoDigits(n int64) string {
	switch {
	case n == 0:
		return ""
	case n < 20:
		return ones[n]
	default:
		s := tens[n/10]
		if n%10 > 0 {
			s += " " + ones[n%10]
		}
		return s
	}
}

func threeDigits(n int64) string {
	var parts []string
	if h := n / 100; h > 0 {
		parts = append(parts, ones[h]+" Hundred")
	}
	if t := twoDigits(n % 100); t != "" {
		parts = append(parts, t)
	}
	return strings.Join(parts, " ")
}

// indianWords groups as crore / lakh / thousand / hundred, which is the Indian
// 2-2-3 digit grouping rather than the western 3-3-3.
func indianWords(n int64) string {
	if n >= 1_00_00_000*100 {
		// Beyond 100 crore the words stop being useful on a receipt; fall back
		// to digits rather than inventing "arab"/"kharab" nobody writes.
		return fmt.Sprintf("%d", n)
	}

	var parts []string
	if crore := n / 1_00_00_000; crore > 0 {
		parts = append(parts, threeDigits(crore)+" Crore")
		n %= 1_00_00_000
	}
	if lakh := n / 1_00_000; lakh > 0 {
		parts = append(parts, twoDigits(lakh)+" Lakh")
		n %= 1_00_000
	}
	if thousand := n / 1000; thousand > 0 {
		parts = append(parts, twoDigits(thousand)+" Thousand")
		n %= 1000
	}
	if rest := threeDigits(n); rest != "" {
		parts = append(parts, rest)
	}
	return strings.Join(parts, " ")
}
