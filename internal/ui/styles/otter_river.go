package styles

import "charm.land/lipgloss/v2"

// OtterRiver returns the default river-inspired OtterCode theme.
func OtterRiver() Styles { return quickStyle(otterRiverOpts()) }

// otterRiverOpts keeps semantic outcomes distinct from brand accents.
func otterRiverOpts() quickStyleOpts {
	o := gruvboxDarkOpts()
	o.primary = lipgloss.Color("#64C4B3")
	o.secondary = lipgloss.Color("#BE936D")
	o.accent = lipgloss.Color("#8DD8C8")
	o.keyword = o.secondary
	o.fgBase = lipgloss.Color("#E4EEEB")
	o.fgSubtle = lipgloss.Color("#9AB2B8")
	o.fgMoreSubtle = o.fgSubtle
	o.fgMostSubtle = lipgloss.Color("#6D8993")
	o.bgBase = lipgloss.Color("#14232B")
	o.bgLeastVisible = lipgloss.Color("#203640")
	o.bgLessVisible = lipgloss.Color("#294550")
	o.bgMostVisible = lipgloss.Color("#365865")
	o.separator = o.bgLessVisible
	o.onPrimary = o.bgBase
	o.button = o.primary
	o.buttonSubtle = o.bgLeastVisible
	o.buttonInactive = o.bgLessVisible
	o.buttonHovered = o.bgMostVisible
	o.plan = o.primary
	o.planMoreSubtle = o.bgMostVisible
	o.ansiBlack = o.bgBase
	o.ansiWhite = o.fgSubtle
	o.ansiCyan = o.primary
	o.ansiBrightBlack = o.fgMostSubtle
	o.ansiBrightWhite = o.fgBase
	o.ansiBrightCyan = o.accent
	return o
}
