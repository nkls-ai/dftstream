package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/nkls-ai/dftstream/internal/fsutil"
)

type appConfig struct {
	ConvexURL      string `json:"convexUrl"`
	Addr           string `json:"addr,omitempty"`
	ErrorReportURL string `json:"errorReportUrl,omitempty"`
	// SPMethod is the group's default high-level single-point method line
	// for `dftstream next sp` (the '!' keywords, without the '!').
	SPMethod string `json:"spMethod,omitempty"`
}

func defaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "dftstream", "config.json")
}

func loadConfigFile(explicit string) (appConfig, error) {
	path := explicit
	if path == "" {
		path = configFilePath()
	}
	return fsutil.LoadJSON[appConfig](path)
}

func saveConfigFile(cfg appConfig) error {
	path := configFilePath()
	if path == "" {
		return errors.New("cannot determine config path")
	}
	// 0644: config carries no secrets (just the deployment URL).
	return fsutil.SaveJSONAtomic(path, cfg, 0o644)
}

func configFilePath() string {
	if p := os.Getenv("DFTSTREAM_UI_CONFIG"); p != "" {
		return p
	}
	return defaultConfigPath()
}

func resolveTrackerURL(flagVal string) string {
	if v := resolve(flagVal, "DFTSTREAM_TRACKER_URL", ""); v != "" {
		return v
	}
	cfg, err := loadConfigFile("")
	if err == nil && cfg.ConvexURL != "" {
		scheme := "convex+"
		if strings.HasPrefix(cfg.ConvexURL, "convex+") {
			scheme = ""
		}
		return scheme + cfg.ConvexURL
	}
	return defaultTrackerURL
}
