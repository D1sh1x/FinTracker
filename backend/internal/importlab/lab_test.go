package importlab

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseFinancialFields(t *testing.T) {
	rows, err := Parse("Баланс 99 000 ₽\n14 октября 2026\nПятёрочка −1 250,50 ₽\nЗарплата +45 000 RUB\nWildberries\n-2 400,5 ₽\nИтого 48 651 ₽", "2026-10-14")
	if err != nil || len(rows) != 3 {
		t.Fatal(rows, err)
	}
	if *rows[0].Amount != "125050" || rows[0].Type != "expense" || *rows[0].Date != "2026-10-14" || rows[0].Description != "Пятёрочка" {
		t.Fatal(rows[0])
	}
	if *rows[1].Amount != "4500000" || rows[1].Type != "income" {
		t.Fatal(rows[1])
	}
	if *rows[2].Amount != "240050" || rows[2].Description != "Wildberries" {
		t.Fatal(rows[2])
	}
}

func TestParserDoesNotInventDirectionOrDates(t *testing.T) {
	rows, err := Parse("Сегодня\nМагазин 500 ₽", "")
	if err != nil || len(rows) != 1 || rows[0].Date != nil || rows[0].Type != "unknown" || len(rows[0].Issues) != 2 {
		t.Fatal(rows, err)
	}
	rows, err = Parse("Вчера\nКафе -10,01 ₽", "2026-01-01")
	if err != nil || *rows[0].Date != "2025-12-31" {
		t.Fatal(rows, err)
	}
	rows, err = Parse("31.02.2026\nПокупка -100 ₽", "")
	if err != nil || rows[0].Date != nil {
		t.Fatal(rows, err)
	}
	rows, err = Parse("01.10.2026\nКомиссия -10 ₽, сумма -500 ₽", "")
	if err != nil || len(rows) != 1 || rows[0].Amount != nil || rows[0].Type != "unknown" {
		t.Fatal(rows, err)
	}
}

func TestParserLimits(t *testing.T) {
	for _, amount := range []string{"0", "1000000000", "999999999999999999999999999"} {
		rows, err := Parse("2026-10-14\nПокупка -"+amount+" ₽", "")
		if err != nil || len(rows) != 1 || rows[0].Amount != nil {
			t.Fatal(rows, err)
		}
	}
	if _, err := Parse(strings.Repeat("Покупка -1 ₽\n", 31), ""); err == nil {
		t.Fatal("accepted too many rows")
	}
	if _, err := Parse(strings.Repeat("a", 64001), ""); err == nil {
		t.Fatal("accepted too much text")
	}
	if _, err := Parse("Кафе -1 ₽", "not-a-date"); err == nil {
		t.Fatal("accepted invalid capture date")
	}
}

func TestParserUsesFixedRublesAndCleanAmountSuffix(t *testing.T) {
	for _, suffix := range []string{"", " P", "Р", " ₽", " RUB", " $"} {
		rows, err := Parse("2026-10-14\nКафе -100"+suffix, "")
		if err != nil || len(rows) != 1 || rows[0].Amount == nil || *rows[0].Amount != "10000" || rows[0].Description != "Кафе" || len(rows[0].Issues) != 0 {
			t.Fatal(suffix, rows, err)
		}
	}
}

func TestBankHistoryExcludesCashbackAndAccountNumbers(t *testing.T) {
	text := `История операций
Сегодня
© KpacHoe&benoe -187,58 P
Продукты +9 ©Э Карта --7055
Получатель А. +500 P
Переводы - СБП Счёт --7011
а Магнит -29,99 Р
Продукты +2 ©Э Карта --7055
Получатель А. +100 P
Переводы - СБП Счёт --7011
Той ramen -510 P
<
=) Фастфуд +26 ©Э Карта --7055
KHUD TOVARY -5Р
Книги и канцтовары Карта --7055
|= Digital Goods -1 799 P
Цифровые подписки Счёт --7011
Вчера
Континент -100 P
Платные дороги и парковки +5 ©Э Карта --7055`
	amounts := []string{"18758", "50000", "2999", "10000", "51000", "500", "179900", "10000"}
	types := []string{"expense", "income", "expense", "income", "expense", "expense", "expense", "expense"}
	labels := []string{"Продукты", "Переводы - СБП", "Продукты", "Переводы - СБП", "Фастфуд", "Книги и канцтовары", "Цифровые подписки", "Платные дороги и парковки"}
	rows, err := Parse(text, "")
	if err != nil || len(rows) != 8 {
		t.Fatal(rows, err)
	}
	for i, row := range rows {
		if row.Amount == nil || *row.Amount != amounts[i] || row.Type != types[i] || row.Date != nil || row.BankCategory != labels[i] || strings.Contains(row.Description, " · ") {
			t.Fatal(i, row)
		}
	}
	rows, err = Parse(text, "2026-01-01")
	if err != nil || *rows[0].Date != "2026-01-01" || *rows[7].Date != "2025-12-31" {
		t.Fatal(rows, err)
	}
}

func TestMaskedAccountsOutsideBankHistoryAreNotAmounts(t *testing.T) {
	rows, err := Parse("Карта ··7055\nСчёт --7011\nКафе -500 ₽ Карта ··7055", "")
	if err != nil || len(rows) != 1 || *rows[0].Amount != "50000" {
		t.Fatal(rows, err)
	}
}

func TestBankOrphanMetadataDoesNotCrossDateHeader(t *testing.T) {
	rows, err := Parse("История операций\nСегодня\nКафе -500 ₽\nВчера\nПродукты +9 вб Карта ··7055", "")
	if err != nil || len(rows) != 1 || rows[0].Description != "Кафе" {
		t.Fatal(rows, err)
	}
}

func TestBankTransfersWithoutPurposeDoNotCallModel(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	rows := []Row{{Description: "Получатель А. · Переводы - СБП", Type: "income"}, {Description: "Получатель Б. · Переводы · СБП", Type: "expense"}}
	metrics, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 0 || metrics.GeneratedTokens != 0 || rows[0].CategoryID != UnknownCategory || rows[1].CategoryID != UnknownCategory {
		t.Fatal(rows, metrics, warnings)
	}
}

func TestBankSubscriptionWithoutMatchingCategoryDoesNotCallModel(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	rows := []Row{{Description: "Digital Goods · Цифровые подписки", Type: "expense"}}
	metrics, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 0 || metrics.GeneratedTokens != 0 || rows[0].CategoryID != UnknownCategory || !strings.Contains(rows[0].Reason, "вручную") {
		t.Fatal(rows, metrics, warnings)
	}
}

func TestBankCategoryFieldKeepsUnknownPolicy(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	rows := []Row{{Description: "Получатель А.", BankCategory: "Переводы - СБП", Type: "income"}, {Description: "Digital Goods", BankCategory: "Цифровые подписки", Type: "expense"}}
	_, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 0 || rows[0].CategoryID != UnknownCategory || rows[1].CategoryID != UnknownCategory {
		t.Fatal(rows, warnings)
	}
}

func TestLongBankCategoryDoesNotDiscardAmount(t *testing.T) {
	rows, err := Parse("История операций\n2026-10-14\nКафе -510 P\n"+strings.Repeat("Длинная подпись ", 20)+"Карта --7055", "")
	if err != nil || len(rows) != 1 || len([]rune(rows[0].BankCategory)) != 120 || *rows[0].Amount != "51000" || rows[0].Description != "Кафе" || len(rows[0].Issues) != 1 {
		t.Fatal(rows, err)
	}
}

func TestNameRegionExcludesIconsAmountsAndSubtitles(t *testing.T) {
	words := []word{{text: "©", x: 40, y: 90, w: 100, h: 110}, {text: "Магнит", x: 190, y: 100, w: 130, h: 30, confidence: 96}, {text: "-29,99", x: 880, y: 100, w: 120, h: 30}, {text: "Продукты", x: 190, y: 160, w: 150, h: 30}, {text: "--7055", x: 880, y: 160, w: 120, h: 30}}
	line := OCRLine{Text: "© Магнит -29,99 P", Box: [4]int{40, 90, 1000, 200}}
	region, candidate, ok := nameRegion(words, line, image.Rect(0, 0, 1080, 2340))
	if !ok || candidate.text != "Магнит" || region.Min.X <= 140 || region.Max.X >= 880 || region.Max.Y >= 160 {
		t.Fatal(region, candidate, ok)
	}
}

func TestNameSelectionPreservesHighConfidenceAndObservedPunctuation(t *testing.T) {
	if got := chooseName(nameCandidate{"KpacHoe&benoe", 84}, nameCandidate{"КрасноебБелое", 77}); got.text != "Красное&Белое" {
		t.Fatal(got)
	}
	if got := chooseName(nameCandidate{"Digital Goods", 96}, nameCandidate{"Неверное имя", 75}); got.text != "Digital Goods" {
		t.Fatal(got)
	}
	if got := chooseName(nameCandidate{"Digital Goods", 96}, nameCandidate{"Неверное имя", 99}); got.text != "Digital Goods" {
		t.Fatal(got)
	}
	if got := chooseName(nameCandidate{"Магнит", 96}, nameCandidate{"-500 ₽", 99}); got.text != "Магнит" {
		t.Fatal(got)
	}
	if got := chooseName(nameCandidate{"Магнит", 96}, nameCandidate{"", 99}); got.text != "Магнит" {
		t.Fatal(got)
	}
}

func TestNameRefinementFailurePreservesBaselineAndCancellation(t *testing.T) {
	words := []word{{text: "Кафе", x: 190, y: 100, w: 100, h: 30, confidence: 96}, {text: "-510", x: 880, y: 100, w: 100, h: 30}}
	lines := []OCRLine{{Text: "Кафе -510 P", Box: [4]int{190, 100, 1000, 130}}}
	reader := func(context.Context, image.Image, string) (string, error) { return "", errors.New("unavailable") }
	if err := refineBankNames(context.Background(), image.NewGray(image.Rect(0, 0, 1080, 200)), words, lines, reader); err != nil || lines[0].Name != "Кафе" {
		t.Fatal(lines, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := refineBankNames(ctx, image.NewGray(image.Rect(0, 0, 1080, 200)), words, lines, reader); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestApplyingNamesCannotChangeFinancialFields(t *testing.T) {
	rows, err := Parse("История операций\nСегодня\nТой ramen -510 P\nФастфуд +26 вб Карта --7055", "2026-10-14")
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	source := rows[0].Source
	applyNames(rows, []OCRLine{{Text: "Той ramen -510 P", Name: "Tori ramen", NameConfidence: 96}})
	if rows[0].Description != "Tori ramen" || *rows[0].Amount != "51000" || rows[0].Type != "expense" || *rows[0].Date != "2026-10-14" || rows[0].BankCategory != "Фастфуд" || rows[0].Source != source {
		t.Fatal(rows)
	}
}

func modelFixture(t *testing.T, content, finish string) *Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["model"] != ModelName || request["response_format"] == nil {
			t.Error("missing model/schema")
		}
		output(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": 40, "completion_tokens": 10}, "timings": map[string]any{"predicted_ms": 100}})
	}))
	t.Cleanup(upstream.Close)
	return New(upstream.URL, "cpu", "")
}

func TestModelCategoriesAndFallback(t *testing.T) {
	s := modelFixture(t, `{"rows":[{"index":0,"category_id":"products","reason":"Продукты"},{"index":1,"category_id":"unknown","reason":"Состав покупки неизвестен"},{"index":2,"category_id":"salary","reason":"Зарплата"}]}`, "stop")
	rows := []Row{{Description: "Пятёрочка продукты", Type: "expense"}, {Description: "WB", Type: "expense"}, {Description: "Зарплата", Type: "income"}}
	if _, _, err := s.modelBatch(context.Background(), rows, []int{0, 1, 2}); err != nil {
		t.Fatal(err)
	}
	metrics, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 0 || rows[0].CategoryID != "products" || rows[1].CategoryName != "Не определено" || rows[2].CategoryID != "salary" || metrics.GeneratedTokens != 10 || metrics.TokensPerSecond != 100 {
		t.Fatal(rows, metrics, warnings)
	}
}

func TestKnownCategoryWithoutReasonHasCorrectLabel(t *testing.T) {
	s := modelFixture(t, `{"rows":[{"index":0,"category_id":"cafe","reason":""}]}`, "stop")
	rows := []Row{{Description: "Кофе в кафе", Type: "expense"}}
	_, warnings := s.classify(context.Background(), rows)
	if len(warnings) > 0 || rows[0].CategoryID != "cafe" || rows[0].Reason != "Категория предложена Qwen" {
		t.Fatal(rows, warnings)
	}
}

func TestProfileCatalogUsesUUIDAndPreservesMoney(t *testing.T) {
	const id = "a5b80719-0405-4b7d-8e3a-32e3e7ef5cb1"
	amount, date := "18758", "2026-10-14"
	for _, kind := range []string{"expense", "income"} {
		t.Run(kind, func(t *testing.T) {
			s := modelFixture(t, `{"rows":[{"index":0,"category_id":"`+id+`","reason":"Продукты"}]}`, "stop")
			s.Categories = []Category{{ID: UnknownCategory, Name: "Не определено", Type: "unknown"}, {ID: id, Name: "Продукты", Type: "expense"}}
			rows := []Row{{Description: "Магнит", Type: kind, Amount: &amount, Date: &date}}
			_, warnings := s.classify(context.Background(), rows)
			if len(warnings) != 0 || *rows[0].Amount != "18758" || *rows[0].Date != "2026-10-14" {
				t.Fatal(rows, warnings)
			}
			want := UnknownCategory
			if kind == "expense" {
				want = id
			}
			if rows[0].CategoryID != want {
				t.Fatal(rows)
			}
		})
	}
}

func TestInvalidModelOutputCannotAssignCategory(t *testing.T) {
	cases := []struct{ name, content, finish string }{
		{"unknown id", `{"rows":[{"index":0,"category_id":"invented","reason":""}]}`, "stop"},
		{"wrong direction", `{"rows":[{"index":0,"category_id":"salary","reason":""}]}`, "stop"},
		{"truncated", `{"rows":[{"index":0,"category_id":"products","reason":""}]}`, "length"},
		{"trailing output", `{"rows":[{"index":0,"category_id":"products","reason":""}]} MORE`, "stop"},
		{"missing row", `{"rows":[]}`, "stop"},
		{"bad index", `{"rows":[{"index":2,"category_id":"products","reason":""}]}`, "stop"},
		{"missing index", `{"rows":[{"category_id":"products","reason":""}]}`, "stop"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := modelFixture(t, tc.content, tc.finish)
			rows := []Row{{Description: "Описание", Type: "expense"}}
			_, warnings := s.classify(context.Background(), rows)
			if rows[0].CategoryName != "Не определено" {
				t.Fatal(rows, warnings)
			}
		})
	}
}

func TestMissingDirectionDoesNotCallModel(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	rows := []Row{{Description: "Покупка", Type: "unknown"}}
	_, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 0 || rows[0].CategoryID != UnknownCategory {
		t.Fatal(rows, warnings)
	}
}

func TestModelFailureAndCancellation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer upstream.Close()
	s := New(upstream.URL, "cpu", "")
	rows := []Row{{Description: "Описание", Type: "expense"}}
	_, warnings := s.classify(context.Background(), rows)
	if len(warnings) != 1 || rows[0].CategoryName != "Не определено" {
		t.Fatal(rows, warnings)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest("POST", "/api/lab/text", strings.NewReader(`{"text":"Кафе -500 ₽"}`)).WithContext(ctx)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != 408 {
		t.Fatal(response.Code, response.Body.String())
	}
}

func TestGateAndMultipart(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	s.Gate <- struct{}{}
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest("POST", "/api/lab/text", strings.NewReader(`{"text":"test"}`)))
	if response.Code != 429 {
		t.Fatal(response.Code)
	}
	<-s.Gate
	called := false
	s.OCR = func(ctx context.Context, data []byte) (string, []OCRLine, error) {
		called = true
		return "Кафе 500 ₽", []OCRLine{}, nil
	}
	var payload bytes.Buffer
	writer := multipart.NewWriter(&payload)
	part, _ := writer.CreateFormFile("image", "sample.png")
	_, _ = part.Write([]byte("fixture"))
	_ = writer.WriteField("capture_date", "2026-10-14")
	_ = writer.Close()
	request := httptest.NewRequest("POST", "/api/lab/analyze", &payload)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response = httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != 200 || !called {
		t.Fatal(response.Code, response.Body.String())
	}
	var result Result
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if len(result.Rows) != 1 || result.Rows[0].CategoryName != "Не определено" {
		t.Fatal(result)
	}
}

func TestMultipartRejectsOversizedAndUnknownFields(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	called := false
	s.OCR = func(context.Context, []byte) (string, []OCRLine, error) { called = true; return "", nil, nil }
	for _, field := range []string{"image", "unexpected"} {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		if field == "image" {
			part, _ := writer.CreateFormFile(field, "huge.png")
			_, _ = io.Copy(part, io.LimitReader(strings.NewReader(strings.Repeat("a", (10<<20)+1)), (10<<20)+1))
		} else {
			_ = writer.WriteField(field, "value")
		}
		_ = writer.Close()
		request := httptest.NewRequest("POST", "/api/lab/analyze", &body)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, request)
		if response.Code != 422 || called {
			t.Fatal(response.Code, called)
		}
	}
}

func TestTSVGeometryKeepsRowOrder(t *testing.T) {
	tsv := "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t2\t1\t1\t1\t300\t40\t70\t20\t90\t-500\n5\t1\t1\t1\t1\t1\t20\t40\t90\t20\t95\tКафе\n5\t1\t3\t1\t1\t1\t20\t80\t90\t20\t50\tВчера\n"
	lines := parseTSV(tsv)
	if len(lines) != 2 || lines[0].Text != "Кафе -500" || lines[1].Text != "Вчера" || lines[0].Box[2] != 370 || lines[1].Confidence != 50 {
		t.Fatal(lines)
	}
}

func TestOCRRejectsInvalidImage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := Tesseract(ctx, []byte("not an image")); err == nil {
		t.Fatal("accepted invalid image")
	}
}

func TestManualCorrectionsRefreshIssues(t *testing.T) {
	s := modelFixture(t, `{"rows":[{"index":0,"category_id":"cafe","reason":"Кафе"}]}`, "stop")
	request := httptest.NewRequest("POST", "/api/lab/classify", strings.NewReader(`{"rows":[{"id":"6e570d53-7fb1-4fd2-aeee-9f617c0e5a6c","description":"Кофе","type":"expense","amount_minor":"50000","date":"2026-10-14","issues":["Направление операции не определено"]}]}`))
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	var result Result
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	if response.Code != 200 || len(result.Rows) != 1 || len(result.Rows[0].Issues) != 0 || result.Rows[0].CategoryID != "cafe" {
		t.Fatal(response.Code, result)
	}
}

func TestManualInputRejectsBadMoneyAndDates(t *testing.T) {
	s := New("http://127.0.0.1:1", "cpu", "")
	for _, field := range []string{`"amount_minor":"abc"`, `"amount_minor":"-1"`, `"date":"2026-02-31"`} {
		body := `{"rows":[{"id":"r1","description":"Кофе","type":"expense",` + field + `}]}`
		request := httptest.NewRequest("POST", "/api/lab/classify", strings.NewReader(body))
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, request)
		if response.Code != 422 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}
