package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"fintrack/internal/importlab"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	address := os.Getenv("LAB_LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8090"
	}
	model := os.Getenv("LAB_MODEL_URL")
	if model == "" {
		model = "http://127.0.0.1:8091"
	}
	spec := os.Getenv("LAB_OPENAPI_PATH")
	if spec == "" {
		spec = "../api/import-lab.openapi.json"
	}
	api := importlab.New(model, os.Getenv("LAB_MODE"), spec)
	defer api.Client.CloseIdleConnections()
	server := &http.Server{Addr: address, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 310 * time.Second, IdleTimeout: 60 * time.Second}
	failures := make(chan error, 1)
	go func() { failures <- server.ListenAndServe() }()
	log.Printf("Import lab: %s; Qwen endpoint configured", address)
	select {
	case err := <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		api.Client.CloseIdleConnections()
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(cleanup); err != nil {
			_ = server.Close()
		}
		<-failures
	}
	return nil
}
