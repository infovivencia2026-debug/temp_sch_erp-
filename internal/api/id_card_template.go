package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The school's own card, front and back.

   Staff cards were drawn by the software — a border, the school's name in a
   corner, the person's name and code. Correct, and nothing like the card any
   particular school issues: they all have artwork already, printed by a
   stationer, with a crest, a colour, a signature block, and on the reverse the
   line about returning it if found.

   So the artwork is theirs and the data is ours. They upload the two sides as
   their printer supplies them; the name, designation and employee code are laid
   over the front. A school that uploads nothing keeps the plain card, because a
   plain card is better than no card.

   Deliberately its own endpoint rather than another field on the branding
   upsert: that upsert writes seventeen columns at once, and a screen that only
   wants to change a card would have to send the school's login headline back
   unchanged to avoid clearing it.
*/

type idCardTemplate struct {
	// File ids, served through /api/v1/files/{id}. The column is named _key
	// because it was built for object-store keys; a file id is what this
	// product's uploader actually produces, and inventing a second storage
	// path for two images would be the more surprising choice.
	FrontFileID string `json:"front_file_id,omitempty"`
	BackFileID  string `json:"back_file_id,omitempty"`
}

func (s *Server) getIDCardTemplate(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var out idCardTemplate
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var front, back *string
		err := tx.QueryRow(r.Context(), `
			SELECT id_card_front_key, id_card_back_key
			  FROM branding_profiles
			 WHERE institution_id = $1 AND campus_id IS NULL`, id.InstitutionID).
			Scan(&front, &back)
		if err == pgx.ErrNoRows {
			// No branding row yet is the normal state of a new school, not a
			// fault: it means no artwork, which is exactly what the empty
			// answer says.
			return nil
		}
		if err != nil {
			return err
		}
		if front != nil {
			out.FrontFileID = *front
		}
		if back != nil {
			out.BackFileID = *back
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) saveIDCardTemplate(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in idCardTemplate
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send the card artwork.")
		return
	}
	front := strings.TrimSpace(in.FrontFileID)
	back := strings.TrimSpace(in.BackFileID)

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The row may not exist yet, and creating it here must not disturb the
		// other seventeen branding columns — hence a targeted upsert that names
		// only these two.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO branding_profiles
			       (institution_id, campus_id, id_card_front_key, id_card_back_key)
			VALUES ($1, NULL, NULLIF($2,''), NULLIF($3,''))
			ON CONFLICT (institution_id,
			             COALESCE(campus_id,'00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET id_card_front_key = NULLIF($2,''),
			              id_card_back_key  = NULLIF($3,'')`,
			id.InstitutionID, front, back)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, idCardTemplate{FrontFileID: front, BackFileID: back})
}
