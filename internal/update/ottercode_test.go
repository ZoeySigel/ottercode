package update

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPersonalRepositoryUpdates(t *testing.T) {
	require.Equal(t, "https://api.github.com/repos/ZoeySigel/ottercode/releases/latest", githubApiUrl)
	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, userAgent, r.Header.Get("User-Agent"))
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","html_url":"https://github.com/ZoeySigel/ottercode/releases/tag/v0.2.0"}`))
			}))
			defer server.Close()
			info, err := Check(t.Context(), "v0.1.0", &github{url: server.URL, client: server.Client()})
			if status == http.StatusForbidden {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, status == http.StatusOK, info.Available())
			if status == http.StatusOK {
				require.Contains(t, info.URL, "ZoeySigel/ottercode/releases")
			}
		})
	}
}
