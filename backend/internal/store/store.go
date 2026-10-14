package store

import (
	"context"
	_ "embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const CurrentVersion = "0003"

//go:embed 0001.sql
var initialSchema string

//go:embed 0002.sql
var budgetDeletionSchema string

//go:embed 0003.sql
var categoryBudgetSchema string

type migration struct{ version, sql string }

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database configuration: %w", err)
	}
	config.MaxConns = 10
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	config.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(762839471)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	for _, step := range []migration{{"0001", initialSchema}, {"0002", budgetDeletionSchema}, {"0003", categoryBudgetSchema}} {
		var applied bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", step.version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		if step.version == "0001" {
			var legacy bool
			if err = tx.QueryRow(ctx, "SELECT to_regclass('profiles') IS NOT NULL").Scan(&legacy); err != nil {
				return err
			}
			if legacy {
				return fmt.Errorf("existing unversioned schema: use a fresh database")
			}
		}
		if _, err = tx.Exec(ctx, step.sql); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", step.version); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
