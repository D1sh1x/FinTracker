package importlab

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

//go:embed web/*
var web embed.FS

type textInput struct {
	Text     string `json:"text"`
	Captured string `json:"capture_date"`
}
type rowsInput struct {
	Rows []Row `json:"rows"`
}

func New(modelURL, mode, spec string) *Server {
	return &Server{ModelURL: modelURL, Mode: mode, OpenAPIPath: spec, Client: &http.Client{Timeout: 100 * time.Second, Transport: http.DefaultTransport.(*http.Transport).Clone()}, Gate: make(chan struct{}, 1), OCR: Tesseract}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/lab/status", s.status)
	mux.HandleFunc("POST /api/lab/analyze", s.wrap(s.analyze))
	mux.HandleFunc("POST /api/lab/text", s.wrap(s.text))
	mux.HandleFunc("POST /api/lab/classify", s.wrap(s.reclassify))
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, s.OpenAPIPath) })
	files, _ := fs.Sub(web, "web")
	static := http.FileServer(http.FS(files))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, 404, "not_found", "Маршрут не найден")
			return
		}
		static.ServeHTTP(w, r)
	})
	return mux
}

func output(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	output(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (s *Server) wrap(handler func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.Gate <- struct{}{}:
			defer func() { <-s.Gate }()
		default:
			writeError(w, 429, "busy", "Уже выполняется тест. Дождитесь результата или отмените его.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		if err := handler(w, r); err != nil {
			if ctx.Err() != nil {
				writeError(w, 408, "cancelled", "Тест отменён или превышено время обработки")
				return
			}
			writeError(w, 422, "invalid_input", err.Error())
		}
	}
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.ModelURL, "/")+"/health", nil)
	ready := false
	if err == nil {
		response, err := s.Client.Do(request)
		if err == nil {
			ready = response.StatusCode == 200
			_ = response.Body.Close()
		}
	}
	message := "Qwen готов к тесту"
	if !ready {
		message = "Qwen загружается или недоступен. Запустите scripts/start-import-lab.ps1."
	}
	output(w, 200, map[string]any{"ready": ready, "model": "Qwen3-4B-Instruct-2507 Q4_K_M", "mode": s.Mode, "ocr": "Tesseract rus+eng", "message": message, "categories": Catalog})
}

func decodeInput(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("Некорректный JSON или неизвестное поле")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("Ожидается один JSON-объект")
	}
	return nil
}

func (s *Server) finish(w http.ResponseWriter, r *http.Request, result Result, started time.Time) error {
	metrics, warnings := s.classify(r.Context(), result.Rows)
	if err := r.Context().Err(); err != nil {
		return err
	}
	result.Warnings = append(result.Warnings, warnings...)
	result.Metrics.ModelMS = metrics.ModelMS
	result.Metrics.PromptTokens = metrics.PromptTokens
	result.Metrics.GeneratedTokens = metrics.GeneratedTokens
	result.Metrics.TokensPerSecond = metrics.TokensPerSecond
	result.Metrics.TotalMS = time.Since(started).Milliseconds()
	output(w, 200, result)
	return nil
}

func emptyResult() Result {
	return Result{Model: "Qwen3-4B-Instruct-2507 Q4_K_M", Lines: []OCRLine{}, Rows: []Row{}, Warnings: []string{}}
}

func (s *Server) text(w http.ResponseWriter, r *http.Request) error {
	started := time.Now()
	var body textInput
	if err := decodeInput(w, r, &body); err != nil {
		return err
	}
	if !utf8.ValidString(body.Text) || strings.TrimSpace(body.Text) == "" {
		return fmt.Errorf("Введите текст операций")
	}
	rows, err := Parse(body.Text, body.Captured)
	if err != nil {
		return err
	}
	result := emptyResult()
	result.Text = body.Text
	result.Rows = rows
	if len(rows) == 0 {
		result.Warnings = append(result.Warnings, "Строки с суммами не найдены. Проверьте текст или добавьте строку вручную.")
	}
	return s.finish(w, r, result, started)
}

func (s *Server) reclassify(w http.ResponseWriter, r *http.Request) error {
	started := time.Now()
	var body rowsInput
	if err := decodeInput(w, r, &body); err != nil {
		return err
	}
	if len(body.Rows) < 1 || len(body.Rows) > maxRows {
		return fmt.Errorf("Допускается от 1 до 30 строк")
	}
	seen := map[string]bool{}
	for i := range body.Rows {
		row := &body.Rows[i]
		if len(row.ID) < 1 || len(row.ID) > 64 || seen[row.ID] || !utf8.ValidString(row.Description) || utf8.RuneCountInString(row.Description) > 500 || utf8.RuneCountInString(row.BankCategory) > 120 {
			return fmt.Errorf("Некорректный ID строки или слишком длинное описание")
		}
		seen[row.ID] = true
		if row.Type != "income" && row.Type != "expense" && row.Type != "unknown" {
			return fmt.Errorf("Тип должен быть income, expense или unknown")
		}
		row.Issues = []string{}
		if row.Type == "unknown" {
			row.Issues = append(row.Issues, "Направление операции не определено")
		}
		if row.Amount == nil {
			row.Issues = append(row.Issues, "Сумма не определена")
		} else {
			amount, err := strconv.ParseInt(*row.Amount, 10, 64)
			if err != nil || amount < 1 || amount > 99999999999 || strconv.FormatInt(amount, 10) != *row.Amount {
				return fmt.Errorf("Сумма должна быть положительной строкой целых копеек")
			}
		}
		if row.Date == nil {
			row.Issues = append(row.Issues, "Дата не определена")
		} else {
			if date, err := captureDate(*row.Date); err != nil || date.IsZero() {
				return fmt.Errorf("Некорректная дата операции")
			}
		}
		if strings.TrimSpace(row.Description) == "" {
			row.Issues = append(row.Issues, "Описание операции не распознано")
		}
	}
	result := emptyResult()
	result.Rows = body.Rows
	return s.finish(w, r, result, started)
}

func (s *Server) analyze(w http.ResponseWriter, r *http.Request) error {
	started := time.Now()
	r.Body = http.MaxBytesReader(w, r.Body, 11<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		return fmt.Errorf("Ожидается файл PNG/JPEG в multipart/form-data")
	}
	var imageData []byte
	captured := ""
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("Не удалось прочитать загрузку")
		}
		switch part.FormName() {
		case "image":
			if imageData != nil {
				_ = part.Close()
				return fmt.Errorf("Загрузите один скриншот")
			}
			imageData, err = io.ReadAll(io.LimitReader(part, (10<<20)+1))
			if err != nil || len(imageData) > 10<<20 {
				_ = part.Close()
				return fmt.Errorf("Файл не должен превышать 10 МБ")
			}
		case "capture_date":
			data, readErr := io.ReadAll(io.LimitReader(part, 32))
			if readErr != nil {
				_ = part.Close()
				return fmt.Errorf("Не удалось прочитать дату")
			}
			captured = string(data)
		default:
			_ = part.Close()
			return fmt.Errorf("Неизвестное поле загрузки")
		}
		_ = part.Close()
	}
	if len(imageData) == 0 {
		return fmt.Errorf("Выберите файл скриншота")
	}
	if _, err := captureDate(captured); err != nil {
		return err
	}
	ocrStarted := time.Now()
	text, lines, err := s.OCR(r.Context(), imageData)
	if err != nil {
		return err
	}
	rows, err := Parse(text, captured)
	if err != nil {
		return err
	}
	applyNames(rows, lines)
	result := emptyResult()
	result.OCR = "Tesseract rus+eng"
	result.Text = text
	result.Lines = lines
	result.Rows = rows
	result.Metrics.OCRMS = time.Since(ocrStarted).Milliseconds()
	if len(rows) == 0 {
		result.Warnings = append(result.Warnings, "OCR не выделил строки с суммами. Исправьте текст или добавьте операцию вручную.")
	}
	low := false
	for _, line := range lines {
		if line.Confidence < 60 {
			low = true
			break
		}
	}
	if low {
		result.Warnings = append(result.Warnings, "В тексте есть фрагменты с низкой оценкой OCR. Сверьте суммы и знаки с изображением.")
	}
	return s.finish(w, r, result, started)
}
