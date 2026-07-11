package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRejectsInvalidPolicy(t *testing.T) {
	tests := []struct {
		name string
		yaml string
	}{
		{
			name: "empty official vendors",
			yaml: "official_vendors: []\n",
		},
		{
			name: "duplicate official vendor",
			yaml: "official_vendors:\n  - OpenAI\n  - OpenAI\n",
		},
		{
			name: "exclude vendor outside allowlist",
			yaml: "official_vendors:\n  - OpenAI\nexclude_models_by_vendor:\n  Alibaba:\n    - deepseek-r1\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeTempFile(t, tt.yaml)
			_, err := Load(path)
			if err == nil || !strings.Contains(err.Error(), "official") {
				t.Fatalf("expected official policy error, got %v", err)
			}
		})
	}
}

func TestLoadBuildsPolicy(t *testing.T) {
	path := writeTempFile(t, "official_vendors:\n  - OpenAI\n  - Alibaba\nexclude_models_by_vendor:\n  Alibaba:\n    - deepseek-r1\n")

	policy, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !policy.AllowsVendor("OpenAI") || !policy.ExcludesModel("Alibaba", "deepseek-r1") {
		t.Fatalf("unexpected policy: %#v", policy)
	}
}

func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "official-vendors.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	return path
}
