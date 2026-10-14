package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"fintrack/internal/httpapi"
	"fintrack/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("server stopped", "code", err.Error())
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://fintrack:fintrack@127.0.0.1:5432/fintrack_go"
	}
	pool, err := store.Open(ctx, url)
	if err != nil {
		return errors.New("database_connection_failed")
	}
	defer pool.Close()
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := store.Migrate(ctx, pool); err != nil {
			return errors.New("migration_failed")
		}
		slog.Info("schema up to date")
		return nil
	}
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8000"
	}
	contract := os.Getenv("OPENAPI_PATH")
	if contract == "" {
		contract = "../api/openapi.json"
	}
	api := &httpapi.Server{Pool: pool, Now: time.Now, OpenAPIPath: contract}
	server := &http.Server{Addr: address, Handler: api.NewHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 90 * time.Second}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.ListenAndServe() }()
	slog.Info("API started", "address", address)
	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("http_server_failed")
		}
	case <-ctx.Done():
		stop()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
		<-serveErrors
	}
	return nil
}
