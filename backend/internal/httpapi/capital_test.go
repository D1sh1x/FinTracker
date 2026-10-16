package httpapi

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"fintrack/internal/store"
	"github.com/google/uuid"
)

func newTestAccount(t *testing.T, app testApp, p, kind, opening string) Account {
	t.Helper()
	response := app.call("POST", "/api/v1/profiles/"+p+"/accounts", accountInput{ID: uuid.NewString(), Name: "Счёт " + kind, Kind: kind, Opening: opening, Start: "2026-10-01"})
	object(t, response, 201)
	var account Account
	if err := json.Unmarshal(response.Body.Bytes(), &account); err != nil {
		t.Fatal(err)
	}
	return account
}
func capitalData(t *testing.T, app testApp, p string) map[string]any {
	t.Helper()
	return object(t, app.call("GET", "/api/v1/profiles/"+p+"/capital", nil), 200)
}
func TestCapitalTransfersAndValuationKeepBudgetSeparate(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	wallet := object(t, app.call("GET", base+"/wallet", nil), 200)
	primary := wallet["id"].(string)
	object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "opening_balance_minor": "1000000"}), 200)
	savings := newTestAccount(t, app, p, "savings", "0")
	investment := newTestAccount(t, app, p, "investment", "200000")
	for _, transfer := range []transferInput{{ID: uuid.NewString(), From: primary, To: savings.ID, Amount: "250000", Date: "2026-10-03"}, {ID: uuid.NewString(), From: primary, To: investment.ID, Amount: "50000", Date: "2026-10-04"}} {
		object(t, app.call("POST", base+"/transfers", transfer), 201)
		object(t, app.call("POST", base+"/transfers", transfer), 200)
	}
	data := capitalData(t, app, p)
	if data["total_minor"] != "1200000" || data["cash_minor"] != "950000" || data["investment_minor"] != "250000" {
		t.Fatal(data)
	}
	categories := object(t, app.call("GET", base+"/categories", nil), 200)["items"].([]any)
	var income, expense string
	for _, raw := range categories {
		c := raw.(map[string]any)
		if c["name"] == "Продукты" {
			expense = c["id"].(string)
		}
		if c["name"] == "Зарплата" {
			income = c["id"].(string)
		}
	}
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "8000"}), 201)
	object(t, app.call("POST", base+"/transactions", operationInput{ID: uuid.NewString(), WalletID: savings.ID, Type: "income", Amount: "50000", CategoryID: income, Date: "2026-10-05"}), 201)
	object(t, app.call("POST", base+"/transactions", operationInput{ID: uuid.NewString(), WalletID: primary, Type: "expense", Amount: "10000", CategoryID: expense, Date: "2026-10-05"}), 201)
	valuation := valuationInput{ID: uuid.NewString(), Amount: "300000", Expected: "250000", Version: 1}
	path := base + "/accounts/" + investment.ID + "/valuations"
	receipt := object(t, app.call("POST", path, valuation), 201)
	replay := object(t, app.call("POST", path, valuation), 200)
	if string(mustJSON(receipt)) != string(mustJSON(replay)) || receipt["delta_minor"] != "50000" {
		t.Fatal(receipt, replay)
	}
	data = capitalData(t, app, p)
	if data["total_minor"] != "1290000" || data["cash_minor"] != "990000" || data["investment_minor"] != "300000" {
		t.Fatal(data)
	}
	history := data["history"].([]any)
	if history[len(history)-1].(map[string]any)["balance_minor"] != "1290000" {
		t.Fatal(history)
	}
	summary := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if summary["balance_minor"] != "990000" || summary["income_minor"] != "50000" || summary["expense_minor"] != "10000" || summary["budget"].(map[string]any)["remaining_minor"] != "-2000" {
		t.Fatal(summary)
	}
	valuation.ID = uuid.NewString()
	object(t, app.call("POST", path, valuation), 409)
	valuation.Expected = "300000"
	valuation.Amount = "0"
	object(t, app.call("POST", path, valuation), 201)
	if data = capitalData(t, app, p); data["investment_minor"] != "0" || data["total_minor"] != "990000" {
		t.Fatal(data)
	}
}
func TestAccountsIsolationArchiveAndValidation(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	other := person(t, app)
	base := "/api/v1/profiles/" + p
	account := newTestAccount(t, app, p, "deposit", "100")
	foreign := newTestAccount(t, app, other, "cash", "100")
	original := accountInput{ID: account.ID, Name: account.Name, Kind: account.Kind, Opening: "100", Start: account.Start}
	object(t, app.call("POST", base+"/accounts", original), 200)
	original.Opening = "101"
	object(t, app.call("POST", base+"/accounts", original), 409)
	path := base + "/accounts/" + account.ID
	object(t, app.call("PATCH", path, accountPatch{Version: 2}), 409)
	archived := true
	object(t, app.call("PATCH", path, accountPatch{Version: 1, Archived: &archived}), 200)
	if capitalData(t, app, p)["total_minor"] != "100" {
		t.Fatal("Archive removed money")
	}
	transfer := transferInput{ID: uuid.NewString(), From: foreign.ID, To: account.ID, Amount: "1", Date: "2026-10-10"}
	object(t, app.call("POST", base+"/transfers", transfer), 404)
	wallet := object(t, app.call("GET", base+"/wallet", nil), 200)
	transfer.From = wallet["id"].(string)
	object(t, app.call("POST", base+"/transfers", transfer), 409)
	object(t, app.call("PATCH", base+"/accounts/"+transfer.From, accountPatch{Version: 1, Archived: &archived}), 409)
	object(t, app.call("PATCH", "/api/v1/profiles/"+other+"/accounts/"+account.ID, accountPatch{Version: 2}), 404)
	object(t, app.call("POST", path+"/valuations", valuationInput{ID: uuid.NewString(), Amount: "1", Expected: "100", Version: 2}), 422)
	bad := accountInput{ID: uuid.NewString(), Name: "Плохой счёт", Kind: "usd", Opening: "0", Start: "2026-10-01"}
	object(t, app.call("POST", base+"/accounts", bad), 422)
	bad.Kind = "investment"
	bad.Opening = "-1"
	object(t, app.call("POST", base+"/accounts", bad), 422)
	bad.Opening = "0"
	bad.Start = "2026-10-14"
	object(t, app.call("POST", base+"/accounts", bad), 422)
	if len(capitalData(t, app, other)["accounts"].([]any)) != 2 {
		t.Fatal("Cross-profile accounts")
	}
}
func TestTransferCancellationAndConcurrentReplay(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	a := newTestAccount(t, app, p, "cash", "99999999999")
	b := newTestAccount(t, app, p, "savings", "99999999999")
	transfer := transferInput{ID: uuid.NewString(), From: a.ID, To: b.ID, Amount: "12345", Date: "2026-10-12"}
	var wg sync.WaitGroup
	statuses := make(chan int, 4)
	for range 4 {
		wg.Go(func() { statuses <- app.call("POST", base+"/transfers", transfer).Code })
	}
	wg.Wait()
	close(statuses)
	created := 0
	for code := range statuses {
		if code == 201 {
			created++
		} else if code != 200 {
			t.Fatal(code)
		}
	}
	if created != 1 {
		t.Fatal(created)
	}
	items := object(t, app.call("GET", base+"/accounts", nil), 200)["items"].([]any)
	for _, raw := range items {
		item := raw.(map[string]any)
		if item["id"] == a.ID && item["balance_minor"] != "99999987654" {
			t.Fatal(item)
		}
		if item["id"] == b.ID && item["balance_minor"] != "100000012344" {
			t.Fatal(item)
		}
	}
	if capitalData(t, app, p)["total_minor"] != "199999999998" {
		t.Fatal("Total drift")
	}
	changed := transfer
	changed.Amount = "12346"
	object(t, app.call("POST", base+"/transfers", changed), 409)
	remove := base + "/transfers/" + transfer.ID
	object(t, app.call("DELETE", remove+"?version=2", nil), 409)
	object(t, app.call("DELETE", remove+"?version=1", nil), 204)
	object(t, app.call("DELETE", remove+"?version=1", nil), 204)
	object(t, app.call("POST", base+"/transfers", transfer), 410)
	if len(object(t, app.call("GET", base+"/transfers", nil), 200)["items"].([]any)) != 0 {
		t.Fatal("Deleted transfer visible")
	}
	if capitalData(t, app, p)["total_minor"] != "199999999998" {
		t.Fatal("Delete changed total")
	}
}
func TestTransferInvalidRequestsAreAtomic(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	a := newTestAccount(t, app, p, "cash", "1000")
	b := newTestAccount(t, app, p, "cash", "0")
	cases := []transferInput{{From: a.ID, To: a.ID, Amount: "1", Date: "2026-10-12"}, {From: a.ID, To: b.ID, Amount: "0", Date: "2026-10-12"}, {From: a.ID, To: b.ID, Amount: "1", Date: "2026-09-30"}, {From: a.ID, To: b.ID, Amount: "1", Date: "2026-10-14"}}
	for _, body := range cases {
		body.ID = uuid.NewString()
		object(t, app.call("POST", base+"/transfers", body), 422)
	}
	if capitalData(t, app, p)["total_minor"] != "1000" {
		t.Fatal("Rejected transfer changed balances")
	}
}
func TestOperationAccountCanBeChangedAndScreenshotUsesSelectedAccount(t *testing.T) {
	app, p := importApp(t)
	base := "/api/v1/profiles/" + p
	account := newTestAccount(t, app, p, "savings", "0")
	job := readyFixture(t, app, p, 32)
	edits := importEditInput{Version: job.Version, WalletID: &account.ID, Rows: []importEditRow{}}
	for _, row := range job.Result.Rows {
		edits.Rows = append(edits.Rows, importEditRow{ID: row.ID, Description: row.Description, Type: row.Type, Amount: row.Amount, Date: row.Date, CategoryID: row.CategoryID})
	}
	job = importJob(t, app.call("PATCH", base+"/imports/"+job.ID+"/rows", edits), 200)
	reloaded := importJob(t, app.call("GET", base+"/imports/"+job.ID, nil), 200)
	if reloaded.WalletID != account.ID {
		t.Fatal("Draft lost selected account")
	}
	body := selectedFixture(job)
	receipt := object(t, app.call("POST", base+"/imports/"+job.ID+"/confirm", body), 200)["items"].([]any)
	for _, raw := range receipt {
		if raw.(map[string]any)["wallet_id"] != account.ID {
			t.Fatal(raw)
		}
	}
	primary := object(t, app.call("GET", base+"/wallet", nil), 200)["id"].(string)
	row := receipt[0].(map[string]any)
	object(t, app.call("PATCH", base+"/transactions/"+row["id"].(string), map[string]any{"version": 1, "wallet_id": primary}), 200)
	accounts := object(t, app.call("GET", base+"/accounts", nil), 200)["items"].([]any)
	for _, raw := range accounts {
		a := raw.(map[string]any)
		if a["id"] == account.ID && a["balance_minor"] != "50000" {
			t.Fatal(a)
		}
		if a["id"] == primary && a["balance_minor"] != "-125050" {
			t.Fatal(a)
		}
	}
}
func TestCapitalMigrationPreservesLegacyWallet(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	before := object(t, app.call("PATCH", base+"/wallet", map[string]any{"version": 1, "opening_balance_minor": "123456"}), 200)
	_, err := app.server.Pool.Exec(context.Background(), `DROP VIEW account_entries; DROP TABLE account_valuations; DROP TABLE account_transfers; ALTER TABLE screenshot_imports DROP COLUMN account_id; ALTER TABLE wallets DROP COLUMN kind CASCADE; ALTER TABLE wallets DROP COLUMN is_primary CASCADE; ALTER TABLE wallets DROP COLUMN is_archived; ALTER TABLE wallets ADD UNIQUE(profile_id); DELETE FROM schema_migrations WHERE version='0005';`)
	if err != nil {
		t.Fatal(err)
	}
	object(t, app.call("GET", "/health/ready", nil), 503)
	if err = store.Migrate(context.Background(), app.server.Pool); err != nil {
		t.Fatal(err)
	}
	after := object(t, app.call("GET", base+"/wallet", nil), 200)
	if after["id"] != before["id"] || after["opening_balance_minor"] != before["opening_balance_minor"] || after["version"] != before["version"] || after["is_primary"] != true {
		t.Fatal(before, after)
	}
	if capitalData(t, app, p)["total_minor"] != "123456" {
		t.Fatal("Migration changed capital")
	}
}

func TestConcurrentValuationsRejectStaleBalance(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	account := newTestAccount(t, app, p, "investment", "10000")
	path := "/api/v1/profiles/" + p + "/accounts/" + account.ID + "/valuations"
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			statuses <- app.call("POST", path, valuationInput{ID: uuid.NewString(), Amount: "20000", Expected: "10000", Version: 1}).Code
		})
	}
	wg.Wait()
	close(statuses)
	created, conflicts := 0, 0
	for code := range statuses {
		if code == 201 {
			created++
		} else if code == 409 {
			conflicts++
		} else {
			t.Fatal(code)
		}
	}
	if created != 1 || conflicts != 1 || capitalData(t, app, p)["total_minor"] != "20000" {
		t.Fatal(created, conflicts)
	}
}
