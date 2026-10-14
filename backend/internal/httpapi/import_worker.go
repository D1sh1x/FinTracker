package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"fintrack/internal/importlab"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ImportWorker struct {
	mu       sync.Mutex
	activeID string
	cancel   context.CancelFunc
}

func (worker *ImportWorker) Cancel(id string) {
	worker.mu.Lock()
	cancel := worker.cancel
	if worker.activeID != id {
		cancel = nil
	}
	worker.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Server) RunImports(ctx context.Context) {
	for ctx.Err() == nil {
		worked, err := s.ProcessNextImport(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Error("import worker failed", "code", "import_processing_error")
		}
		if worked && err == nil {
			continue
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Server) ProcessNextImport(ctx context.Context) (bool, error) {
	if s.ImportWorker == nil {
		return false, errors.New("import worker not configured")
	}
	_, err := s.Pool.Exec(ctx, "UPDATE screenshot_imports SET status='failed',error='Срок ожидания истёк. Загрузите скриншот ещё раз',image=NULL,version=version+1,updated_at=now() WHERE status='queued' AND updated_at<now()-interval '7 days'")
	if err != nil {
		return false, err
	}
	var id, p, capture, token string
	var data []byte
	token = uuid.NewString()
	err = s.Pool.QueryRow(ctx, `WITH candidate AS (SELECT id FROM screenshot_imports WHERE image IS NOT NULL AND (status='queued' OR (status='processing' AND lease_until<now())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE screenshot_imports s SET status='processing',lease_until=now()+interval '6 minutes',lease_token=$1,updated_at=now() FROM candidate c WHERE s.id=c.id RETURNING s.id::text,profile_id::text,to_char(capture_date,'YYYY-MM-DD'),image`, token).Scan(&id, &p, &capture, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	task, cancel := context.WithTimeout(ctx, 5*time.Minute)
	worker := s.ImportWorker
	worker.mu.Lock()
	worker.activeID = id
	worker.cancel = cancel
	worker.mu.Unlock()
	defer func() {
		cancel()
		worker.mu.Lock()
		if worker.activeID == id {
			worker.activeID = ""
			worker.cancel = nil
		}
		worker.mu.Unlock()
	}()
	var owned bool
	err = s.Pool.QueryRow(task, "SELECT status='processing' AND lease_token=$2 FROM screenshot_imports WHERE id=$1", id, token).Scan(&owned)
	if err == nil && !owned {
		return true, nil
	}
	var result importlab.Result
	if err == nil {
		result, err = s.computeImport(task, p, id, capture, data)
	}
	cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if ctx.Err() != nil {
		_, releaseErr := s.Pool.Exec(cleanup, "UPDATE screenshot_imports SET status='queued',lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2", id, token)
		return true, releaseErr
	}
	if err != nil {
		_, saveErr := s.Pool.Exec(cleanup, "UPDATE screenshot_imports SET status='failed',image=NULL,error='Не удалось распознать скриншот. Повторите загрузку или внесите операции вручную',version=version+1,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2", id, token)
		return true, saveErr
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return true, err
	}
	_, err = s.Pool.Exec(cleanup, "UPDATE screenshot_imports SET status='ready',image=NULL,result=$3,version=version+1,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND lease_token=$2", id, token, raw)
	return true, err
}

func (s *Server) computeImport(ctx context.Context, p, id, capture string, data []byte) (result importlab.Result, err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("import computation failed")
		}
	}()
	rawCategories, err := jsonRows(ctx, s.Pool, "SELECT "+categoryJSON+" FROM categories c WHERE profile_id=$1 AND NOT is_archived ORDER BY created_at,id", p)
	if err != nil {
		return result, err
	}
	categories := []importlab.Category{{ID: importlab.UnknownCategory, Name: "Не определено", Type: "unknown"}}
	unknown := map[string]string{}
	for _, raw := range rawCategories {
		var category Category
		if err = json.Unmarshal(raw, &category); err != nil {
			return result, err
		}
		if strings.EqualFold(category.Name, "Не определено") {
			unknown[category.Type] = category.ID
			continue
		}
		categories = append(categories, importlab.Category{ID: category.ID, Name: category.Name, Type: category.Type})
	}
	if s.ProcessImport != nil {
		result, err = s.ProcessImport(ctx, data, capture, categories)
	} else {
		engine := importlab.New(s.ModelURL, "", " ")
		engine.Categories = categories
		defer engine.Client.CloseIdleConnections()
		result, err = engine.Compute(ctx, data, capture)
	}
	if err != nil {
		return result, err
	}
	for i := range result.Rows {
		row := &result.Rows[i]
		row.ID = uuid.NewSHA1(uuid.MustParse(id), []byte(row.ID)).String()
		if row.CategoryID == importlab.UnknownCategory {
			row.CategoryID = unknown[row.Type]
		}
	}
	return result, nil
}
