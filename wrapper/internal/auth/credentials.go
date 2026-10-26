package auth

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/nkls-ai/dftstream/internal/fsutil"
)

// Method records how stored credentials were obtained; it selects the
// refresh exchange used on a 401.
type Method string

const (
	// MethodBrowserLink is the DFTStream CLI token (convex-auth and Clerk).
	MethodBrowserLink Method = "browser-link"
	// MethodPassword is the legacy convex-auth direct grant (no refresh).
	MethodPassword Method = "password"
)

// Environment variables the credential layer reads.
const (
	// EnvMachineToken carries an org-scoped machine token (`ost_…`). It lives
	// in the environment only — never written to disk, printed or logged.
	EnvMachineToken = "DFTSTREAM_TOKEN"
	// EnvCredentialsPath overrides the credentials.json location.
	EnvCredentialsPath = "DFTSTREAM_CREDENTIALS"
	// EnvOrg names the default organization.
	EnvOrg = "DFTSTREAM_ORG"
	// EnvSiteURL overrides the Convex site origin for HTTP actions.
	EnvSiteURL = "DFTSTREAM_CONVEX_SITE_URL"
)

// credentialsMode is the only mode credentials.json may have: it holds
// bearer tokens.
const credentialsMode os.FileMode = 0o600

// Credentials is the content of credentials.json written by `dftstream
// login`. The access token is short-lived; the refresh token rotates.
type Credentials struct {
	Method       Method `json:"method"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	// Default org for `dftstream run` when --org is not passed.
	OrgSlug string `json:"orgSlug,omitempty"`
	OrgID   string `json:"orgId,omitempty"`
}

// CredentialsPath is where credentials.json lives ("" if undeterminable).
func CredentialsPath() string {
	if p := os.Getenv(EnvCredentialsPath); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "dftstream", "credentials.json")
}

// permWarnOut receives the loose-permissions warning; a var for tests.
var permWarnOut io.Writer = os.Stderr

var permWarnOnce sync.Once

// LoadCredentials reads credentials.json. A missing file returns the zero
// value, so unauthenticated local flows keep working. A file readable by
// group/other (e.g. written by an old version or copied around) triggers a
// one-time warning: it carries bearer tokens.
func LoadCredentials() (Credentials, error) {
	return loadCredentialsAt(CredentialsPath())
}

func loadCredentialsAt(path string) (Credentials, error) {
	c, err := fsutil.LoadJSON[Credentials](path)
	if err != nil {
		return c, err
	}
	warnLoosePerms(path)
	return c, nil
}

func warnLoosePerms(path string) {
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		// Missing file is the normal logged-out state; anything else was
		// already surfaced by the read that preceded this.
		return
	}
	if info.Mode().Perm()&0o077 == 0 {
		return
	}
	permWarnOnce.Do(func() {
		fmt.Fprintf(permWarnOut, "warning: %s is readable by other users (mode %o) and holds bearer tokens. Fix: chmod 600 %s\n", path, info.Mode().Perm(), path) //nolint:errcheck — write to stderr is best-effort
	})
}

// SaveCredentials writes credentials.json atomically at mode 0600.
func SaveCredentials(c Credentials) error {
	return saveCredentialsAt(CredentialsPath(), c)
}

func saveCredentialsAt(path string, c Credentials) error {
	if path == "" {
		return errors.New("cannot determine credentials path")
	}
	return fsutil.SaveJSONAtomic(path, c, credentialsMode)
}

// ClearCredentials removes credentials.json (logout). Missing is a no-op.
func ClearCredentials() error {
	path := CredentialsPath()
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
