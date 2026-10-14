package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

func parseFilters(r *http.Request) (filters, error) {
	query := r.URL.Query()
	result := filters{From: query.Get("date_from"), To: query.Get("date_to"), Type: query.Get("type"), Category: query.Get("category_id"), Q: query.Get("q")}
	if result.From != "" {
		if _, err := validDate(result.From); err != nil {
			return result, err
		}
	}
	if result.To != "" {
		if _, err := validDate(result.To); err != nil {
			return result, err
		}
	}
	if result.From != "" && result.To != "" && result.From >= result.To {
		return result, invalid("date_to", "Конец периода должен быть позже начала")
	}
	if result.Type != "" && !validKind(result.Type) {
		return result, invalid("type", "Неизвестный тип операции")
	}
	if result.Category != "" {
		id, err := identifier(result.Category)
		if err != nil {
			return result, err
		}
		result.Category = id
	}
	if utf8.RuneCountInString(result.Q) > 100 {
		return result, invalid("q", "Поисковый запрос должен быть не длиннее 100 символов")
	}
	return result, nil
}

func filterSQL(p string, f filters) (string, []any) {
	where := "t.profile_id=$1 AND t.deleted_at IS NULL"
	args := []any{p}
	for _, item := range []struct{ value, condition string }{{f.From, "t.occurred_on>="}, {f.To, "t.occurred_on<"}, {f.Type, "t.type="}, {f.Category, "t.category_id="}} {
		if item.value != "" {
			args = append(args, item.value)
			where += " AND " + item.condition + "$" + strconv.Itoa(len(args))
		}
	}
	if f.Q != "" {
		escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(f.Q)
		args = append(args, "%"+escaped+"%")
		where += " AND t.note ILIKE $" + strconv.Itoa(len(args))
	}
	return where, args
}

func cursorContext(p string, f filters) string {
	data, _ := json.Marshal(struct {
		Profile string
		Filters filters
	}{p, f})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
