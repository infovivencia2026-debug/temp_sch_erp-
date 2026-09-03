package api

import (
	"net/http"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE TWO VENDORS A SCHOOL HERE ACTUALLY USES, PRE-SHAPED.

   The SMS provider is a generic HTTP gateway: an endpoint, a method, an
   encoding and a bag of parameters with {to}, {text}, {sender}, {key} and
   {dlt} substituted at send time. That generality is right — it has already
   outlived one vendor — and it is also the reason nobody can configure it. To
   fill that form from scratch you need the vendor's HTTP API in front of you
   and you need to know which of its fields carries the message.

   So these are starting points, not drivers. Choosing one fills the form; the
   form stays editable, because a vendor that changes its endpoint must not
   need a deploy. Nothing here is a secret: the key is stored separately and
   substituted as {key}, so a preset can be read by anybody who can open the
   screen.

   DLT is not optional in India and is not a detail. Every transactional SMS
   must carry the template id registered with the operator, and a message sent
   without it is rejected by the network rather than by the vendor — which
   looks like the gateway being broken. Both presets carry the field so it
   cannot be forgotten silently. */

type smsPreset struct {
	ID       string            `json:"id"`
	Label    string            `json:"label"`
	Note     string            `json:"note"`
	Endpoint string            `json:"endpoint"`
	Method   string            `json:"method"`
	Encoding string            `json:"encoding"`
	Params   map[string]string `json:"params"`
	// What the school has to supply beyond the API key, in the words its
	// vendor uses for them.
	Needs []string `json:"needs"`
}

func smsPresets() []smsPreset {
	return []smsPreset{
		{
			ID:       "msg91",
			Label:    "MSG91",
			Note:     "Uses the authkey as the API key. Sender is your six-character header, and the DLT template id is required for transactional traffic.",
			Endpoint: "https://api.msg91.com/api/sendhttp.php",
			Method:   "GET",
			Encoding: "form",
			Params: map[string]string{
				"authkey":   "{key}",
				"mobiles":   "{to}",
				"message":   "{text}",
				"sender":    "{sender}",
				"route":     "4",
				"country":   "91",
				"DLT_TE_ID": "{dlt}",
			},
			Needs: []string{"authkey", "sender header", "DLT template id"},
		},
		{
			ID:       "gupshup",
			Label:    "Gupshup (Enterprise SMS)",
			Note:     "Uses the account password as the API key and the user id as a parameter. The mask is your approved sender header.",
			Endpoint: "https://enterprise.smsgupshup.com/GatewayAPI/rest",
			Method:   "GET",
			Encoding: "form",
			Params: map[string]string{
				"method":        "SendMessage",
				"send_to":       "{to}",
				"msg":           "{text}",
				"msg_type":      "TEXT",
				"auth_scheme":   "plain",
				"password":      "{key}",
				"v":             "1.1",
				"format":        "text",
				"mask":          "{sender}",
				"dltTemplateId": "{dlt}",
				"userid":        "",
			},
			Needs: []string{"user id", "password", "approved mask", "DLT template id"},
		},
	}
}

/*
Published rather than kept in the bundle.

	The shapes belong with the provider that consumes them: a copy in the web
	app is a second source of truth for the same fact, and the two disagree the
	first time either is edited. It is also the difference between fixing a
	vendor's changed endpoint in a deploy of the server and a rebuild of the
	client.
*/
func (s *Server) listSMSPresets(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{"items": smsPresets()})
}
