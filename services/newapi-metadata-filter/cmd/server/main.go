package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/config"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/httpapi"
	"github.com/afreecoder/apipool-v2/services/newapi-metadata-filter/internal/upstream"
)

const (
	defaultUpstreamBase = "https://basellm.github.io/llm-metadata"
	defaultListenAddr   = ":8080"
	defaultConfigPath   = "/app/config/official-vendors.yaml"
	defaultTimeout      = 15 * time.Second
	defaultMaxBytes     = 8 * 1024 * 1024
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	settings, err := loadSettings()
	if err != nil {
		logger.Error("invalid startup configuration", "error", err)
		os.Exit(1)
	}
	policy, err := config.Load(settings.configPath)
	if err != nil {
		logger.Error("load policy", "error", err)
		os.Exit(1)
	}

	server := httpapi.New(upstream.Client{
		BaseURL:  settings.upstreamBase,
		HTTP:     &http.Client{Timeout: settings.requestTimeout},
		MaxBytes: settings.maxResponseBytes,
	}, policy)
	httpServer := &http.Server{
		Addr:              settings.listenAddr,
		Handler:           requestLogger(logger, server.Handler()),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("metadata filter listening", "address", settings.listenAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("shutdown", "error", err)
		os.Exit(1)
	}
}

type settings struct {
	upstreamBase     string
	listenAddr       string
	configPath       string
	requestTimeout   time.Duration
	maxResponseBytes int64
}

func loadSettings() (settings, error) {
	upstreamBase := environmentOr("UPSTREAM_METADATA_BASE", defaultUpstreamBase)
	parsedURL, err := url.Parse(upstreamBase)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" {
		return settings{}, fmt.Errorf("UPSTREAM_METADATA_BASE must be an absolute HTTPS URL")
	}
	requestTimeout, err := positiveSeconds("REQUEST_TIMEOUT_SECONDS", defaultTimeout)
	if err != nil {
		return settings{}, err
	}
	maxResponseBytes, err := positiveBytes("MAX_RESPONSE_BYTES", defaultMaxBytes)
	if err != nil {
		return settings{}, err
	}

	return settings{
		upstreamBase:     strings.TrimRight(upstreamBase, "/"),
		listenAddr:       environmentOr("LISTEN_ADDR", defaultListenAddr),
		configPath:       environmentOr("CONFIG_PATH", defaultConfigPath),
		requestTimeout:   requestTimeout,
		maxResponseBytes: maxResponseBytes,
	}, nil
}

func environmentOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func positiveSeconds(name string, fallback time.Duration) (time.Duration, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return time.Duration(seconds) * time.Second, nil
}

func positiveBytes(name string, fallback int64) (int64, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	bytes, err := strconv.ParseInt(value, 10, 64)
	if err != nil || bytes <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return bytes, nil
}

func requestLogger(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		start := time.Now()
		next.ServeHTTP(writer, request)
		logger.Info("request", "path", request.URL.Path, "method", request.Method, "duration_ms", time.Since(start).Milliseconds())
	})
}
