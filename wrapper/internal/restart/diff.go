package restart

import "strings"

// diffMaxLines bounds the O(n*m) LCS table. ORCA inputs are tens of
// lines; anything past the bound (a pasted trajectory, say) falls back to
// printing the generated text verbatim.
const diffMaxLines = 2000

// Diff renders a minimal line diff between the parent input and the
// generated restart input, for `dftstream restart --dry-run`: unchanged
// lines indented, removals prefixed "- ", additions "+ ". Not a patch
// format — it exists so a chemist can eyeball what the restart changed
// without opening two files.
func Diff(oldText, newText string) string {
	a := splitDiffLines(oldText)
	b := splitDiffLines(newText)
	if len(a) > diffMaxLines || len(b) > diffMaxLines {
		return newText
	}

	// Longest-common-subsequence table; inputs are tiny.
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}

	var out strings.Builder
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			out.WriteString("  " + a[i] + "\n")
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			out.WriteString("- " + a[i] + "\n")
			i++
		default:
			out.WriteString("+ " + b[j] + "\n")
			j++
		}
	}
	for ; i < len(a); i++ {
		out.WriteString("- " + a[i] + "\n")
	}
	for ; j < len(b); j++ {
		out.WriteString("+ " + b[j] + "\n")
	}
	return out.String()
}

// splitDiffLines splits on newlines, dropping one trailing empty element
// so a final "\n" does not diff as an extra blank line.
func splitDiffLines(text string) []string {
	lines := strings.Split(text, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	return lines
}
