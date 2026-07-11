package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/config"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/filter"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/metadata"
)

const (
	modelsPath      = "/api/newapi/models.json"
	ratioConfigPath = "/api/newapi/ratio_config-v1-base.json"
	vendorsPath     = "/api/newapi/vendors.json"
)

// Fetcher fetches both public metadata resources for one uncached request.
type Fetcher interface {
	FetchModels(context.Context) (metadata.Envelope[metadata.Model], error)
	FetchVendors(context.Context) (metadata.Envelope[metadata.Vendor], error)
}

// Server exposes source-compatible filtered metadata endpoints.
type Server struct {
	fetcher Fetcher
	policy  config.Policy
}

func New(fetcher Fetcher, policy config.Policy) *Server {
	return &Server{fetcher: fetcher, policy: policy}
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.serveHTTP)
}

func (s *Server) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		if request.URL.Path == modelsPath || request.URL.Path == ratioConfigPath || request.URL.Path == vendorsPath || request.URL.Path == "/healthz" {
			writer.Header().Set("Allow", http.MethodGet)
			writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "only GET is supported", nil)
			return
		}
		writeError(writer, http.StatusNotFound, "not_found", "endpoint not found", nil)
		return
	}

	switch request.URL.Path {
	case "/healthz":
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	case modelsPath:
		result, err := s.fetchAndBuild(request.Context())
		if err != nil {
			s.writeFetchError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, metadata.Envelope[metadata.Model]{Success: true, Data: result.Models})
	case ratioConfigPath:
		result, err := s.fetchAndBuild(request.Context())
		if err != nil {
			s.writeFetchError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, filter.BuildTokenRatioConfig(result.Models))
	case vendorsPath:
		result, err := s.fetchAndBuild(request.Context())
		if err != nil {
			s.writeFetchError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, metadata.Envelope[metadata.Vendor]{Success: true, Data: result.Vendors})
	default:
		writeError(writer, http.StatusNotFound, "not_found", "endpoint not found", nil)
	}
}

func (s *Server) fetchAndBuild(ctx context.Context) (filter.Result, error) {
	models, err := s.fetcher.FetchModels(ctx)
	if err != nil {
		return filter.Result{}, err
	}
	vendors, err := s.fetcher.FetchVendors(ctx)
	if err != nil {
		return filter.Result{}, err
	}
	return filter.Build(models.Data, vendors.Data, s.policy)
}

func (s *Server) writeFetchError(writer http.ResponseWriter, err error) {
	var duplicate *filter.DuplicateModelError
	if errors.As(err, &duplicate) {
		writeError(writer, http.StatusBadGateway, "duplicate_model_name", "filtered metadata contains duplicate model_name", duplicate.Conflicts)
		return
	}
	writeError(writer, http.StatusBadGateway, "upstream_metadata_unavailable", "filtered metadata is unavailable", nil)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string, conflicts any) {
	response := struct {
		Success   bool   `json:"success"`
		Code      string `json:"code"`
		Message   string `json:"message"`
		Conflicts any    `json:"conflicts,omitempty"`
	}{
		Success:   false,
		Code:      code,
		Message:   message,
		Conflicts: conflicts,
	}
	writeJSON(writer, status, response)
}
