package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/config"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/metadata"
)

func TestServerServesFilteredMetadata(t *testing.T) {
	server := New(&fakeFetcher{
		models:  metadata.Envelope[metadata.Model]{Success: true, Data: []metadata.Model{{ModelName: "gpt-5.5", VendorName: "OpenAI"}}},
		vendors: metadata.Envelope[metadata.Vendor]{Success: true, Data: []metadata.Vendor{{Name: "OpenAI", Icon: "openai.svg"}}},
	}, policy(t))

	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/newapi/models.json", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var response metadata.Envelope[metadata.Model]
	if err := json.NewDecoder(rr.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Success || len(response.Data) != 1 || response.Data[0].VendorName != "OpenAI" {
		t.Fatalf("response = %#v", response)
	}
}

func TestServerServesFilteredTokenRatioConfig(t *testing.T) {
	var models metadata.Envelope[metadata.Model]
	if err := json.Unmarshal([]byte(`{
		"success": true,
		"data": [
			{
				"model_name": "gpt-5.4-mini",
				"vendor_name": "OpenAI",
				"ratio_model": 0.375,
				"ratio_completion": 6,
				"ratio_cache": 0.1
			},
			{
				"model_name": "gpt-5.4-mini",
				"vendor_name": "OpenCode Zen",
				"ratio_model": 7.5,
				"ratio_completion": 2,
				"ratio_cache": 0.5
			}
		]
	}`), &models); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	server := New(&fakeFetcher{
		models: models,
		vendors: metadata.Envelope[metadata.Vendor]{Success: true, Data: []metadata.Vendor{
			{Name: "OpenAI", Icon: "openai.svg"},
			{Name: "OpenCode Zen", Icon: "opencode.svg"},
		}},
	}, policy(t))

	for _, path := range []string{
		"/api/newapi/ratio_config-v1-base.json",
		"/api/pricing",
	} {
		t.Run(path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			server.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
			}

			var response struct {
				Success bool `json:"success"`
				Data    struct {
					ModelRatio      map[string]float64 `json:"model_ratio"`
					CompletionRatio map[string]float64 `json:"completion_ratio"`
					CacheRatio      map[string]float64 `json:"cache_ratio"`
					ModelPrice      map[string]float64 `json:"model_price"`
				} `json:"data"`
			}
			if err := json.NewDecoder(rr.Body).Decode(&response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if !response.Success {
				t.Fatalf("response success = false")
			}
			if got, want := response.Data.ModelRatio["gpt-5.4-mini"], 0.375; got != want {
				t.Fatalf("model ratio = %v, want %v", got, want)
			}
			if got, want := response.Data.CompletionRatio["gpt-5.4-mini"], 6.0; got != want {
				t.Fatalf("completion ratio = %v, want %v", got, want)
			}
			if got, want := response.Data.CacheRatio["gpt-5.4-mini"], 0.1; got != want {
				t.Fatalf("cache ratio = %v, want %v", got, want)
			}
			if len(response.Data.ModelPrice) != 0 {
				t.Fatalf("model price = %#v, want no per-call prices", response.Data.ModelPrice)
			}
		})
	}
}

func TestServerRejectsDuplicateModelNames(t *testing.T) {
	server := New(&fakeFetcher{
		models: metadata.Envelope[metadata.Model]{Success: true, Data: []metadata.Model{
			{ModelName: "gpt-5.5", VendorName: "OpenAI"},
			{ModelName: "gpt-5.5", VendorName: "Google"},
		}},
		vendors: metadata.Envelope[metadata.Vendor]{Success: true, Data: []metadata.Vendor{{Name: "OpenAI", Icon: "openai.svg"}, {Name: "Google", Icon: "google.svg"}}},
	}, policy(t))

	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/newapi/vendors.json", nil))
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}

	var response struct {
		Success   bool   `json:"success"`
		Code      string `json:"code"`
		Conflicts []struct {
			ModelName string `json:"model_name"`
		} `json:"conflicts"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Success || response.Code != "duplicate_model_name" || len(response.Conflicts) != 1 {
		t.Fatalf("response = %#v", response)
	}
}

func TestServerDoesNotFetchForInvalidRequests(t *testing.T) {
	fetcher := &fakeFetcher{}
	server := New(fetcher, policy(t))

	post := httptest.NewRecorder()
	server.Handler().ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/newapi/models.json", nil))
	if post.Code != http.StatusMethodNotAllowed || fetcher.calls != 0 {
		t.Fatalf("POST status = %d, calls = %d", post.Code, fetcher.calls)
	}

	missing := httptest.NewRecorder()
	server.Handler().ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if missing.Code != http.StatusNotFound || fetcher.calls != 0 {
		t.Fatalf("missing status = %d, calls = %d", missing.Code, fetcher.calls)
	}
}

type fakeFetcher struct {
	models  metadata.Envelope[metadata.Model]
	vendors metadata.Envelope[metadata.Vendor]
	calls   int
}

func (f *fakeFetcher) FetchModels(context.Context) (metadata.Envelope[metadata.Model], error) {
	f.calls++
	return f.models, nil
}

func (f *fakeFetcher) FetchVendors(context.Context) (metadata.Envelope[metadata.Vendor], error) {
	f.calls++
	return f.vendors, nil
}

func policy(t *testing.T) config.Policy {
	t.Helper()
	path := filepath.Join(t.TempDir(), "official-vendors.yaml")
	contents := "official_vendors:\n  - OpenAI\n  - Google\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	policy, err := config.Load(path)
	if err != nil {
		t.Fatalf("load policy: %v", err)
	}
	return policy
}
