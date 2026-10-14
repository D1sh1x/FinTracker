package importlab

import (
	"regexp"
	"strings"
	"time"
)

var (
	maskedAccount    = regexp.MustCompile(`(?i)(?:карта|сч[её]т)\s*[·.•…:*—-]+\s*\d{4}\b`)
	bankCashback     = regexp.MustCompile(`\s*\+\d+(?:[,.]\d+)?\s+.*$`)
	bankTransfer     = regexp.MustCompile(`(?i)(?:^| · )переводы\s*[·.−-]?\s*сбп\s*$`)
	bankSubscription = regexp.MustCompile(`(?i)(?:^| · )цифровые подписки\s*$`)
	bankLabels       = []string{"Продукты", "Переводы", "Фастфуд", "Книги и канцтовары", "Цифровые подписки", "Платные дороги и парковки"}
)

func isBankHistory(text string) bool {
	return strings.Contains(strings.ToLower(text), "история операций") && maskedAccount.MatchString(text)
}

func bankText(text string) string {
	if !isBankHistory(text) {
		return text
	}
	lines := []string{}
	lastOperation := -1
	for _, source := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		account := maskedAccount.FindStringIndex(source)
		if account != nil {
			label := strings.TrimSpace(bankCashback.ReplaceAllString(source[:account[0]], ""))
			for _, known := range bankLabels {
				if index := strings.Index(strings.ToLower(label), strings.ToLower(known)); index >= 0 {
					label = label[index:]
					break
				}
			}
			if label != "" && lastOperation >= 0 && len(lines)-lastOperation <= 2 {
				lines[lastOperation] += " · " + label
			}
			lastOperation = -1
			continue
		}
		if _, header := dateHeader(source, time.Time{}); header {
			lastOperation = -1
		} else if moneyWithCurrency.MatchString(source) || moneyWithSign.MatchString(source) {
			lastOperation = len(lines)
		}
		lines = append(lines, source)
	}
	return strings.Join(lines, "\n")
}
