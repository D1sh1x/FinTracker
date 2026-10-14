package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func readBudget(r *http.Request, db queryer, p, month string) (Budget, json.RawMessage, error) {
	return readBudgetState(r, db, p, month, false)
}

func readBudgetState(r *http.Request, db queryer, p, month string, includeDeleted bool) (Budget, json.RawMessage, error) {
	projection, condition := budgetJSON, " AND deleted_at IS NULL"
	if includeDeleted {
		projection += " || jsonb_build_object('deleted_at', b.deleted_at)"
		condition = ""
	}
	raw, err := rawRow(r.Context(), db, "SELECT "+projection+" FROM monthly_budgets b WHERE profile_id=$1 AND month=$2"+condition, p, month+"-01")
	var row Budget
	if err == nil {
		err = json.Unmarshal(raw, &row)
	}
	return row, raw, err
}

func (s *Server) getBudget(w http.ResponseWriter, r *http.Request) error {
	month := r.PathValue("month")
	if _, err := validMonth(month); err != nil {
		return err
	}
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	_, raw, err := readBudget(r, s.Pool, person.ID, month)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func (s *Server) putBudget(w http.ResponseWriter, r *http.Request) error {
	var body budgetInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	month := r.PathValue("month")
	if _, err := validMonth(month); err != nil {
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
	existing, _, err := readBudgetState(r, tx, person.ID, month, true)
	status := 200
	if errors.Is(err, pgx.ErrNoRows) {
		if body.Version != nil {
			return conflict("stale_version", "Бюджет был удалён. Обновите данные")
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO monthly_budgets(id,profile_id,month,limit_minor,version,created_at,updated_at) VALUES($1,$2,$3,$4,1,now(),now())", uuid.NewString(), person.ID, month+"-01", limit)
		status = 201
	} else if err == nil && existing.DeletedAt != nil {
		if body.Version != nil {
			return conflict("stale_version", "Бюджет был удалён. Обновите данные")
		}
		_, err = tx.Exec(r.Context(), "UPDATE monthly_budgets SET limit_minor=$3,deleted_at=NULL,version=version+1,updated_at=now() WHERE profile_id=$1 AND month=$2", person.ID, month+"-01", limit)
		status = 201
	} else if err == nil {
		if body.Version == nil {
			return conflict("stale_version", "Бюджет уже существует. Обновите данные")
		}
		if err := checkVersion(existing.Version, *body.Version); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "UPDATE monthly_budgets SET limit_minor=$3,version=version+1,updated_at=now() WHERE profile_id=$1 AND month=$2", person.ID, month+"-01", limit)
	}
	if err != nil {
		return err
	}
	_, raw, err := readBudget(r, tx, person.ID, month)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if status == 201 {
		w.Header().Set("Location", "/api/v1/profiles/"+person.ID+"/budgets/"+month)
	}
	return writeJSON(w, status, raw)
}

func (s *Server) deleteBudget(w http.ResponseWriter, r *http.Request) error {
	month := r.PathValue("month")
	if _, err := validMonth(month); err != nil {
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
	row, _, err := readBudgetState(r, tx, person.ID, month, true)
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
	if _, err := tx.Exec(r.Context(), "UPDATE monthly_budgets SET deleted_at=now(),updated_at=now(),version=version+1 WHERE profile_id=$1 AND month=$2", person.ID, month+"-01"); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
