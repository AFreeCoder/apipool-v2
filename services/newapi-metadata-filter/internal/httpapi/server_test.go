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
