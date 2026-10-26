package cli

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
)

func ConfigCmd(args []string) int {
	if len(args) == 0 {
		return configShow()
	}
	switch args[0] {
	case "show", "get":
		return configShow()
	case "set-url":
		if len(args) < 2 {
			cliui.Error(os.Stderr, "missing URL argument", "Usage: dftstream config set-url <convex-url>")
			return 2
		}
		return configSetURL(args[1])
	case "-h", "--help", "help":
		configUsage()
		return 0
	default:
		cliui.Error(os.Stderr, fmt.Sprintf("unknown config subcommand %q", args[0]), "Run `dftstream config --help` for usage.")
		return 2
	}
}

func configShow() int {
	path := configFilePath()
	cfg, err := loadConfigFile("")

	cliui.Title(os.Stderr, "dftstream config")
	fmt.Fprintf(os.Stderr, "config file:  %s\n", path)
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("could not load config: %v", err), "")
	}

	if cfg.ConvexURL != "" {
		fmt.Fprintf(os.Stderr, "convex url:   %s\n", cfg.ConvexURL)
	} else {
		fmt.Fprintf(os.Stderr, "convex url:   (not set, using default)\n")
	}

	resolved := resolveTrackerURL("")
	fmt.Fprintf(os.Stderr, "tracker url:  %s\n", resolved)
	warnPlaintextBackendURL(strings.TrimPrefix(resolved, "convex+"))

	if envURL := os.Getenv("DFTSTREAM_TRACKER_URL"); envURL != "" {
		fmt.Fprintf(os.Stderr, "\nnote: DFTSTREAM_TRACKER_URL is set in environment (%s)\n", envURL)
		fmt.Fprintf(os.Stderr, "      environment overrides the config file.\n")
	}
	if envURL := os.Getenv("DFTSTREAM_CONVEX_URL"); envURL != "" {
		fmt.Fprintf(os.Stderr, "\nnote: DFTSTREAM_CONVEX_URL is set in environment (%s)\n", envURL)
		fmt.Fprintf(os.Stderr, "      environment overrides the config file for `dftstream ui`.\n")
	}

	return 0
}

func configSetURL(rawURL string) int {
	url := strings.TrimSpace(rawURL)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		cliui.Error(os.Stderr, "URL must start with http:// or https://", "Example: dftstream config set-url http://your-server:16767")
		return 2
	}

	cfg, err := loadConfigFile("")
	if err != nil {
		cfg = appConfig{}
	}
	cfg.ConvexURL = url

	if err := saveConfigFile(cfg); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not write config: %v", err), "Check directory permissions.")
		return 1
	}

	cliui.Success(os.Stderr, fmt.Sprintf("config updated: convexUrl = %s", url))
	fmt.Fprintf(os.Stderr, "config file:  %s\n", configFilePath())
	fmt.Fprintf(os.Stderr, "tracker url:  convex+%s\n", url)
	warnPlaintextBackendURL(url)
	return 0
}

// warnPlaintextBackendURL prints a warning when the backend URL is
// plain http:// to a non-loopback host: every authenticated request
// sends the login token as `Authorization: Bearer ...`, readable by
// anyone on the network path. Loopback never leaves the machine, so a
// local dev backend (http://127.0.0.1:3210) stays quiet.
func warnPlaintextBackendURL(rawURL string) {
	if !isPlaintextRemoteURL(rawURL) {
		return
	}
	cliui.Warning(os.Stderr,
		fmt.Sprintf("backend URL %s uses plain http:// to a non-local host: login tokens travel unencrypted", rawURL),
		"Use https:// for any backend reached over a network.")
}

// isPlaintextRemoteURL reports whether rawURL is http:// to a host other
// than localhost/127.0.0.1/::1.
func isPlaintextRemoteURL(rawURL string) bool {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Scheme != "http" {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return false
	}
	ip := net.ParseIP(host)
	return ip == nil || !ip.IsLoopback()
}

func configUsage() {
	cliui.Title(os.Stderr, "dftstream config - view and update configuration")
	fmt.Fprintln(os.Stderr, `
Usage:
  dftstream config                    Show current configuration
  dftstream config show               Show current configuration
  dftstream config set-url <url>      Set the Convex backend URL

Examples:
  # Switch to a Docker-hosted backend
  dftstream config set-url http://your-server:16767

  # Switch to Convex cloud
  dftstream config set-url https://your-deployment.convex.cloud

  # Switch back to local
  dftstream config set-url http://127.0.0.1:3210

The URL is saved to ~/.config/dftstream/config.json and used by
all subcommands (run, ui, list, import).`)
}
