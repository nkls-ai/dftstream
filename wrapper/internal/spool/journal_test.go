package spool

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

func testWriter(t *testing.T) *Writer {
	t.Helper()
	w, err := NewWriter(WriterConfig{
		Root:           t.TempDir(),
		RunName:        "h2o-opt",
		ExperimentName: "solvation",
		Mode:           ModeOffline,
	})
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	return w
}

func TestJournalRoundTrip(t *testing.T) {
	w := testWriter(t)

	ev := []tracker.Event{{Seq: 1, TS: time.Unix(1700000000, 0).UTC(), Kind: "scf_iter", Payload: map[string]any{"energy": -2.5}}}
	charge := 0
	rc := tracker.RunCreate{ExperimentID: "spool-exp-1", Name: "h2o-opt", NProcs: 4, Charge: &charge}
	if err := w.Append(OpEnsureExperiment, Payload{OrgID: "org1", Name: "solvation", LocalID: "spool-exp-1"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Append(OpCreateRun, Payload{LocalID: "spool-run-1", Run: &rc}); err != nil {
		t.Fatal(err)
	}
	if err := w.Append(OpAppendEvents, Payload{RunID: "spool-run-1", Events: ev}); err != nil {
		t.Fatal(err)
	}
	if err := w.Append(OpAppendGeometry, Payload{RunID: "spool-run-1", Cycle: 2, XYZ: "2\n\nH 0 0 0\nH 0 0 1\n"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	j, err := Load(w.Dir())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if j.Tail != nil {
		t.Fatalf("unexpected tail error: %v", j.Tail)
	}
	if j.Header.Format != FormatName || j.Header.Version != FormatVersion || j.Header.RunName != "h2o-opt" {
		t.Fatalf("header mismatch: %+v", j.Header)
	}
	if len(j.Ops) != 4 {
		t.Fatalf("ops = %d, want 4", len(j.Ops))
	}
	for i, rec := range j.Ops {
		if rec.Seq != int64(i+1) {
			t.Fatalf("op %d has seq %d", i, rec.Seq)
		}
		if want := j.Header.JournalID + ":" + itoa(rec.Seq); rec.Key != want {
			t.Fatalf("op %d key = %q, want %q", i, rec.Key, want)
		}
	}
	if j.Ops[1].Op != OpCreateRun || j.Ops[1].Payload.Run == nil {
		t.Fatalf("create_run payload lost: %+v", j.Ops[1])
	}
	got := j.Ops[1].Payload.Run
	if got.NProcs != 4 || got.Charge == nil || *got.Charge != 0 || got.ExperimentID != "spool-exp-1" {
		t.Fatalf("run payload mismatch: %+v", got)
	}
	if p := j.Ops[2].Payload; len(p.Events) != 1 || p.Events[0].Kind != "scf_iter" ||
		p.Events[0].Payload["energy"] != -2.5 || !p.Events[0].TS.Equal(ev[0].TS) {
		t.Fatalf("events payload mismatch: %+v", j.Ops[2].Payload)
	}
	if p := j.Ops[3].Payload; p.Cycle != 2 || !strings.Contains(p.XYZ, "H 0 0 1") {
		t.Fatalf("geometry payload mismatch: %+v", p)
	}
}

func TestJournalCorruptTailKeepsValidPrefix(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(path string) error
		wantOps int
	}{
		{
			name: "truncated mid-record",
			mutate: func(path string) error {
				b, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				return os.WriteFile(path, b[:len(b)-25], 0o600)
			},
			wantOps: 2,
		},
		{
			name: "garbage appended",
			mutate: func(path string) error {
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
				if err != nil {
					return err
				}
				if _, err := f.WriteString("\x00\xffnot json at all\n"); err != nil {
					if cerr := f.Close(); cerr != nil {
						return cerr
					}
					return err
				}
				return f.Close()
			},
			wantOps: 3,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := testWriter(t)
			for i := 1; i <= 3; i++ {
				if err := w.Append(OpAppendGeometry, Payload{RunID: "spool-run-1", Cycle: i, XYZ: "x"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			if err := tc.mutate(JournalPath(w.Dir())); err != nil {
				t.Fatalf("mutate: %v", err)
			}
			j, err := Load(w.Dir())
			if err != nil {
				t.Fatalf("Load after damage: %v", err)
			}
			if j.Tail == nil {
				t.Fatal("tail damage was not reported")
			}
			if len(j.Ops) != tc.wantOps {
				t.Fatalf("ops = %d, want %d (tail: %v)", len(j.Ops), tc.wantOps, j.Tail)
			}
			for i, rec := range j.Ops {
				if rec.Seq != int64(i+1) {
					t.Fatalf("prefix op %d has seq %d", i, rec.Seq)
				}
			}
		})
	}
}

func TestLoadRejectsNewerFormat(t *testing.T) {
	w := testWriter(t)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	path := JournalPath(w.Dir())
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	newer := strings.Replace(string(b), `{"v":1,`, `{"v":99,`, 1)
	if newer == string(b) {
		t.Fatal("could not bump header version in fixture")
	}
	if err := os.WriteFile(path, []byte(newer), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(w.Dir()); err == nil || !strings.Contains(err.Error(), "upgrade dftstream") {
		t.Fatalf("Load of newer format = %v, want upgrade error", err)
	}
}

func TestBlobRoundTripAndCorruption(t *testing.T) {
	w := testWriter(t)
	body := []byte("FINAL SINGLE POINT ENERGY      -1.0\n")
	ref, err := w.WriteBlob("h2.out", body)
	if err != nil {
		t.Fatalf("WriteBlob: %v", err)
	}
	if err := w.Append(OpSetArtifacts, Payload{RunID: "spool-run-1", Artifacts: []ArtifactRec{{Name: "h2.out", Blob: &ref}}}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	j, err := Load(w.Dir())
	if err != nil {
		t.Fatal(err)
	}
	got, err := j.LoadBlob(*j.Ops[0].Payload.Artifacts[0].Blob)
	if err != nil {
		t.Fatalf("LoadBlob: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("blob body mismatch: %q", got)
	}

	// Flip a byte: the digest check must refuse to hand the body back.
	blobPath := filepath.Join(j.Dir, ref.File)
	raw, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatal(err)
	}
	raw[0] ^= 0xff
	if err := os.WriteFile(blobPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := j.LoadBlob(ref); err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("LoadBlob on corrupt blob = %v, want digest error", err)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestLoadAcceptsPreRenameFormatName(t *testing.T) {
	w := testWriter(t)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	path := JournalPath(w.Dir())
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Replace(string(b), `"`+FormatName+`"`, `"`+legacyFormatName+`"`, 1)
	if legacy == string(b) {
		t.Fatal("could not rewrite header format name in fixture")
	}
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(w.Dir()); err != nil {
		t.Fatalf("Load of a pre-rename journal = %v, want success", err)
	}
}
