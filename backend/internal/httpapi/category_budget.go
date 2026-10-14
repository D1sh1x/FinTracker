package httpapi

import (
	"encoding/json"
	"errors"
	"math/big"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type CategoryBudgetSummary struct {
	CategoryID  string  `json:"category_id"`
	Name        string  `json:"name"`
	Icon        string  `json:"icon"`
	Color       string  `json:"color"`
	Archived    bool    `json:"is_archived"`
	Limit       *string `json:"limit_minor"`
	Version     *int    `json:"version"`
	Spent       string  `json:"spent_minor"`
	Remaining   *string `json:"remaining_minor"`
	Overspent   string  `json:"overspent_minor"`
	UsedPercent *string `json:"used_percent"`
}

type CategoryBudgetsSummary struct {
	Month          string                  `json:"month"`
	Items          []CategoryBudgetSummary `json:"items"`
	Allocated      string                  `json:"allocated_minor"`
	OverallLimit   *string                 `json:"overall_limit_minor"`
	ExceedsOverall bool                    `json:"exceeds_overall"`
}

func readCategoryBudget(r *http.Request, db queryer, p, month, id string, includeDeleted bool) (Budget, json.RawMessage, error) {
	projection, condition := categoryBudgetJSON, " AND deleted_at IS NULL"
	if includeDeleted {
		projection += " || jsonb_build_object('deleted_at', b.deleted_at)"
		condition = ""
	}
	raw, err := rawRow(r.Context(), db, "SELECT "+projection+" FROM category_budgets b WHERE profile_id=$1 AND month=$2 AND category_id=$3"+condition, p, month+"-01", id)
	var row Budget
	if err == nil {
		err = json.Unmarshal(raw, &row)
	}
	return row, raw, err
}

func categoryBudgetsSummary(r *http.Request, db queryer, p, month string, spent map[string]string, overall *string) (CategoryBudgetsSummary, error) {
	result := CategoryBudgetsSummary{Month: month, Items: []CategoryBudgetSummary{}, OverallLimit: overall}
	allocated := new(big.Int)
	rows, err := db.Query(r.Context(), `SELECT c.id::text,c.name,c.icon,c.color,c.is_archived,b.limit_minor::text,b.version
        FROM categories c LEFT JOIN category_budgets b ON b.profile_id=c.profile_id AND b.category_id=c.id AND b.month=$2 AND b.deleted_at IS NULL
        WHERE c.profile_id=$1 AND c.type='expense' ORDER BY c.is_archived,c.created_at,c.id`, p, month+"-01")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		item := CategoryBudgetSummary{Spent: "0", Overspent: "0"}
		if err := rows.Scan(&item.CategoryID, &item.Name, &item.Icon, &item.Color, &item.Archived, &item.Limit, &item.Version); err != nil {
			return result, err
		}
		if amount, ok := spent[item.CategoryID]; ok {
			item.Spent = amount
		}
		if item.Archived && item.Limit == nil && item.Spent == "0" {
			continue
		}
		if item.Limit != nil {
			limit, amount := exact(*item.Limit), exact(item.Spent)
			remaining := new(big.Int).Sub(limit, amount)
			value := remaining.String()
			item.Remaining = &value
			if remaining.Sign() < 0 {
				item.Overspent = new(big.Int).Neg(remaining).String()
			}
			used := usedPercent(limit, amount)
			item.UsedPercent = &used
			allocated.Add(allocated, limit)
		}
		result.Items = append(result.Items, item)
	}
	result.Allocated = allocated.String()
	if overall != nil {
		result.ExceedsOverall = allocated.Cmp(exact(*overall)) > 0
	}
	return result, rows.Err()
}

func (s *Server) listCategoryBudgets(w http.ResponseWriter, r *http.Request) error {
	month := r.PathValue("month")
	start, err := validMonth(month)
	if err != nil {
		return err
	}
	tx, err := s.Pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer rollback(tx)
	person, _, err := s.readProfile(r.Context(), tx, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), `SELECT category_id::text,SUM(amount_minor)::text FROM transactions
        WHERE profile_id=$1 AND type='expense' AND deleted_at IS NULL AND occurred_on >= $2 AND occurred_on < $3 GROUP BY category_id`, person.ID, start.Format("2006-01-02"), start.AddDate(0, 1, 0).Format("2006-01-02"))
	if err != nil {
		return err
	}
	spent := map[string]string{}
	for rows.Next() {
		var id, amount string
		if err := rows.Scan(&id, &amount); err != nil {
			rows.Close()
			return err
		}
		spent[id] = amount
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	budget, _, err := readBudget(r, tx, person.ID, month)
	var overall *string
	if err == nil {
		overall = &budget.Limit
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	result, err := categoryBudgetsSummary(r, tx, person.ID, month, spent, overall)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, result)
}

func (s *Server) putCategoryBudget(w http.ResponseWriter, r *http.Request) error {
	var body budgetInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	month := r.PathValue("month")
	if _, err := validMonth(month); err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	limit, err := money(body.Limit, false)
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	category, _, err := readCategory(r, tx, person.ID, id)
	if err != nil {
		return err
	}
	if category.Type != "expense" {
		return invalid("category_id", "Лимит доступен только для категории расходов")
	}
	existing, _, err := readCategoryBudget(r, tx, person.ID, month, id, true)
	status := 200
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && existing.DeletedAt != nil) {
		if body.Version != nil {
			return conflict("stale_version", "Лимит удалён. Обновите данные")
		}
		if category.Archived {
			return conflict("category_archived", "Сначала восстановите категорию из архива")
		}
		if errors.Is(err, pgx.ErrNoRows) {
			_, err = tx.Exec(r.Context(), "INSERT INTO category_budgets(id,profile_id,category_id,month,limit_minor,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,1,now(),now())", uuid.NewString(), person.ID, id, month+"-01", limit)
		} else {
			_, err = tx.Exec(r.Context(), "UPDATE category_budgets SET limit_minor=$4,deleted_at=NULL,version=version+1,updated_at=now() WHERE profile_id=$1 AND month=$2 AND category_id=$3", person.ID, month+"-01", id, limit)
		}
		status = 201
	} else if err == nil {
		if body.Version == nil {
			return conflict("stale_version", "Лимит уже задан. Обновите данные")
		}
		if err := checkVersion(existing.Version, *body.Version); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "UPDATE category_budgets SET limit_minor=$4,version=version+1,updated_at=now() WHERE profile_id=$1 AND month=$2 AND category_id=$3", person.ID, month+"-01", id, limit)
	}
	if err != nil {
		return err
	}
	_, raw, err := readCategoryBudget(r, tx, person.ID, month, id, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if status == 201 {
		w.Header().Set("Location", "/api/v1/profiles/"+person.ID+"/category-budgets/"+month)
	}
	return writeJSON(w, status, raw)
}

func (s *Server) deleteCategoryBudget(w http.ResponseWriter, r *http.Request) error {
	month := r.PathValue("month")
	if _, err := validMonth(month); err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	version, err := requestVersion(r)
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	row, _, err := readCategoryBudget(r, tx, person.ID, month, id, true)
	if err != nil {
		return err
	}
	if row.DeletedAt != nil {
		w.WriteHeader(204)
		return nil
	}
	if err := checkVersion(row.Version, version); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), "UPDATE category_budgets SET deleted_at=now(),updated_at=now(),version=version+1 WHERE profile_id=$1 AND month=$2 AND category_id=$3", person.ID, month+"-01", id); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
