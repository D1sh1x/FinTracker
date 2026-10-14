package importlab

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	moneyWithCurrency = regexp.MustCompile(`([+−-]?)\s*(\d{1,3}(?:[ \x{00a0}\x{202f}]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(?:₽|руб\.?|RUB)`)
	moneyWithSign     = regexp.MustCompile(`([+−-])\s*(\d{1,3}(?:[ \x{00a0}\x{202f}]\d{3})+|\d+)(?:[,.](\d{1,2}))?`)
	amountSuffix      = regexp.MustCompile(`(?i)^\s*(?:₽|руб\.?|RUB|[РP$€£¥])(?:\s|$)`)
	numericDate       = regexp.MustCompile(`^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$`)
	wordDate          = regexp.MustCompile(`^(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?$`)
	monthNames        = map[string]int{"января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6, "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12}
)

func captureDate(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	date, err := time.Parse(time.DateOnly, value)
	if err != nil || date.Year() < 1 {
		return time.Time{}, fmt.Errorf("Укажите дату съёмки в формате ГГГГ-ММ-ДД")
	}
	return date, nil
}

func dateHeader(text string, captured time.Time) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "сегодня" || lower == "вчера" {
		if captured.IsZero() {
			return "", true
		}
		if lower == "вчера" {
			captured = captured.AddDate(0, 0, -1)
		}
		return captured.Format(time.DateOnly), true
	}
	if date, err := time.Parse(time.DateOnly, lower); err == nil {
		return date.Format(time.DateOnly), true
	}
	match := numericDate.FindStringSubmatch(lower)
	month := 0
	if match != nil {
		month, _ = strconv.Atoi(match[2])
	} else {
		match = wordDate.FindStringSubmatch(lower)
		if match != nil {
			month = monthNames[match[2]]
		}
	}
	if match == nil {
		return "", false
	}
	if match[3] == "" && captured.IsZero() {
		return "", true
	}
	day, _ := strconv.Atoi(match[1])
	year := captured.Year()
	if match[3] != "" {
		year, _ = strconv.Atoi(match[3])
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if year < 1 || date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return "", true
	}
	return date.Format(time.DateOnly), true
}

func parseAmount(match []string) *string {
	whole := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\u00a0' || r == '\u202f' {
			return -1
		}
		return r
	}, match[2])
	fraction := match[3]
	if len(fraction) < 2 {
		fraction += strings.Repeat("0", 2-len(fraction))
	}
	amount, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil || amount < 1 || amount > 99999999999 {
		return nil
	}
	value := strconv.FormatInt(amount, 10)
	return &value
}

func Parse(text, capturedValue string) ([]Row, error) {
	captured, err := captureDate(capturedValue)
	if err != nil {
		return nil, err
	}
	if len(text) > 64000 {
		return nil, fmt.Errorf("Слишком много текста: максимум 64 КБ")
	}
	rows := []Row{}
	bankHistory := isBankHistory(text)
	currentDate, pending := "", ""
	for _, source := range strings.Split(strings.ReplaceAll(bankText(text), "\r\n", "\n"), "\n") {
		source = maskedAccount.ReplaceAllString(source, "")
		source = strings.TrimSpace(source)
		if source == "" {
			continue
		}
		if date, ok := dateHeader(source, captured); ok {
			currentDate = date
			pending = ""
			continue
		}
		lower := strings.ToLower(source)
		skip := false
		for _, label := range []string{"баланс", "остаток", "итого", "потрачено за", "всего за", "доступно", "расходы за", "доходы за"} {
			if strings.Contains(lower, label) {
				skip = true
				break
			}
		}
		if skip {
			pending = ""
			continue
		}
		regex := moneyWithCurrency
		matches := regex.FindAllStringSubmatchIndex(source, -1)
		if len(matches) == 0 {
			regex = moneyWithSign
			matches = regex.FindAllStringSubmatchIndex(source, -1)
		}
		if len(matches) == 0 {
			pending = source
			continue
		}
		if len(matches) > 1 {
			rows = append(rows, Row{ID: fmt.Sprintf("r%d", len(rows)+1), Description: source, Type: "unknown", Source: source, CategoryID: UnknownCategory, CategoryName: "Не определено", Issues: []string{"В строке несколько сумм — уточните операцию"}})
		} else {
			indices := matches[0]
			part := source[indices[0]:indices[1]]
			match := regex.FindStringSubmatch(part)
			description := strings.Join(strings.Fields(source[:indices[0]]+" "+amountSuffix.ReplaceAllString(source[indices[1]:], " ")), " ")
			if description == "" {
				description = pending
			}
			row := Row{ID: fmt.Sprintf("r%d", len(rows)+1), Description: description, Type: "unknown", Source: source, Amount: parseAmount(match), CategoryID: UnknownCategory, CategoryName: "Не определено", Issues: []string{}}
			if bankHistory {
				if split := strings.LastIndex(row.Description, " · "); split >= 0 {
					row.BankCategory = row.Description[split+len(" · "):]
					row.Description = row.Description[:split]
					if category := []rune(row.BankCategory); len(category) > 120 {
						row.BankCategory = string(category[:120])
						row.Issues = append(row.Issues, "Подпись банка сокращена — сверьте исходную строку")
					}
				}
			}
			if match[1] == "+" {
				row.Type = "income"
			} else if match[1] == "-" || match[1] == "−" {
				row.Type = "expense"
			}
			if currentDate != "" {
				date := currentDate
				row.Date = &date
			} else {
				row.Issues = append(row.Issues, "Дата не распознана — проверьте дату съёмки и заголовок")
			}
			if row.Type == "unknown" {
				row.Issues = append(row.Issues, "Направление операции не определено")
			}
			if row.Amount == nil {
				row.Issues = append(row.Issues, "Сумма не определена или вне допустимого диапазона")
			}
			if row.Description == "" {
				row.Issues = append(row.Issues, "Описание операции не распознано")
			}
			rows = append(rows, row)
		}
		pending = ""
		if len(rows) > maxRows {
			return nil, fmt.Errorf("На один тест допускается до %d операций", maxRows)
		}
	}
	return rows, nil
}
