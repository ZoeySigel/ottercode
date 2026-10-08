package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOtterCodeIgnoresUpstreamConfiguration(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OTTERCODE_GLOBAL_CONFIG", filepath.Join(dir, "config"))
	t.Setenv("OTTERCODE_GLOBAL_DATA", filepath.Join(dir, "data"))
	t.Setenv("CRUSH_GLOBAL_CONFIG", filepath.Join(dir, "upstream-config"))
	t.Setenv("CRUSH_GLOBAL_DATA", filepath.Join(dir, "upstream-data"))
	for _, name := range []string{"crush.json", ".crush.json", "crushrc", ".crushrc"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("invalid upstream configuration"), 0o600))
	}
	newConfig := filepath.Join(dir, "ottercode.json")
	require.NoError(t, os.WriteFile(newConfig, []byte(`{}`), 0o600))
	paths := lookupConfigs(dir)
	require.Contains(t, paths, newConfig)
	for _, path := range paths {
		require.False(t, strings.Contains(path, "crush"), path)
		require.False(t, strings.Contains(path, "upstream"), path)
	}
	require.Equal(t, filepath.Join(dir, "config", "ottercode.json"), GlobalConfig())
	require.Equal(t, filepath.Join(dir, "data", "ottercode.json"), GlobalConfigData())
	require.Equal(t, ".ottercode", defaultDataDirectory)
}
