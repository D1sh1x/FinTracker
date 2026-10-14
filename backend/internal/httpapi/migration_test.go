package httpapi

import (
	"bytes"
	"context"
	"testing"

	"fintrack/internal/store"
)

func TestBudgetRecreationRejectsStaleRequests(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	path := "/api/v1/profiles/" + p + "/budgets/2026-10"
	first := object(t, app.call("PUT", path, map[string]any{"limit_minor": "100000"}), 201)
	object(t, app.call("DELETE", path+"?version=1", nil), 204)
	object(t, app.call("GET", path, nil), 404)
	recreated := object(t, app.call("PUT", path, map[string]any{"limit_minor": "200000"}), 201)
	if recreated["version"] != float64(3) || first["id"] != recreated["id"] {
		t.Fatal(recreated)
	}
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "300000", "version": 1}), 409)
	object(t, app.call("DELETE", path+"?version=1", nil), 409)
	object(t, app.call("DELETE", path+"?version=3", nil), 204)
	object(t, app.call("DELETE", path+"?version=3", nil), 204)
}

func TestMigrationPreservesFinancialData(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	object(t, app.call("POST", base+"/transactions", operation(t, app, p, "income", "3000000")), 201)
	object(t, app.call("POST", base+"/transactions", operation(t, app, p, "expense", "125050")), 201)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "2000000"}), 201)
	before := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	ctx := context.Background()
	if _, err := app.server.Pool.Exec(ctx, "DROP TABLE category_budgets; ALTER TABLE monthly_budgets DROP COLUMN deleted_at; DELETE FROM schema_migrations WHERE version IN ('0002','0003')"); err != nil {
		t.Fatal(err)
	}
	object(t, app.call("GET", "/health/ready", nil), 503)
	if err := store.Migrate(ctx, app.server.Pool); err != nil {
		t.Fatal(err)
	}
	after := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if !bytes.Equal(mustJSON(before), mustJSON(after)) {
		t.Fatal("Migration changed financial data", before, after)
	}
	object(t, app.call("GET", "/health/ready", nil), 200)
}
