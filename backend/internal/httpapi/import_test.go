package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"fintrack/internal/importlab"
	"github.com/google/uuid"
)

func importPNG(t *testing.T, value uint8) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 2, 2))
	img.SetGray(0, 0, color.Gray{Y: value})
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func uploadFixture(t *testing.T, app testApp, p string, data []byte, date string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", "screen.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = writer.WriteField("capture_date", date)
	_ = writer.Close()
	request := httptest.NewRequest("POST", "/api/v1/profiles/"+p+"/imports", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	return response
}

func importJob(t *testing.T, response *httptest.ResponseRecorder, status int) ScreenshotImport {
	t.Helper()
	object(t, response, status)
	var job ScreenshotImport
	if err := json.Unmarshal(response.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	return job
}

func importApp(t *testing.T) (testApp, string) {
	app := setup(t)
	p := person(t, app)
	app.server.ImportWorker = &ImportWorker{}
	app.server.ProcessImport = func(ctx context.Context, data []byte, capture string, categories []importlab.Category) (importlab.Result, error) {
		rows, err := importlab.Parse(capture+"\nКафе −1250,50 ₽\nВходящий перевод +500 ₽", capture)
		if err != nil {
			return importlab.Result{}, err
		}
		for _, category := range categories {
			if category.Name == "Кафе" {
				rows[0].CategoryID = category.ID
				rows[0].CategoryName = category.Name
			}
		}
		rows[1].CategoryID = importlab.UnknownCategory
		rows[1].CategoryName = "Не определено"
		return importlab.Result{Rows: rows, Warnings: []string{}, Lines: []importlab.OCRLine{}, Model: "fixture"}, nil
	}
	return app, p
}

func readyFixture(t *testing.T, app testApp, p string, value uint8) ScreenshotImport {
	t.Helper()
	queued := importJob(t, uploadFixture(t, app, p, importPNG(t, value), "2026-10-13"), 202)
	if queued.Status != "queued" || len(queued.Result.Rows) != 0 {
		t.Fatal(queued)
	}
	if worked, err := app.server.ProcessNextImport(context.Background()); err != nil || !worked {
		t.Fatal(worked, err)
	}
	job := importJob(t, app.call("GET", "/api/v1/profiles/"+p+"/imports/"+queued.ID, nil), 200)
	if job.Status != "ready" || len(job.Result.Rows) != 2 || job.Result.Rows[1].CategoryID == "" {
		t.Fatal(job)
	}
	return job
}

func selectedFixture(job ScreenshotImport) importConfirmInput {
	body := importConfirmInput{Version: job.Version, Rows: []importSelection{}}
	for _, row := range job.Result.Rows {
		body.Rows = append(body.Rows, importSelection{ID: row.ID})
	}
	return body
}

func TestScreenshotFinancialLifecycleAndReplay(t *testing.T) {
	app, p := importApp(t)
	base := "/api/v1/profiles/" + p
	job := readyFixture(t, app, p, 1)
	path := base + "/imports/" + job.ID
	before := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if before["expense_minor"] != "0" {
		t.Fatal(before)
	}
	object(t, app.call("PUT", base+"/budgets/2026-10", map[string]any{"limit_minor": "100000"}), 201)
	object(t, app.call("PUT", base+"/category-budgets/2026-10/"+job.Result.Rows[0].CategoryID, map[string]any{"limit_minor": "100000"}), 201)
	body := selectedFixture(job)
	receipt := object(t, app.call("POST", path+"/confirm", body), 200)
	totals := object(t, app.call("GET", base+"/summary?month=2026-10", nil), 200)
	if totals["expense_minor"] != "125050" || totals["income_minor"] != "50000" || totals["balance_minor"] != "-75050" || totals["budget"].(map[string]any)["remaining_minor"] != "-25050" {
		t.Fatal(totals)
	}
	items := receipt["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["source"] != "screenshot" {
		t.Fatal(receipt)
	}
	if got := object(t, app.call("POST", path+"/confirm", body), 200); !bytes.Equal(mustJSON(got), mustJSON(receipt)) {
		t.Fatal(got, receipt)
	}
	duplicate := importJob(t, uploadFixture(t, app, p, importPNG(t, 1), "2026-10-13"), 200)
	if duplicate.ID != job.ID || duplicate.Status != "confirmed" {
		t.Fatal(duplicate)
	}
	body.Rows = body.Rows[:1]
	object(t, app.call("POST", path+"/confirm", body), 409)
	body = selectedFixture(job)
	tid := items[0].(map[string]any)["id"].(string)
	object(t, app.call("DELETE", base+"/transactions/"+tid+"?version=1", nil), 204)
	object(t, app.call("POST", path+"/confirm", body), 200)
	if count := len(object(t, app.call("GET", base+"/transactions", nil), 200)["items"].([]any)); count != 1 {
		t.Fatal(count)
	}
}

func TestScreenshotDuplicatesRequireExplicitOverride(t *testing.T) {
	app, p := importApp(t)
	job := readyFixture(t, app, p, 2)
	base := "/api/v1/profiles/" + p
	path := base + "/imports/" + job.ID
	row := job.Result.Rows[0]
	object(t, app.call("POST", base+"/transactions", operationInput{ID: uuid.NewString(), Type: row.Type, Amount: *row.Amount, Date: *row.Date, CategoryID: row.CategoryID}), 201)
	current := importJob(t, app.call("GET", path, nil), 200)
	if len(current.Duplicates[row.ID]) != 1 {
		t.Fatal(current)
	}
	body := selectedFixture(job)
	object(t, app.call("POST", path+"/confirm", body), 409)
	if count := len(object(t, app.call("GET", base+"/transactions", nil), 200)["items"].([]any)); count != 1 {
		t.Fatal(count)
	}
	body.Rows[0].AllowDuplicate = true
	object(t, app.call("POST", path+"/confirm", body), 200)
}

func TestScreenshotAtomicValidationVersionsAndProfileIsolation(t *testing.T) {
	app, p := importApp(t)
	other := person(t, app)
	job := readyFixture(t, app, p, 3)
	path := "/api/v1/profiles/" + p + "/imports/" + job.ID
	object(t, app.call("GET", "/api/v1/profiles/"+other+"/imports/"+job.ID, nil), 404)
	edits := importEditInput{Version: job.Version, Rows: []importEditRow{}}
	for _, row := range job.Result.Rows {
		edits.Rows = append(edits.Rows, importEditRow{ID: row.ID, Description: row.Description, Type: row.Type, Amount: row.Amount, Date: row.Date, CategoryID: row.CategoryID})
	}
	future := "2026-10-14"
	edits.Rows[1].Date = &future
	changed := importJob(t, app.call("PATCH", path+"/rows", edits), 200)
	object(t, app.call("PATCH", path+"/rows", edits), 409)
	object(t, app.call("POST", path+"/confirm", selectedFixture(changed)), 422)
	if count := len(object(t, app.call("GET", "/api/v1/profiles/"+p+"/transactions", nil), 200)["items"].([]any)); count != 0 {
		t.Fatal(count)
	}
	body := selectedFixture(changed)
	body.Rows = body.Rows[:1]
	receipt := object(t, app.call("POST", path+"/confirm", body), 200)
	if len(receipt["items"].([]any)) != 1 {
		t.Fatal(receipt)
	}
}

func TestConcurrentScreenshotConfirmationDoesNotDuplicate(t *testing.T) {
	app, p := importApp(t)
	job := readyFixture(t, app, p, 4)
	body := selectedFixture(job)
	path := "/api/v1/profiles/" + p + "/imports/" + job.ID + "/confirm"
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 4)
	for range 4 {
		wg.Go(func() { responses <- app.call("POST", path, body) })
	}
	wg.Wait()
	close(responses)
	for response := range responses {
		object(t, response, 200)
	}
	if count := len(object(t, app.call("GET", "/api/v1/profiles/"+p+"/transactions", nil), 200)["items"].([]any)); count != 2 {
		t.Fatal(count)
	}
}

func TestScreenshotCancellationAndRetry(t *testing.T) {
	app, p := importApp(t)
	data := importPNG(t, 5)
	queued := importJob(t, uploadFixture(t, app, p, data, "2026-10-13"), 202)
	path := "/api/v1/profiles/" + p + "/imports/" + queued.ID
	entered := make(chan struct{})
	done := make(chan error, 1)
	app.server.ProcessImport = func(ctx context.Context, _ []byte, _ string, _ []importlab.Category) (importlab.Result, error) {
		close(entered)
		<-ctx.Done()
		return importlab.Result{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _, err := app.server.ProcessNextImport(ctx); done <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	cancelled := importJob(t, app.call("POST", path+"/cancel", importVersionInput{Version: queued.Version}), 200)
	if cancelled.Status != "cancelled" {
		t.Fatal(cancelled)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not cancel")
	}
	current := importJob(t, app.call("GET", path, nil), 200)
	if current.Status != "cancelled" {
		t.Fatal(current)
	}
	retry := importJob(t, uploadFixture(t, app, p, data, "2026-10-13"), 202)
	if retry.ID != queued.ID || retry.Version <= cancelled.Version || retry.Status != "queued" {
		t.Fatal(retry)
	}
}

func TestScreenshotExpiredLeaseIsRecovered(t *testing.T) {
	app, p := importApp(t)
	queued := importJob(t, uploadFixture(t, app, p, importPNG(t, 6), "2026-10-13"), 202)
	_, err := app.server.Pool.Exec(context.Background(), "UPDATE screenshot_imports SET status='processing',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1", queued.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := app.server.ProcessNextImport(context.Background()); err != nil || !worked {
		t.Fatal(worked, err)
	}
	job := importJob(t, app.call("GET", "/api/v1/profiles/"+p+"/imports/"+queued.ID, nil), 200)
	if job.Status != "ready" {
		t.Fatal(job)
	}
	var imageGone bool
	if err := app.server.Pool.QueryRow(context.Background(), "SELECT image IS NULL FROM screenshot_imports WHERE id=$1", job.ID).Scan(&imageGone); err != nil || !imageGone {
		t.Fatal(imageGone, err)
	}
}

func TestScreenshotRejectsInvalidUploadAndUnknownProfile(t *testing.T) {
	app, p := importApp(t)
	object(t, uploadFixture(t, app, p, []byte("not an image"), "2026-10-13"), 422)
	object(t, uploadFixture(t, app, p, importPNG(t, 7), "2026-10-14"), 422)
	object(t, uploadFixture(t, app, uuid.NewString(), importPNG(t, 7), "2026-10-13"), 404)
}

func TestExpiredScreenshotCanBeRetriedAfterSevenDays(t *testing.T) {
	app, p := importApp(t)
	data := importPNG(t, 8)
	queued := importJob(t, uploadFixture(t, app, p, data, "2026-10-13"), 202)
	_, err := app.server.Pool.Exec(context.Background(), "UPDATE screenshot_imports SET created_at=now()-interval '8 days',updated_at=now()-interval '8 days' WHERE id=$1", queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := app.server.ProcessNextImport(context.Background()); err != nil || worked {
		t.Fatal(worked, err)
	}
	path := "/api/v1/profiles/" + p + "/imports/" + queued.ID
	if job := importJob(t, app.call("GET", path, nil), 200); job.Status != "failed" {
		t.Fatal(job)
	}
	retry := importJob(t, uploadFixture(t, app, p, data, "2026-10-13"), 202)
	if retry.ID != queued.ID {
		t.Fatal(retry)
	}
	if worked, err := app.server.ProcessNextImport(context.Background()); err != nil || !worked {
		t.Fatal(worked, err)
	}
	if job := importJob(t, app.call("GET", path, nil), 200); job.Status != "ready" {
		t.Fatal(job)
	}
}
