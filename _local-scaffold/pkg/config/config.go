// Package config turns the environment into typed configuration and fails loudly
// at startup when something required is missing. Nothing here reads the
// environment after Load returns.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env         string // dev | staging | production
	HTTPAddr    string
	DatabaseURL string
	RedisAddr   string
	RedisDB     int
	SessionTTL  time.Duration
	LogLevel    string
	CORSOrigins []string
	// TrustedProxies is empty by default: Gin must not believe X-Forwarded-For
	// unless we know a proxy is in front of it, or client IP in the audit log
	// becomes whatever the caller says it is.
	TrustedProxies []string
}

type missing []string

func (m missing) Error() string {
	return fmt.Sprintf("missing required environment variables: %s", strings.Join(m, ", "))
}

// Load reads configuration from the environment. Required values have no
// default in any environment — a production deploy with no DATABASE_URL should
// refuse to start rather than quietly point at localhost.
func Load() (Config, error) {
	var absent missing

	required := func(key string) string {
		v := os.Getenv(key)
		if v == "" {
			absent = append(absent, key)
		}
		return v
	}

	cfg := Config{
		Env:            optional("APP_ENV", "dev"),
		HTTPAddr:       optional("HTTP_ADDR", ":8080"),
		DatabaseURL:    required("DATABASE_URL"),
		RedisAddr:      optional("REDIS_ADDR", "127.0.0.1:6379"),
		RedisDB:        optionalInt("REDIS_DB", 0),
		SessionTTL:     optionalDuration("SESSION_TTL", 12*time.Hour),
		LogLevel:       optional("LOG_LEVEL", "info"),
		CORSOrigins:    optionalList("CORS_ORIGINS", []string{"http://localhost:3000"}),
		TrustedProxies: optionalList("TRUSTED_PROXIES", nil),
	}

	if len(absent) > 0 {
		return Config{}, absent
	}
	if cfg.Env != "dev" && cfg.Env != "staging" && cfg.Env != "production" {
		return Config{}, fmt.Errorf("APP_ENV must be dev, staging or production, got %q", cfg.Env)
	}
	return cfg, nil
}

func (c Config) IsProduction() bool { return c.Env == "production" }

func optional(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func optionalInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func optionalDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

func optionalList(key string, fallback []string) []string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
