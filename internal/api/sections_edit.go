package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Changing a section after it exists.

   Sections could be created and imported and never edited, which is the wrong
   way round: the name is the thing most likely to be wrong on the first pass.
   A school types A and B during setup because that is what the example said,
   then discovers its own noticeboards say Rose and Jasmine, and had no way to
   fix it short of deleting a section — which it also could not do.

   Renaming is safe in a way that is worth stating: everything else points at
   the section by id, so the name is a label and nothing joins on it. The
   register, the timetable, the marks and the fee ledger all follow the rename
   without moving.

   Deleting is not safe, so it is refused the moment anybody is enrolled. A
   section with children in it is not a mistake to be cleaned up; it is a class
   whose roll would go with it.
*/

type sectionPatch struct {
	// Pointers, so "not mentioned" and "set to empty" are different requests.
	// Clearing a room is a real edit; omitting it is not.
	Name           *string `json:"name,omitempty"`
	Capacity       *int    `json:"capacity,omitempty"`
	Room           *string `json:"room,omitempty"`
	ClassTeacherID *string `json:"class_teacher_id,omitempty"`
}

var (
	errSectionGone      = errors.New("no such section")
	errSectionNameTaken = errors.New("name taken")
	errSectionTooSmall  = errors.New("capacity below enrolment")
)

// updateSection renames a section or changes what it holds.
func (s *Server) updateSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sectionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid section id")
		return
	}
	var req sectionPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil {
		*req.Name = strings.TrimSpace(*req.Name)
		if *req.Name == "" {
			httpx.BadRequest(w, r,
				"a section needs a name — a letter, or whatever this school calls it")
			return
		}
	}
	if req.Capacity != nil && *req.Capacity <= 0 {
		httpx.BadRequest(w, r, "capacity must be at least one")
		return
	}

	var name string
	var enrolled int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT s.name,
			       (SELECT count(*)::int FROM enrollments e
			         WHERE e.section_id = s.id AND e.status = 'active')
			  FROM sections s WHERE s.id = $1`, sectionID).Scan(&name, &enrolled); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errSectionGone
			}
			return err
		}
		// Capacity is a warning threshold everywhere else, but setting it below
		// the children already in the room would make the warning permanent and
		// meaningless. Refused with the number, so the answer is on screen.
		if req.Capacity != nil && *req.Capacity < enrolled {
			return errSectionTooSmall
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE sections
			   SET name             = COALESCE($2, name),
			       capacity         = COALESCE($3, capacity),
			       room             = CASE WHEN $4::text IS NULL THEN room
			                               ELSE NULLIF($4, '') END,
			       class_teacher_id = CASE WHEN $5::text IS NULL THEN class_teacher_id
			                               ELSE NULLIF($5, '')::uuid END
			 WHERE id = $1`,
			sectionID, req.Name, req.Capacity, req.Room, req.ClassTeacherID)
		if err != nil && strings.Contains(err.Error(), "sections_class_id_academic_year_id_name_key") {
			return errSectionNameTaken
		}
		if err != nil {
			return err
		}
		if req.Name != nil {
			name = *req.Name
		}
		return nil
	})

	switch {
	case errors.Is(err, errSectionGone):
		httpx.BadRequest(w, r, "no such section in this school")
		return
	case errors.Is(err, errSectionNameTaken):
		httpx.BadRequest(w, r, "this class already has a section with that name")
		return
	case errors.Is(err, errSectionTooSmall):
		httpx.BadRequest(w, r,
			"that capacity is below the number of children already in the section")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": sectionID.String(), "name": name, "enrolled": enrolled,
	})
}

// deleteSection removes an empty section.
func (s *Server) deleteSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sectionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid section id")
		return
	}

	var enrolled int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM enrollments e WHERE e.section_id = s.id)
			  FROM sections s WHERE s.id = $1`, sectionID).Scan(&enrolled); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errSectionGone
			}
			return err
		}
		/* Every enrolment, not only the active ones.

		   A section whose children were all promoted out still holds last
		   year's register, and the cascade on enrollments would take it with
		   the row. Somebody clearing up an old section would delete the
		   attendance and marks history of the class that sat in it, and would
		   be told nothing. */
		if enrolled > 0 {
			return errSectionTooSmall
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM sections WHERE id = $1`, sectionID)
		return err
	})

	switch {
	case errors.Is(err, errSectionGone):
		httpx.BadRequest(w, r, "no such section in this school")
		return
	case errors.Is(err, errSectionTooSmall):
		httpx.BadRequest(w, r,
			"this section has enrolments against it, including past years — rename it instead, "+
				"or move the children out first. Deleting it would take their register with it")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": sectionID.String()})
}
