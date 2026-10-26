package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/inputlint"
	"github.com/nkls-ai/dftstream/internal/sysinfo"
)

// LintCmd implements `dftstream lint <input.inp>`: pre-flight checks an
// ORCA input for queue-time-wasting mistakes. Exit codes: 0 clean (or
// warnings only), 1 at least one error-severity finding, 2 usage error.
func LintCmd(args []string) int {
	fs := flag.NewFlagSet("lint", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	strict := fs.Bool("strict", false, "exit non-zero on warnings too")
	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream lint")
		fmt.Fprintf(os.Stderr, `
Usage:
  dftstream lint [flags] <inputfile>

Checks the input for mistakes that waste queue time: impossible
charge/multiplicity, memory requests past this machine's RAM, missing
coordinate files, and likely keyword typos.

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		cliui.Error(os.Stderr, "expected exactly one input file", "Example: dftstream lint water.inp")
		fs.Usage()
		return 2
	}

	inputPath, err := filepath.Abs(fs.Arg(0))
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not resolve %q: %v", fs.Arg(0), err), "")
		return 2
	}
	text, err := os.ReadFile(inputPath)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("read input: %v", err), "")
		return 2
	}

	findings := inputlint.Lint(string(text), inputlint.Options{
		Dir:        filepath.Dir(inputPath),
		TotalRAMMB: sysinfo.TotalRAMMB(),
	})
	printLintFindings(findings)
	if len(findings) == 0 {
		cliui.Success(os.Stderr, "input looks good")
	}
	if inputlint.HasErrors(findings) {
		return 1
	}
	if *strict {
		for _, f := range findings {
			if f.Severity == inputlint.SeverityWarn {
				return 1
			}
		}
	}
	return 0
}

func printLintFindings(findings []inputlint.Finding) {
	for _, f := range findings {
		msg := fmt.Sprintf("[%s] %s", f.Code, f.Message)
		switch f.Severity {
		case inputlint.SeverityError:
			cliui.Error(os.Stderr, msg, "")
		case inputlint.SeverityWarn:
			cliui.Warning(os.Stderr, msg, "")
		default:
			cliui.Hint(os.Stderr, msg)
		}
	}
}
