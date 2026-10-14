package httpapi

import (
	"context"
	"fmt"
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

func TestMeasuredPerformance(t *testing.T) {
	if os.Getenv("FINTRACK_BENCH") != "1" {
		t.Skip("Set FINTRACK_BENCH=1 for the 100000-row measurement")
	}
	app := setup(t)
	p := person(t, app)
	body := operation(t, app, p, "expense", "1000")
	_, err := app.server.Pool.Exec(context.Background(), `INSERT INTO transactions(id,profile_id,wallet_id,category_id,type,amount_minor,occurred_on,note,source,version,created_at,updated_at)
      SELECT gen_random_uuid(),$1,w.id,$2,'expense',1000,'2026-10-13','measurement','manual',1,now(),now() FROM wallets w CROSS JOIN generate_series(1,100000) WHERE w.profile_id=$1`, p, body["category_id"])
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/summary?month=2026-10", "/transactions?limit=50"} {
		path := "/api/v1/profiles/" + p + route
		object(t, app.call("GET", path, nil), 200)
		durations := make(chan time.Duration, 50)
		errors := make(chan string, 50)
		var wg sync.WaitGroup
		for range 5 {
			wg.Go(func() {
				for range 10 {
					started := time.Now()
					response := app.call("GET", path, nil)
					durations <- time.Since(started)
					if response.Code != 200 {
						errors <- fmt.Sprint(response.Code)
					}
				}
			})
		}
		wg.Wait()
		close(durations)
		close(errors)
		for failure := range errors {
			t.Error("Request failed:", failure)
		}
		values := []time.Duration{}
		for value := range durations {
			values = append(values, value)
		}
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		t.Logf("METRIC rows=100000 clients=5 route=%s p95_ms=%.1f requests=%d", route, float64(values[47].Microseconds())/1000, len(values))
	}
}
