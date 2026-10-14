package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fintrack/internal/store"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *responseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(data)
}
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) wrap(handler endpoint) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		w := &responseWriter{ResponseWriter: writer}
		id := uuid.NewString()
		started := time.Now()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		ctx, cancel := context.WithTimeout(request.Context(), 55*time.Second)
		defer cancel()
		r := request.WithContext(ctx)
		defer func() {
			slog.Info("request", "route", r.Pattern, "method", r.Method, "status", w.status, "duration_ms", time.Since(started).Milliseconds(), "request_id", id)
		}()
		defer func() {
			if failure := recover(); failure != nil {
				if w.status != 0 || failure == http.ErrAbortHandler {
					slog.Error("response aborted", "request_id", id, "code", "stream_error")
					panic(http.ErrAbortHandler)
				}
				s.writeError(w, id, errors.New("panic"))
			}
		}()
		if err := handler(w, r); err != nil {
			if w.status != 0 {
				panic(http.ErrAbortHandler)
			}
			s.writeError(w, id, err)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, err = w.Write(append(data, '\n'))
	return err
}

func (s *Server) writeError(w http.ResponseWriter, requestID string, err error) {
	problem := &apiError{Status: 500, Code: "internal_error", Message: "Не удалось выполнить действие. Повторите позже"}
	var api *apiError
	var postgres *pgconn.PgError
	switch {
	case errors.As(err, &api):
		problem = api
	case errors.Is(err, pgx.ErrNoRows):
		problem = &apiError{Status: 404, Code: "not_found", Message: "Запись не найдена"}
	case errors.As(err, &postgres):
		if postgres.Code == "23505" && postgres.ConstraintName == "uq_category_name" {
			problem = &apiError{Status: 409, Code: "category_name_exists", Message: "Такая категория уже есть, в том числе в архиве", Fields: map[string]string{"name": "Используйте другое имя или восстановите категорию"}}
		} else if postgres.Code == "23505" || postgres.Code == "23503" || postgres.Code == "23514" {
			problem = &apiError{Status: 409, Code: "data_conflict", Message: "Запись уже существует или её данные изменились"}
		} else {
			problem = &apiError{Status: 503, Code: "service_unavailable", Message: "Сервис временно недоступен. Повторите позже"}
		}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), pgconn.SafeToRetry(err):
		problem = &apiError{Status: 503, Code: "service_unavailable", Message: "Сервис временно недоступен. Повторите позже"}
	}
	if problem.Fields == nil {
		problem.Fields = map[string]string{}
	}
	if problem.Status >= 500 {
		slog.Error("request failed", "request_id", requestID, "code", problem.Code)
	}
	_ = writeJSON(w, problem.Status, map[string]any{"error": map[string]any{"code": problem.Code, "message": problem.Message, "fields": problem.Fields, "request_id": requestID}})
}

func (s *Server) readProfile(ctx context.Context, db queryer, id string, lock bool) (Profile, json.RawMessage, error) {
	id, err := identifier(id)
	if err != nil {
		return Profile{}, nil, err
	}
	query := "SELECT " + profileJSON + " FROM profiles p WHERE p.id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	raw, err := rawRow(ctx, db, query, id)
	var profile Profile
	if err == nil {
		err = json.Unmarshal(raw, &profile)
	}
	return profile, raw, err
}

func (s *Server) beginWrite(r *http.Request) (pgx.Tx, Profile, error) {
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		return nil, Profile{}, err
	}
	person, _, err := s.readProfile(r.Context(), tx, r.PathValue("p"), true)
	if err != nil {
		rollback(tx)
		return nil, Profile{}, err
	}
	return tx, person, nil
}

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

func (s *Server) live(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, 200, map[string]string{"status": "ok"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) error {
	var version string
	if err := s.Pool.QueryRow(r.Context(), "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").Scan(&version); err != nil {
		return &apiError{Status: 503, Code: "schema_not_ready", Message: "Сервис или схема базы данных ещё не готовы"}
	}
	if version != store.CurrentVersion {
		return &apiError{Status: 503, Code: "schema_not_ready", Message: "Схема базы данных требует обновления"}
	}
	return writeJSON(w, 200, map[string]string{"status": "ready"})
}
