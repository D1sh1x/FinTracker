package httpapi

import (
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const transferJSON = `to_jsonb(t)-'deleted_at'||jsonb_build_object('amount_minor',amount_minor::text,'occurred_on',to_char(occurred_on,'YYYY-MM-DD'))`
const valuationJSON = `to_jsonb(v)||jsonb_build_object('amount_minor',amount_minor::text,'previous_minor',previous_minor::text,'delta_minor',delta_minor::text,'occurred_on',to_char(occurred_on,'YYYY-MM-DD'))`

type Account struct {
	Wallet
	Balance string `json:"balance_minor"`
}
type accountInput struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Opening string `json:"opening_balance_minor"`
	Start   string `json:"tracking_start_date"`
}
type accountPatch struct {
	Name     *string `json:"name,omitempty"`
	Archived *bool   `json:"is_archived,omitempty"`
	Version  int     `json:"version"`
}
type transferInput struct {
	ID     string `json:"id"`
	From   string `json:"from_account_id"`
	To     string `json:"to_account_id"`
	Amount string `json:"amount_minor"`
	Date   string `json:"occurred_on"`
	Note   string `json:"note"`
}
type transferRecord struct {
	transferInput
	ProfileID string  `json:"profile_id"`
	Version   int     `json:"version"`
	DeletedAt *string `json:"deleted_at"`
}
type valuationInput struct {
	ID       string `json:"id"`
	Amount   string `json:"amount_minor"`
	Expected string `json:"expected_balance_minor"`
	Version  int    `json:"version"`
}
type valuationRecord struct {
	ID        string `json:"id"`
	ProfileID string `json:"profile_id"`
	AccountID string `json:"account_id"`
	Amount    string `json:"amount_minor"`
	Previous  string `json:"previous_minor"`
	Delta     string `json:"delta_minor"`
	Date      string `json:"occurred_on"`
	Version   int    `json:"request_version"`
}

func readAccount(r *http.Request, db queryer, p, id string) (Account, error) {
	var account Account
	id, err := identifier(id)
	if err != nil {
		return account, err
	}
	raw, err := rawRow(r.Context(), db, "SELECT "+walletJSON+"||jsonb_build_object('balance_minor',COALESCE((SELECT SUM(delta_minor)::text FROM account_entries WHERE profile_id=$1 AND account_id=$2),'0')) FROM wallets w WHERE profile_id=$1 AND id=$2", p, id)
	if err == nil {
		err = json.Unmarshal(raw, &account)
	}
	return account, err
}
func operationAccount(r *http.Request, db queryer, p, id string) (Wallet, error) {
	if id == "" {
		wallet, _, err := readWallet(r, db, p)
		return wallet, err
	}
	id, err := identifier(id)
	if err != nil {
		return Wallet{}, err
	}
	raw, err := rawRow(r.Context(), db, "SELECT "+walletJSON+" FROM wallets w WHERE profile_id=$1 AND id=$2", p, id)
	var wallet Wallet
	if err == nil {
		err = json.Unmarshal(raw, &wallet)
	}
	return wallet, err
}
func accountsFor(r *http.Request, db queryer, p string) ([]Account, error) {
	raws, err := jsonRows(r.Context(), db, "SELECT "+walletJSON+"||jsonb_build_object('balance_minor',COALESCE(e.balance,'0')) FROM wallets w LEFT JOIN (SELECT account_id,SUM(delta_minor)::text balance FROM account_entries WHERE profile_id=$1 GROUP BY account_id)e ON e.account_id=w.id WHERE w.profile_id=$1 ORDER BY w.is_primary DESC,w.created_at,w.id", p)
	if err != nil {
		return nil, err
	}
	result := []Account{}
	for _, raw := range raws {
		var row Account
		if err := json.Unmarshal(raw, &row); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, nil
}
func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	accounts, err := accountsFor(r, s.Pool, person.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"items": accounts})
}
func (s *Server) createAccount(w http.ResponseWriter, r *http.Request) error {
	var body accountInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	var err error
	body.ID, err = identifier(body.ID)
	if err != nil {
		return err
	}
	body.Name, err = name(body.Name)
	if err != nil {
		return err
	}
	if body.Kind != "cash" && body.Kind != "savings" && body.Kind != "deposit" && body.Kind != "investment" {
		return invalid("kind", "Выберите тип счёта")
	}
	opening, err := money(body.Opening, true)
	if err != nil {
		return err
	}
	body.Opening = strconv.FormatInt(opening, 10)
	if body.Kind == "investment" && opening < 0 {
		return invalid("opening_balance_minor", "Стоимость портфеля не может быть отрицательной")
	}
	if _, err = validDate(body.Start); err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if body.Start > s.today(person.Timezone) {
		return invalid("tracking_start_date", "Начало учёта не может быть в будущем")
	}
	var owner string
	err = tx.QueryRow(r.Context(), "SELECT profile_id::text FROM wallets WHERE id=$1", body.ID).Scan(&owner)
	if err == nil {
		if owner != person.ID {
			return duplicate()
		}
		existing, err := readAccount(r, tx, person.ID, body.ID)
		if err != nil {
			return err
		}
		if existing.Name != body.Name || existing.Kind != body.Kind || existing.Opening != body.Opening || existing.Start != body.Start {
			return duplicate()
		}
		return writeJSON(w, 200, existing)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err = tx.Exec(r.Context(), "INSERT INTO wallets(id,profile_id,name,kind,opening_balance_minor,tracking_start_date,version,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,1,now(),now())", body.ID, person.ID, body.Name, body.Kind, opening, body.Start)
	if err != nil {
		return err
	}
	account, err := readAccount(r, tx, person.ID, body.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 201, account)
}
func (s *Server) patchAccount(w http.ResponseWriter, r *http.Request) error {
	var body accountPatch
	if err := decode(w, r, &body); err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	account, err := readAccount(r, tx, person.ID, r.PathValue("id"))
	if err != nil {
		return err
	}
	if err = checkVersion(account.Version, body.Version); err != nil {
		return err
	}
	if body.Name != nil {
		account.Name, err = name(*body.Name)
		if err != nil {
			return err
		}
	}
	if body.Archived != nil {
		if *body.Archived && account.Primary {
			return conflict("primary_account", "Основной счёт нельзя архивировать")
		}
		account.Archived = *body.Archived
	}
	_, err = tx.Exec(r.Context(), "UPDATE wallets SET name=$3,is_archived=$4,version=version+1,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, account.ID, account.Name, account.Archived)
	if err != nil {
		return err
	}
	account, err = readAccount(r, tx, person.ID, account.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, account)
}
func (s *Server) getCapital(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.Pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer rollback(tx)
	person, _, err := s.readProfile(r.Context(), tx, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	accounts, err := accountsFor(r, tx, person.ID)
	if err != nil {
		return err
	}
	cash, invest := new(big.Int), new(big.Int)
	for _, account := range accounts {
		if account.Kind == "investment" {
			invest.Add(invest, exact(account.Balance))
		} else {
			cash.Add(cash, exact(account.Balance))
		}
	}
	history, err := jsonRows(r.Context(), tx, `SELECT json_build_object('date',to_char(occurred_on,'YYYY-MM-DD'),'balance_minor',SUM(SUM(delta_minor)) OVER(ORDER BY occurred_on)::text) FROM account_entries WHERE profile_id=$1 GROUP BY occurred_on ORDER BY occurred_on`, person.ID)
	if err != nil {
		return err
	}
	valuations, err := jsonRows(r.Context(), tx, "SELECT "+valuationJSON+" FROM account_valuations v WHERE profile_id=$1 ORDER BY created_at DESC,id LIMIT 50", person.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"currency": "RUB", "total_minor": new(big.Int).Add(cash, invest).String(), "cash_minor": cash.String(), "investment_minor": invest.String(), "accounts": accounts, "history": history, "valuations": valuations})
}
func (s *Server) listTransfers(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	rows, err := jsonRows(r.Context(), s.Pool, "SELECT "+transferJSON+" FROM account_transfers t WHERE profile_id=$1 AND deleted_at IS NULL ORDER BY occurred_on DESC,created_at DESC,id LIMIT 100", person.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"items": rows})
}
func (s *Server) createTransfer(w http.ResponseWriter, r *http.Request) error {
	var body transferInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	var err error
	body.ID, err = identifier(body.ID)
	if err != nil {
		return err
	}
	body.From, err = identifier(body.From)
	if err != nil {
		return err
	}
	body.To, err = identifier(body.To)
	if err != nil {
		return err
	}
	if body.From == body.To {
		return invalid("to_account_id", "Выберите другой счёт")
	}
	amount, err := money(body.Amount, false)
	if err != nil {
		return err
	}
	body.Amount = strconv.FormatInt(amount, 10)
	if _, err = validDate(body.Date); err != nil {
		return err
	}
	if !utf8.ValidString(body.Note) || utf8.RuneCountInString(body.Note) > 500 {
		return invalid("note", "Комментарий не должен превышать 500 символов")
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	raw, err := rawRow(r.Context(), tx, "SELECT to_jsonb(t)||jsonb_build_object('amount_minor',amount_minor::text,'occurred_on',to_char(occurred_on,'YYYY-MM-DD')) FROM account_transfers t WHERE id=$1", body.ID)
	if err == nil {
		var existing transferRecord
		if err = json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		if existing.ProfileID != person.ID {
			return duplicate()
		}
		if existing.DeletedAt != nil {
			return &apiError{Status: 410, Code: "transfer_deleted", Message: "Перевод уже отменён"}
		}
		if existing.transferInput != body {
			return duplicate()
		}
		raw, err = rawRow(r.Context(), tx, "SELECT "+transferJSON+" FROM account_transfers t WHERE id=$1", body.ID)
		if err != nil {
			return err
		}
		return writeJSON(w, 200, raw)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	from, err := operationAccount(r, tx, person.ID, body.From)
	if err != nil {
		return err
	}
	to, err := operationAccount(r, tx, person.ID, body.To)
	if err != nil {
		return err
	}
	if from.Archived || to.Archived {
		return conflict("account_archived", "Переводы на архивные счета запрещены")
	}
	if body.Date < from.Start || body.Date < to.Start || body.Date > s.today(person.Timezone) {
		return invalid("occurred_on", "Дата должна попадать в период учёта обоих счетов и не быть в будущем")
	}
	_, err = tx.Exec(r.Context(), "INSERT INTO account_transfers(id,profile_id,from_account_id,to_account_id,amount_minor,occurred_on,note)VALUES($1,$2,$3,$4,$5,$6,$7)", body.ID, person.ID, body.From, body.To, amount, body.Date, body.Note)
	if err != nil {
		return err
	}
	raw, err = rawRow(r.Context(), tx, "SELECT "+transferJSON+" FROM account_transfers t WHERE id=$1", body.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 201, raw)
}
func (s *Server) deleteTransfer(w http.ResponseWriter, r *http.Request) error {
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
	var current int
	var deleted bool
	err = tx.QueryRow(r.Context(), "SELECT version,deleted_at IS NOT NULL FROM account_transfers WHERE profile_id=$1 AND id=$2", person.ID, id).Scan(&current, &deleted)
	if err != nil {
		return err
	}
	if deleted {
		w.WriteHeader(204)
		return nil
	}
	if err = checkVersion(current, version); err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), "UPDATE account_transfers SET deleted_at=now(),version=version+1,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
func (s *Server) createValuation(w http.ResponseWriter, r *http.Request) error {
	var body valuationInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	var err error
	body.ID, err = identifier(body.ID)
	if err != nil {
		return err
	}
	id, err := identifier(r.PathValue("id"))
	if err != nil {
		return err
	}
	target, err := money(body.Amount, true)
	if err != nil {
		return err
	}
	if target < 0 {
		return invalid("amount_minor", "Стоимость не может быть отрицательной")
	}
	body.Amount = strconv.FormatInt(target, 10)
	if len(body.Expected) > 100 {
		return invalid("expected_balance_minor", "Передайте текущий остаток счёта")
	}
	expected, ok := new(big.Int).SetString(body.Expected, 10)
	if !ok || expected.String() != body.Expected {
		return invalid("expected_balance_minor", "Передайте текущий остаток счёта")
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	raw, err := rawRow(r.Context(), tx, "SELECT "+valuationJSON+" FROM account_valuations v WHERE id=$1", body.ID)
	if err == nil {
		var existing valuationRecord
		if err = json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		if existing.ProfileID != person.ID || existing.AccountID != id || existing.Amount != body.Amount || existing.Previous != body.Expected || existing.Version != body.Version {
			return duplicate()
		}
		return writeJSON(w, 200, raw)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	account, err := readAccount(r, tx, person.ID, id)
	if err != nil {
		return err
	}
	if account.Kind != "investment" {
		return invalid("account_id", "Переоценка доступна только для инвестиционного портфеля")
	}
	if account.Archived {
		return conflict("account_archived", "Портфель в архиве")
	}
	if err = checkVersion(account.Version, body.Version); err != nil {
		return err
	}
	if account.Balance != body.Expected {
		return conflict("balance_conflict", "Остаток изменился. Обновите данные перед переоценкой")
	}
	delta := new(big.Int).Sub(big.NewInt(target), expected).String()
	_, err = tx.Exec(r.Context(), "INSERT INTO account_valuations(id,profile_id,account_id,amount_minor,previous_minor,delta_minor,occurred_on,request_version)VALUES($1,$2,$3,$4,$5,$6,$7,$8)", body.ID, person.ID, id, target, body.Expected, delta, s.today(person.Timezone), body.Version)
	if err != nil {
		return err
	}
	raw, err = rawRow(r.Context(), tx, "SELECT "+valuationJSON+" FROM account_valuations v WHERE id=$1", body.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 201, raw)
}
