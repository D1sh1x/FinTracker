FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /fintrack ./cmd/fintrack

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN addgroup -S fintrack && adduser -S -G fintrack fintrack
WORKDIR /app
COPY --from=build /fintrack /app/fintrack
COPY api/openapi.json /app/api/openapi.json
ENV LISTEN_ADDR=0.0.0.0:8000 OPENAPI_PATH=/app/api/openapi.json
USER fintrack
EXPOSE 8000
CMD ["/app/fintrack"]
