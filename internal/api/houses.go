package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Houses — Ruby, Emerald, Sapphire, Topaz, or whatever this school calls them.

   The table and students.house_id have been in the baseline since the
   beginning and no screen ever touched either, so a school that runs a house
   system kept it on a noticeboard and in a teacher's notebook. Sports day, the
   inter-house cup and half of what a child is proud of at school lived
   entirely outside the product.

   NOT SEEDED WITH NAMES. A school's houses are named after its founders, local
   rivers, saints, colours, birds — there is no default that is not wrong
   somewhere, and four wrong names in a dropdown are worse than an empty list
   with an Add button, because somebody has to notice they are wrong first.

   Optional throughout. A school with no house system sees an empty list and a
   child with no house is not a record with something missing from it.
*/

type houseRow struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	// So the office can see the system is balanced, which is the question a
	// house list is actually asked.
	Students int `json:"students"`
}

func (s *Server) listHouses(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT h.id::text, h.name, h.color,
		       (SELECT count(*) FROM students st
		         WHERE st.house_id = h.id AND st.status = 'active')::int
		  FROM houses h
		 ORDER BY h.name`, nil,
		func(rows pgx.Rows) (houseRow, error) {
			var v houseRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Color, &v.Students)
		})
	respond(w, r, items, err)
}

type houseWriteRequest struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

func (s *Server) saveHouse(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req houseWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpx.BadRequest(w, r, "a house needs a name")
		return
	}
	if len(name) > 60 {
		httpx.BadRequest(w, r, "keep a house name under 60 characters")
		return
	}
	color := strings.TrimSpace(req.Color)

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			hid, err := uuid.Parse(req.ID)
			if err != nil {
				return err
			}
			return tx.QueryRow(r.Context(), `
				UPDATE houses SET name = $2, color = COALESCE(NULLIF($3,''), color)
				 WHERE id = $1 RETURNING id::text`, hid, name, color).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO houses (institution_id, name, color)
			VALUES ($1, $2, COALESCE(NULLIF($3,''), '#64748b'))
			RETURNING id::text`, id.InstitutionID, name, color).Scan(&out)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "name": name})
}

/* Deleting a house does not delete the children in it.

   students.house_id is ON DELETE SET NULL, so a house wound up in a
   reorganisation leaves its members without a house rather than taking them
   with it — which is the only acceptable behaviour for a field that is
   decoration on a child's record and a fixture in nobody's life but the
   sports master's.
*/
func (s *Server) deleteHouse(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	hid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid house id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `DELETE FROM houses WHERE id = $1`, hid)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
