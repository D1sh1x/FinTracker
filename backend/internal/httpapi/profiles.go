package httpapi

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
)

var initialCategories = []categoryInput{
	{Type: "expense", Name: "Продукты", Icon: "shopping", Color: "#69805D"},
	{Type: "expense", Name: "Кафе", Icon: "coffee", Color: "#BC8761"},
	{Type: "expense", Name: "Транспорт", Icon: "car", Color: "#7398AE"},
	{Type: "expense", Name: "Дом", Icon: "home", Color: "#9690AF"},
	{Type: "expense", Name: "Здоровье", Icon: "heart", Color: "#BD7D83"},
	{Type: "expense", Name: "Покупки", Icon: "bag", Color: "#BEA067"},
	{Type: "expense", Name: "Развлечения", Icon: "sparkles", Color: "#8D9C79"},
	{Type: "expense", Name: "Другое", Icon: "circle", Color: "#91948E"},
	{Type: "income", Name: "Зарплата", Icon: "briefcase", Color: "#69805D"},
	{Type: "income", Name: "Подработка", Icon: "wallet", Color: "#7398AE"},
	{Type: "income", Name: "Другой доход", Icon: "gift", Color: "#9690AF"},
	{Type: "income", Name: "Не определено", Icon: "circle", Color: "#9690AF"},
	{Type: "expense", Name: "Не определено", Icon: "circle", Color: "#9690AF"},
}

func (s *Server) listProfiles(w http.ResponseWriter, r *http.Request) error {
	rows, err := jsonRows(r.Context(), s.Pool, "SELECT "+profileJSON+" FROM profiles p ORDER BY created_at,id")
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"items": rows})
}

func (s *Server) createProfile(w http.ResponseWriter, r *http.Request) error {
	var body profileInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	id, err := identifier(body.ID)
	if err != nil {
		return err
	}
	body.Name, err = name(body.Name)
	if err != nil {
		return err
	}
	zone := "Europe/Moscow"
	if body.Timezone != nil {
		zone = *body.Timezone
	}
	if _, err := location(zone); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	parsed := uuid.MustParse(id)
	if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock($1)", int64(binary.BigEndian.Uint64(parsed[:8]))); err != nil {
		return err
	}
	existing, raw, err := s.readProfile(r.Context(), tx, id, false)
	if err == nil {
		if existing.Name != body.Name || existing.Timezone != zone {
			return duplicate()
		}
		return writeJSON(w, 200, raw)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO profiles(id,name,timezone,currency,created_at,updated_at) VALUES($1,$2,$3,'RUB',now(),now())", id, body.Name, zone); err != nil {
		return err
	}
	start := s.today(zone)[:7] + "-01"
	if _, err = tx.Exec(r.Context(), "INSERT INTO wallets(id,profile_id,name,opening_balance_minor,tracking_start_date,version,created_at,updated_at) VALUES($1,$2,'Общий баланс',0,$3,1,now(),now())", uuid.NewString(), id, start); err != nil {
		return err
	}
	for _, category := range initialCategories {
		if _, err := tx.Exec(r.Context(), "INSERT INTO categories(id,profile_id,type,name,normalized_name,icon,color,is_archived,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,now(),now())", uuid.NewString(), id, category.Type, category.Name, cases.Fold().String(category.Name), category.Icon, category.Color); err != nil {
			return err
		}
	}
	_, raw, err = s.readProfile(r.Context(), tx, id, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Location", "/api/v1/profiles/"+id)
	return writeJSON(w, 201, raw)
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) error {
	_, raw, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request) error {
	var body profilePatch
	if err := decode(w, r, &body); err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if body.Name != nil {
		person.Name, err = name(*body.Name)
		if err != nil {
			return err
		}
	}
	if body.Timezone != nil {
		if _, err := location(*body.Timezone); err != nil {
			return err
		}
		person.Timezone = *body.Timezone
	}
	if _, err = tx.Exec(r.Context(), "UPDATE profiles SET name=$2, timezone=$3, updated_at=now() WHERE id=$1", person.ID, person.Name, person.Timezone); err != nil {
		return err
	}
	_, raw, err := s.readProfile(r.Context(), tx, person.ID, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func readWallet(r *http.Request, db queryer, p string) (Wallet, json.RawMessage, error) {
	raw, err := rawRow(r.Context(), db, "SELECT "+walletJSON+" FROM wallets w WHERE profile_id=$1", p)
	var wallet Wallet
	if err == nil {
		err = json.Unmarshal(raw, &wallet)
	}
	return wallet, raw, err
}

func (s *Server) getWallet(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	_, raw, err := readWallet(r, s.Pool, person.ID)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}

func (s *Server) patchWallet(w http.ResponseWriter, r *http.Request) error {
	var body walletPatch
	if err := decode(w, r, &body); err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	wallet, _, err := readWallet(r, tx, person.ID)
	if err != nil {
		return err
	}
	if err := checkVersion(wallet.Version, body.Version); err != nil {
		return err
	}
	opening, _ := strconv.ParseInt(wallet.Opening, 10, 64)
	if body.Opening != nil {
		opening, err = money(*body.Opening, true)
		if err != nil {
			return err
		}
	}
	if body.Start != nil {
		if _, err := validDate(*body.Start); err != nil {
			return err
		}
		if *body.Start > s.today(person.Timezone) {
			return invalid("tracking_start_date", "Начало учёта не может быть в будущем")
		}
		var before bool
		if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM transactions WHERE profile_id=$1 AND deleted_at IS NULL AND occurred_on<$2)", person.ID, *body.Start).Scan(&before); err != nil {
			return err
		}
		if before {
			return conflict("tracking_date_conflict", "До этой даты уже есть операции. Выберите более раннюю дату")
		}
		wallet.Start = *body.Start
	}
	if _, err = tx.Exec(r.Context(), "UPDATE wallets SET opening_balance_minor=$2,tracking_start_date=$3,version=version+1,updated_at=now() WHERE profile_id=$1", person.ID, opening, wallet.Start); err != nil {
		return err
	}
	_, raw, err := readWallet(r, tx, person.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}
