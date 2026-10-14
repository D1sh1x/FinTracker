FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /fintrack ./cmd/fintrack

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng ca-certificates wget && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home fintrack
WORKDIR /app
COPY --from=build /fintrack /app/fintrack
COPY api/openapi.json /app/api/openapi.json
ENV LISTEN_ADDR=0.0.0.0:8000 OPENAPI_PATH=/app/api/openapi.json OMP_THREAD_LIMIT=2
USER fintrack
EXPOSE 8000
CMD ["/app/fintrack"]
