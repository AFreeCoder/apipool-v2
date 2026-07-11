package config

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type filePolicy struct {
	OfficialVendors       []string            `yaml:"official_vendors"`
	ExcludeModelsByVendor map[string][]string `yaml:"exclude_models_by_vendor"`
}

// Policy is the validated, lookup-friendly version of the checked-in YAML policy.
type Policy struct {
	officialVendors       map[string]struct{}
	excludeModelsByVendor map[string]map[string]struct{}
}

// Load parses and validates a supplier policy from path.
func Load(path string) (Policy, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return Policy{}, fmt.Errorf("read policy: %w", err)
	}

	var parsed filePolicy
	if err := yaml.Unmarshal(contents, &parsed); err != nil {
		return Policy{}, fmt.Errorf("parse policy: %w", err)
	}

	if len(parsed.OfficialVendors) == 0 {
		return Policy{}, fmt.Errorf("official_vendors must not be empty")
	}

	policy := Policy{
		officialVendors:       make(map[string]struct{}, len(parsed.OfficialVendors)),
		excludeModelsByVendor: make(map[string]map[string]struct{}, len(parsed.ExcludeModelsByVendor)),
	}
	for _, vendor := range parsed.OfficialVendors {
		if vendor != strings.TrimSpace(vendor) || vendor == "" {
			return Policy{}, fmt.Errorf("official_vendors contains a blank value")
		}
		if _, exists := policy.officialVendors[vendor]; exists {
			return Policy{}, fmt.Errorf("official_vendors contains duplicate value %q", vendor)
		}
		policy.officialVendors[vendor] = struct{}{}
	}

	for vendor, models := range parsed.ExcludeModelsByVendor {
		if vendor != strings.TrimSpace(vendor) || vendor == "" {
			return Policy{}, fmt.Errorf("exclude_models_by_vendor contains a blank vendor")
		}
		if _, allowed := policy.officialVendors[vendor]; !allowed {
			return Policy{}, fmt.Errorf("exclude_models_by_vendor vendor %q is not in official_vendors", vendor)
		}
		excluded := make(map[string]struct{}, len(models))
		for _, model := range models {
			if model != strings.TrimSpace(model) || model == "" {
				return Policy{}, fmt.Errorf("exclude_models_by_vendor.%s contains a blank model", vendor)
			}
			if _, exists := excluded[model]; exists {
				return Policy{}, fmt.Errorf("exclude_models_by_vendor.%s contains duplicate model %q", vendor, model)
			}
			excluded[model] = struct{}{}
		}
		policy.excludeModelsByVendor[vendor] = excluded
	}

	return policy, nil
}

func (p Policy) AllowsVendor(vendor string) bool {
	_, ok := p.officialVendors[vendor]
	return ok
}

func (p Policy) ExcludesModel(vendor, model string) bool {
	models, ok := p.excludeModelsByVendor[vendor]
	if !ok {
		return false
	}
	_, ok = models[model]
	return ok
}
