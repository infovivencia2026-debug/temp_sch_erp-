package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/storage"
)

/* Files, on the disk that is actually here.

   R2 has never been configured on this installation. presignUpload has always
   answered 503, so every screen that wanted a file — study material, a lesson
   plan, a scanned certificate — offered a box for a link instead and said so
   honestly on its face. A school that wants to hand a worksheet to a class
   does not have an object store; it has this server, with disk on it.

   So: multipart in, stream out, rows in the same files table the rest of the
   product already reads. When R2 is configured the same handlers put the
   bytes in the bucket instead -- the container host has no disk that
   survives a deploy -- and no caller has to know which is in use, because
   both mint a file id and nothing downstream stores anything else. The
   object key is the path the file would have had on disk, so a directory
   copied into the bucket (`migrate files-to-r2`) is read by the same rows.

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

// storeDir is where uploads land on disk, or "" when the deployment has none.
func (s *Server) storeDir() string { return strings.TrimSpace(s.FileStoreDir) }

// hasFileStore is the one question every file handler asks first: is there
// anywhere at all -- bucket or directory -- for the bytes to live?
func (s *Server) hasFileStore() bool { return s.Storage != nil || s.storeDir() != "" }

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
	if !s.hasFileStore() {
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

	/* Bucket first when there is one; the disk is what remains otherwise.

	   Two code paths that end at the same INSERT. Each is responsible for
	   its own cleanup on failure, because a row with no bytes behind it is a
	   broken link on somebody's screen, and that is worse than either. */
	var written int64
	var sum []byte
	var discard func()
	if s.Storage != nil {
		var msg string
		written, sum, msg, err = putUploadInStore(r.Context(), s.Storage, rel, contentType, src)
		if msg != "" {
			httpx.BadRequest(w, r, msg)
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		discard = func() { _ = s.Storage.Delete(context.WithoutCancel(r.Context()), rel) }
	} else {
		var full string
		var msg string
		full, written, sum, msg, err = putUploadOnDisk(dir, rel, src)
		if errors.Is(err, errStoreUnwritable) {
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
		if msg != "" {
			httpx.BadRequest(w, r, msg)
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		discard = func() { os.Remove(full) }
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
			written, sum, purpose, id.UserID)
		return err
	})
	if err != nil {
		discard()
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

var errStoreUnwritable = errors.New("file store directory cannot be created")

// putUploadOnDisk writes the part under dir/rel and returns the path, the
// byte count and the checksum. A non-empty msg is a reason the uploader can
// act on (too big, empty, cut off) and means the file was not kept.
func putUploadOnDisk(dir, rel string, src io.Reader) (full string, written int64, sum []byte, msg string, err error) {
	full = filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		// Wrapped so the handler can name it; see the 503 it turns into.
		return "", 0, nil, "", fmt.Errorf("%w: %v", errStoreUnwritable, err)
	}
	dst, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return "", 0, nil, "", err
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(dst, h),
		io.LimitReader(src, maxLocalUploadBytes+1))
	closeErr := dst.Close()
	switch {
	case copyErr != nil:
		os.Remove(full)
		return "", 0, nil, "the upload did not complete", nil
	case closeErr != nil:
		os.Remove(full)
		return "", 0, nil, "", closeErr
	case written > maxLocalUploadBytes:
		os.Remove(full)
		return "", 0, nil, "that file is larger than 64 MB", nil
	case written == 0:
		os.Remove(full)
		return "", 0, nil, "that file is empty", nil
	}
	return full, written, h.Sum(nil), "", nil
}

/*
putUploadInStore sends the part to the bucket under key.

	The bucket signs the length into the request, so the size has to be known
	before the first byte is sent -- which the disk path never needed, since a
	file on disk is as long as whatever was written to it. A multipart part is
	seekable (Go spools anything over the memory threshold to a temp file), so
	it is measured and hashed in one pass and then rewound for the PUT. Twice
	over at most 64 MB of local file is cheaper than buffering it in memory
	and far cheaper than a multipart upload to the bucket.
*/
func putUploadInStore(ctx context.Context, store *storage.Store, key, contentType string, src io.ReadSeeker) (written int64, sum []byte, msg string, err error) {
	h := sha256.New()
	written, err = io.Copy(h, io.LimitReader(src, maxLocalUploadBytes+1))
	switch {
	case err != nil:
		return 0, nil, "the upload did not complete", nil
	case written > maxLocalUploadBytes:
		return 0, nil, "that file is larger than 64 MB", nil
	case written == 0:
		return 0, nil, "that file is empty", nil
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return 0, nil, "", err
	}
	if err := store.Put(ctx, key, contentType, written, src); err != nil {
		return 0, nil, "", err
	}
	return written, h.Sum(nil), "", nil
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
	if !s.hasFileStore() {
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
			if err != nil {
				return err
			}
			pred, args := res.StudentPredicate("st", 2)
			var ok bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM students st WHERE st.id = $1 AND `+pred+`)`, append([]any{*studentOwner}, args...)...).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return pgx.ErrNoRows
			}
		} else if appOwner != nil {
			if !id.Can(rbac.AdmissionsRead) {
				return pgx.ErrNoRows
			}
		} else if empOwner != nil {
			if !id.Can(rbac.EmployeesRead) {
				var isSelf bool
				if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM employees WHERE id = $1 AND user_id = $2)`, *empOwner, id.UserID).Scan(&isSelf); err != nil {
					return err
				}
				if !isSelf {
					return pgx.ErrNoRows
				}
			}
		} else if hwOwner != nil {
			res, err := s.resolveScope(r)
			if err != nil {
				return err
			}
			pred, args := res.TimetablePredicate("hw.section_id", 2)
			var ok bool

			qargs := []any{*hwOwner}
			if args != nil {
				qargs = append(qargs, args)
			}
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM homework hw WHERE hw.id = $1 AND `+pred+`)`, qargs...).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return pgx.ErrNoRows
			}
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

	body, err := s.openStoredFile(r, key)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	defer body.Close()

	// Attachment, always, and nosniff with it. A school's document store is
	// exactly the place somebody would like to serve an HTML file from, and
	// this origin is the one the session cookie is scoped to.
	safeName := strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(name)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	/* ?inline=1 asks to SHOW it rather than hand it over.

	   A teacher checking that the worksheet they attached is the right one, and
	   a parent reading it on a phone, should not have to download a file to
	   find out — and a downloaded file is a copy of a school record sitting in
	   somebody's Downloads folder for ever, which is worse for the school than
	   not downloading it at all.

	   What makes that safe is the sandbox rather than any judgement about the
	   file: a CSP of `sandbox` with no allow-scripts puts the response in a
	   unique opaque origin, so it can run no script, read no cookie and reach
	   nothing belonging to this origin — as true of an HTML file somebody
	   uploaded as of a PDF. The type allowlist is a second line, not the
	   first. */
	if r.URL.Query().Get("inline") == "1" && viewableInline(contentType) {
		w.Header().Set("Content-Disposition", `inline; filename="`+safeName+`"`)
		w.Header().Set("Content-Security-Policy",
			"sandbox; default-src 'none'; img-src 'self' data:; "+
				"style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'")
	} else {
		w.Header().Set("Content-Disposition", `attachment; filename="`+safeName+`"`)
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	body.serve(w, r, name)
}

/*
storedFile is one file on its way out, from whichever store holds it.

	The disk gives http.ServeContent a seeker and gets Range, If-Modified-Since
	and Content-Length for free. The bucket gives a stream, so the Range header
	is forwarded to it instead and its answer -- 200 or 206, with the bucket's
	own Content-Range -- is relayed. Same wire shape either way, which is what
	the phone shells' video players and PDF viewers depend on.
*/
type storedFile struct {
	file *os.File
	obj  *storage.Object
}

func (f *storedFile) Close() error {
	if f.file != nil {
		return f.file.Close()
	}
	return f.obj.Body.Close()
}

func (f *storedFile) serve(w http.ResponseWriter, r *http.Request, name string) {
	if f.file != nil {
		info, err := f.file.Stat()
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		http.ServeContent(w, r, name, info.ModTime(), f.file)
		return
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(f.obj.Size, 10))
	if !f.obj.LastModified.IsZero() {
		w.Header().Set("Last-Modified", f.obj.LastModified.UTC().Format(http.TimeFormat))
	}
	status := http.StatusOK
	if f.obj.Partial {
		w.Header().Set("Content-Range", f.obj.ContentRange)
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, f.obj.Body)
	}
}

/*
openStoredFile finds key in the bucket, or on the disk, or nowhere.

	The bucket is asked first when there is one. A key it does not hold is
	then looked for on disk -- not as a permanent arrangement but so that
	turning R2 on and copying the directory across can happen in either order
	without a window where every existing attachment is a 404. With no
	directory configured the miss is simply a miss. storage.ErrNotFound is the
	only error the caller turns into 404; everything else is the bucket or
	the disk misbehaving and is reported as such.
*/
func (s *Server) openStoredFile(r *http.Request, key string) (*storedFile, error) {
	if s.Storage != nil {
		obj, err := s.Storage.GetRange(r.Context(), key, r.Header.Get("Range"))
		if err == nil {
			return &storedFile{obj: obj}, nil
		}
		if !errors.Is(err, storage.ErrNotFound) || s.storeDir() == "" {
			return nil, err
		}
	}
	dir := s.storeDir()
	if dir == "" {
		return nil, storage.ErrNotFound
	}
	// The key was written by this code and is a uuid under a uuid, but it
	// arrives here from the database, and a path out of a database is still a
	// path from outside this function.
	full := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+key)))
	if !strings.HasPrefix(full, filepath.Clean(dir)+string(filepath.Separator)) {
		return nil, storage.ErrNotFound
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, storage.ErrNotFound
	}
	return &storedFile{file: f}, nil
}

/*
viewableInline says whether a browser can be asked to render this in place.

	Deliberately a list of what browsers actually display rather than "anything
	not obviously dangerous": a type nobody can render is a blank frame, and a
	blank frame is indistinguishable from a broken one.

	SVG is absent on purpose. It renders as an image and people reason about it
	as an image, but it is a document that can carry script — the one type where
	what somebody expects and what the file can do come apart. The sandbox would
	hold it; the surprise is the reason not to.
*/
func viewableInline(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	switch ct {
	case "application/pdf",
		"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
		"image/bmp", "image/avif", "image/heic", "image/heif",
		"text/plain", "text/csv", "text/markdown", "text/tab-separated-values",
		"audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm",
		"video/mp4", "video/webm", "video/ogg", "video/quicktime":
		return true
	}
	return false
}
