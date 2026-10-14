package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	positiveMoney = regexp.MustCompile(`^[1-9][0-9]{0,10}$`)
	signedMoney   = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,10})$`)
	colorPattern  = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	iconSet       = map[string]bool{"shopping": true, "coffee": true, "car": true, "home": true, "heart": true, "bag": true, "sparkles": true, "circle": true, "briefcase": true, "wallet": true, "gift": true}
)

func invalid(field, message string) error {
	return &apiError{Status: 422, Code: "validation_error", Message: message, Fields: map[string]string{field: message}}
}

func missing() error {
	return &apiError{Status: 404, Code: "not_found", Message: "Запись не найдена"}
}
func conflict(code, message string) error {
	return &apiError{Status: 409, Code: code, Message: message}
}
func duplicate() error {
	return conflict("duplicate_id", "Этот идентификатор уже использован для другой записи")
}

func decode(w http.ResponseWriter, r *http.Request, target any) error {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		return invalid("request", "Слишком большой или некорректный запрос")
	}
	if !utf8.Valid(data) || !json.Valid(data) {
		return &apiError{Status: 400, Code: "invalid_json", Message: "Некорректный JSON"}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return invalid("request", "Ожидается JSON-объект")
	}
	structure := reflect.TypeOf(target).Elem()
	for key, value := range fields {
		known := false
		for index := range structure.NumField() {
			jsonName, _, _ := strings.Cut(structure.Field(index).Tag.Get("json"), ",")
			if jsonName == key {
				known = true
				break
			}
		}
		if !known {
			return invalid(key, "Неизвестное поле запроса")
		}
		if string(value) == "null" {
			return invalid(key, "Поле не может быть null")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalid("request", "Неизвестное поле или неверный тип значения")
	}
	return nil
}

func identifier(value string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil || len(value) != 36 {
		return "", invalid("id", "Некорректный UUID")
	}
	return parsed.String(), nil
}

func name(value string) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 50 {
		return "", invalid("name", "Имя должно содержать от 1 до 50 символов")
	}
	return value, nil
}

func money(value string, signed bool) (int64, error) {
	pattern := positiveMoney
	if signed {
		pattern = signedMoney
	}
	if !pattern.MatchString(value) {
		return 0, invalid("amount_minor", "Сумма должна быть целой строкой копеек в допустимом диапазоне")
	}
	amount, err := strconv.ParseInt(value, 10, 64)
	if err != nil || amount > maxAmount || amount < -maxAmount {
		return 0, invalid("amount_minor", "Сумма превышает допустимый диапазон")
	}
	return amount, nil
}

func validDate(value string) (time.Time, error) {
	date, err := time.Parse(time.DateOnly, value)
	if err != nil || len(value) != 10 || date.Year() < 1 {
		return time.Time{}, invalid("occurred_on", "Некорректная дата")
	}
	return date, nil
}

func validMonth(value string) (time.Time, error) {
	date, err := time.Parse("2006-01", value)
	if err != nil || len(value) != 7 || date.Year() < 1 || date.Year() >= 9999 {
		return time.Time{}, invalid("month", "Некорректный месяц")
	}
	return date, nil
}

func location(value string) (*time.Location, error) {
	zone, err := time.LoadLocation(value)
	if err != nil || value == "Local" || value == "" {
		return nil, invalid("timezone", "Неизвестный часовой пояс")
	}
	return zone, nil
}

func (s *Server) today(zone string) string {
	loc, _ := time.LoadLocation(zone)
	return s.Now().In(loc).Format(time.DateOnly)
}

func validKind(value string) bool { return value == "expense" || value == "income" }

func checkVersion(actual, expected int) error {
	if expected < 1 {
		return invalid("version", "Укажите текущую версию записи")
	}
	if actual != expected {
		return conflict("stale_version", "Запись изменилась. Обновите данные и повторите действие")
	}
	return nil
}

func requestVersion(r *http.Request) (int, error) {
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil || version < 1 {
		return 0, invalid("version", "Укажите текущую версию записи")
	}
	return version, nil
}
