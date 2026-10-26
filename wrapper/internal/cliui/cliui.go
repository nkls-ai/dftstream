package cliui

import (
	"fmt"
	"io"

	"github.com/fatih/color"
)

var (
	errorLabel   = color.New(color.FgRed, color.Bold)
	warnLabel    = color.New(color.FgYellow, color.Bold)
	successLabel = color.New(color.FgGreen, color.Bold)
	hintLabel    = color.New(color.FgCyan, color.Bold)
	titleStyle   = color.New(color.FgCyan, color.Bold)
)

func Title(w io.Writer, text string) {
	titleStyle.Fprintln(w, text)
}

func Success(w io.Writer, message string) {
	successLabel.Fprint(w, "success: ")
	fprintln(w, message)
}

func Warning(w io.Writer, message, fix string) {
	warnLabel.Fprint(w, "warning: ")
	fprintln(w, message)
	if fix != "" {
		Hint(w, fix)
	}
}

func Error(w io.Writer, message, fix string) {
	errorLabel.Fprint(w, "error: ")
	fprintln(w, message)
	if fix != "" {
		Hint(w, fix)
	}
}

func Hint(w io.Writer, message string) {
	hintLabel.Fprint(w, "fix: ")
	fprintln(w, message)
}

func fprintln(w io.Writer, message string) {
	_, _ = fmt.Fprintln(w, message) //nolint:errcheck — write to stderr is best-effort
}
