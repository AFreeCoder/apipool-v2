package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/metadata"
)

const (
	modelsPath  = "/api/newapi/models.json"
	vendorsPath = "/api/newapi/vendors.json"
)

// Client fetches the public NewAPI metadata source.
type Client struct {
	BaseURL  string
	HTTP     *http.Client
	MaxBytes int64
}

func (c Client) FetchModels(ctx context.Context) (metadata.Envelope[metadata.Model], error) {
	return fetch[metadata.Model](ctx, c, modelsPath, "models")
}

func (c Client) FetchVendors(ctx context.Context) (metadata.Envelope[metadata.Vendor], error) {
	return fetch[metadata.Vendor](ctx, c, vendorsPath, "vendors")
}

func fetch[T any](ctx context.Context, c Client, resourcePath, resourceName string) (metadata.Envelope[T], error) {
	if c.MaxBytes <= 0 {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: max response bytes must be positive", resourceName)
	}
	baseURL, err := url.Parse(c.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: invalid base URL", resourceName)
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/") + resourcePath
	baseURL.RawQuery = ""

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL.String(), nil)
	if err != nil {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: create request: %w", resourceName, err)
	}

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: request: %w", resourceName, err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: upstream status %d", resourceName, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, c.MaxBytes+1))
	if err != nil {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: read response: %w", resourceName, err)
	}
	if int64(len(body)) > c.MaxBytes {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: response exceeds %d bytes", resourceName, c.MaxBytes)
	}

	var envelope metadata.Envelope[T]
	if err := json.Unmarshal(body, &envelope); err != nil {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: decode response: %w", resourceName, err)
	}
	if !envelope.Success {
		return metadata.Envelope[T]{}, fmt.Errorf("fetch %s: upstream success=false", resourceName)
	}
	return envelope, nil
}
