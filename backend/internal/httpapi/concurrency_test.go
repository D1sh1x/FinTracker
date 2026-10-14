package httpapi

import (
	"slices"
	"sort"
	"sync"
	"testing"
)

func TestConcurrentVersionUpdates(t *testing.T) {
	app := setup(t)
	p := person(t, app)
	body := operation(t, app, p, "expense", "1000")
	path := "/api/v1/profiles/" + p + "/transactions"
	object(t, app.call("POST", path, body), 201)
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, amount := range []string{"1200", "1300"} {
		wg.Go(func() {
			codes <- app.call("PATCH", path+"/"+body["id"].(string), map[string]any{"version": 1, "amount_minor": amount}).Code
		})
	}
	wg.Wait()
	close(codes)
	statuses := []int{}
	for code := range codes {
		statuses = append(statuses, code)
	}
	sort.Ints(statuses)
	if !slices.Equal(statuses, []int{200, 409}) {
		t.Fatal(statuses)
	}
	row := object(t, app.call("GET", path+"/"+body["id"].(string), nil), 200)
	if row["version"] != float64(2) {
		t.Fatal(row)
	}
}

func TestProfileTimezoneValidation(t *testing.T) {
	app := setup(t)
	for _, zone := range []string{"", "Local", "Unknown/Zone"} {
		object(t, app.call("POST", "/api/v1/profiles", map[string]any{"id": "519bcf15-7ffb-4de7-9db7-1dcc77d312fe", "name": "Проверка", "timezone": zone}), 422)
	}
}
