// Package config loads runtime configuration from the environment.
//
// The deployed unit reads /etc/school-erp.env via systemd's EnvironmentFile,
// so nothing here depends on a .env file existing; godotenv is a convenience
// for local development only.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	AppEnv   string
	HTTPAddr string
	BaseURL  string

	DatabaseURL string
	DBMaxConns  int32

	RedisURL string

	SessionSecret  []byte
	SessionTTL     time.Duration
	SessionIdleTTL time.Duration
	PasswordPepper string
	CredentialKey  string

	R2 R2Config
}

type R2Config struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	PublicHost      string
	PresignExpiry   time.Duration
}

// Configured reports whether the R2 credentials are real. deploy.sh writes
// REPLACE_ME placeholders, and production is currently running with them --
// uploads fail at first use rather than at boot. Load surfaces that as a
// warning so the operator sees it in the logs on every start.
func (r R2Config) Configured() bool {
	for _, v := range []string{r.AccountID, r.AccessKeyID, r.SecretAccessKey} {
		if v == "" || v == "REPLACE_ME" {
			return false
		}
	}
	return true
}

func Load() (*Config, error) {
	_ = godotenv.Load()

	c := &Config{
		AppEnv:         env("APP_ENV", "development"),
		HTTPAddr:       env("HTTP_ADDR", "127.0.0.1:8090"),
		BaseURL:        env("BASE_URL", "http://localhost:8090"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		DBMaxConns:     int32(envInt("DB_MAX_CONNS", 10)),
		RedisURL:       env("REDIS_URL", "redis://127.0.0.1:6379/0"),
		SessionSecret:  []byte(os.Getenv("SESSION_SECRET")),
		SessionTTL:     envDur("SESSION_TTL", 12*time.Hour),
		SessionIdleTTL: envDur("SESSION_IDLE_TTL", 2*time.Hour),
		PasswordPepper: os.Getenv("PASSWORD_PEPPER"),
		CredentialKey:  os.Getenv("CREDENTIAL_KEY"),
		R2: R2Config{
			AccountID:       os.Getenv("R2_ACCOUNT_ID"),
			AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
			Bucket:          env("R2_BUCKET", "school-erp"),
			PublicHost:      os.Getenv("R2_PUBLIC_HOST"),
			PresignExpiry:   envDur("R2_PRESIGN_EXPIRY", 10*time.Minute),
		},
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if len(c.SessionSecret) < 32 {
		return nil, fmt.Errorf("SESSION_SECRET must be at least 32 bytes")
	}
	// Changing this invalidates every stored password, so refuse to run with a
	// default rather than silently locking everyone out later.
	if c.PasswordPepper == "" {
		return nil, fmt.Errorf("PASSWORD_PEPPER is required")
	}
	return c, nil
}

func (c *Config) IsProduction() bool { return strings.EqualFold(c.AppEnv, "production") }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil {
		return v
	}
	return def
}
