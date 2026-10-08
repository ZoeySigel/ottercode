//go:build !darwin

package notification

import (
	_ "embed"
)

//go:embed ottercode-icon-solo.png
var Icon []byte
