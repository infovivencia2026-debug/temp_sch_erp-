package main

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"mime"
	"os"
	"path/filepath"

	"github.com/school-erp/erp/internal/config"
	"github.com/school-erp/erp/internal/storage"
)

/*
filesToR2 moves a disk-backed installation onto the bucket.

	The object key is the path relative to FILE_STORE_DIR, which is exactly
	what the handlers wrote into files.object_key, so no row changes and the
	copy can run before or after R2 is switched on for the web process (the
	download path looks in the bucket first and on disk second until this has
	run). Idempotent: an object already present is skipped, so a copy that was
	interrupted is finished by running it again. Nothing is deleted from disk;
	that is a decision for whoever runs the box once the bucket has been seen
	to serve. The equivalent without this binary is
	`rclone copy $FILE_STORE_DIR r2:$R2_BUCKET`.
*/
func filesToR2(ctx context.Context, cfg *config.Config) error {
	store, err := storage.New(cfg.R2)
	if err != nil {
		return err
	}
	root := cfg.FileStoreDir
	var copied, skipped int
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		key := filepath.ToSlash(filepath.Clean(p[len(root):]))
		if key[0] == '/' {
			key = key[1:]
		}
		if ok, err := store.Exists(ctx, key); err != nil {
			return err
		} else if ok {
			skipped++
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		// The type in the bucket is advisory: the handler serves whatever
		// files.content_type says, so a guess from the extension is enough.
		ct := mime.TypeByExtension(filepath.Ext(p))
		if ct == "" {
			ct = "application/octet-stream"
		}
		if err := store.Put(ctx, key, ct, info.Size(), f); err != nil {
			return err
		}
		copied++
		slog.Info("copied", "key", key, "bytes", info.Size())
		return nil
	})
	if err != nil {
		return fmt.Errorf("files-to-r2: %w", err)
	}
	slog.Info("files-to-r2 done", "copied", copied, "already_present", skipped, "bucket", cfg.R2.Bucket)
	return nil
}
