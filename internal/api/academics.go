package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type academicYear struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	StartsOn  string `json:"starts_on"`
	EndsOn    string `json:"ends_on"`
	IsCurrent bool   `json:"is_current"`
}

type class struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Level  int32   `json:"level"`
	Stream *string `json:"stream,omitempty"`
}

type section struct {
	ID             string  `json:"id"`
	ClassID        string  `json:"class_id"`
	ClassName      string  `json:"class_name"`
	AcademicYearID string  `json:"academic_year_id"`
	Name           string  `json:"name"`
	Capacity       int32   `json:"capacity"`
	Room           *string `json:"room,omitempty"`
	ClassTeacher   *string `json:"class_teacher,omitempty"`
	Enrolled       int     `json:"enrolled"`
}

type subject struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Code         string `json:"code"`
	IsScholastic bool   `json:"is_scholastic"`
}

// collect runs a tenant-scoped query and maps every row through scan.
// The academics endpoints are all "list a small reference table", so factoring
// the transaction and row loop out keeps each handler to its SQL.
func collect[T any](s *Server, r *http.Request, sql string, args []any, scan func(pgx.Rows) (T, error)) ([]T, error) {
	id := httpx.IdentityFrom(r.Context())
	out := []T{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), sql, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			v, err := scan(rows)
			if err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}

func respond[T any](w http.ResponseWriter, r *http.Request, items []T, err error) {
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) listAcademicYears(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, name, to_char(starts_on,'YYYY-MM-DD'), to_char(ends_on,'YYYY-MM-DD'), is_current
		  FROM academic_years ORDER BY starts_on DESC`, nil,
		func(rows pgx.Rows) (academicYear, error) {
			var v academicYear
			return v, rows.Scan(&v.ID, &v.Name, &v.StartsOn, &v.EndsOn, &v.IsCurrent)
		})
	respond(w, r, items, err)
}

func (s *Server) listClasses(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, name, level, stream FROM classes ORDER BY level, name`, nil,
		func(rows pgx.Rows) (class, error) {
			var v class
			return v, rows.Scan(&v.ID, &v.Name, &v.Level, &v.Stream)
		})
	respond(w, r, items, err)
}

// listSections reports live occupancy alongside capacity, because "is 8-B
// full?" is the question every section list is actually asked.
func (s *Server) listSections(w http.ResponseWriter, r *http.Request) {
	yearID := nullString(r.URL.Query().Get("academic_year_id"))

	/* mine=true: only the sections this person may actually write to.

	   This is the reference list of every section in the school, which is
	   right for the office and wrong for a form. A teacher setting homework
	   was offered all six grades, filled the whole form, and was refused with
	   "missing permission" on submit — the dropdown promising something the
	   server was always going to refuse. Offering a choice that cannot be
	   taken is worse than not offering it: the person has already done the
	   work by the time they find out.

	   The same predicate the write path checks, not a second opinion about
	   what a teacher reaches: teach it, or be its class teacher. */
	mine := "TRUE"
	args := []any{yearID}
	if q := r.URL.Query().Get("mine"); q == "true" || q == "class_teacher" {
		res, err := s.resolveScope(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		// mine=class_teacher for the screens only a class teacher may use — the
		// report card is theirs alone. mine=true for the wider set a subject
		// teacher legitimately writes to.
		ids := res.SectionIDs
		if q == "class_teacher" {
			ids = res.ClassTeacherOf
		}
		if !res.AnySection {
			if len(ids) == 0 {
				// No sections at all is a real answer, and an empty dropdown
				// with an honest empty state beats one full of refusals.
				mine = "FALSE"
			} else {
				args = append(args, ids)
				mine = "sec.id = ANY($" + itoa(len(args)) + ")"
			}
		}
	}

	items, err := collect(s, r, `
		SELECT sec.id::text, sec.class_id::text, c.name, sec.academic_year_id::text,
		       sec.name, sec.capacity, sec.room, u.full_name,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = sec.id AND e.status = 'active')
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		  LEFT JOIN users u ON u.id = sec.class_teacher_id
		 WHERE ($1::uuid IS NULL OR sec.academic_year_id = $1)
		   AND `+mine+`
		 ORDER BY c.level, sec.name`, args,
		func(rows pgx.Rows) (section, error) {
			var v section
			return v, rows.Scan(&v.ID, &v.ClassID, &v.ClassName, &v.AcademicYearID,
				&v.Name, &v.Capacity, &v.Room, &v.ClassTeacher, &v.Enrolled)
		})
	respond(w, r, items, err)
}

func (s *Server) listSubjects(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, name, code, is_scholastic FROM subjects ORDER BY name`, nil,
		func(rows pgx.Rows) (subject, error) {
			var v subject
			return v, rows.Scan(&v.ID, &v.Name, &v.Code, &v.IsScholastic)
		})
	respond(w, r, items, err)
}

// getRefData is one round trip for everything the SPA needs to render its
// filter bars: years, classes, sections, subjects. The client used to fetch
// these as four parallel calls on every route change.
func (s *Server) getRefData(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := map[string]any{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		years := []academicYear{}
		if err := scanInto(r.Context(), tx, `
			SELECT id::text, name, to_char(starts_on,'YYYY-MM-DD'),
			       to_char(ends_on,'YYYY-MM-DD'), is_current
			  FROM academic_years ORDER BY starts_on DESC`,
			func(rows pgx.Rows) error {
				var v academicYear
				if err := rows.Scan(&v.ID, &v.Name, &v.StartsOn, &v.EndsOn, &v.IsCurrent); err != nil {
					return err
				}
				years = append(years, v)
				return nil
			}); err != nil {
			return err
		}

		classes := []class{}
		if err := scanInto(r.Context(), tx,
			`SELECT id::text, name, level, stream FROM classes ORDER BY level, name`,
			func(rows pgx.Rows) error {
				var v class
				if err := rows.Scan(&v.ID, &v.Name, &v.Level, &v.Stream); err != nil {
					return err
				}
				classes = append(classes, v)
				return nil
			}); err != nil {
			return err
		}

		sections := []section{}
		if err := scanInto(r.Context(), tx, `
			SELECT sec.id::text, sec.class_id::text, c.name, sec.academic_year_id::text,
			       sec.name, sec.capacity, sec.room, NULL::text, 0
			  FROM sections sec JOIN classes c ON c.id = sec.class_id
			 ORDER BY c.level, sec.name`,
			func(rows pgx.Rows) error {
				var v section
				if err := rows.Scan(&v.ID, &v.ClassID, &v.ClassName, &v.AcademicYearID,
					&v.Name, &v.Capacity, &v.Room, &v.ClassTeacher, &v.Enrolled); err != nil {
					return err
				}
				sections = append(sections, v)
				return nil
			}); err != nil {
			return err
		}

		subjects := []subject{}
		if err := scanInto(r.Context(), tx,
			`SELECT id::text, name, code, is_scholastic FROM subjects ORDER BY name`,
			func(rows pgx.Rows) error {
				var v subject
				if err := rows.Scan(&v.ID, &v.Name, &v.Code, &v.IsScholastic); err != nil {
					return err
				}
				subjects = append(subjects, v)
				return nil
			}); err != nil {
			return err
		}

		out["academic_years"] = years
		out["classes"] = classes
		out["sections"] = sections
		out["subjects"] = subjects
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// scanInto runs a query and hands each row to fn.
//
// Variadic args rather than string interpolation: the approvals queue narrows
// student leave to the caller's own sections, and a user id spliced into SQL
// is the one place this codebase must never start.
func scanInto(ctx context.Context, tx pgx.Tx, sql string, fn func(pgx.Rows) error, args ...any) error {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}
