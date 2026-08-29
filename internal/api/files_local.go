package api

import (
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Files, on the disk that is actually here.

   R2 has never been configured on this installation. presignUpload has always
   answered 503, so every screen that wanted a file — study material, a lesson
   plan, a scanned certificate — offered a box for a link instead and said so
   honestly on its face. A school that wants to hand a worksheet to a class
   does not have an object store; it has this server, with disk on it.

   So: multipart in, stream out, rows in the same files table the rest of the
   product already reads. When R2 is configured this becomes the second choice
   rather than the only one, and no caller has to know which is in use, because
   both mint a file id and nothing downstream stores anything else.

   Three things this is careful about, all of them the same worry — a school
   ERP is a place where a stranger can persuade somebody to upload a file and
   then persuade somebody else to open it:

     Everything is served as an attachment with nosniff, so a file the browser
     might otherwise decide to execute is downloaded instead of run.

     The stored name is a uuid this code chose. The name the uploader supplied
     is kept in a column and used only in Content-Disposition, so "../../etc"
     is a label rather than a path.

     Reads go through RLS on the same tenant scope as every other query, so a
     file id guessed or leaked from another school resolves to no row. */

// maxLocalUploadBytes is the ceiling for a disk-backed upload, and it has to
// stay at or below nginx's client_max_body_size or the proxy rejects the
// request before this code ever sees it.
const maxLocalUploadBytes = 64 << 20

// blockedUploadExtensions are the things a browser or a Windows desktop may
// run. Everything else is allowed: the request was for "all types of files",
// and a school genuinely does need .docx, .pptx, .mp4, .zip and a hundred
// others. Refusing the executable set is not a filter on document types, it
// is a refusal to become a malware host with a login page.
var blockedUploadExtensions = map[string]bool{
	".exe": true, ".dll": true, ".scr": true, ".com": true, ".bat": true,
	".cmd": true, ".msi": true, ".ps1": true, ".vbs": true, ".jse": true,
	".js": true, ".jar": true, ".sh": true, ".app": true, ".apk": true,
	".hta": true, ".cpl": true, ".reg": true, ".lnk": true, ".pif": true,
}

var errNoFileStore = errors.New("file storage is not configured on this deployment")

// storeDir is where uploads land, or "" when the deployment has none.
func (s *Server) storeDir() string { return strings.TrimSpace(s.FileStoreDir) }

/*
uploadFile takes a multipart file and returns the id everything else uses.

	Deliberately not a presign. A presigned PUT exists so the bytes can go
	straight to a bucket without passing through the application; with the disk
	under the application there is no bucket to go straight to, and inventing a
	two-step handshake to reach a local directory would be ceremony with an
	extra failure mode in it.
*/
func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	dir := s.storeDir()
	if dir == "" {
		httpx.Error(w, r, http.StatusServiceUnavailable, "storage_unconfigured",
			errNoFileStore.Error())
		return
	}

	// The reader is capped before anything is read, so an oversized body is
	// refused while it arrives rather than after it has been written to disk.
	r.Body = http.MaxBytesReader(w, r.Body, maxLocalUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		httpx.BadRequest(w, r, "could not read the upload. Is it larger than 64 MB?")
		return
	}
	src, header, err := r.FormFile("file")
	if err != nil {
		httpx.BadRequest(w, r, "no file was attached under the field name 'file'")
		return
	}
	defer src.Close()

	// filepath.Base first: the browser sends whatever the operating system
	// gave it, and some send a whole path.
	original := filepath.Base(strings.TrimSpace(header.Filename))
	if original == "" || original == "." || original == string(filepath.Separator) {
		original = "upload"
	}
	ext := strings.ToLower(filepath.Ext(original))
	if blockedUploadExtensions[ext] {
		httpx.BadRequest(w, r,
			"files of type "+ext+" cannot be uploaded, they are programs, "+
				"and this is a school's document store")
		return
	}

	purpose := strings.TrimSpace(r.FormValue("purpose"))
	if purpose == "" {
		purpose = "attachment"
	}
	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	/* The name on disk is chosen here and owes nothing to the uploader.

	   Laid out by institution and month so a directory stays a size a person
	   can list, and so removing one school's files is a directory operation
	   rather than a query. */
	fileID := uuid.New()
	rel := filepath.ToSlash(filepath.Join(id.InstitutionID.String(),
		time.Now().Format("2006-01"), fileID.String()+ext))
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		/* Named, because nobody using the product can act on "refused".

		   The store sat on a path the service was not permitted to write —
		   systemd hardening listing only the log directory — so every upload
		   in the product failed and every screen said the same four words. An
		   internal error is opaque on purpose and this one is not the reader's
		   fault to interpret: what they need is that it is the school's
		   installation and not their file, so they stop trying other files. */
		httpx.Error(w, r, http.StatusServiceUnavailable, "storage_unwritable",
			"the school's file storage cannot be written to. Nothing is wrong "+
				"with your file — this needs whoever runs the server.")
		httpx.LogError(r, err)
		return
	}

	dst, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	sum := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(dst, sum),
		io.LimitReader(src, maxLocalUploadBytes+1))
	closeErr := dst.Close()
	switch {
	case copyErr != nil:
		os.Remove(full)
		httpx.BadRequest(w, r, "the upload did not complete")
		return
	case closeErr != nil:
		os.Remove(full)
		httpx.Internal(w, r, closeErr)
		return
	case written > maxLocalUploadBytes:
		os.Remove(full)
		httpx.BadRequest(w, r, "that file is larger than 64 MB")
		return
	case written == 0:
		os.Remove(full)
		httpx.BadRequest(w, r, "that file is empty")
		return
	}

	// The row goes in last. An orphaned file with no row is a wasted byte of
	// disk; a row with no file is a broken link on somebody's screen.
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO files (id, institution_id, object_key, original_name,
			                   content_type, size_bytes, checksum_sha256,
			                   purpose, uploaded_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			fileID, id.InstitutionID, rel, original, contentType,
			written, sum.Sum(nil), purpose, id.UserID)
		return err
	})
	if err != nil {
		os.Remove(full)
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"file_id":      fileID.String(),
		"name":         original,
		"size_bytes":   written,
		"content_type": contentType,
		"url":          "/api/v1/files/" + fileID.String(),
	})
}

// downloadFile streams a stored file back to somebody in the same school.
//
// The row lookup runs under the tenant scope, so a file id belonging to
// another institution finds nothing — the check is RLS rather than an if
// statement, which is the same guarantee every other read in the product has
// and not a second one that could disagree with it.
func (s *Server) downloadFile(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	fileID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid file id")
		return
	}
	dir := s.storeDir()
	if dir == "" {
		httpx.Error(w, r, http.StatusServiceUnavailable, "storage_unconfigured",
			errNoFileStore.Error())
		return
	}

	var key, name, contentType string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var studentOwner, appOwner, empOwner, hwOwner *uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT f.object_key, f.original_name, f.content_type,
			       (SELECT student_id FROM student_documents WHERE file_id = f.id LIMIT 1),
			       (SELECT application_id FROM application_documents WHERE file_id = f.id LIMIT 1),
			       (SELECT employee_id FROM employee_documents WHERE file_id = f.id LIMIT 1),
			       (SELECT homework_id FROM homework_attachments WHERE file_id = f.id LIMIT 1)
			  FROM files f WHERE f.id = $1 AND f.deleted_at IS NULL`, fileID).
			Scan(&key, &name, &contentType, &studentOwner, &appOwner, &empOwner, &hwOwner)
		if err != nil {
			return err
		}

		if studentOwner != nil {
			res, err := s.resolveScope(r)
			if err != nil { return err }
			pred, args := res.StudentPredicate("st", 2)
			var ok bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM students st WHERE st.id = $1 AND `+pred+`)`, append([]any{*studentOwner}, args...)...).Scan(&ok); err != nil {
				return err
			}
			if !ok { return pgx.ErrNoRows }
		} else if appOwner != nil {
			if !id.Can(rbac.AdmissionsRead) { return pgx.ErrNoRows }
		} else if empOwner != nil {
			if !id.Can(rbac.EmployeesRead) {
				var isSelf bool
				if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM employees WHERE id = $1 AND user_id = $2)`, *empOwner, id.UserID).Scan(&isSelf); err != nil {
					return err
				}
				if !isSelf { return pgx.ErrNoRows }
			}
		} else if hwOwner != nil {
			res, err := s.resolveScope(r)
			if err != nil { return err }
			pred, args := res.TimetablePredicate("hw.section_id", 2)
			var ok bool
			
			qargs := []any{*hwOwner}
			if args != nil {
				qargs = append(qargs, args)
			}
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM homework hw WHERE hw.id = $1 AND `+pred+`)`, qargs...).Scan(&ok); err != nil {
				return err
			}
			if !ok { return pgx.ErrNoRows }
		}
		// A file with no owner keeps today's institution-only behaviour.
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The key was written by this code and is a uuid under a uuid, but it
	// arrives here from the database, and a path out of a database is still a
	// path from outside this function.
	full := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+key)))
	if !strings.HasPrefix(full, filepath.Clean(dir)+string(filepath.Separator)) {
		httpx.NotFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Attachment, always, and nosniff with it. A school's document store is
	// exactly the place somebody would like to serve an HTML file from, and
	// this origin is the one the session cookie is scoped to.
	safeName := strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(name)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `attachment; filename="`+safeName+`"`)
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, name, info.ModTime(), f)
}
