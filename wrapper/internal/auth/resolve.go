package auth

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// Resolve picks the credential source for a backend at convexURL. It is the
// ONLY place a source is selected, in this precedence:
//
//  1. DFTSTREAM_TOKEN (machine token) — batch jobs must behave identically
//     whether or not some human's credentials.json exists on the host;
//  2. credentials.json from `dftstream login`;
//  3. none — local unauthenticated flows keep working.
//
// The organization is --org (orgFlag), then DFTSTREAM_ORG, then the
// source's own default (the machine token's bound org / the stored login's).
func Resolve(convexURL, orgFlag string) (Session, error) {
	site := SiteURL(convexURL)
	if secret := MachineTokenFromEnv(); secret != "" {
		ctx, cancel := context.WithTimeout(context.Background(), MachineTokenExchangeTimeout)
		defer cancel()
		src, tokenOrg, err := NewMachineToken(ctx, site, secret)
		if err != nil {
			return Session{}, err
		}
		return Session{Org: pickOrg(orgFlag, tokenOrg), Source: src}, nil
	}
	path := CredentialsPath()
	creds, err := loadCredentialsAt(path)
	if err != nil {
		return Session{}, fmt.Errorf("read credentials: %w", err)
	}
	org := pickOrg(orgFlag, creds.OrgID)
	if creds.AccessToken == "" {
		// Not logged in: no bearer, but still honor an explicit org so the
		// request reaches the right place if auth is off.
		return Session{Org: org, Source: None{}}, nil
	}
	return Session{Org: org, Source: NewStoredLogin(site, path, creds)}, nil
}

// MachineTokenFromEnv returns the trimmed DFTSTREAM_TOKEN ("" if unset).
func MachineTokenFromEnv() string {
	return strings.TrimSpace(os.Getenv(EnvMachineToken))
}

// pickOrg applies --org > DFTSTREAM_ORG > the source's default.
func pickOrg(orgFlag, sourceDefault string) string {
	if orgFlag != "" {
		return orgFlag
	}
	if env := strings.TrimSpace(os.Getenv(EnvOrg)); env != "" {
		return env
	}
	return sourceDefault
}

// ResolveFixHint is the fix line to print when Resolve fails.
func ResolveFixHint() string {
	if MachineTokenFromEnv() != "" {
		return MachineTokenFixHint
	}
	return "Run `dftstream login` to authenticate, or remove ~/.config/dftstream/credentials.json."
}
