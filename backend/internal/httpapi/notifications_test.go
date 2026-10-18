package httpapi

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func pushBody(t *testing.T, app testApp, p string) map[string]any {
	t.Helper()
	wallet := object(t, app.call("GET", "/api/v1/profiles/"+p+"/wallet", nil), 200)
	return map[string]any{"id": uuid.NewString(), "wallet_id": wallet["id"], "package_name": "ru.wildberries.bank", "text": "Покупка 43 ₽ по карте *7055 Транспорт Краснодара. Доступно 933,48 ₽", "posted_at": "2026-10-13T09:40:00Z"}
}

func TestNotificationImportLifecycle(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	base := "/api/v1/profiles/" + p
	path := base + "/notification-imports"
	body := pushBody(t, app, p)
	receipt := object(t, app.call("POST", path, body), 201)
	id := receipt["transaction_id"].(string)
	row := object(t, app.call("GET", base+"/transactions/"+id, nil), 200)
	if row["amount_minor"] != "4300" || row["note"] != "Транспорт Краснодара" || row["source"] != "notification" {
		t.Fatalf("wrong transaction: %+v", row)
	}
	var category string
	if err := app.server.Pool.QueryRow(context.Background(), "SELECT name FROM categories WHERE id=$1", row["category_id"]).Scan(&category); err != nil || category != "Транспорт" {
		t.Fatalf("category %s %v", category, err)
	}
	object(t, app.call("PATCH", base+"/transactions/"+id, map[string]any{"version": 1, "note": "Исправлено"}), 200)
	if replay := object(t, app.call("POST", path, body), 200); replay["transaction_id"] != id {
		t.Fatal("replay changed receipt")
	}
	object(t, app.call("DELETE", base+"/transactions/"+id+"?version=2", nil), 204)
	object(t, app.call("POST", path, body), 200)
	body["text"] = "Покупка 44 ₽ по карте *7055 Транспорт Краснодара"
	object(t, app.call("POST", path, body), 409)
	other := person(t, app)
	object(t, app.call("POST", "/api/v1/profiles/"+other+"/notification-imports", body), 409)
	body["id"] = uuid.NewString()
	body["text"] = "Покупка 43 ₽ по карте *7055 Непонятный магазин"
	newReceipt := object(t, app.call("POST", path, body), 201)
	newRow := object(t, app.call("GET", base+"/transactions/"+newReceipt["transaction_id"].(string), nil), 200)
	if err := app.server.Pool.QueryRow(context.Background(), "SELECT name FROM categories WHERE id=$1", newRow["category_id"]).Scan(&category); err != nil || category != "Не определено" {
		t.Fatalf("unknown fallback %s %v", category, err)
	}
}

func TestNotificationConcurrentReplayAndEqualPurchases(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	path := "/api/v1/profiles/" + p + "/notification-imports"
	body := pushBody(t, app, p)
	var group sync.WaitGroup
	codes := make(chan int, 6)
	for i := 0; i < 6; i++ {
		group.Go(func() { codes <- app.call("POST", path, body).Code })
	}
	group.Wait()
	close(codes)
	created := 0
	for code := range codes {
		if code == 201 {
			created++
		} else if code != 200 {
			t.Fatalf("unexpected replay status %d", code)
		}
	}
	if created != 1 {
		t.Fatalf("created %d", created)
	}
	body["id"] = uuid.NewString()
	object(t, app.call("POST", path, body), 201)
	rows := object(t, app.call("GET", "/api/v1/profiles/"+p+"/transactions", nil), 200)["items"].([]any)
	if len(rows) != 2 {
		t.Fatalf("equal real purchases lost or duplicated: %d", len(rows))
	}
}

func TestNotificationRejectsUnrecognizedAndWrongAccount(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	path := "/api/v1/profiles/" + p + "/notification-imports"
	body := pushBody(t, app, p)
	body["package_name"] = "ru.nspk.mirpay"
	object(t, app.call("POST", path, body), 422)
	body["package_name"] = "ru.wildberries.bank"
	body["text"] = "Доступно 933,48 ₽"
	object(t, app.call("POST", path, body), 422)
	body["text"] = "Покупка 43 ₽ по карте *7055 Магнит"
	body["posted_at"] = "2026-10-14T12:00:00Z"
	object(t, app.call("POST", path, body), 422)
	body["posted_at"] = "2026-10-13T09:40:00Z"
	other := person(t, app)
	body["wallet_id"] = pushBody(t, app, other)["wallet_id"]
	object(t, app.call("POST", path, body), 404)
}
