// Package telemetry reports anonymous, opt-in run outcomes to an endpoint
// the operator configures. It is off unless BOTH the opt-in switch and an
// endpoint are set, mirroring the UI's ui/src/lib/errorReporting.ts: an
// empty endpoint makes delivery a no-op, and nothing is ever collected
// "just in case".
//
// What may be reported is deliberately tiny and closed: the wrapper build,
// the platform, the ORCA version, the job's run types, and the parser's
// error class. That set answers the only question this exists to answer —
// "which ORCA versions and job types fail, and how" — and nothing else.
//
// What is NEVER reported, by construction rather than by convention:
//
//   - molecules: no geometries, no charges, no multiplicities, no element
//     lists, no input text;
//   - filenames or paths: no input path, no cwd, no run/experiment names;
//   - identity: no hostname, no username, no org, no run id.
//
// Every field is a fixed, typed scalar and each one is validated against a
// conservative allowlist before it leaves the process (see sanitize), so a
// future caller cannot smuggle a path or a molecule through a field that
// happens to be a string.
package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/stringutil"
	"github.com/nkls-ai/dftstream/internal/version"
)

// Env keys. Both are required: an endpoint without the opt-in does
// nothing, and the opt-in without an endpoint has nowhere to go.
const (
	EnvEnabled  = "DFTSTREAM_TELEMETRY"          // "1"/"true" to opt in
	EnvEndpoint = "DFTSTREAM_TELEMETRY_ENDPOINT" // https URL to POST to
)

// deliveryTimeout bounds one report. Telemetry is the last thing that
// should delay a chemist's shell prompt.
const deliveryTimeout = 3 * time.Second

// The allowlists every reported string must match. They are per-field and
// deliberately narrow, shaped after the closed vocabularies they accept —
// inputparse's run types are ALL-CAPS, the parser's error classes are
// lower_snake, and a version is digits and dots. A filename, a path or a
// sentence matches none of them, which is the point: this is the last gate
// before the wire, not a formatting preference.
var (
	// e.g. OPT, FREQ, NEB-TS (inputparse.RunType values)
	safeRunType = regexp.MustCompile(`^[A-Z][A-Z0-9-]{0,23}$`)
	// e.g. scf_not_converged (parser.ErrorClass values)
	safeErrorClass = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
	// e.g. 6.0.1, 5.0.4-rc1
	safeVersion = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$`)
)

// Config is the resolved telemetry setting. The zero value is disabled,
// which is what every install has until someone opts in.
type Config struct {
	Endpoint string
	// Client is the HTTP client used for delivery; nil uses a default with
	// deliveryTimeout. Tests inject their own.
	Client *http.Client
}

// Enabled reports whether anything will actually be sent.
func (c Config) Enabled() bool { return c.Endpoint != "" }

// FromEnv resolves the configuration from the environment. Disabled
// unless the operator both opted in and named an https endpoint — a
// plaintext endpoint is rejected rather than silently downgraded.
func FromEnv() Config {
	if on, ok := stringutil.ParseBool(os.Getenv(EnvEnabled)); !ok || !on {
		return Config{}
	}
	ep := strings.TrimSpace(os.Getenv(EnvEndpoint))
	if !strings.HasPrefix(ep, "https://") {
		return Config{}
	}
	return Config{Endpoint: ep}
}

// Report is one run's outcome. Every field is optional; anything that
// fails validation is dropped rather than sent.
type Report struct {
	// RunTypes are the job kinds the input requested ("OPT", "FREQ", ...).
	RunTypes []string `json:"runTypes,omitempty"`
	// OrcaVersion is ORCA's own version string as it printed it.
	OrcaVersion string `json:"orcaVersion,omitempty"`
	// ErrorClass is the parser's failure classification, empty on success.
	ErrorClass string `json:"errorClass,omitempty"`
	// OK is whether the run finished cleanly.
	OK bool `json:"ok"`

	// Filled in by Send; ignored on input.
	WrapperVersion string `json:"wrapperVersion,omitempty"`
	APIVersion     int    `json:"apiVersion,omitempty"`
	OS             string `json:"os,omitempty"`
	Arch           string `json:"arch,omitempty"`
}

// sanitize drops every field that is not a plain, short, allowlisted
// token. It is the last gate before the wire: if a caller ever routes a
// filename or a molecule into one of these fields, it does not leave the
// process.
func sanitize(r Report) Report {
	out := Report{OK: r.OK}
	if safeVersion.MatchString(r.OrcaVersion) {
		out.OrcaVersion = r.OrcaVersion
	}
	if safeErrorClass.MatchString(r.ErrorClass) {
		out.ErrorClass = r.ErrorClass
	}
	for _, rt := range r.RunTypes {
		if safeRunType.MatchString(rt) {
			out.RunTypes = append(out.RunTypes, rt)
		}
	}
	// Cap the list so a pathological input cannot turn it into a payload.
	if len(out.RunTypes) > 8 {
		out.RunTypes = out.RunTypes[:8]
	}
	return out
}

// Send delivers one report, best-effort. It returns an error only so a
// caller that wants to log at debug level can; a telemetry failure must
// never affect a run's exit code, and Send never blocks longer than
// deliveryTimeout.
func (c Config) Send(ctx context.Context, r Report) error {
	if !c.Enabled() {
		return nil
	}
	payload := sanitize(r)
	payload.WrapperVersion = version.Version
	payload.APIVersion = version.APIVersion
	payload.OS = runtime.GOOS
	payload.Arch = runtime.GOARCH

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, deliveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(sendCtx, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", version.UserAgent())

	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: deliveryTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	// The response body carries nothing we act on; drain-and-close so the
	// connection can be reused, and report a close failure rather than
	// discarding it.
	return resp.Body.Close()
}
