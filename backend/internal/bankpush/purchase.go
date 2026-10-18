package bankpush

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const Package = "ru.wildberries.bank"

var purchase = regexp.MustCompile(`(?i)^Покупка ([0-9]+(?: [0-9]{3})*(?:[,.][0-9]{1,2})?)\s*(?:₽|руб\.?) по карте [*•·]+([0-9]{4}) (.+)$`)
var available = regexp.MustCompile(`(?i)\.? Доступно [0-9]+(?: [0-9]{3})*(?:[,.][0-9]{1,2})?\s*(?:₽|руб\.?)\.?$`)

type Purchase struct {
	Amount      string
	Card        string
	Description string
}

func Parse(text string) (Purchase, error) {
	text = strings.Join(strings.Fields(text), " ")
	match := purchase.FindStringSubmatch(text)
	if match == nil {
		return Purchase{}, errors.New("unsupported purchase notification")
	}
	number := strings.ReplaceAll(strings.ReplaceAll(match[1], " ", ""), ",", ".")
	parts := strings.Split(number, ".")
	minor := "00"
	if len(parts) == 2 {
		minor = (parts[1] + "0")[:2]
	}
	amount, err := strconv.ParseInt(parts[0]+minor, 10, 64)
	if err != nil || amount < 1 || amount > 99_999_999_999 {
		return Purchase{}, errors.New("invalid purchase amount")
	}
	description := strings.TrimSpace(available.ReplaceAllString(match[3], ""))
	description = strings.TrimSuffix(description, ".")
	if description == "" || utf8.RuneCountInString(description) > 500 || strings.ContainsAny(description, "₽\n") || strings.Contains(strings.ToLower(description), "доступно") {
		return Purchase{}, errors.New("ambiguous purchase notification")
	}
	return Purchase{Amount: strconv.FormatInt(amount, 10), Card: match[2], Description: description}, nil
}

func Category(description string) string {
	text := strings.ToLower(description)
	for _, merchant := range []string{"транспорт краснодара", "яндекс go", "яндекс такси", "yandex go"} {
		if text == merchant || strings.HasPrefix(text, merchant+" ") {
			return "Транспорт"
		}
	}
	for _, merchant := range []string{"магнит", "пятёрочка", "пятерочка", "перекрёсток", "перекресток"} {
		if text == merchant || strings.HasPrefix(text, merchant+" ") {
			return "Продукты"
		}
	}
	return ""
}
