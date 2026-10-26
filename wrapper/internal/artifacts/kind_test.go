package artifacts

import (
	"encoding/json"
	"testing"
)

// Kind crosses the Convex wire format; the typed constant must marshal
// exactly as the plain string it replaced.
func TestKindMarshalsAsPlainString(t *testing.T) {
	cases := map[Kind]string{
		KindInput: `"input"`, KindStdout: `"stdout"`, KindOutput: `"output"`,
		KindProperty: `"property"`, KindCube: `"cube"`, KindGoatMinimum: `"goat_minimum"`,
		KindGoatEnsemble: `"goat_ensemble"`, KindVibMode: `"vibmode"`,
		KindTrajectory: `"trj"`, KindOther: `"other"`,
	}
	for k, want := range cases {
		got, err := json.Marshal(map[string]any{"kind": k})
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != `{"kind":`+want+`}` {
			t.Errorf("Kind %q marshalled as %s, want kind %s", k, got, want)
		}
	}
}
