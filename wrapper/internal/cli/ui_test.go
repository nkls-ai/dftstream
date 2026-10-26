package cli

import "testing"

func TestWithPortRewritesPort(t *testing.T) {
	got, err := withPort("127.0.0.1:3000", "3001")
	if err != nil {
		t.Fatalf("withPort returned error: %v", err)
	}
	if got != "127.0.0.1:3001" {
		t.Fatalf("withPort() = %q, want %q", got, "127.0.0.1:3001")
	}
}

func TestWithPortKeepsHostOnlyAddress(t *testing.T) {
	got, err := withPort("0.0.0.0", "8080")
	if err != nil {
		t.Fatalf("withPort returned error: %v", err)
	}
	if got != "0.0.0.0:8080" {
		t.Fatalf("withPort() = %q, want %q", got, "0.0.0.0:8080")
	}
}

func TestWithPortRejectsInvalidPort(t *testing.T) {
	for _, port := range []string{"0", "65536", "abc"} {
		if _, err := withPort("127.0.0.1:3000", port); err == nil {
			t.Fatalf("withPort(_, %q) returned nil error", port)
		}
	}
}

// /api/local-file must default OFF the moment an auth provider is
// configured: it has no auth of its own, so a multi-user deployment
// would otherwise expose every user's files to anyone with the URL.
func TestResolveLocalFiles(t *testing.T) {
	cases := []struct {
		name            string
		flagOn, flagOff bool
		env             string
		provider        uiAuthProvider
		want            bool
	}{
		{name: "default single-user: on", want: true},
		{name: "auth provider: off by default", provider: "convex", want: false},
		{name: "auth provider + --local-files: on", provider: "clerk", flagOn: true, want: true},
		{name: "auth provider + env=1: on", provider: "convex", env: "1", want: true},
		{name: "auth provider + env=true: on", provider: "convex", env: "true", want: true},
		{name: "--no-local-files wins over --local-files", flagOn: true, flagOff: true, want: false},
		{name: "--no-local-files wins over env=1", flagOff: true, env: "1", want: false},
		{name: "env=0 disables without auth", env: "0", want: false},
		{name: "env=false disables without auth", env: "false", want: false},
		{name: "env=0 disables with auth and flag", provider: "convex", flagOn: false, env: "0", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveLocalFiles(tc.flagOn, tc.flagOff, tc.env, tc.provider); got != tc.want {
				t.Errorf("resolveLocalFiles(%v, %v, %q, %q) = %v, want %v",
					tc.flagOn, tc.flagOff, tc.env, tc.provider, got, tc.want)
			}
		})
	}
}

func TestResolveUIOptionsDisablesLocalFilesUnderAuthProvider(t *testing.T) {
	t.Setenv("DFTSTREAM_UI_LOCAL_FILES", "")
	t.Setenv("DFTSTREAM_AUTH_PROVIDER", "")

	f, err := parseUIFlags([]string{"--auth-provider", "convex"})
	if err != nil {
		t.Fatalf("parseUIFlags: %v", err)
	}
	opts, err := resolveUIOptions(f)
	if err != nil {
		t.Fatalf("resolveUIOptions: %v", err)
	}
	if opts.localFiles {
		t.Error("localFiles = true with --auth-provider convex, want false")
	}

	f, err = parseUIFlags([]string{"--auth-provider", "convex", "--local-files"})
	if err != nil {
		t.Fatalf("parseUIFlags: %v", err)
	}
	opts, err = resolveUIOptions(f)
	if err != nil {
		t.Fatalf("resolveUIOptions: %v", err)
	}
	if !opts.localFiles {
		t.Error("localFiles = false with explicit --local-files, want true")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:3000": true,
		"localhost:3000": true,
		"[::1]:3000":     true,
		"0.0.0.0:3000":   false,
		"192.168.1.5:80": false,
		"chem-ws:3000":   false,
	} {
		if got := isLoopbackHost(addr); got != want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestParseUIAuthProvider(t *testing.T) {
	cases := []struct {
		raw, key string
		want     uiAuthProvider
		wantErr  bool
	}{
		{raw: "", want: uiAuthNone},
		{raw: "convex", want: uiAuthConvex},
		{raw: " Convex ", want: uiAuthConvex},
		{raw: "clerk", key: "pk_test_x", want: uiAuthClerk},
		{raw: "clerk", wantErr: true},
		{raw: "auth0", wantErr: true},
		{raw: "convex-auth", wantErr: true},
	}
	for _, tc := range cases {
		got, err := parseUIAuthProvider(tc.raw, tc.key)
		if (err != nil) != tc.wantErr || got != tc.want {
			t.Errorf("parseUIAuthProvider(%q, %q) = (%q, %v), want (%q, err=%v)", tc.raw, tc.key, got, err, tc.want, tc.wantErr)
		}
	}
}

func TestResolveUIOptionsRejectsUnknownProvider(t *testing.T) {
	t.Setenv("DFTSTREAM_AUTH_PROVIDER", "")
	t.Setenv("DFTSTREAM_CLERK_PUBLISHABLE_KEY", "")
	f, err := parseUIFlags([]string{"--auth-provider", "clerck"})
	if err != nil {
		t.Fatalf("parseUIFlags: %v", err)
	}
	if _, err := resolveUIOptions(f); exitCodeFor(err) != 2 {
		t.Errorf("resolveUIOptions err = %v, want exit status 2", err)
	}
}
