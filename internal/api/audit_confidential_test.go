package api

import "testing"

func TestConfidentialBody(t *testing.T) {
	withheld := []string{
		"/api/v1/infirmary/visits",
		"/api/v1/infirmary/medications",
		"/api/v1/comms/counselor/threads",
		"/api/v1/comms/counselor/threads/11111111-1111-1111-1111-111111111111/messages",
	}
	for _, p := range withheld {
		if !confidentialBody(p) {
			t.Errorf("%s must not have its body recorded in the audit trail", p)
		}
	}
	kept := []string{
		"/api/v1/fees/payments",
		"/api/v1/exams/marks",
		"/api/v1/comms/grievances/x/updates",
		"/api/v1/audit",
	}
	for _, p := range kept {
		if confidentialBody(p) {
			t.Errorf("%s is an ordinary change; the trail needs its payload", p)
		}
	}
}
