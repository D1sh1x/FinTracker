package httpapi

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPartialResponseIsAborted(t *testing.T) {
	api := &Server{}
	server := httptest.NewServer(api.wrap(func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Content-Type", "text/csv")
		if _, err := w.Write([]byte("partial export\n")); err != nil {
			return err
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			return err
		}
		return errors.New("simulated stream failure")
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 2 * time.Second
	response, err := client.Get(server.URL)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if _, err := io.ReadAll(response.Body); err == nil {
		t.Fatal("A truncated export was accepted as a completed response")
	}
}
