package httpapi

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func safeCSV(value string) string {
	trimmed := strings.TrimSpace(value)
	if (len(trimmed) > 0 && strings.ContainsRune("=+-@", rune(trimmed[0]))) || strings.HasPrefix(value, "\t") || strings.HasPrefix(value, "\r") || strings.HasPrefix(value, "\n") {
		return "'" + value
	}
	return value
}

func (s *Server) exportCSV(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	filters, err := parseFilters(r)
	if err != nil {
		return err
	}
	where, args := filterSQL(person.ID, filters)
	rows, err := s.Pool.Query(r.Context(), "SELECT "+transactionJSON+",c.name FROM transactions t JOIN categories c ON c.id=t.category_id WHERE "+where+" ORDER BY t.occurred_on DESC,t.id DESC", args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="fintrack-transactions.csv"`)
	if _, err := w.Write([]byte{0xef, 0xbb, 0xbf}); err != nil {
		return err
	}
	writer := csv.NewWriter(w)
	writer.Comma = ';'
	writer.UseCRLF = true
	if err := writer.Write([]string{"ID", "Профиль", "Тип", "Дата", "Категория", "Сумма", "Валюта", "Комментарий", "Источник"}); err != nil {
		return err
	}
	for rows.Next() {
		var data json.RawMessage
		var category string
		if err := rows.Scan(&data, &category); err != nil {
			return err
		}
		var row Operation
		if err := json.Unmarshal(data, &row); err != nil {
			return err
		}
		amount, _ := strconv.ParseInt(row.Amount, 10, 64)
		kind := "Расход"
		if row.Type == "income" {
			kind = "Доход"
		}
		if err := writer.Write([]string{row.ID, safeCSV(person.Name), kind, row.Date, safeCSV(category), fmt.Sprintf("%d,%02d", amount/100, amount%100), "RUB", safeCSV(row.Note), "manual"}); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writer.Flush()
	return writer.Error()
}
