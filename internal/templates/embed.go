// Package templates embeds the server-rendered pages into the binary.
//
// Embedding is what lets the systemd unit run with ProtectSystem=strict and no
// write access to its own directory -- there is nothing on disk to read.
package templates

import (
	"embed"
	"html/template"
)

//go:embed *.gohtml
var FS embed.FS

func Parse() (*template.Template, error) {
	return template.ParseFS(FS, "*.gohtml")
}
