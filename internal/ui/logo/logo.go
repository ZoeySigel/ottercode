// Package logo renders the OtterCode wordmark.
package logo

import (
	"image/color"

	"charm.land/lipgloss/v2"
	"github.com/ZoeySigel/ottercode/internal/ui/styles"
	"github.com/charmbracelet/x/ansi"
)

type letterform func(bool) string

const diag = `╱`

// Opts controls the logo colors and available terminal width.
type Opts struct {
	FieldColor   color.Color
	TitleColorA  color.Color
	TitleColorB  color.Color
	CharmColor   color.Color
	VersionColor color.Color
	Width        int
	Hyper        bool // Provider identity does not change the product wordmark.
	Unstable     bool // Retained for callers of the original rendering API.
}

// Name returns the longest product wordmark that fits the available columns.
func Name(width int) string {
	if width >= 9 {
		return "OTTERCODE"
	}
	if width >= 5 {
		return "OTTER"
	}
	return ansi.Truncate("OC", max(0, width), "")
}

// Render draws the wordmark and version without overflowing the width.
func Render(base lipgloss.Style, version string, compact bool, o Opts) string {
	width := o.Width
	if width <= 0 {
		width = 28
	}
	fg := func(c color.Color, s string) string {
		return lipgloss.NewStyle().Foreground(c).Render(s)
	}
	name := styles.ApplyBoldForegroundGrad(base, Name(width), o.TitleColorA, o.TitleColorB)
	if available := width - lipgloss.Width(name) - 1; available > 0 {
		name += " " + fg(o.VersionColor, ansi.Truncate(version, available, ""))
	}
	return ansi.Truncate(name, width, "")
}

// SmallRender draws a one-line wordmark for smaller windows.
func SmallRender(t *styles.Styles, width int, o Opts) string {
	name := styles.ApplyBoldForegroundGrad(t.Logo.GradCanvas, Name(width), t.Logo.SmallGradFromColor, t.Logo.SmallGradToColor)
	return ansi.Truncate(name, max(0, width), "")
}
