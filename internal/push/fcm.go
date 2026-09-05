// Package push delivers a notification to a phone through Firebase Cloud
// Messaging, using the HTTP v1 API and nothing but the standard library.
//
// A service account JSON, as downloaded from the Firebase console, is the
// whole configuration. Its private key signs a JWT, the JWT buys an access
// token, and the token authorises a send. No Google SDK: that is one
// dependency for two HTTP calls, and the JWT is nine lines.
package push

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ErrUnregistered says the token no longer names an installed app: the app
// was removed, or Firebase rotated the token. The row should be deleted.
var ErrUnregistered = errors.New("push: token is not registered")

// Message is what the phone is handed. Data-only: the app draws the
// notification itself, so it looks the same whether the app is open or not,
// and the link is opened inside the app rather than in a browser.
type Message struct {
	Title string
	Body  string
	Link  string
	Kind  string
	ID    string
}

type FCM struct {
	projectID string
	email     string
	tokenURI  string
	key       *rsa.PrivateKey
	client    *http.Client

	mu      sync.Mutex
	access  string
	expires time.Time
}

// New reads a service-account file. An empty path is "push is not configured"
// and returns nil, nil so the caller can leave the pump switched off.
func New(path string) (*FCM, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("push: read service account: %w", err)
	}
	var sa struct {
		ProjectID  string `json:"project_id"`
		Email      string `json:"client_email"`
		PrivateKey string `json:"private_key"`
		TokenURI   string `json:"token_uri"`
	}
	if err := json.Unmarshal(raw, &sa); err != nil {
		return nil, fmt.Errorf("push: service account is not JSON: %w", err)
	}
	if sa.ProjectID == "" || sa.Email == "" || sa.PrivateKey == "" {
		return nil, errors.New("push: service account lacks project_id, client_email or private_key")
	}
	block, _ := pem.Decode([]byte(sa.PrivateKey))
	if block == nil {
		return nil, errors.New("push: private_key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("push: private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("push: private key is not RSA")
	}
	if sa.TokenURI == "" {
		sa.TokenURI = "https://oauth2.googleapis.com/token"
	}
	return &FCM{
		projectID: sa.ProjectID, email: sa.Email, tokenURI: sa.TokenURI, key: key,
		client: &http.Client{Timeout: 15 * time.Second},
	}, nil
}

// Send hands one message to one device.
func (f *FCM) Send(ctx context.Context, token string, m Message) error {
	access, err := f.accessToken(ctx)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"message": map[string]any{
			"token": token,
			"data": map[string]string{
				"title": m.Title, "body": m.Body, "link": m.Link, "kind": m.Kind, "id": m.ID,
			},
			"android": map[string]any{"priority": "high"},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://fcm.googleapis.com/v1/projects/"+f.projectID+"/messages:send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	text, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	// 404 is FCM's answer for a token it no longer knows; UNREGISTERED is
	// the same fact spelled out in the body.
	if res.StatusCode == http.StatusNotFound || strings.Contains(string(text), "UNREGISTERED") {
		return ErrUnregistered
	}
	return fmt.Errorf("push: fcm %d: %s", res.StatusCode, strings.TrimSpace(string(text)))
}

// accessToken is cached until a minute before it expires.
func (f *FCM) accessToken(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.access != "" && time.Until(f.expires) > time.Minute {
		return f.access, nil
	}
	now := time.Now()
	claims, _ := json.Marshal(map[string]any{
		"iss":   f.email,
		"scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud":   f.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString(claims)
	sum := sha256.Sum256([]byte(header + "." + payload))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	jwt := header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(sig)

	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {jwt},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("push: token response: %w", err)
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("push: no access token: %s %s", out.Error, out.Description)
	}
	f.access = out.AccessToken
	f.expires = now.Add(time.Duration(out.ExpiresIn) * time.Second)
	return f.access, nil
}
