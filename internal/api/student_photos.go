package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The child's photograph.

   students.photo_file_id has been in the baseline since the beginning and
   nothing has ever written to it: the ID card screen reads it, the statutory
   return checks for it, the report card prints it — and every one of them saw
   an empty column, because there was no way to put a photograph on a child.

   Two ways, because schools have two situations:

     one child   somebody at the front desk, a new admission mid-term
     the school  the photographer's delivery, six hundred files at once

   The second is the one that matters. A school photographs everybody on one
   morning in June and receives a folder of JPEGs named by admission number;
   asking the office to open six hundred records and upload six hundred files
   is asking them not to bother, and then the ID cards and the report cards go
   out with an empty box for the rest of the year.
*/

type studentPhotoRequest struct {
	// A file already uploaded through /api/v1/files. Empty removes the photo,
	// which is what a school does when a child's picture is wrong rather than
	// missing.
	FileID string `json:"file_id"`
}

func (s *Server) setStudentPhoto(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req studentPhotoRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var file *uuid.UUID
	if v := strings.TrimSpace(req.FileID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		file = &parsed
	}

	// The same boundary every other write to a child obeys: a teacher may not
	// put a photograph on a child in another section.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE students st SET photo_file_id = $1 WHERE st.id = $2 AND `+pred,
			append([]any{file, sid}, args...)...)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Forbidden(w, r, "this child is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type bulkPhotoRequest struct {
	// Keyed by admission number, because that is what the photographer's files
	// are named and what the office can check by eye. Matching on the child's
	// name would guess between two children called Ananya Sharma, and the
	// wrong face on a report card is not a small error.
	Photos []struct {
		AdmissionNo string `json:"admission_no"`
		FileID      string `json:"file_id"`
	} `json:"photos"`
}

// importStudentPhotos attaches a batch by admission number.
//
// Everything that matched is applied and everything that did not is named
// back. A batch that fails entirely because one file is called IMG_4471.jpg is
// a batch somebody gives up on.
func (s *Server) importStudentPhotos(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req bulkPhotoRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Photos) == 0 {
		httpx.BadRequest(w, r, "choose the photographs to import")
		return
	}
	if len(req.Photos) > 2000 {
		httpx.BadRequest(w, r, "import at most 2000 photographs at a time")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 3)

	matched := 0
	unmatched := []string{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, ph := range req.Photos {
			adm := strings.TrimSpace(ph.AdmissionNo)
			fid, perr := uuid.Parse(strings.TrimSpace(ph.FileID))
			if adm == "" || perr != nil {
				unmatched = append(unmatched, adm)
				continue
			}
			tag, err := tx.Exec(r.Context(),
				`UPDATE students st SET photo_file_id = $1
				  WHERE lower(st.admission_no) = lower($2) AND `+pred,
				append([]any{fid, adm}, args...)...)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				unmatched = append(unmatched, adm)
				continue
			}
			matched++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"matched": matched, "unmatched": unmatched,
	})
}

/* --- the parents' photographs ---------------------------------------------

   Same shape as the child's, deliberately: one file id, empty removes it, and
   the same scope predicate decides who may write. A different mechanism here
   would be a second place for the "which children may this teacher touch"
   question to be answered, and the day the two answers differ is the day a
   teacher edits a family in another section.

   Reached through the child rather than by guardian id alone. A guardian row
   belongs to the institution, not to a section, so on its own it carries
   nothing to check a teacher's scope against — and a guardian with two
   children in different sections is ordinary. */
func (s *Server) setGuardianPhoto(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	gid, err := uuid.Parse(chiURLParam(r, "gid"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid guardian id")
		return
	}
	var req studentPhotoRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var file *uuid.UUID
	if v := strings.TrimSpace(req.FileID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		file = &parsed
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 3)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The guardian must actually be this child's, or the child id would be
		// decoration and any guardian in the school could be edited by naming
		// a section the caller happens to teach.
		tag, err := tx.Exec(r.Context(), `
			UPDATE guardians g SET photo_file_id = $1
			 WHERE g.id = $2
			   AND EXISTS (SELECT 1 FROM student_guardians sg
			               JOIN students st ON st.id = sg.student_id
			              WHERE sg.guardian_id = g.id AND st.id = $3
			                AND `+pred+`)`,
			append([]any{file, gid, sid}, args...)...)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Forbidden(w, r, "this family is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}
