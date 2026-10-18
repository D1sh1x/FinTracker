package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fintrack/internal/bankpush"
	"fintrack/internal/importlab"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type notificationInput struct {
	ID       string `json:"id"`
	WalletID string `json:"wallet_id"`
	Package  string `json:"package_name"`
	Text     string `json:"text"`
	PostedAt string `json:"posted_at"`
}

func (s *Server) notificationCategory(r *http.Request, p, description string) (string, error) {
	raw, err := jsonRows(r.Context(), s.Pool, "SELECT "+categoryJSON+" FROM categories c WHERE profile_id=$1 AND type='expense' AND NOT is_archived ORDER BY created_at,id", p)
	if err != nil {
		return "", err
	}
	catalog := []importlab.Category{{ID: importlab.UnknownCategory, Name: "Не определено", Type: "unknown"}}
	unknown, rule := "", ""
	for _, data := range raw {
		var c Category
		if err := json.Unmarshal(data, &c); err != nil {
			return "", err
		}
		if strings.EqualFold(c.Name, "Не определено") {
			unknown = c.ID
			continue
		}
		if strings.EqualFold(c.Name, bankpush.Category(description)) {
			rule = c.ID
		}
		catalog = append(catalog, importlab.Category{ID: c.ID, Name: c.Name, Type: c.Type})
	}
	if rule != "" {
		return rule, nil
	}
	if unknown == "" {
		return "", conflict("unknown_category_missing", "Восстановите категорию расходов «Не определено»")
	}
	if s.ModelURL == "" {
		return unknown, nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	engine := importlab.New(s.ModelURL, "", "")
	engine.Categories = catalog
	defer engine.Client.CloseIdleConnections()
	rows := []importlab.Row{{Type: "expense", Description: description}}
	engine.Classify(ctx, rows)
	if rows[0].CategoryID == importlab.UnknownCategory || rows[0].CategoryID == "" {
		return unknown, nil
	}
	return rows[0].CategoryID, nil
}

func notificationReceipt(r *http.Request, db queryer, p, id, hash string) (string, error) {
	var profile, storedHash, transaction string
	err := db.QueryRow(r.Context(), "SELECT profile_id::text,request_sha256,transaction_id::text FROM notification_receipts WHERE id=$1", id).Scan(&profile, &storedHash, &transaction)
	if err != nil {
		return "", err
	}
	if profile != p || storedHash != hash {
		return "", duplicate()
	}
	return transaction, nil
}

func (s *Server) importNotification(w http.ResponseWriter, r *http.Request) error {
	var body notificationInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	var err error
	if body.ID, err = identifier(body.ID); err != nil {
		return err
	}
	if body.WalletID, err = identifier(body.WalletID); err != nil {
		return err
	}
	if body.Package != bankpush.Package {
		return invalid("package_name", "Поддерживается только приложение WB Банка")
	}
	if utf8.RuneCountInString(body.Text) > 2000 {
		return invalid("text", "Слишком длинное уведомление")
	}
	posted, err := time.Parse(time.RFC3339Nano, body.PostedAt)
	if err != nil || posted.After(s.Now().Add(5*time.Minute)) {
		return invalid("posted_at", "Проверьте время уведомления")
	}
	purchase, err := bankpush.Parse(body.Text)
	if err != nil {
		return &apiError{Status: 422, Code: "notification_unrecognized", Message: "Уведомление не похоже на поддерживаемую покупку WB Банка. Проверьте его вручную"}
	}
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(body)
	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])
	transaction, err := notificationReceipt(r, s.Pool, person.ID, body.ID, hash)
	if err == nil {
		return writeJSON(w, 200, map[string]string{"id": body.ID, "transaction_id": transaction, "status": "imported"})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	category, err := s.notificationCategory(r, person.ID, purchase.Description)
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	transaction, err = notificationReceipt(r, tx, person.ID, body.ID, hash)
	if err == nil {
		return writeJSON(w, 200, map[string]string{"id": body.ID, "transaction_id": transaction, "status": "imported"})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	zone, err := time.LoadLocation(person.Timezone)
	if err != nil {
		return err
	}
	row := Operation{ID: uuid.NewString(), ProfileID: person.ID, WalletID: body.WalletID, CategoryID: category, Type: "expense", Amount: purchase.Amount, Date: posted.In(zone).Format("2006-01-02"), Note: purchase.Description}
	if err := s.validateOperation(r, tx, person, &row, nil); err != nil {
		return err
	}
	amount, _ := strconv.ParseInt(row.Amount, 10, 64)
	_, err = tx.Exec(r.Context(), "INSERT INTO transactions(id,profile_id,wallet_id,category_id,type,amount_minor,occurred_on,note,source,version,created_at,updated_at) VALUES($1,$2,$3,$4,'expense',$5,$6,$7,'notification',1,now(),now())", row.ID, person.ID, row.WalletID, row.CategoryID, amount, row.Date, row.Note)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), "INSERT INTO notification_receipts(id,profile_id,request_sha256,transaction_id) VALUES($1,$2,$3,$4)", body.ID, person.ID, hash, row.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 201, map[string]string{"id": body.ID, "transaction_id": row.ID, "status": "imported"})
}
