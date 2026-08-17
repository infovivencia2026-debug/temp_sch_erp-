// Package migrations embeds the goose SQL migrations so cmd/migrate is a
// single self-contained binary -- the deploy uploads three files and nothing
// else, with no migrations directory to keep in sync on the server.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
