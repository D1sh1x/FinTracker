package httpapi

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"fintrack/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type testApp struct {
	handler http.Handler
	server  *Server
}

func setup(t *testing.T) testApp {
	t.Helper()
	database := os.Getenv("TEST_DATABASE_URL")
	if database == "" {
		database = "postgres://fintrack:fintrack@127.0.0.1:5432/fintrack_test"
	}
	parsed, err := url.Parse(database)
	if err != nil || !strings.HasSuffix(parsed.Path, "_test") {
		t.Fatal("Tests require a database whose name ends with _test")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	namespace := "ft_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, `CREATE SCHEMA "`+namespace+`"`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	params := parsed.Query()
	params.Set("search_path", namespace)
	parsed.RawQuery = params.Encode()
	var pool *pgxpool.Pool
	t.Cleanup(func() {
		if pool != nil {
			pool.Close()
		}
		_, err := admin.Exec(ctx, `DROP SCHEMA "`+namespace+`" CASCADE`)
		if err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	pool, err = store.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal("Migration is not idempotent:", err)
	}
	server := &Server{Pool: pool, Now: func() time.Time { return time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC) }}
	return testApp{handler: server.NewHandler(), server: server}
}

func (app testApp) call(method, path string, body any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	return response
}

func object(t *testing.T, response *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if response.Code != status {
		t.Fatalf("Expected %d, got %d: %s", status, response.Code, response.Body.String())
	}
	result := map[string]any{}
	if status != 204 {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func person(t *testing.T, app testApp) string {
	t.Helper()
	id := uuid.NewString()
	object(t, app.call("POST", "/api/v1/profiles", map[string]any{"id": id, "name": "Алексей"}), 201)
	return id
}

func operation(t *testing.T, app testApp, p, kind, amount string) map[string]any {
	t.Helper()
	rows := object(t, app.call("GET", "/api/v1/profiles/"+p+"/categories", nil), 200)["items"].([]any)
	for _, item := range rows {
		category := item.(map[string]any)
		if category["type"] == kind {
			return map[string]any{"id": uuid.NewString(), "type": kind, "amount_minor": amount, "category_id": category["id"], "occurred_on": "2026-10-13", "note": ""}
		}
	}
	t.Fatal("Category missing")
	return nil
}

func TestFinancialLifecycle(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "opening_balance_minor": "1000000"}), 200)
	object(t, app.call("POST", base+"/transactions", operation(t, app, p, "income", "3000000")), 201)
	expense := operation(t, app, p, "expense", "125050")
	object(t, app.call("POST", base+"/transactions", expense), 201)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "2000000"}), 201)
	totals := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if totals["balance_minor"] != "3874950" || totals["income_minor"] != "3000000" || totals["expense_minor"] != "125050" {
		t.Fatal(totals)
	}
	budget := totals["budget"].(map[string]any)
	if budget["remaining_minor"] != "1874950" || budget["days_remaining"] != float64(19) {
		t.Fatal(budget)
	}
	path := base + "/transactions/" + expense["id"].(string)
	changed := object(t, app.call("PATCH", path, map[string]any{"amount_minor": "100000", "version": 1}), 200)
	if changed["version"] != float64(2) {
		t.Fatal(changed)
	}
	if object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)["balance_minor"] != "3900000" {
		t.Fatal("Changed balance")
	}
	object(t, app.call("DELETE", path+"?version=1", nil), 409)
	object(t, app.call("DELETE", path+"?version=2", nil), 204)
	object(t, app.call("DELETE", path+"?version=2", nil), 204)
	totals = object(t, app.call("GET", base+"/summary?month=2026-09", nil), 200)
	if totals["balance_minor"] != "4000000" || totals["expense_minor"] != "0" || totals["income_minor"] != "0" {
		t.Fatal(totals)
	}
}

func TestIdempotencyAndDeletion(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	object(t, app.call("POST", "/api/v1/profiles", map[string]any{"id": p, "name": "Алексей"}), 200)
	object(t, app.call("POST", "/api/v1/profiles", map[string]any{"id": p, "name": "Другой"}), 409)
	body := operation(t, app, p, "expense", "1")
	object(t, app.call("POST", base+"/transactions", body), 201)
	object(t, app.call("POST", base+"/transactions", body), 200)
	body["amount_minor"] = "2"
	object(t, app.call("POST", base+"/transactions", body), 409)
	rows := object(t, app.call("GET", base+"/transactions", nil), 200)["items"].([]any)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	object(t, app.call("DELETE", base+"/transactions/"+body["id"].(string)+"?version=1", nil), 204)
	object(t, app.call("POST", base+"/transactions", body), 410)
}

func TestConcurrentDuplicates(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	body := operation(t, app, p, "expense", "123")
	codes := make(chan int, 4)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() { codes <- app.call("POST", "/api/v1/profiles/"+p+"/transactions", body).Code })
	}
	wg.Wait()
	close(codes)
	statuses := []int{}
	for code := range codes {
		statuses = append(statuses, code)
	}
	sort.Ints(statuses)
	if !slices.Equal(statuses, []int{200, 200, 200, 201}) {
		t.Fatal(statuses)
	}
	rows := object(t, app.call("GET", "/api/v1/profiles/"+p+"/transactions", nil), 200)["items"].([]any)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
}

func TestConcurrentProfileCreation(t *testing.T) {
	app := setup(t)
	body := map[string]any{"id": uuid.NewString(), "name": "Один профиль"}
	codes := make(chan int, 3)
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() { codes <- app.call("POST", "/api/v1/profiles", body).Code })
	}
	wg.Wait()
	close(codes)
	statuses := []int{}
	for code := range codes {
		statuses = append(statuses, code)
	}
	sort.Ints(statuses)
	if !slices.Equal(statuses, []int{200, 200, 201}) {
		t.Fatal(statuses)
	}
	categories := object(t, app.call("GET", "/api/v1/profiles/"+body["id"].(string)+"/categories", nil), 200)["items"].([]any)
	if len(categories) != 13 {
		t.Fatal(categories)
	}
}

func TestProfileIsolationAndCategoryArchive(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	other := person(t, app)
	base := "/api/v1/profiles/" + p
	otherBase := "/api/v1/profiles/" + other
	body := operation(t, app, p, "expense", "125050")
	object(t, app.call("POST", otherBase+"/transactions", body), 404)
	object(t, app.call("POST", base+"/transactions", body), 201)
	path := base + "/transactions/" + body["id"].(string)
	object(t, app.call("GET", otherBase+"/transactions/"+body["id"].(string), nil), 404)
	object(t, app.call("PATCH", otherBase+"/transactions/"+body["id"].(string), map[string]any{"version": 1, "note": "x"}), 404)
	if object(t, app.call("GET", otherBase+"/summary?month=2026-10", nil), 200)["balance_minor"] != "0" {
		t.Fatal("Cross profile totals")
	}
	cat := base + "/categories/" + body["category_id"].(string)
	object(t, app.call("PATCH", cat, map[string]any{"is_archived": true}), 200)
	body["id"] = uuid.NewString()
	object(t, app.call("POST", base+"/transactions", body), 409)
	object(t, app.call("PATCH", path, map[string]any{"note": "Архивная категория сохранена", "version": 1}), 200)
	object(t, app.call("PATCH", cat, map[string]any{"type": "income"}), 422)
	object(t, app.call("PATCH", cat, map[string]any{"is_archived": false}), 200)
	body["type"] = "income"
	object(t, app.call("POST", base+"/transactions", body), 422)
}

func TestValidationAndErrors(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	cases := []struct {
		key   string
		value any
	}{
		{"amount_minor", "0"}, {"amount_minor", 100}, {"amount_minor", "1.01"},
		{"amount_minor", "999999999999"}, {"note", nil},
		{"occurred_on", "2026-10-14"}, {"occurred_on", "2026-09-30"},
		{"occurred_on", "0000-01-01"}, {"surprise", true}, {"Type", "expense"},
	}
	for _, test := range cases {
		t.Run(test.key+"_"+strings.ReplaceAll(string(mustJSON(test.value)), "/", ""), func(t *testing.T) {
			body := operation(t, app, p, "expense", "100")
			body[test.key] = test.value
			response := object(t, app.call("POST", base+"/transactions", body), 422)
			if response["error"].(map[string]any)["request_id"] == "" {
				t.Fatal(response)
			}
		})
	}
	object(t, app.call("GET", base+"/summary?month=0000-01", nil), 422)
	object(t, app.call("GET", base+"/summary?month=9999-12", nil), 422)
	object(t, app.call("GET", "/api/v1/missing", nil), 404)
	request := httptest.NewRequest("POST", "/api/v1/profiles", strings.NewReader("{"))
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	object(t, response, 400)
	object(t, app.call("GET", "/health/ready", nil), 200)
}

func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }

func TestPaginationSearchAndCSV(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	for i := range 4 {
		body := operation(t, app, p, "expense", "125050")
		body["note"] = "обычная 100%_ покупка"
		if i == 3 {
			body["note"] = "=SUM(1;2)\n\"проверка\""
		}
		object(t, app.call("POST", base+"/transactions", body), 201)
	}
	first := object(t, app.call("GET", base+"/transactions?limit=2", nil), 200)
	if first["has_more"] != true {
		t.Fatal(first)
	}
	second := object(t, app.call("GET", base+"/transactions?limit=2&cursor="+url.QueryEscape(first["next_cursor"].(string)), nil), 200)
	if second["has_more"] != false {
		t.Fatal(second)
	}
	seen := map[string]bool{}
	for _, page := range []map[string]any{first, second} {
		for _, row := range page["items"].([]any) {
			seen[row.(map[string]any)["id"].(string)] = true
		}
	}
	if len(seen) != 4 {
		t.Fatal(seen)
	}
	object(t, app.call("GET", base+"/transactions?q=other&cursor="+url.QueryEscape(first["next_cursor"].(string)), nil), 400)
	filtered := object(t, app.call("GET", base+"/transactions?q="+url.QueryEscape("100%_"), nil), 200)
	if len(filtered["items"].([]any)) != 3 {
		t.Fatal(filtered)
	}
	response := app.call("GET", base+"/exports/transactions.csv", nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if !bytes.HasPrefix(response.Body.Bytes(), []byte{0xef, 0xbb, 0xbf}) {
		t.Fatal("Missing BOM")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(response.Body.String(), "\ufeff")))
	reader.Comma = ';'
	rows, err := reader.ReadAll()
	if err != nil || len(rows) != 5 {
		t.Fatal(err, rows)
	}
	safe := false
	for _, row := range rows[1:] {
		if strings.HasPrefix(row[7], "'=SUM") {
			safe = true
		}
		if row[5] != "1250,50" {
			t.Fatal(row)
		}
	}
	if !safe {
		t.Fatal("CSV formula not escaped")
	}
}

func TestBudgetsAndTrackingStart(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	if object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)["budget"] != nil {
		t.Fatal("Missing budget should be null")
	}
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "500000"}), 201)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "600000"}), 409)
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "600000", "version": 1}), 200)
	object(t, app.call("DELETE", base+"/budgets/2026-10?version=2", nil), 204)
	body := operation(t, app, p, "expense", "100")
	body["occurred_on"] = "2026-10-10"
	object(t, app.call("POST", base+"/transactions", body), 201)
	object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "tracking_start_date": "2026-10-11"}), 409)
	object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "tracking_start_date": "2026-10-14"}), 422)
}

func TestCategoryUniquenessAndUnicode(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p + "/categories"
	body := map[string]any{"id": uuid.NewString(), "name": "Книги", "type": "expense", "icon": "bag", "color": "#69805D"}
	object(t, app.call("POST", base, body), 201)
	object(t, app.call("POST", base, body), 200)
	body["id"] = uuid.NewString()
	body["name"] = "  книги "
	object(t, app.call("POST", base, body), 409)
	body["id"] = uuid.NewString()
	body["name"] = strings.Repeat("ﬃ", 50)
	object(t, app.call("POST", base, body), 201)
}

func TestCanceledRequest(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	request := httptest.NewRequest("GET", "/api/v1/profiles/"+p, nil)
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request.WithContext(ctx))
	object(t, response, 503)
}

func TestExactLargeAggregate(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	body := operation(t, app, p, "expense", "99999999999")
	_, err := app.server.Pool.Exec(context.Background(), `INSERT INTO transactions(id,profile_id,wallet_id,category_id,type,amount_minor,occurred_on,note,source,version,created_at,updated_at)
      SELECT gen_random_uuid(),$1,w.id,$2,'expense',99999999999,'2026-10-13','large aggregate','manual',1,now(),now() FROM wallets w CROSS JOIN generate_series(1,100000) WHERE w.profile_id=$1`, p, body["category_id"])
	if err != nil {
		t.Fatal(err)
	}
	totals := object(t, app.call("GET", "/api/v1/profiles/"+p+"/summary?month=2026-10", nil), 200)
	if totals["expense_minor"] != "9999999999900000" || totals["balance_minor"] != "-9999999999900000" {
		t.Fatal(totals)
	}
}

func TestBudgetMathBoundaries(t *testing.T) {
	for _, test := range []struct {
		date string
		days int
	}{{"2024-02-28", 2}, {"2024-02-29", 1}, {"2026-10-31", 1}} {
		t.Run(test.date, func(t *testing.T) {
			current, _ := time.Parse(time.DateOnly, test.date)
			month := time.Date(current.Year(), current.Month(), 1, 0, 0, 0, 0, time.UTC)
			result := budgetSummary(exact("10001"), exact("0"), month, current)
			if result["days_remaining"] != test.days {
				t.Fatal(result)
			}
		})
	}
	month, _ := time.Parse("2006-01", "2026-10")
	current, _ := time.Parse(time.DateOnly, "2026-10-13")
	result := budgetSummary(exact("500000"), exact("600000"), month, current)
	if result["remaining_minor"] != "-100000" || result["used_percent"] != "120.0" || result["daily_available_minor"] != "0" {
		t.Fatal(result)
	}
	result = budgetSummary(exact("500000"), exact("0"), month.AddDate(0, -1, 0), current)
	if result["daily_available_minor"] != nil {
		t.Fatal(result)
	}
}
