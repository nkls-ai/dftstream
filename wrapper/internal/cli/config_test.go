package cli

import "testing"

// Bearer tokens ride every tracker request as an Authorization header, so
// a plain-http backend on a real network means credentials in cleartext.
// Loopback backends (the default local dev flow) must stay quiet.
func TestIsPlaintextRemoteURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"http://chem-server.example:16767", true},
		{"http://10.0.0.5:3210", true},
		{"http://chem-server.example", true},
		{"http://127.0.0.1:3210", false},
		{"http://localhost:3210", false},
		{"http://[::1]:3210", false},
		{"https://your-deployment.convex.cloud", false},
		{"https://chem-server.example", false},
		{"  http://chem-server.example  ", true},
		{"not a url", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := isPlaintextRemoteURL(tc.url); got != tc.want {
			t.Errorf("isPlaintextRemoteURL(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}
