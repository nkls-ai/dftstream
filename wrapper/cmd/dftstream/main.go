// Command dftstream wraps an ORCA quantum-chemistry calculation and
// streams progress to the configured tracking backend.
package main

import (
	"fmt"
	"os"

	"github.com/nkls-ai/dftstream/internal/cli"
	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cli.WarnLegacyEnv(os.Stderr, os.Environ())
	switch os.Args[1] {
	case "run":
		os.Exit(cli.RunCmd(os.Args[2:]))
	case "submit":
		os.Exit(cli.SubmitCmd(os.Args[2:]))
	case "queue":
		os.Exit(cli.QueueCmd(os.Args[2:]))
	case "sync":
		os.Exit(cli.SyncCmd(os.Args[2:]))
	case "list":
		os.Exit(cli.ListCmd(os.Args[2:]))
	case "import-experiments", "import", "import-batch":
		os.Exit(cli.ImportCmd(os.Args[2:]))
	case "import-cubes":
		os.Exit(cli.ImportCubesCmd(os.Args[2:]))
	case "reimport":
		os.Exit(cli.ReimportCmd(os.Args[2:]))
	case "restart":
		os.Exit(cli.RestartCmd(os.Args[2:]))
	case "next":
		os.Exit(cli.NextCmd(os.Args[2:]))
	case "lint":
		os.Exit(cli.LintCmd(os.Args[2:]))
	case "ui":
		os.Exit(cli.UICmd(os.Args[2:]))
	case "config":
		os.Exit(cli.ConfigCmd(os.Args[2:]))
	case "login":
		os.Exit(cli.LoginCmd(os.Args[2:]))
	case "logout":
		os.Exit(cli.LogoutCmd(os.Args[2:]))
	case "version", "--version", "-v":
		fmt.Fprintf(os.Stdout, "dftstream %s\n", version.String())
		os.Exit(0)
	case "-h", "--help", "help":
		usage()
		os.Exit(0)
	default:
		cliui.Error(os.Stderr, fmt.Sprintf("unknown subcommand %q", os.Args[1]), "Run `dftstream --help` to see available commands.")
		usage()
		os.Exit(2)
	}
}

func usage() {
	cliui.Title(os.Stderr, "dftstream - tracker for ORCA experiments")
	fmt.Fprintf(os.Stderr, `

Usage:
  dftstream run [flags] <inputfile> [-- <orca-args...>]
  dftstream submit [flags] <inputfile>... | all
  dftstream queue <status|watch|cancel> [flags]
  dftstream sync [flags] [journal-dir...]
  dftstream list
  dftstream import-experiments [flags] <root-folder>
  dftstream import-batch --batch <name> <root-folder>
  dftstream import-cubes <run-id> <file.cube> [...]
  dftstream reimport [--fix] [--experiment <name>] [--run <name>]
  dftstream restart [flags] <run.out>
  dftstream next <neb-ts|irc|opt-endpoints|sp> [flags] <run.out>...
  dftstream lint [flags] <inputfile>
  dftstream ui [flags]
  dftstream config [show | set-url <url>]
  dftstream login [--ui-url <url>]
  dftstream logout
  dftstream version

Run 'dftstream <subcommand> -help' for subcommand-specific flags.
`)
}
