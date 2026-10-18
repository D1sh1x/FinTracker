package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"fintrack/internal/importlab"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxAmount          int64 = 99_999_999_999
	profileJSON              = `to_jsonb(p)`
	walletJSON               = `to_jsonb(w) || jsonb_build_object('opening_balance_minor', w.opening_balance_minor::text, 'tracking_start_date', to_char(w.tracking_start_date, 'YYYY-MM-DD'))`
	categoryJSON             = `to_jsonb(c) - 'normalized_name'`
	transactionJSON          = `to_jsonb(t) - 'deleted_at' || jsonb_build_object('amount_minor', t.amount_minor::text, 'occurred_on', to_char(t.occurred_on, 'YYYY-MM-DD'))`
	budgetJSON               = `to_jsonb(b) - 'deleted_at' || jsonb_build_object('limit_minor', b.limit_minor::text, 'month', to_char(b.month, 'YYYY-MM'))`
	categoryBudgetJSON       = `to_jsonb(b) - 'deleted_at' - 'category_type' || jsonb_build_object('limit_minor', b.limit_minor::text, 'month', to_char(b.month, 'YYYY-MM'))`
)

type Server struct {
	Pool          *pgxpool.Pool
	Now           func() time.Time
	OpenAPIPath   string
	ModelURL      string
	ImportWorker  *ImportWorker
	ProcessImport func(context.Context, []byte, string, []importlab.Category) (importlab.Result, error)
}

type Profile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Timezone string `json:"timezone"`
}

type Wallet struct {
	ProfileID string `json:"profile_id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Primary   bool   `json:"is_primary"`
	Archived  bool   `json:"is_archived"`
	ID        string `json:"id"`
	Opening   string `json:"opening_balance_minor"`
	Start     string `json:"tracking_start_date"`
	Version   int    `json:"version"`
}

type Category struct {
	ID        string `json:"id"`
	ProfileID string `json:"profile_id"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	Icon      string `json:"icon"`
	Color     string `json:"color"`
	Archived  bool   `json:"is_archived"`
}

type Operation struct {
	ID         string     `json:"id"`
	ProfileID  string     `json:"profile_id"`
	WalletID   string     `json:"wallet_id"`
	CategoryID string     `json:"category_id"`
	Type       string     `json:"type"`
	Amount     string     `json:"amount_minor"`
	Date       string     `json:"occurred_on"`
	Note       string     `json:"note"`
	Source     string     `json:"source"`
	Version    int        `json:"version"`
	DeletedAt  *time.Time `json:"deleted_at"`
}

type Budget struct {
	ID        string     `json:"id"`
	Month     string     `json:"month"`
	Limit     string     `json:"limit_minor"`
	Version   int        `json:"version"`
	DeletedAt *time.Time `json:"deleted_at"`
}

type apiError struct {
	Status  int
	Code    string
	Message string
	Fields  map[string]string
}

type queryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type endpoint func(http.ResponseWriter, *http.Request) error

type profileInput struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Timezone *string `json:"timezone"`
}

type profilePatch struct {
	Name     *string `json:"name"`
	Timezone *string `json:"timezone"`
}

type walletPatch struct {
	Opening *string `json:"opening_balance_minor"`
	Start   *string `json:"tracking_start_date"`
	Version int     `json:"version"`
}

type categoryInput struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

type categoryPatch struct {
	Name     *string `json:"name"`
	Icon     *string `json:"icon"`
	Color    *string `json:"color"`
	Archived *bool   `json:"is_archived"`
}

type operationInput struct {
	WalletID   string `json:"wallet_id"`
	ID         string `json:"id"`
	Type       string `json:"type"`
	Amount     string `json:"amount_minor"`
	CategoryID string `json:"category_id"`
	Date       string `json:"occurred_on"`
	Note       string `json:"note"`
}

type operationPatch struct {
	WalletID   *string `json:"wallet_id"`
	Type       *string `json:"type"`
	Amount     *string `json:"amount_minor"`
	CategoryID *string `json:"category_id"`
	Date       *string `json:"occurred_on"`
	Note       *string `json:"note"`
	Version    int     `json:"version"`
}

type budgetInput struct {
	Limit   string `json:"limit_minor"`
	Version *int   `json:"version"`
}

type filters struct {
	From     string
	To       string
	Type     string
	Category string
	Q        string
}

type pageCursor struct {
	Context string `json:"context"`
	Date    string `json:"date"`
	ID      string `json:"id"`
}

type categoryTotal struct {
	ID     string `json:"category_id"`
	Name   string `json:"name"`
	Icon   string `json:"icon"`
	Color  string `json:"color"`
	Amount string `json:"amount_minor"`
}

func (e *apiError) Error() string { return e.Code }

func (s *Server) NewHandler() http.Handler {
	mux := http.NewServeMux()
	routes := map[string]endpoint{
		"GET /api/v1/profiles":                                      s.listProfiles,
		"POST /api/v1/profiles":                                     s.createProfile,
		"GET /api/v1/profiles/{p}":                                  s.getProfile,
		"PATCH /api/v1/profiles/{p}":                                s.patchProfile,
		"GET /api/v1/profiles/{p}/wallet":                           s.getWallet,
		"GET /api/v1/profiles/{p}/accounts":                         s.listAccounts,
		"POST /api/v1/profiles/{p}/accounts":                        s.createAccount,
		"PATCH /api/v1/profiles/{p}/accounts/{id}":                  s.patchAccount,
		"GET /api/v1/profiles/{p}/capital":                          s.getCapital,
		"GET /api/v1/profiles/{p}/transfers":                        s.listTransfers,
		"POST /api/v1/profiles/{p}/transfers":                       s.createTransfer,
		"DELETE /api/v1/profiles/{p}/transfers/{id}":                s.deleteTransfer,
		"POST /api/v1/profiles/{p}/accounts/{id}/valuations":        s.createValuation,
		"PATCH /api/v1/profiles/{p}/wallet":                         s.patchWallet,
		"GET /api/v1/profiles/{p}/categories":                       s.listCategories,
		"POST /api/v1/profiles/{p}/categories":                      s.createCategory,
		"PATCH /api/v1/profiles/{p}/categories/{id}":                s.patchCategory,
		"GET /api/v1/profiles/{p}/transactions":                     s.listOperations,
		"POST /api/v1/profiles/{p}/transactions":                    s.createOperation,
		"POST /api/v1/profiles/{p}/notification-imports":            s.importNotification,
		"GET /api/v1/profiles/{p}/transactions/{id}":                s.getOperation,
		"PATCH /api/v1/profiles/{p}/transactions/{id}":              s.patchOperation,
		"DELETE /api/v1/profiles/{p}/transactions/{id}":             s.deleteOperation,
		"GET /api/v1/profiles/{p}/budgets/{month}":                  s.getBudget,
		"PUT /api/v1/profiles/{p}/budgets/{month}":                  s.putBudget,
		"DELETE /api/v1/profiles/{p}/budgets/{month}":               s.deleteBudget,
		"GET /api/v1/profiles/{p}/category-budgets/{month}":         s.listCategoryBudgets,
		"PUT /api/v1/profiles/{p}/category-budgets/{month}/{id}":    s.putCategoryBudget,
		"DELETE /api/v1/profiles/{p}/category-budgets/{month}/{id}": s.deleteCategoryBudget,
		"GET /api/v1/profiles/{p}/summary":                          s.summary,
		"GET /api/v1/profiles/{p}/imports":                          s.listImports,
		"POST /api/v1/profiles/{p}/imports":                         s.uploadImport,
		"GET /api/v1/profiles/{p}/imports/{id}":                     s.getImport,
		"PATCH /api/v1/profiles/{p}/imports/{id}/rows":              s.editImport,
		"POST /api/v1/profiles/{p}/imports/{id}/confirm":            s.confirmImport,
		"POST /api/v1/profiles/{p}/imports/{id}/cancel":             s.cancelImport,
		"GET /api/v1/profiles/{p}/exports/transactions.csv":         s.exportCSV,
		"GET /health/live":                                          s.live,
		"GET /health/ready":                                         s.ready,
	}
	for pattern, handler := range routes {
		mux.HandleFunc(pattern, s.wrap(handler))
	}
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, s.OpenAPIPath) })
	mux.HandleFunc("/", s.wrap(func(w http.ResponseWriter, r *http.Request) error { return missing() }))
	return mux
}

func rawRow(ctx context.Context, db queryer, query string, args ...any) (json.RawMessage, error) {
	var raw json.RawMessage
	err := db.QueryRow(ctx, query, args...).Scan(&raw)
	return raw, err
}

func jsonRows(ctx context.Context, db queryer, query string, args ...any) ([]json.RawMessage, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		result = append(result, raw)
	}
	return result, rows.Err()
}
