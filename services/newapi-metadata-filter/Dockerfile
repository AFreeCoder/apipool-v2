FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/newapi-metadata-filter ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache wget \
  && addgroup -S app \
  && adduser -S -G app app
WORKDIR /app
COPY --from=build /out/newapi-metadata-filter /app/newapi-metadata-filter
COPY config/official-vendors.yaml /app/config/official-vendors.yaml
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/app/newapi-metadata-filter"]
