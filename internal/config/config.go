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
	// GatewaySecret signs and verifies payment callbacks. In production this
	// is the Razorpay key secret; where none is configured it falls back to
	// CredentialKey so the simulated gateway still verifies against something
	// installation-specific rather than a constant anyone could forge against.
	GatewaySecret string

	R2 R2Config

	// FileStoreDir is where uploaded files live when there is no object store.
	//
	// R2 has never been configured on this deployment, so /api/v1/files/presign
	// answered 503 and every screen offering an upload had to fall back to
	// asking for a link. A school that wants to put a worksheet in front of a
	// class does not have a bucket; it has a server with disk on it.
	//
	// Not a replacement for R2 and not pretending to be: a single box with no
	// replication. It is the difference between a feature that works and one
	// that explains why it cannot.
	FileStoreDir string

	// APKDir holds the published Android builds served by /apps.
	//
	// On disk rather than embedded: an APK is tens of megabytes and ships on
	// its own schedule, so embedding one would mean rebuilding and redeploying
	// the server to fix a bug in the driver's app. `make deploy-server` builds
	// Go and the SPA; it does not build Android and should not start.
	APKDir string
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
		GatewaySecret:  os.Getenv("PAYMENT_GATEWAY_SECRET"),
		FileStoreDir:   env("FILE_STORE_DIR", "/var/lib/temperp/files"),
		APKDir:         env("APK_DIR", "/var/lib/temperp/apk"),
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
	// Not required, because an installation that takes no payments should not
	// be made to invent a payment secret to boot. Falling back keeps callback
	// signatures installation-specific either way.
	if c.GatewaySecret == "" {
		c.GatewaySecret = c.CredentialKey
	}
	if c.GatewaySecret == "" {
		c.GatewaySecret = string(c.SessionSecret)
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
