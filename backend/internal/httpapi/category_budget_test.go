package httpapi

import (
	"context"
	"slices"
	"sort"
	"sync"
	"testing"

	"fintrack/internal/store"
	"github.com/google/uuid"
)

func categoryBudgetItem(t *testing.T, result map[string]any, id string) map[string]any {
	t.Helper()
	for _, value := range result["items"].([]any) {
		item := value.(map[string]any)
		if item["category_id"] == id {
			return item
		}
	}
	t.Fatal("Budget category missing", id)
	return nil
}

func TestCategoryBudgetFinancialLifecycle(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "tracking_start_date": "2026-09-01"}), 200)
	expense := operation(t, app, p, "expense", "120000")
	id := expense["category_id"].(string)
	other := uuid.NewString()
	object(t, app.call("POST", base+"/categories", map[string]any{"id": other, "type": "expense", "name": "Квартира", "icon": "home", "color": "#7955cc"}), 201)
	path := base + "/category-budgets/2026-10/" + id
	list := func() map[string]any { return object(t, app.call("GET", base+"/category-budgets/2026-10", nil), 200) }
	initial := categoryBudgetItem(t, list(), id)
	if initial["limit_minor"] != nil || initial["remaining_minor"] != nil || initial["spent_minor"] != "0" {
		t.Fatal(initial)
	}
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "500000"}), 201)
	object(t, app.call("PUT", base+"/category-budgets/2026-10/"+other, map[string]any{"limit_minor": "4000000"}), 201)
	object(t, app.call("POST", base+"/transactions", expense), 201)
	first := categoryBudgetItem(t, list(), id)
	if first["remaining_minor"] != "380000" || first["overspent_minor"] != "0" || first["used_percent"] != "24.0" {
		t.Fatal(first)
	}
	more := operation(t, app, p, "expense", "400000")
	object(t, app.call("POST", base+"/transactions", more), 201)
	object(t, app.call("POST", base+"/transactions", operation(t, app, p, "income", "9000000")), 201)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "1000000"}), 201)
	result := list()
	item := categoryBudgetItem(t, result, id)
	if item["remaining_minor"] != "-20000" || item["overspent_minor"] != "20000" || item["used_percent"] != "104.0" || result["allocated_minor"] != "4500000" || result["exceeds_overall"] != true {
		t.Fatal(result)
	}
	summary := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if string(mustJSON(summary["category_budgets"])) != string(mustJSON(result)) || summary["budget"].(map[string]any)["remaining_minor"] != "480000" {
		t.Fatal(summary)
	}
	operationPath := base + "/transactions/" + more["id"].(string)
	object(t, app.call("PATCH", operationPath, map[string]any{"version": 1, "amount_minor": "380000"}), 200)
	exactLimit := categoryBudgetItem(t, list(), id)
	if exactLimit["remaining_minor"] != "0" || exactLimit["overspent_minor"] != "0" || exactLimit["used_percent"] != "100.0" {
		t.Fatal(exactLimit)
	}
	object(t, app.call("PATCH", operationPath, map[string]any{"version": 2, "category_id": other}), 200)
	if categoryBudgetItem(t, list(), id)["spent_minor"] != "120000" || categoryBudgetItem(t, list(), other)["remaining_minor"] != "3620000" {
		t.Fatal(list())
	}
	object(t, app.call("PATCH", operationPath, map[string]any{"version": 3, "occurred_on": "2026-09-30"}), 200)
	if categoryBudgetItem(t, list(), other)["spent_minor"] != "0" {
		t.Fatal(list())
	}
	object(t, app.call("DELETE", base+"/transactions/"+expense["id"].(string)+"?version=1", nil), 204)
	if categoryBudgetItem(t, list(), id)["spent_minor"] != "0" {
		t.Fatal(list())
	}
	future := object(t, app.call("GET", base+"/category-budgets/2026-11", nil), 200)
	if categoryBudgetItem(t, future, id)["limit_minor"] != nil || future["allocated_minor"] != "0" {
		t.Fatal(future)
	}
	another := person(t, app)
	isolated := object(t, app.call("GET", "/api/v1/profiles/"+another+"/category-budgets/2026-10", nil), 200)
	if isolated["allocated_minor"] != "0" {
		t.Fatal(isolated)
	}
}

func TestCategoryBudgetVersionsAndArchive(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	id := operation(t, app, p, "expense", "1")["category_id"].(string)
	path := base + "/category-budgets/2026-10/" + id
	race := func(body map[string]any, want []int) {
		t.Helper()
		codes := make(chan int, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Go(func() { codes <- app.call("PUT", path, body).Code })
		}
		wg.Wait()
		close(codes)
		actual := []int{}
		for code := range codes {
			actual = append(actual, code)
		}
		sort.Ints(actual)
		if !slices.Equal(actual, want) {
			t.Fatal(actual, want)
		}
	}
	race(map[string]any{"limit_minor": "100000"}, []int{201, 409})
	race(map[string]any{"limit_minor": "200000", "version": 1}, []int{200, 409})
	object(t, app.call("DELETE", path+"?version=1", nil), 409)
	object(t, app.call("DELETE", path+"?version=2", nil), 204)
	object(t, app.call("DELETE", path+"?version=2", nil), 204)
	recreated := object(t, app.call("PUT", path, map[string]any{"limit_minor": "300000"}), 201)
	if recreated["version"] != float64(4) {
		t.Fatal(recreated)
	}
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "400000", "version": 1}), 409)
	object(t, app.call("DELETE", path+"?version=2", nil), 409)
	object(t, app.call("PATCH", base+"/categories/"+id, map[string]any{"is_archived": true}), 200)
	object(t, app.call("PUT", base+"/category-budgets/2026-11/"+id, map[string]any{"limit_minor": "1"}), 409)
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "400000", "version": 4}), 200)
	archived := object(t, app.call("GET", base+"/category-budgets/2026-10", nil), 200)
	if !categoryBudgetItem(t, archived, id)["is_archived"].(bool) {
		t.Fatal(archived)
	}
	object(t, app.call("DELETE", path+"?version=5", nil), 204)
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "1"}), 409)
	object(t, app.call("PATCH", base+"/categories/"+id, map[string]any{"is_archived": false}), 200)
	restored := object(t, app.call("PUT", path, map[string]any{"limit_minor": "1"}), 201)
	if restored["version"] != float64(7) {
		t.Fatal(restored)
	}
}

func TestCategoryBudgetValidationAndExactSums(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	id := operation(t, app, p, "expense", "1")["category_id"].(string)
	path := base + "/category-budgets/2026-10/" + id
	for _, value := range []any{"0", "-1", "1.2", "100000000000", 100, nil} {
		object(t, app.call("PUT", path, map[string]any{"limit_minor": value}), 422)
	}
	object(t, app.call("PUT", base+"/category-budgets/bad/"+id, map[string]any{"limit_minor": "1"}), 422)
	object(t, app.call("PUT", base+"/category-budgets/2026-10/bad", map[string]any{"limit_minor": "1"}), 422)
	object(t, app.call("PUT", base+"/category-budgets/2026-10/"+uuid.NewString(), map[string]any{"limit_minor": "1"}), 404)
	other := person(t, app)
	object(t, app.call("PUT", "/api/v1/profiles/"+other+"/category-budgets/2026-10/"+id, map[string]any{"limit_minor": "1"}), 404)
	income := operation(t, app, p, "income", "1")["category_id"].(string)
	object(t, app.call("PUT", base+"/category-budgets/2026-10/"+income, map[string]any{"limit_minor": "1"}), 422)
	object(t, app.call("DELETE", path, nil), 422)
	object(t, app.call("DELETE", path+"?version=1", nil), 404)
	object(t, app.call("PUT", path, map[string]any{"limit_minor": "99999999999"}), 201)
	for range 2 {
		object(t, app.call("POST", base+"/transactions", operation(t, app, p, "expense", "99999999999")), 201)
	}
	result := object(t, app.call("GET", base+"/category-budgets/2026-10", nil), 200)
	item := categoryBudgetItem(t, result, id)
	if item["spent_minor"] != "199999999998" || item["remaining_minor"] != "-99999999999" || item["overspent_minor"] != "99999999999" {
		t.Fatal(item)
	}
	ctx := context.Background()
	_, err := app.server.Pool.Exec(ctx, "INSERT INTO category_budgets(id,profile_id,category_id,month,limit_minor,version,created_at,updated_at) VALUES($1,$2,$3,'2026-12-01',1,1,now(),now())", uuid.NewString(), p, income)
	if err == nil {
		t.Fatal("Database accepted an income category budget")
	}
}

func TestCategoryBudgetMigrationFrom0002(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	object(t, app.call("POST", base+"/transactions", operation(t, app, p, "expense", "125050")), 201)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "2000000"}), 201)
	before := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	ctx := context.Background()
	if _, err := app.server.Pool.Exec(ctx, "DROP TABLE category_budgets; DELETE FROM schema_migrations WHERE version='0003'"); err != nil {
		t.Fatal(err)
	}
	object(t, app.call("GET", "/health/ready", nil), 503)
	if err := store.Migrate(ctx, app.server.Pool); err != nil {
		t.Fatal(err)
	}
	after := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if string(mustJSON(before)) != string(mustJSON(after)) {
		t.Fatal("Migration changed existing finances")
	}
	object(t, app.call("GET", "/health/ready", nil), 200)
}

func TestCategoryBudgetWithoutLimitKeepsNull(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	expense := operation(t, app, p, "expense", "100")
	object(t, app.call("POST", "/api/v1/profiles/"+p+"/transactions", expense), 201)
	r := object(t, app.call("GET", "/api/v1/profiles/"+p+"/category-budgets/2026-10", nil), 200)
	item := categoryBudgetItem(t, r, expense["category_id"].(string))
	if item["used_percent"] != nil || item["limit_minor"] != nil || item["overspent_minor"] != "0" {
		t.Fatal(item)
	}
}
