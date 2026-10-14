FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS build
WORKDIR /src
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /importlab ./cmd/importlab

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home importlab
WORKDIR /app
COPY --from=build /importlab /app/importlab
COPY api/import-lab.openapi.json /app/openapi.json
ENV LAB_LISTEN_ADDR=0.0.0.0:8090 LAB_OPENAPI_PATH=/app/openapi.json OMP_THREAD_LIMIT=2
USER importlab
EXPOSE 8090
CMD ["/app/importlab"]
