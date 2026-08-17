// Package migrations carries the SQL schema files into the binary, so a
// deployment is one artefact and `api migrate` can never run a different schema
// than the code it shipped with.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
