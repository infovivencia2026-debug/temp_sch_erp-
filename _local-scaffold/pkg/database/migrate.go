package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
)

// Migrate applies any migration files not yet recorded, in filename order, each
// in its own transaction. Forward-only by design: rolling back a schema change
// in production is a data-loss decision, not a command. Backwards-compatible
// migrations (expand → migrate → contract) are what make image rollback safe.
//
// Applied migrations are checksummed. Editing a file that has already run is a
// deploy-time error, not a silent divergence between environments.
func Migrate(ctx context.Context, db *DB, fsys fs.FS, appRole string) error {
	conn, err := db.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			checksum   text        NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]string{}
	rows, err := conn.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var version, checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			rows.Close()
			return err
		}
		applied[version] = checksum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		version := strings.TrimSuffix(name, ".sql")

		if prior, ok := applied[version]; ok {
			if prior != checksum {
				return fmt.Errorf(
					"migration %s has changed since it was applied (recorded %s, now %s) — "+
						"add a new migration instead of editing a released one",
					version, prior[:12], checksum[:12])
			}
			continue
		}

		slog.Info("applying migration", "version", version)

		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin %s: %w", version, err)
		}
		// 0003 grants privileges to the application role, whose name is
		// deployment-specific; pass it through as a session setting.
		if appRole != "" {
			if _, err := tx.Exec(ctx, "SELECT set_config('erp.app_role', $1, true)", appRole); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("set app role for %s: %w", version, err)
			}
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", version, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
			version, checksum); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record %s: %w", version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit %s: %w", version, err)
		}
	}

	slog.Info("migrations up to date", "count", len(names))
	return nil
}
