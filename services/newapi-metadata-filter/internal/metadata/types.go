package metadata

import "encoding/json"

// Envelope matches the JSON envelope consumed by NewAPI's upstream metadata sync.
type Envelope[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    []T    `json:"data"`
}

// Model is the subset of the upstream NewAPI metadata schema used by NewAPI.
type Model struct {
	Description     string          `json:"description"`
	Endpoints       json.RawMessage `json:"endpoints"`
	Icon            string          `json:"icon"`
	ModelName       string          `json:"model_name"`
	NameRule        int             `json:"name_rule"`
	RatioCache      *float64        `json:"ratio_cache,omitempty"`
	RatioCompletion *float64        `json:"ratio_completion,omitempty"`
	RatioModel      *float64        `json:"ratio_model,omitempty"`
	Status          int             `json:"status"`
	Tags            string          `json:"tags"`
	VendorName      string          `json:"vendor_name"`
}

// TokenRatioConfig is the ratio_config-v1-base response consumed by NewAPI's
// upstream price sync. Per-call ModelPrice values are intentionally empty: the
// filtered models metadata does not contain enough information to price them.
type TokenRatioConfig struct {
	Data    TokenRatioData `json:"data"`
	Message string         `json:"message"`
	Success bool           `json:"success"`
}

type TokenRatioData struct {
	CacheRatio      map[string]float64 `json:"cache_ratio"`
	CompletionRatio map[string]float64 `json:"completion_ratio"`
	ModelPrice      map[string]float64 `json:"model_price"`
	ModelRatio      map[string]float64 `json:"model_ratio"`
}

// Vendor is the supplier metadata referenced by Model.VendorName.
type Vendor struct {
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Name        string `json:"name"`
	Status      int    `json:"status"`
}
