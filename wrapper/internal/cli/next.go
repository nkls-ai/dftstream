package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/followup"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/restart"
)

// nextOptions holds the parsed flags and positional targets of
// `dftstream next <kind> <run.out>...`.
type nextOptions struct {
	kind    string
	targets []string
	nimages int
	method  string
	force   bool
	dryRun  bool
}

// NextCmd implements `dftstream next` — generate the next input of the
// TS workflow (NEB-TS, IRC, endpoint opts, high-level SP) from finished
// runs. Source files are only read; outputs are new files.
func NextCmd(args []string) int {
	opts, gen, err := parseNextFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}

	sources := make([]followup.Source, 0, len(opts.targets))
	for _, target := range opts.targets {
		src, err := loadFollowupSource(target)
		if err != nil {
			return exitCodeFor(err)
		}
		sources = append(sources, src)
	}

	res, err := gen.Generate(followup.Request{
		Sources: sources,
		NImages: opts.nimages,
		Method:  resolveSPMethod(opts.method),
		Force:   opts.force,
	})
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "")
		return 1
	}
	for _, w := range res.Warnings {
		cliui.Warning(os.Stderr, w, "")
	}
	return writeFollowupFiles(res.Files, opts)
}

func parseNextFlags(args []string) (nextOptions, followup.Generator, error) {
	if len(args) == 0 || args[0] == "-help" || args[0] == "--help" || args[0] == "help" {
		nextUsage()
		if len(args) == 0 {
			return nextOptions{}, nil, exitStatus(2)
		}
		return nextOptions{}, nil, exitStatus(0)
	}
	kind := args[0]
	gen, ok := followup.Registry[kind]
	if !ok {
		cliui.Error(os.Stderr, fmt.Sprintf("unknown follow-up kind %q", kind),
			"Valid kinds: "+strings.Join(followup.Names, ", "))
		return nextOptions{}, nil, exitStatus(2)
	}

	fs := flag.NewFlagSet("next "+kind, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	nimages := fs.Int("nimages", 8, "number of NEB images (neb-ts)")
	method := fs.String("method", "", "high-level '!' keyword line for the single point (sp)")
	force := fs.Bool("f", false, "override validation refusals and overwrite existing files")
	dryRun := fs.Bool("dry-run", false, "print the generated input(s) to stdout instead of writing")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args[1:]); err != nil {
		return nextOptions{}, nil, exitStatus(2)
	}
	if *help || fs.NArg() != gen.NumSources() {
		nextUsage()
		if *help {
			return nextOptions{}, nil, exitStatus(0)
		}
		cliui.Error(os.Stderr, fmt.Sprintf("`next %s` needs exactly %d run file(s), got %d", kind, gen.NumSources(), fs.NArg()), "")
		return nextOptions{}, nil, exitStatus(2)
	}
	return nextOptions{
		kind:    kind,
		targets: fs.Args(),
		nimages: *nimages,
		method:  *method,
		force:   *force,
		dryRun:  *dryRun,
	}, gen, nil
}

// loadFollowupSource reads one parent run (.out plus sibling .inp,
// accepting either path as the argument) and analyzes it.
func loadFollowupSource(target string) (followup.Source, error) {
	outPath, stem := resolveRestartTarget(target)
	outText, inpText, err := readRestartFiles(outPath, stem)
	if err != nil {
		return followup.Source{}, err
	}
	return followup.Source{
		OutPath:  outPath,
		Stem:     stem,
		Summary:  inputparse.Parse(string(inpText)),
		Analysis: restart.AnalyzeOutput(string(outText)),
	}, nil
}

// resolveSPMethod applies the flag → config-file default chain for the
// sp generator's method line.
func resolveSPMethod(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	cfg, err := loadConfigFile("")
	if err != nil {
		return ""
	}
	return cfg.SPMethod
}

func writeFollowupFiles(files []followup.OutputFile, opts nextOptions) int {
	if opts.dryRun {
		for _, f := range files {
			fmt.Fprintf(os.Stdout, "# ---- %s ----\n%s", filepath.Base(f.Path), f.Content)
		}
		return 0
	}
	if !opts.force {
		for _, f := range files {
			if _, err := os.Stat(f.Path); err == nil {
				cliui.Error(os.Stderr, fmt.Sprintf("%s already exists", f.Path), "Pass -f to overwrite.")
				return 1
			}
		}
	}
	for _, f := range files {
		if err := os.WriteFile(f.Path, []byte(f.Content), 0o644); err != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("cannot write %s: %v", f.Path, err), "")
			return 1
		}
		cliui.Success(os.Stderr, "wrote "+f.Path)
	}
	for _, f := range files {
		if strings.HasSuffix(f.Path, ".inp") {
			fmt.Fprintf(os.Stderr, "submit with: dftstream run %s\n", f.Path)
		}
	}
	return 0
}

func nextUsage() {
	cliui.Title(os.Stderr, "dftstream next - generate the next input of the TS workflow")
	fmt.Fprint(os.Stderr, `
Usage:
  dftstream next <kind> [flags] <run.out>...

Kinds:
`)
	for _, name := range followup.Names {
		fmt.Fprintf(os.Stderr, "  %s\n", followup.Registry[name].Usage())
	}
	fmt.Fprint(os.Stderr, `
The typical chain: optimize reactant + product (Opt Freq), then
  next neb-ts r.out p.out   → find the TS        (verify: 1 imaginary mode)
  next irc ts.out           → confirm it connects reactant and product
  next opt-endpoints irc.out→ optimize what the IRC ran into
  next sp any.out           → refine energies at a higher level

Source files are only read; outputs are new files next to the source.

Flags:
  -nimages int    NEB images for neb-ts (default 8)
  -method string  '!' keyword line for sp (default: spMethod from the config file)
  -f              override validation refusals / overwrite existing files
  -dry-run        print the generated input(s) to stdout instead of writing
`)
}
