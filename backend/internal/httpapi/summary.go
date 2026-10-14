package httpapi

import (
	"errors"
	"math/big"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func exact(value string) *big.Int { result, _ := new(big.Int).SetString(value, 10); return result }

func usedPercent(limit, spent *big.Int) string {
	numerator := new(big.Int).Mul(spent, big.NewInt(2000))
	numerator.Add(numerator, limit)
	tenths := new(big.Int).Quo(numerator, new(big.Int).Mul(limit, big.NewInt(2)))
	whole, fraction := new(big.Int), new(big.Int)
	whole.QuoRem(tenths, big.NewInt(10), fraction)
	return whole.String() + "." + fraction.String()
}

func budgetSummary(limit, spent *big.Int, month, current time.Time) map[string]any {
	remaining := new(big.Int).Sub(limit, spent)
	var days any
	var daily any
	if month.Year() == current.Year() && month.Month() == current.Month() {
		count := time.Date(current.Year(), current.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day() - current.Day() + 1
		days = count
		available := new(big.Int).Set(remaining)
		if available.Sign() < 0 {
			available.SetInt64(0)
		}
		daily = new(big.Int).Quo(available, big.NewInt(int64(count))).String()
	}
	return map[string]any{"limit_minor": limit.String(), "spent_minor": spent.String(), "remaining_minor": remaining.String(), "used_percent": usedPercent(limit, spent), "daily_available_minor": daily, "days_remaining": days}
}

func (s *Server) summary(w http.ResponseWriter, r *http.Request) error {
	month := r.URL.Query().Get("month")
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
	wallet, _, err := readWallet(r, tx, person.ID)
	if err != nil {
		return err
	}
	end := start.AddDate(0, 1, 0).Format(time.DateOnly)
	balance, income, expense := exact(wallet.Opening), new(big.Int), new(big.Int)
	categories := []categoryTotal{}
	categorySpent := map[string]string{}
	rows, err := tx.Query(r.Context(), `SELECT c.id::text,c.name,c.icon,c.color,c.type,SUM(t.amount_minor)::text,
      COALESCE(SUM(t.amount_minor) FILTER (WHERE t.occurred_on >= $2 AND t.occurred_on < $3),0)::text
      FROM categories c JOIN transactions t ON c.id=t.category_id
      WHERE t.profile_id=$1 AND t.deleted_at IS NULL GROUP BY c.id
      ORDER BY SUM(t.amount_minor) FILTER (WHERE t.occurred_on >= $2 AND t.occurred_on < $3) DESC NULLS LAST,c.name`, person.ID, start.Format(time.DateOnly), end)
	if err != nil {
		return err
	}
	for rows.Next() {
		var category categoryTotal
		var kind, total string
		if err := rows.Scan(&category.ID, &category.Name, &category.Icon, &category.Color, &kind, &total, &category.Amount); err != nil {
			rows.Close()
			return err
		}
		monthlyAmount := exact(category.Amount)
		if kind == "income" {
			balance.Add(balance, exact(total))
			income.Add(income, monthlyAmount)
		} else {
			categorySpent[category.ID] = category.Amount
			balance.Sub(balance, exact(total))
			expense.Add(expense, monthlyAmount)
			if monthlyAmount.Sign() > 0 {
				categories = append(categories, category)
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	budget, _, err := readBudget(r, tx, person.ID, month)
	var budgetData any
	var overall *string
	if err == nil {
		overall = &budget.Limit
		zone, _ := time.LoadLocation(person.Timezone)
		budgetData = budgetSummary(exact(budget.Limit), expense, start, s.Now().In(zone))
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	categoryBudgets, err := categoryBudgetsSummary(r, tx, person.ID, month, categorySpent, overall)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"month": month, "currency": "RUB", "balance_minor": balance.String(), "income_minor": income.String(), "expense_minor": expense.String(), "net_minor": new(big.Int).Sub(income, expense).String(), "categories": categories, "budget": budgetData, "category_budgets": categoryBudgets})
}
