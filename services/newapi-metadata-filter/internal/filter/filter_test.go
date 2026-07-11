package filter

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/config"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/metadata"
)

func TestBuildFiltersVendorsAndExplicitExclusions(t *testing.T) {
	result, err := Build(
		[]metadata.Model{
			{ModelName: "gpt-5.5", VendorName: "OpenAI"},
			{ModelName: "gpt-5.5", VendorName: "OpenCode Zen"},
			{ModelName: "deepseek-r1", VendorName: "Alibaba"},
			{ModelName: "kimi-k2.6", VendorName: "Moonshot AI"},
			{ModelName: "kimi-k2.6", VendorName: "Moonshot AI (China)"},
		},
		[]metadata.Vendor{
			{Name: "OpenAI", Icon: "openai.svg"},
			{Name: "OpenCode Zen", Icon: "opencode.svg"},
			{Name: "Alibaba", Icon: "alibaba.svg"},
			{Name: "Moonshot AI", Icon: "moonshot.svg"},
			{Name: "Moonshot AI (China)", Icon: "moonshot-cn.svg"},
		},
		loadPolicy(t),
	)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if got, want := len(result.Models), 2; got != want {
		t.Fatalf("models length = %d, want %d: %#v", got, want, result.Models)
	}
	if got, want := len(result.Vendors), 2; got != want {
		t.Fatalf("vendors length = %d, want %d: %#v", got, want, result.Vendors)
	}
}

func TestBuildRejectsDuplicateModelName(t *testing.T) {
	_, err := Build(
		[]metadata.Model{
			{ModelName: "gpt-5.5", VendorName: "OpenAI"},
			{ModelName: "gpt-5.5", VendorName: "Google"},
		},
		[]metadata.Vendor{{Name: "OpenAI", Icon: "openai.svg"}, {Name: "Google", Icon: "google.svg"}},
		loadPolicy(t),
	)

	var duplicate *DuplicateModelError
	if !errors.As(err, &duplicate) || duplicate.ModelName != "gpt-5.5" || len(duplicate.Conflicts) != 1 {
		t.Fatalf("expected gpt-5.5 duplicate, got %v", err)
	}
}

func TestBuildRejectsOfficialVendorWithoutIcon(t *testing.T) {
	_, err := Build(
		[]metadata.Model{{ModelName: "gpt-5.5", VendorName: "OpenAI"}},
		[]metadata.Vendor{{Name: "OpenAI"}},
		loadPolicy(t),
	)
	if err == nil {
		t.Fatal("Build() error = nil, want missing icon error")
	}
}

func loadPolicy(t *testing.T) config.Policy {
	t.Helper()
	path := filepath.Join(t.TempDir(), "official-vendors.yaml")
	contents := "official_vendors:\n  - OpenAI\n  - Google\n  - Alibaba\n  - Moonshot AI\nexclude_models_by_vendor:\n  Alibaba:\n    - deepseek-r1\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	policy, err := config.Load(path)
	if err != nil {
		t.Fatalf("load policy: %v", err)
	}
	return policy
}
