// Package storage wraps Cloudflare R2 (S3-compatible) for user uploads.
//
// Nothing user-uploaded touches local disk: the systemd unit runs with
// ProtectSystem=strict and no writable path except /var/log/school-erp, and
// the box has under a gigabyte free. Browsers upload straight to R2 with a
// presigned PUT, so a 40 MB scanned transfer certificate never travels through
// the 1 vCPU Go process.
package storage

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/config"
)

var ErrNotConfigured = errors.New("R2 is not configured")

type Store struct {
	client  *s3.Client
	presign *s3.PresignClient
	cfg     config.R2Config
}

func New(cfg config.R2Config) (*Store, error) {
	if !cfg.Configured() {
		return nil, ErrNotConfigured
	}
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.AccountID)
	client := s3.New(s3.Options{
		// R2 ignores the region but the SDK requires one; "auto" is what
		// Cloudflare documents.
		Region:       "auto",
		BaseEndpoint: aws.String(endpoint),
		Credentials: aws.NewCredentialsCache(
			credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")),
	})
	// Note on SDK version: s3 v1.72.0 turned on CRC32 trailing checksums by
	// default, which R2 rejects with 501 until you set
	// RequestChecksumCalculation=WhenRequired. This build is pinned to v1.71.0
	// -- matching the deployed binary -- where that default is not yet in
	// effect, so no override exists or is needed. Add both options if you bump
	// the SDK.
	return &Store{client: client, presign: s3.NewPresignClient(client), cfg: cfg}, nil
}

// Key builds a tenant-prefixed object key. The institution id leads so a
// bucket-level policy or lifecycle rule can be scoped per tenant, and so a
// listing can never accidentally span tenants.
func Key(institutionID uuid.UUID, kind, filename string) string {
	ext := strings.ToLower(path.Ext(filename))
	return fmt.Sprintf("%s/%s/%s%s", institutionID, kind, uuid.NewString(), ext)
}

type PresignedUpload struct {
	URL       string            `json:"url"`
	Key       string            `json:"key"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
}

// PresignPut returns a short-lived URL the browser PUTs the file to directly.
func (s *Store) PresignPut(ctx context.Context, key, contentType string, size int64) (*PresignedUpload, error) {
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.cfg.Bucket),
		Key:           aws.String(key),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(size),
	}, s3.WithPresignExpires(s.cfg.PresignExpiry))
	if err != nil {
		return nil, fmt.Errorf("presign put: %w", err)
	}
	return &PresignedUpload{
		URL:    req.URL,
		Key:    key,
		Method: req.Method,
		// Content-Length is signed, so the browser must send exactly the size
		// it declared or R2 rejects the signature.
		Headers:   map[string]string{"Content-Type": contentType},
		ExpiresAt: time.Now().Add(s.cfg.PresignExpiry),
	}, nil
}

// PresignGet returns a short-lived download URL. Used for anything private --
// student documents, payslips, report-card PDFs.
func (s *Store) PresignGet(ctx context.Context, key, downloadName string) (string, error) {
	in := &s3.GetObjectInput{Bucket: aws.String(s.cfg.Bucket), Key: aws.String(key)}
	if downloadName != "" {
		in.ResponseContentDisposition = aws.String(
			fmt.Sprintf("attachment; filename=%q", downloadName))
	}
	req, err := s.presign.PresignGetObject(ctx, in, s3.WithPresignExpires(s.cfg.PresignExpiry))
	if err != nil {
		return "", fmt.Errorf("presign get: %w", err)
	}
	return req.URL, nil
}

// PublicURL is for genuinely public objects (institution logo) when a public
// R2 host is configured. Everything else must go through PresignGet.
func (s *Store) PublicURL(key string) (string, bool) {
	if s.cfg.PublicHost == "" {
		return "", false
	}
	u := url.URL{Scheme: "https", Host: s.cfg.PublicHost, Path: "/" + key}
	return u.String(), true
}

func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.cfg.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("delete %s: %w", key, err)
	}
	return nil
}
