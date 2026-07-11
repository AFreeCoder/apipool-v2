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
	Description string          `json:"description"`
	Endpoints   json.RawMessage `json:"endpoints"`
	Icon        string          `json:"icon"`
	ModelName   string          `json:"model_name"`
	NameRule    int             `json:"name_rule"`
	Status      int             `json:"status"`
	Tags        string          `json:"tags"`
	VendorName  string          `json:"vendor_name"`
}

// Vendor is the supplier metadata referenced by Model.VendorName.
type Vendor struct {
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Name        string `json:"name"`
	Status      int    `json:"status"`
}
