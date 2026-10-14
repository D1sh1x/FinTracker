package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

func readOperation(r *http.Request, db queryer, p, id string, deleted bool) (Operation, json.RawMessage, error) {
	query := "SELECT to_jsonb(t) || jsonb_build_object('amount_minor',t.amount_minor::text,'occurred_on',to_char(t.occurred_on,'YYYY-MM-DD')) FROM transactions t WHERE profile_id=$1 AND id=$2"
	if !deleted {
		query += " AND deleted_at IS NULL"
	}
	raw, err := rawRow(r.Context(), db, query, p, id)
	var row Operation
	if err == nil {
		err = json.Unmarshal(raw, &row)
	}
	return row, raw, err
}

func visibleOperation(r *http.Request, db queryer, p, id string) (json.RawMessage, error) {
	return rawRow(r.Context(), db, "SELECT "+transactionJSON+" FROM transactions t WHERE profile_id=$1 AND id=$2 AND deleted_at IS NULL", p, id)
}

func (s *Server) validateOperation(r *http.Request, db queryer, person Profile, row *Operation, previous *Operation) error {
	if !validKind(row.Type) {
		return invalid("type", "Выберите доход или расход")
	}
	amount, err := money(row.Amount, false)
	if err != nil {
		return err
	}
	row.Amount = strconv.FormatInt(amount, 10)
	row.CategoryID, err = identifier(row.CategoryID)
	if err != nil {
		return err
	}
	if _, err := validDate(row.Date); err != nil {
		return err
	}
	if utf8.RuneCountInString(row.Note) > 500 {
		return invalid("note", "Комментарий не должен превышать 500 символов")
	}
	category, _, err := readCategory(r, db, person.ID, row.CategoryID)
	if err != nil {
		return err
	}
	if category.Type != row.Type {
		return &apiError{Status: 422, Code: "category_type_mismatch", Message: "Выберите категорию подходящего типа", Fields: map[string]string{"category_id": "Тип категории не совпадает с операцией"}}
	}
	if category.Archived && (previous == nil || previous.CategoryID != category.ID) {
		return conflict("category_archived", "Категория в архиве. Выберите другую")
	}
	wallet, _, err := readWallet(r, db, person.ID)
	if err != nil {
		return err
	}
	if row.Date < wallet.Start {
		return invalid("occurred_on", "Дата раньше начала учёта. Измените дату или начало учёта в настройках")
	}
	if (previous == nil || previous.Date != row.Date) && row.Date > s.today(person.Timezone) {
		return invalid("occurred_on", "Операция не может быть в будущем")
	}
	row.WalletID = wallet.ID
	return nil
}

func (s *Server) createOperation(w http.ResponseWriter, r *http.Request) error {
	var body operationInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	var err error
	body.ID, err = identifier(body.ID)
	if err != nil {
		return err
	}
	body.CategoryID, err = identifier(body.CategoryID)
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	raw, err := rawRow(r.Context(), tx, "SELECT to_jsonb(t) || jsonb_build_object('amount_minor',t.amount_minor::text,'occurred_on',to_char(t.occurred_on,'YYYY-MM-DD')) FROM transactions t WHERE id=$1", body.ID)
	if err == nil {
		var existing Operation
		if err := json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		if existing.ProfileID != person.ID {
			return duplicate()
		}
		if existing.DeletedAt != nil {
			return &apiError{Status: 410, Code: "transaction_deleted", Message: "Эта операция была удалена"}
		}
		if existing.Type != body.Type || existing.Amount != body.Amount || existing.CategoryID != body.CategoryID || existing.Date != body.Date || existing.Note != body.Note {
			return duplicate()
		}
		raw, err = visibleOperation(r, tx, person.ID, body.ID)
		if err != nil {
			return err
		}
		return writeJSON(w, 200, raw)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	row := Operation{ID: body.ID, ProfileID: person.ID, Type: body.Type, Amount: body.Amount, CategoryID: body.CategoryID, Date: body.Date, Note: body.Note}
	if err := s.validateOperation(r, tx, person, &row, nil); err != nil {
		return err
	}
	amount, _ := strconv.ParseInt(row.Amount, 10, 64)
	if _, err := tx.Exec(r.Context(), "INSERT INTO transactions(id,profile_id,wallet_id,category_id,type,amount_minor,occurred_on,note,source,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual',1,now(),now())", row.ID, row.ProfileID, row.WalletID, row.CategoryID, row.Type, amount, row.Date, row.Note); err != nil {
		return err
	}
	raw, err = visibleOperation(r, tx, person.ID, row.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Location", "/api/v1/profiles/"+person.ID+"/transactions/"+row.ID)
	return writeJSON(w, 201, raw)
}

func (s *Server) getOperation(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	raw, err := visibleOperation(r, s.Pool, person.ID, id)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func (s *Server) patchOperation(w http.ResponseWriter, r *http.Request) error {
	var body operationPatch
	if err := decode(w, r, &body); err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	existing, _, err := readOperation(r, tx, person.ID, id, false)
	if err != nil {
		return err
	}
	if err := checkVersion(existing.Version, body.Version); err != nil {
		return err
	}
	row := existing
	if body.Type != nil {
		row.Type = *body.Type
	}
	if body.Amount != nil {
		row.Amount = *body.Amount
	}
	if body.CategoryID != nil {
		row.CategoryID = *body.CategoryID
	}
	if body.Date != nil {
		row.Date = *body.Date
	}
	if body.Note != nil {
		row.Note = *body.Note
	}
	if err := s.validateOperation(r, tx, person, &row, &existing); err != nil {
		return err
	}
	amount, _ := strconv.ParseInt(row.Amount, 10, 64)
	if _, err := tx.Exec(r.Context(), "UPDATE transactions SET category_id=$3,type=$4,amount_minor=$5,occurred_on=$6,note=$7,version=version+1,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id, row.CategoryID, row.Type, amount, row.Date, row.Note); err != nil {
		return err
	}
	raw, err := visibleOperation(r, tx, person.ID, id)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func (s *Server) deleteOperation(w http.ResponseWriter, r *http.Request) error {
	version, err := requestVersion(r)
	if err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	row, _, err := readOperation(r, tx, person.ID, id, true)
	if err != nil {
		return err
	}
	if row.DeletedAt == nil {
		if err := checkVersion(row.Version, version); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), "UPDATE transactions SET deleted_at=now(),updated_at=now(),version=version+1 WHERE profile_id=$1 AND id=$2", person.ID, id); err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
	}
	w.WriteHeader(204)
	return nil
}

func (s *Server) listOperations(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	filters, err := parseFilters(r)
	if err != nil {
		return err
	}
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 200 {
			return invalid("limit", "Размер страницы должен быть от 1 до 200")
		}
	}
	where, args := filterSQL(person.ID, filters)
	context := cursorContext(person.ID, filters)
	if encoded := r.URL.Query().Get("cursor"); encoded != "" {
		data, err := base64.URLEncoding.DecodeString(encoded)
		var cursor pageCursor
		if len(encoded) > 1000 || err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Context != context {
			return &apiError{Status: 400, Code: "invalid_cursor", Message: "Обновите список операций: курсор недействителен"}
		}
		if _, err := validDate(cursor.Date); err != nil {
			return &apiError{Status: 400, Code: "invalid_cursor", Message: "Курсор недействителен"}
		}
		if _, err := identifier(cursor.ID); err != nil {
			return &apiError{Status: 400, Code: "invalid_cursor", Message: "Курсор недействителен"}
		}
		args = append(args, cursor.Date, cursor.ID)
		where += " AND (t.occurred_on,t.id)<($" + strconv.Itoa(len(args)-1) + "::date,$" + strconv.Itoa(len(args)) + "::uuid)"
	}
	args = append(args, limit+1)
	pageQuery := "SELECT t.* FROM transactions t WHERE " + where + " ORDER BY t.occurred_on DESC,t.id DESC LIMIT $" + strconv.Itoa(len(args))
	rows, err := jsonRows(r.Context(), s.Pool, "SELECT "+transactionJSON+" FROM ("+pageQuery+") t ORDER BY t.occurred_on DESC,t.id DESC", args...)
	if err != nil {
		return err
	}
	hasMore := len(rows) > limit
	var next *string
	if hasMore {
		rows = rows[:limit]
		var last Operation
		if err := json.Unmarshal(rows[len(rows)-1], &last); err != nil {
			return err
		}
		data, _ := json.Marshal(pageCursor{Context: context, Date: last.Date, ID: last.ID})
		encoded := base64.URLEncoding.EncodeToString(data)
		next = &encoded
	}
	return writeJSON(w, 200, map[string]any{"items": rows, "next_cursor": next, "has_more": hasMore})
}
