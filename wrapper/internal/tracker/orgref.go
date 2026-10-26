package tracker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// fnOrganizationsMyOrgs lists the caller's organizations. A CLI or machine
// token only ever sees the one org it is bound to.
const fnOrganizationsMyOrgs = "organizations:myOrgs"

// ErrOrgNotAvailable marks an org reference the credential definitively
// cannot use (as opposed to a lookup that failed in transit).
var ErrOrgNotAvailable = errors.New("organization not available to this credential")

// ResolveOrg is resolveOrg for callers that want to fail before doing any
// work (`dftstream run` checks it before starting ORCA). Errors wrapping
// ErrOrgNotAvailable are definitive; anything else is transport.
func (c *ConvexHTTPTracker) ResolveOrg(ctx context.Context, ref string) (string, error) {
	return c.resolveOrg(ctx, ref)
}

// orgListing is one row of organizations:myOrgs.
type orgListing struct {
	OrganizationID string `json:"organizationId"`
	Slug           string `json:"slug"`
}

// resolveOrg maps the user's organization reference (--org /
// DFTSTREAM_ORG: a slug or an id) to the id every backend validator takes.
// It used to be sent verbatim, so the documented `--org <slug>` failed
// argument validation on the first mutation and the run fell back to
// untracked.
//
// Resolution is against the caller's own orgs, once per reference per
// tracker. A reference matching none of them is an error naming what this
// credential can use — except when the caller has no orgs at all (auth off,
// or not logged in), where the reference goes through unchanged and the
// backend decides, exactly as before.
func (c *ConvexHTTPTracker) resolveOrg(ctx context.Context, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", nil
	}
	c.orgMu.Lock()
	defer c.orgMu.Unlock()
	if id, ok := c.orgIDs[ref]; ok {
		return id, nil
	}
	raw, err := c.query(ctx, fnOrganizationsMyOrgs, map[string]any{})
	if err != nil {
		return "", fmt.Errorf("resolve organization %q: %w", ref, err)
	}
	var orgs []orgListing
	if err := json.Unmarshal(raw, &orgs); err != nil {
		return "", fmt.Errorf("resolve organization %q: decode %s: %w", ref, fnOrganizationsMyOrgs, err)
	}
	id, err := matchOrgRef(ref, orgs)
	if err != nil {
		return "", err
	}
	if c.orgIDs == nil {
		c.orgIDs = map[string]string{}
	}
	c.orgIDs[ref] = id
	return id, nil
}

// matchOrgRef is resolveOrg's pure half.
func matchOrgRef(ref string, orgs []orgListing) (string, error) {
	if len(orgs) == 0 {
		return ref, nil
	}
	for _, o := range orgs {
		if o.OrganizationID == ref || strings.EqualFold(o.Slug, ref) {
			return o.OrganizationID, nil
		}
	}
	slugs := make([]string, 0, len(orgs))
	for _, o := range orgs {
		slugs = append(slugs, o.Slug)
	}
	sort.Strings(slugs)
	return "", fmt.Errorf("%w: %q (it can use: %s)", ErrOrgNotAvailable, ref, strings.Join(slugs, ", "))
}
