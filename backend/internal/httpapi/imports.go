package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fintrack/internal/importlab"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ScreenshotImport struct {
	WalletID      string                 `json:"wallet_id"`
	ID            string                 `json:"id"`
	ProfileID     string                 `json:"profile_id"`
	CaptureDate   string                 `json:"capture_date"`
	Status        string                 `json:"status"`
	Version       int                    `json:"version"`
	CreatedAt     time.Time              `json:"created_at"`
	UpdatedAt     time.Time              `json:"updated_at"`
	Result        importlab.Result       `json:"result"`
	Duplicates    map[string][]Operation `json:"duplicates"`
	Error         string                 `json:"error"`
	Receipt       *ImportReceipt         `json:"receipt"`
	confirmedHash string
}

type ImportReceipt struct {
	Items []json.RawMessage `json:"items"`
}
type importEditRow struct {
	ID          string  `json:"id"`
	Description string  `json:"description"`
	Type        string  `json:"type"`
	Amount      *string `json:"amount_minor"`
	Date        *string `json:"date"`
	CategoryID  string  `json:"category_id"`
}
type importEditInput struct {
	WalletID *string         `json:"wallet_id,omitempty"`
	Version  int             `json:"version"`
	Rows     []importEditRow `json:"rows"`
}
type importSelection struct {
	ID             string `json:"id"`
	AllowDuplicate bool   `json:"allow_duplicate"`
}
type importConfirmInput struct {
	WalletID string            `json:"wallet_id,omitempty"`
	Version  int               `json:"version"`
	Rows     []importSelection `json:"rows"`
}
type importVersionInput struct {
	Version int `json:"version"`
}

func readImport(r *http.Request, db queryer, p, id string, lock bool) (ScreenshotImport, error) {
	var job ScreenshotImport
	var result, receipt []byte
	var hash *string
	query := `SELECT id::text,profile_id::text,to_char(capture_date,'YYYY-MM-DD'),status,version,created_at,updated_at,result,error,receipt,confirmed_hash,account_id::text FROM screenshot_imports WHERE profile_id=$1 AND id=$2`
	if lock {
		query += " FOR UPDATE"
	}
	err := db.QueryRow(r.Context(), query, p, id).Scan(&job.ID, &job.ProfileID, &job.CaptureDate, &job.Status, &job.Version, &job.CreatedAt, &job.UpdatedAt, &result, &job.Error, &receipt, &hash, &job.WalletID)
	if err != nil {
		return job, err
	}
	job.Result = importlab.Result{Rows: []importlab.Row{}, Lines: []importlab.OCRLine{}, Warnings: []string{}}
	if err = json.Unmarshal(result, &job.Result); err != nil {
		return job, err
	}
	if receipt != nil {
		if err = json.Unmarshal(receipt, &job.Receipt); err != nil {
			return job, err
		}
	}
	if hash != nil {
		job.confirmedHash = *hash
	}
	job.Duplicates = map[string][]Operation{}
	return job, nil
}

func (s *Server) importPath(r *http.Request) (Profile, string, error) {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return person, "", err
	}
	id, err := identifier(r.PathValue("id"))
	return person, id, err
}

func (s *Server) importDuplicates(r *http.Request, db queryer, job *ScreenshotImport) error {
	for _, row := range job.Result.Rows {
		matches, err := duplicateOperations(r, db, job.ProfileID, row)
		if err != nil {
			return err
		}
		if len(matches) > 0 {
			job.Duplicates[row.ID] = matches
		}
	}
	return nil
}

func duplicateOperations(r *http.Request, db queryer, p string, row importlab.Row) ([]Operation, error) {
	result := []Operation{}
	if row.Date == nil || row.Amount == nil || !validKind(row.Type) {
		return result, nil
	}
	if _, err := validDate(*row.Date); err != nil {
		return result, nil
	}
	amount, err := money(*row.Amount, false)
	if err != nil {
		return result, nil
	}
	raws, err := jsonRows(r.Context(), db, "SELECT "+transactionJSON+" FROM transactions t WHERE profile_id=$1 AND deleted_at IS NULL AND occurred_on=$2 AND type=$3 AND amount_minor=$4 ORDER BY id LIMIT 5", p, *row.Date, row.Type, amount)
	if err != nil {
		return result, err
	}
	for _, raw := range raws {
		var op Operation
		if err = json.Unmarshal(raw, &op); err != nil {
			return result, err
		}
		result = append(result, op)
	}
	return result, nil
}

func (s *Server) listImports(w http.ResponseWriter, r *http.Request) error {
	person, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false)
	if err != nil {
		return err
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT id::text FROM screenshot_imports WHERE profile_id=$1 ORDER BY created_at DESC,id LIMIT 20", person.ID)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	items := []ScreenshotImport{}
	for _, id := range ids {
		job, err := readImport(r, s.Pool, person.ID, id, false)
		if err != nil {
			return err
		}
		items = append(items, job)
	}
	return writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) getImport(w http.ResponseWriter, r *http.Request) error {
	person, id, err := s.importPath(r)
	if err != nil {
		return err
	}
	job, err := readImport(r, s.Pool, person.ID, id, false)
	if err != nil {
		return err
	}
	if job.Status == "ready" {
		if err = s.importDuplicates(r, s.Pool, &job); err != nil {
			return err
		}
	}
	return writeJSON(w, 200, job)
}

func uploadedImage(w http.ResponseWriter, r *http.Request) ([]byte, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 11<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, "", invalid("image", "Выберите PNG/JPEG или вставьте скриншот через Ctrl+V")
	}
	var data []byte
	capture := ""
	seenDate := false
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", invalid("image", "Не удалось прочитать загрузку")
		}
		switch part.FormName() {
		case "image":
			if data != nil {
				_ = part.Close()
				return nil, "", invalid("image", "Загрузите один скриншот")
			}
			data, err = io.ReadAll(io.LimitReader(part, (10<<20)+1))
			if err != nil || len(data) > 10<<20 {
				_ = part.Close()
				return nil, "", invalid("image", "Файл больше 10 МБ")
			}
		case "capture_date":
			if seenDate {
				_ = part.Close()
				return nil, "", invalid("capture_date", "Дата указана дважды")
			}
			seenDate = true
			value, err := io.ReadAll(io.LimitReader(part, 32))
			if err != nil {
				_ = part.Close()
				return nil, "", invalid("capture_date", "Не удалось прочитать дату")
			}
			capture = string(value)
		default:
			_ = part.Close()
			return nil, "", invalid("image", "Неизвестное поле загрузки")
		}
		_ = part.Close()
	}
	if len(data) == 0 {
		return nil, "", invalid("image", "Выберите скриншот")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 20_000_000 {
		return nil, "", invalid("image", "Нужен PNG/JPEG не больше 20 млн пикселей")
	}
	if _, err := validDate(capture); err != nil {
		return nil, "", invalid("capture_date", "Укажите дату съёмки скриншота")
	}
	return data, capture, nil
}

func (s *Server) uploadImport(w http.ResponseWriter, r *http.Request) error {
	// Validate the profile before reading a large upload.
	if _, _, err := s.readProfile(r.Context(), s.Pool, r.PathValue("p"), false); err != nil {
		return err
	}
	data, capture, err := uploadedImage(w, r)
	if err != nil {
		return err
	}
	tx, person, err := s.beginWrite(r)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if capture > s.today(person.Timezone) {
		return invalid("capture_date", "Дата съёмки не может быть в будущем")
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	var id, status string
	err = tx.QueryRow(r.Context(), "SELECT id::text,status FROM screenshot_imports WHERE profile_id=$1 AND file_sha256=$2 FOR UPDATE", person.ID, hash).Scan(&id, &status)
	code := 200
	if errors.Is(err, pgx.ErrNoRows) {
		id = uuid.NewString()
		wallet, _, walletErr := readWallet(r, tx, person.ID)
		if walletErr != nil {
			return walletErr
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO screenshot_imports(id,profile_id,file_sha256,capture_date,status,image,account_id) VALUES($1,$2,$3,$4,'queued',$5,$6)", id, person.ID, hash, capture, data, wallet.ID)
		code = 202
	} else if err == nil && (status == "failed" || status == "cancelled") {
		_, err = tx.Exec(r.Context(), "UPDATE screenshot_imports SET status='queued',version=version+1,image=$3,capture_date=$4,result='{}',error='',lease_until=NULL,lease_token=NULL,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id, data, capture)
		code = 202
	} else if status == "queued" || status == "processing" {
		code = 202
	}
	if err != nil {
		return err
	}
	job, err := readImport(r, tx, person.ID, id, false)
	if err != nil {
		return err
	}
	if job.Status == "ready" {
		if err = s.importDuplicates(r, tx, &job); err != nil {
			return err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Location", "/api/v1/profiles/"+person.ID+"/imports/"+id)
	return writeJSON(w, code, job)
}

func mutableImport(job ScreenshotImport, version int) error {
	if job.Version != version {
		return conflict("version_conflict", "Черновик изменился. Загрузите актуальную версию")
	}
	if job.Status != "ready" {
		return conflict("import_state", "Черновик сейчас нельзя редактировать или подтверждать")
	}
	return nil
}

func (s *Server) editImport(w http.ResponseWriter, r *http.Request) error {
	var body importEditInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if body.Rows == nil || len(body.Rows) > 30 {
		return invalid("rows", "Допускается до 30 строк")
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
	job, err := readImport(r, tx, person.ID, id, true)
	if err != nil {
		return err
	}
	if err = mutableImport(job, body.Version); err != nil {
		return err
	}
	if body.WalletID != nil {
		account, err := operationAccount(r, tx, person.ID, *body.WalletID)
		if err != nil {
			return err
		}
		if account.Archived {
			return conflict("account_archived", "Выберите активный счёт")
		}
		job.WalletID = account.ID
	}
	previous := map[string]importlab.Row{}
	for _, row := range job.Result.Rows {
		previous[row.ID] = row
	}
	rows := []importlab.Row{}
	seen := map[string]bool{}
	for _, input := range body.Rows {
		rowID, err := identifier(input.ID)
		if err != nil {
			return err
		}
		if seen[rowID] {
			return invalid("rows", "ID строк должны быть различными")
		}
		seen[rowID] = true
		if !utf8.ValidString(input.Description) || utf8.RuneCountInString(input.Description) > 500 {
			return invalid("description", "Название не должно превышать 500 символов")
		}
		if input.Type != "unknown" && !validKind(input.Type) {
			return invalid("type", "Выберите доход, расход или неизвестное направление")
		}
		if input.Amount != nil {
			if _, err := money(*input.Amount, false); err != nil {
				return err
			}
		}
		if input.Date != nil {
			if _, err := validDate(*input.Date); err != nil {
				return err
			}
		}
		row := previous[rowID]
		row.ID = rowID
		row.Description = strings.TrimSpace(input.Description)
		row.Type = input.Type
		row.Amount = input.Amount
		row.Date = input.Date
		row.CategoryID = input.CategoryID
		row.CategoryName = "Не определено"
		if input.CategoryID != "" {
			cid, err := identifier(input.CategoryID)
			if err != nil {
				return err
			}
			category, _, err := readCategory(r, tx, person.ID, cid)
			if err != nil {
				return err
			}
			if category.Type != row.Type {
				return invalid("category_id", "Категория должна соответствовать направлению")
			}
			row.CategoryID = cid
			row.CategoryName = category.Name
		}
		row.Issues = []string{}
		if row.Amount == nil {
			row.Issues = append(row.Issues, "Укажите сумму")
		}
		if row.Date == nil {
			row.Issues = append(row.Issues, "Укажите дату")
		}
		if !validKind(row.Type) {
			row.Issues = append(row.Issues, "Укажите направление")
		}
		if row.Description == "" {
			row.Issues = append(row.Issues, "Укажите название")
		}
		row.Reason = "Поля проверены и исправлены пользователем"
		rows = append(rows, row)
	}
	job.Result.Rows = rows
	result, err := json.Marshal(job.Result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), "UPDATE screenshot_imports SET result=$3,account_id=$4,version=version+1,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id, result, job.WalletID)
	if err != nil {
		return err
	}
	job, err = readImport(r, tx, person.ID, id, false)
	if err != nil {
		return err
	}
	if err = s.importDuplicates(r, tx, &job); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, job)
}

func (s *Server) confirmImport(w http.ResponseWriter, r *http.Request) error {
	var body importConfirmInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	if len(body.Rows) < 1 || len(body.Rows) > 30 {
		return invalid("rows", "Выберите от 1 до 30 операций")
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
	job, err := readImport(r, tx, person.ID, id, true)
	if err != nil {
		return err
	}
	encoded, _ := json.Marshal(body)
	sum := sha256.Sum256(encoded)
	hash := hex.EncodeToString(sum[:])
	if job.Status == "confirmed" {
		if job.confirmedHash != hash {
			return conflict("import_confirmed", "Этот импорт уже подтверждён с другим набором строк")
		}
		return writeJSON(w, 200, job.Receipt)
	}
	if err = mutableImport(job, body.Version); err != nil {
		return err
	}
	accountID := body.WalletID
	if accountID == "" {
		accountID = job.WalletID
	}
	source := map[string]importlab.Row{}
	for _, row := range job.Result.Rows {
		source[row.ID] = row
	}
	seen := map[string]bool{}
	operations := []Operation{}
	for _, selection := range body.Rows {
		row, ok := source[selection.ID]
		if !ok || seen[selection.ID] {
			return invalid("rows", "Выбрана неизвестная или повторная строка")
		}
		seen[selection.ID] = true
		if row.Amount == nil || row.Date == nil || row.Description == "" {
			return invalid(row.ID, "Проверьте сумму, дату и название выбранной строки")
		}
		categoryID := row.CategoryID
		if categoryID == "" {
			err = tx.QueryRow(r.Context(), "SELECT id::text FROM categories WHERE profile_id=$1 AND type=$2 AND normalized_name='не определено' AND NOT is_archived", person.ID, row.Type).Scan(&categoryID)
			if err != nil {
				return invalid(row.ID, "Выберите активную категорию")
			}
		}
		op := Operation{ID: uuid.NewSHA1(uuid.MustParse(job.ID), []byte(row.ID)).String(), ProfileID: person.ID, WalletID: accountID, Type: row.Type, Amount: *row.Amount, Date: *row.Date, Note: row.Description, CategoryID: categoryID}
		if err = s.validateOperation(r, tx, person, &op, nil); err != nil {
			return err
		}
		duplicates, err := duplicateOperations(r, tx, person.ID, row)
		if err != nil {
			return err
		}
		if len(duplicates) > 0 && !selection.AllowDuplicate {
			return conflict("possible_duplicate", "Есть похожая операция. Обновите черновик и подтвердите, что это отдельная запись")
		}
		operations = append(operations, op)
	}
	receipt := ImportReceipt{Items: []json.RawMessage{}}
	for _, op := range operations {
		amount, _ := strconv.ParseInt(op.Amount, 10, 64)
		_, err = tx.Exec(r.Context(), "INSERT INTO transactions(id,profile_id,wallet_id,category_id,type,amount_minor,occurred_on,note,source,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'screenshot',1,now(),now())", op.ID, person.ID, op.WalletID, op.CategoryID, op.Type, amount, op.Date, op.Note)
		if err != nil {
			return err
		}
		raw, err := visibleOperation(r, tx, person.ID, op.ID)
		if err != nil {
			return err
		}
		receipt.Items = append(receipt.Items, raw)
	}
	receiptJSON, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = tx.Exec(r.Context(), "UPDATE screenshot_imports SET status='confirmed',version=version+1,image=NULL,confirmed_hash=$3,receipt=$4,account_id=$5,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id, hash, receiptJSON, operations[0].WalletID)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	return writeJSON(w, 200, receipt)
}

func (s *Server) cancelImport(w http.ResponseWriter, r *http.Request) error {
	var body importVersionInput
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
	job, err := readImport(r, tx, person.ID, id, true)
	if err != nil {
		return err
	}
	if job.Status == "confirmed" {
		return conflict("import_confirmed", "Подтверждённый импорт нельзя отменить; операции можно редактировать в истории")
	}
	if job.Status != "cancelled" && job.Version != body.Version {
		return conflict("version_conflict", "Черновик изменился. Обновите его")
	}
	if job.Status != "cancelled" {
		_, err = tx.Exec(r.Context(), "UPDATE screenshot_imports SET status='cancelled',version=version+1,image=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE profile_id=$1 AND id=$2", person.ID, id)
		if err != nil {
			return err
		}
	}
	job, err = readImport(r, tx, person.ID, id, false)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	if s.ImportWorker != nil {
		s.ImportWorker.Cancel(id)
	}
	return writeJSON(w, 200, job)
}
