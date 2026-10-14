package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
)

func readCategory(r *http.Request, db queryer, p, id string) (Category, json.RawMessage, error) {
	raw, err := rawRow(r.Context(), db, "SELECT "+categoryJSON+" FROM categories c WHERE profile_id=$1 AND id=$2", p, id)
	var category Category
	if err == nil {
		err = json.Unmarshal(raw, &category)
	}
	return category, raw, err
}

func (s *Server) listCategories(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	kind := r.URL.Query().Get("type")
	if kind != "" && !validKind(kind) {
		return invalid("type", "Неизвестный тип категории")
	}
	include := false
	if value := r.URL.Query().Get("include_archived"); value != "" {
		include, err = strconv.ParseBool(value)
		if err != nil {
			return invalid("include_archived", "Укажите true или false")
		}
	}
	rows, err := jsonRows(r.Context(), s.Pool, "SELECT "+categoryJSON+" FROM categories c WHERE profile_id=$1 AND ($2='' OR type=$2) AND ($3 OR NOT is_archived) ORDER BY created_at,id", person.ID, kind, include)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{"items": rows})
}

func (s *Server) createCategory(w http.ResponseWriter, r *http.Request) error {
	var body categoryInput
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
	if !validKind(body.Type) {
		return invalid("type", "Выберите доход или расход")
	}
	if !iconSet[body.Icon] {
		return invalid("icon", "Выберите значок из списка")
	}
	if !colorPattern.MatchString(body.Color) {
		return invalid("color", "Некорректный цвет")
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	raw, err := rawRow(r.Context(), tx, "SELECT "+categoryJSON+" FROM categories c WHERE id=$1", body.ID)
	if err == nil {
		var existing Category
		if err := json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		if existing.ProfileID != person.ID || existing.Name != body.Name || existing.Type != body.Type || existing.Icon != body.Icon || existing.Color != body.Color || existing.Archived {
			return duplicate()
		}
		return writeJSON(w, 200, raw)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO categories(id,profile_id,type,name,normalized_name,icon,color,is_archived,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,now(),now())", body.ID, person.ID, body.Type, body.Name, cases.Fold().String(body.Name), body.Icon, body.Color); err != nil {
		return err
	}
	_, raw, err = readCategory(r, tx, person.ID, body.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Location", "/api/v1/profiles/"+person.ID+"/categories/"+body.ID)
	return writeJSON(w, 201, raw)
}

func (s *Server) patchCategory(w http.ResponseWriter, r *http.Request) error {
	var body categoryPatch
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
	category, _, err := readCategory(r, tx, person.ID, id)
	if err != nil {
		return err
	}
	if body.Name != nil {
		category.Name, err = name(*body.Name)
		if err != nil {
			return err
		}
	}
	if body.Icon != nil {
		if !iconSet[*body.Icon] {
			return invalid("icon", "Выберите значок из списка")
		}
		category.Icon = *body.Icon
	}
	if body.Color != nil {
		if !colorPattern.MatchString(*body.Color) {
			return invalid("color", "Некорректный цвет")
		}
		category.Color = *body.Color
	}
	if body.Archived != nil {
		category.Archived = *body.Archived
	}
	if _, err := tx.Exec(r.Context(), "UPDATE categories SET name=$3,normalized_name=$4,icon=$5,color=$6,is_archived=$7,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id, category.Name, cases.Fold().String(category.Name), category.Icon, category.Color, category.Archived); err != nil {
		return err
	}
	_, raw, err := readCategory(r, tx, person.ID, id)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, raw)
}
