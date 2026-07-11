package filter

import (
	"fmt"
	"sort"
	"strings"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/config"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/metadata"
)

// Result is a source-compatible, internally consistent metadata result.
type Result struct {
	Models  []metadata.Model
	Vendors []metadata.Vendor
}

// DuplicateModelError signals that the explicit policy did not make model_name unique.
type DuplicateModelError struct {
	ModelName string
	Vendors   []string
	Conflicts []DuplicateModelConflict
}

func (e *DuplicateModelError) Error() string {
	return fmt.Sprintf("duplicate model_name %q for vendors %s", e.ModelName, strings.Join(e.Vendors, ", "))
}

// DuplicateModelConflict describes one unresolved model_name collision.
type DuplicateModelConflict struct {
	ModelName string   `json:"model_name"`
	Vendors   []string `json:"vendors"`
}

// Build applies the checked-in policy without applying implicit vendor precedence.
func Build(models []metadata.Model, vendors []metadata.Vendor, policy config.Policy) (Result, error) {
	vendorsByName := make(map[string]metadata.Vendor, len(vendors))
	for _, vendor := range vendors {
		if vendor.Name == "" {
			return Result{}, fmt.Errorf("upstream vendor has an empty name")
		}
		if _, exists := vendorsByName[vendor.Name]; exists {
			return Result{}, fmt.Errorf("upstream contains duplicate vendor %q", vendor.Name)
		}
		vendorsByName[vendor.Name] = vendor
	}

	filteredModels := make([]metadata.Model, 0, len(models))
	modelVendors := make(map[string][]string, len(models))
	for _, model := range models {
		if !policy.AllowsVendor(model.VendorName) || policy.ExcludesModel(model.VendorName, model.ModelName) {
			continue
		}
		if model.ModelName == "" {
			return Result{}, fmt.Errorf("upstream model for vendor %q has an empty model_name", model.VendorName)
		}
		vendor, exists := vendorsByName[model.VendorName]
		if !exists {
			return Result{}, fmt.Errorf("model %q references missing vendor %q", model.ModelName, model.VendorName)
		}
		if strings.TrimSpace(vendor.Icon) == "" {
			return Result{}, fmt.Errorf("model %q references vendor %q without an icon", model.ModelName, model.VendorName)
		}

		filteredModels = append(filteredModels, model)
		modelVendors[model.ModelName] = append(modelVendors[model.ModelName], model.VendorName)
	}

	duplicates := make([]DuplicateModelConflict, 0)
	for modelName, modelVendorNames := range modelVendors {
		if len(modelVendorNames) > 1 {
			duplicates = append(duplicates, DuplicateModelConflict{ModelName: modelName, Vendors: modelVendorNames})
		}
	}
	if len(duplicates) > 0 {
		sort.Slice(duplicates, func(i, j int) bool { return duplicates[i].ModelName < duplicates[j].ModelName })
		return Result{}, &DuplicateModelError{
			ModelName: duplicates[0].ModelName,
			Vendors:   duplicates[0].Vendors,
			Conflicts: duplicates,
		}
	}

	filteredVendors := make([]metadata.Vendor, 0, len(filteredModels))
	usedVendors := make(map[string]struct{}, len(filteredModels))
	for _, model := range filteredModels {
		if _, alreadyAdded := usedVendors[model.VendorName]; alreadyAdded {
			continue
		}
		filteredVendors = append(filteredVendors, vendorsByName[model.VendorName])
		usedVendors[model.VendorName] = struct{}{}
	}

	return Result{Models: filteredModels, Vendors: filteredVendors}, nil
}
