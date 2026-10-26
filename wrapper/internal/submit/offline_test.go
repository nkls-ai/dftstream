package submit

import (
	"strings"
	"testing"
)

// TestOfflineClusterScriptJournalsAndChainsSync: a cluster whose compute
// nodes cannot reach the backend must (a) run the wrapper in offline mode so
// no walltime is spent on connection timeouts, (b) chain a best-effort
// `dftstream sync` after ORCA, and (c) still exit with ORCA's own code.
func TestOfflineClusterScriptJournalsAndChainsSync(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.ComputeNodesOffline = true
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script
	for _, want := range []string{
		"export DFTSTREAM_OFFLINE=1",
		"/path/to/dftstream sync ||",
		"ORCA_EXIT=$?",
		`exit "$ORCA_EXIT"`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("offline-cluster script is missing %q\n%s", want, script)
		}
	}
	// The offline export must come before the run line, the sync after it.
	runIdx := strings.Index(script, "dftstream run ")
	if off := strings.Index(script, "export DFTSTREAM_OFFLINE=1"); off == -1 || off > runIdx {
		t.Errorf("DFTSTREAM_OFFLINE export must precede the run line\n%s", script)
	}
	if syncIdx := strings.Index(script, "dftstream sync"); syncIdx < runIdx {
		t.Errorf("sync chain must follow the run line\n%s", script)
	}
}

func TestOfflineClusterArrayScriptChainsSync(t *testing.T) {
	req := testRequest(t, map[string]string{"a.inp": realInput, "b.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.ComputeNodesOffline = true
	req.Array = true
	req.ArrayName = "batchjob"
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script
	if !strings.Contains(script, "export DFTSTREAM_OFFLINE=1") || !strings.Contains(script, "dftstream sync ||") {
		t.Errorf("array script lacks the offline spool chain\n%s", script)
	}
}

// The default stays exactly as before: no offline export, no sync chain, no
// exit-code plumbing — existing clusters see byte-identical scripts.
func TestOnlineClusterScriptIsUnchanged(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script
	for _, unwanted := range []string{"DFTSTREAM_OFFLINE", "dftstream sync", "ORCA_EXIT"} {
		if strings.Contains(script, unwanted) {
			t.Errorf("online-cluster script unexpectedly contains %q\n%s", unwanted, script)
		}
	}
}

// A non-streamed job on an offline cluster needs no spool handling at all.
func TestOfflineClusterWithoutStreamStaysPlain(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.ComputeNodesOffline = true
	req.Stream = false
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if strings.Contains(jobs[0].Script, "DFTSTREAM_OFFLINE") {
		t.Errorf("unstreamed job must not export DFTSTREAM_OFFLINE\n%s", jobs[0].Script)
	}
}

func TestConfigParsesComputeNodesOffline(t *testing.T) {
	yaml := strings.Replace(string(DefaultConfigYAML()),
		"    default_profile: cpu", "    compute_nodes_offline: true\n    default_profile: cpu", 1)
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	cl, err := cfg.ClusterNamed("")
	if err != nil {
		t.Fatal(err)
	}
	if !cl.ComputeNodesOffline {
		t.Fatal("compute_nodes_offline: true was not parsed")
	}
	// And the shipped default remains false.
	def, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatal(err)
	}
	defCl, err := def.ClusterNamed("")
	if err != nil {
		t.Fatal(err)
	}
	if defCl.ComputeNodesOffline {
		t.Fatal("shipped default must be online")
	}
}
