package logo

import (
	"strings"
	"testing"

	"github.com/ZoeySigel/ottercode/internal/ui/styles"
	"github.com/charmbracelet/x/ansi"
	"github.com/stretchr/testify/require"
)

func TestWordmarkFitsTerminal(t *testing.T) {
	theme := styles.OtterRiver()
	for _, width := range []int{1, 2, 5, 9, 18, 22, 23, 30, 80, 120} {
		for _, hyper := range []bool{false, true} {
			for _, compact := range []bool{false, true} {
				opts := Opts{Width: width, Hyper: hyper}
				for _, rendered := range []string{Render(theme.Logo.GradCanvas, "v0.1.0", compact, opts), SmallRender(&theme, width, opts)} {
					require.LessOrEqual(t, len(strings.Split(rendered, "\n")), 4, "landing header reserves four rows")
					for _, line := range strings.Split(rendered, "\n") {
						require.LessOrEqual(t, ansi.StringWidth(line), width)
					}
					require.Contains(t, ansi.Strip(rendered), Name(width))
					require.NotContains(t, strings.ToLower(rendered), "crush")
				}
			}
		}
	}
}
