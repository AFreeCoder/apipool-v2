package upstream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientFetchModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/newapi/models.json" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"success":true,"data":[{"model_name":"gpt-5.5","vendor_name":"OpenAI"}]}`))
	}))
	defer server.Close()

	client := Client{BaseURL: server.URL, HTTP: server.Client(), MaxBytes: 1024}
	models, err := client.FetchModels(context.Background())
	if err != nil {
		t.Fatalf("FetchModels() error = %v", err)
	}
	if !models.Success || len(models.Data) != 1 || models.Data[0].ModelName != "gpt-5.5" {
		t.Fatalf("FetchModels() = %#v", models)
	}
}

func TestClientRejectsInvalidUpstreamResponses(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		maxBytes int64
		want     string
	}{
		{name: "non 200", status: http.StatusInternalServerError, body: "bad", maxBytes: 1024, want: "status 500"},
		{name: "success false", status: http.StatusOK, body: `{"success":false,"message":"upstream failed"}`, maxBytes: 1024, want: "success=false"},
		{name: "invalid json", status: http.StatusOK, body: "{", maxBytes: 1024, want: "decode"},
		{name: "response too large", status: http.StatusOK, body: `{"success":true,"data":[{"model_name":"gpt-5.5"}]}`, maxBytes: 8, want: "exceeds"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = fmt.Fprint(w, tt.body)
			}))
			defer server.Close()

			client := Client{BaseURL: server.URL, HTTP: server.Client(), MaxBytes: tt.maxBytes}
			_, err := client.FetchModels(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("FetchModels() error = %v, want containing %q", err, tt.want)
			}
		})
	}
}
