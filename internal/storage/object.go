package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

/* Objects through the application, not around it.

   PresignPut exists so a browser can hand a file to the bucket without it
   passing through this process. That is still the right shape for a
   JavaScript client that knows how to do a two-step upload, and the wrong
   shape for everything else: the multipart upload endpoint the SPA and the
   phone shells actually use, and any host with no disk to fall back on.
   These methods are that endpoint's way of reaching the bucket, and they
   deliberately mirror what the disk gives it -- a writer, a reader with a
   size and a type, and a remove -- so the handler branches once, on whether
   a Store exists, and nothing else about it has to know.

   Keys are whatever the caller stores in files.object_key. Nothing here
   invents a prefix, so a row written when the file lived on disk names the
   same object after a one-off copy (see `migrate files-to-r2`). */

// ErrNotFound is what Get returns for a key the bucket does not hold. Callers
// turn it into a 404, or into a look at the disk during a migration; every
// other error is the bucket or the network and stays an internal error.
var ErrNotFound = errors.New("object not found")

// Object is one stored file on its way to a client. The caller owns Body and
// must close it.
type Object struct {
	Body         io.ReadCloser
	ContentType  string
	Size         int64
	LastModified time.Time
	// ContentRange and Partial are set when the caller asked for a byte range
	// and the bucket honoured it, so the handler can answer 206 for a video
	// scrubbed on a phone rather than sending the whole file each time.
	ContentRange string
	Partial      bool
}

// Put writes size bytes from r under key. size is signed into the request,
// so the reader must produce exactly that many bytes; the multipart handler
// measures the part before calling this for that reason. A seekable reader
// is preferred -- the SDK can then retry a failed PUT on its own.
func (s *Store) Put(ctx context.Context, key, contentType string, size int64, r io.Reader) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.cfg.Bucket),
		Key:           aws.String(key),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(size),
		Body:          r,
	})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// Get opens key for reading. See GetRange for the byte-range form.
func (s *Store) Get(ctx context.Context, key string) (*Object, error) {
	return s.GetRange(ctx, key, "")
}

// GetRange opens key, honouring an HTTP Range header value when one is given.
// The header is passed through verbatim: the bucket validates it, and a
// malformed one comes back as an error rather than a full-body 200.
func (s *Store) GetRange(ctx context.Context, key, byteRange string) (*Object, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)}
	if byteRange != "" {
		in.Range = aws.String(byteRange)
	}
	out, err := s.client.GetObject(ctx, in)
	if err != nil {
		if isMissing(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	obj := &Object{Body: out.Body, ContentType: aws.ToString(out.ContentType),
		Size: aws.ToInt64(out.ContentLength), LastModified: aws.ToTime(out.LastModified)}
	if out.ContentRange != nil {
		obj.ContentRange = *out.ContentRange
		obj.Partial = true
	}
	return obj, nil
}

// Exists is for the migration: copying a directory twice must be harmless.
func (s *Store) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)})
	if err != nil {
		if isMissing(err) {
			return false, nil
		}
		return false, fmt.Errorf("head %s: %w", key, err)
	}
	return true, nil
}

// isMissing: GetObject says NoSuchKey, HeadObject says NotFound, and R2 has
// been seen to answer a bare 404 with neither code. All three mean the same
// thing to a caller.
func isMissing(err error) bool {
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	if errors.As(err, &nsk) || errors.As(err, &nf) {
		return true
	}
	var re interface{ HTTPStatusCode() int }
	return errors.As(err, &re) && re.HTTPStatusCode() == 404
}
