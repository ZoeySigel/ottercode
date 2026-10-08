package styles

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOtterRiverDefaultAndFallback(t *testing.T) {
	require.Contains(t, BuiltinThemeNames(), "otter-river")
	river, err := ExportResolvedPalette("otter-river")
	require.NoError(t, err)
	require.Equal(t, "#14232b", river.BgBase)
	require.Equal(t, "#e4eeeb", river.FgBase)
	require.Equal(t, "#64c4b3", river.Primary)
	for _, name := range []string{"", "otter-river", "missing-otter-theme"} {
		s := ThemeFromConfig(name)
		require.Equal(t, OtterRiver().Markdown.Document.Color, s.Markdown.Document.Color)
	}
}
