package importlab

import "net/http"

const (
	UnknownCategory = "unknown"
	ModelName       = "qwen3-4b"
	maxRows         = 30
)

var Catalog = []Category{
	{"products", "Продукты", "expense"}, {"cafe", "Кафе и рестораны", "expense"},
	{"transport", "Транспорт", "expense"}, {"home", "Квартира и дом", "expense"},
	{"health", "Здоровье", "expense"}, {"shopping", "Покупки", "expense"},
	{"entertainment", "Развлечения", "expense"},
	{"salary", "Зарплата", "income"}, {"sidejob", "Подработка", "income"},
	{"other_income", "Другой доход", "income"}, {UnknownCategory, "Не определено", "unknown"},
}

type Category struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type Row struct {
	ID           string   `json:"id"`
	Description  string   `json:"description"`
	BankCategory string   `json:"bank_category,omitempty"`
	Type         string   `json:"type"`
	Amount       *string  `json:"amount_minor"`
	Date         *string  `json:"date"`
	Source       string   `json:"source"`
	CategoryID   string   `json:"category_id"`
	CategoryName string   `json:"category_name"`
	Reason       string   `json:"reason"`
	Issues       []string `json:"issues"`
}

type OCRLine struct {
	Text           string  `json:"text"`
	Confidence     float64 `json:"confidence"`
	Box            [4]int  `json:"box"`
	Name           string  `json:"name,omitempty"`
	NameConfidence float64 `json:"name_confidence,omitempty"`
}

type Metrics struct {
	OCRMS           int64   `json:"ocr_ms"`
	ModelMS         int64   `json:"model_ms"`
	TotalMS         int64   `json:"total_ms"`
	PromptTokens    int     `json:"prompt_tokens"`
	GeneratedTokens int     `json:"generated_tokens"`
	TokensPerSecond float64 `json:"tokens_per_second"`
}

type Result struct {
	Model    string    `json:"model"`
	OCR      string    `json:"ocr"`
	Text     string    `json:"text"`
	Lines    []OCRLine `json:"lines"`
	Rows     []Row     `json:"rows"`
	Warnings []string  `json:"warnings"`
	Metrics  Metrics   `json:"metrics"`
}

type Server struct {
	ModelURL    string
	Client      *http.Client
	Gate        chan struct{}
	OpenAPIPath string
	Mode        string
	OCR         OCRFunc
	Categories  []Category
}
