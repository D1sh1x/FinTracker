import { readFile, writeFile } from "node:fs/promises";
const path = "api/openapi.json";
const spec = JSON.parse(await readFile(path, "utf8"));
const schemas = spec.components.schemas;
const str = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  date = { type: "string", format: "date" };
const amount = { type: "string", pattern: "^[1-9][0-9]{0,10}$" },
  signed = { type: "string", pattern: "^-?[0-9]+$" },
  version = { type: "integer", minimum: 1 };
const ref = (n) => ({ $ref: "#/components/schemas/" + n });
const object = (
  properties,
  required = Object.keys(properties),
  additionalProperties = false,
) => ({ type: "object", properties, required, additionalProperties });
const items = (n) => ({ type: "array", items: ref(n) });
const kind = {
  type: "string",
  enum: ["cash", "savings", "deposit", "investment"],
};
schemas.Account = object({
  id: uuid,
  profile_id: uuid,
  name: { type: "string", minLength: 1, maxLength: 50 },
  kind,
  is_primary: { type: "boolean" },
  is_archived: { type: "boolean" },
  opening_balance_minor: signed,
  tracking_start_date: date,
  version,
  balance_minor: signed,
});
schemas.Accounts = object({ items: items("Account") });
schemas.AccountCreate = object({
  id: uuid,
  name: { type: "string", minLength: 1, maxLength: 50 },
  kind,
  opening_balance_minor: signed,
  tracking_start_date: date,
});
schemas.AccountPatch = object(
  {
    name: { type: "string", minLength: 1, maxLength: 50 },
    is_archived: { type: "boolean" },
    version,
  },
  ["version"],
);
schemas.TransferCreate = object(
  {
    id: uuid,
    from_account_id: uuid,
    to_account_id: uuid,
    amount_minor: amount,
    occurred_on: date,
    note: { type: "string", maxLength: 500 },
  },
  ["id", "from_account_id", "to_account_id", "amount_minor", "occurred_on"],
);
schemas.Transfer = object(
  { ...schemas.TransferCreate.properties, profile_id: uuid, version },
  undefined,
  true,
);
schemas.Transfers = object({ items: items("Transfer") });
schemas.ValuationCreate = object({
  id: uuid,
  amount_minor: { type: "string", pattern: "^[0-9]{1,11}$" },
  expected_balance_minor: signed,
  version,
});
schemas.Valuation = object(
  {
    id: uuid,
    profile_id: uuid,
    account_id: uuid,
    amount_minor: signed,
    previous_minor: signed,
    delta_minor: signed,
    occurred_on: date,
    request_version: version,
  },
  undefined,
  true,
);
schemas.CapitalPoint = object({ date, balance_minor: signed });
schemas.Capital = object({
  currency: { type: "string", const: "RUB" },
  total_minor: signed,
  cash_minor: signed,
  investment_minor: signed,
  accounts: items("Account"),
  history: items("CapitalPoint"),
  valuations: items("Valuation"),
});
schemas.TransactionCreate.properties.wallet_id = {
  ...uuid,
  description: "Optional account UUID; omitted uses the primary account.",
};
schemas.TransactionPatch.properties.wallet_id = uuid;
schemas.ScreenshotImport.properties.wallet_id = uuid;
if (!schemas.ScreenshotImport.required.includes("wallet_id"))
  schemas.ScreenshotImport.required.push("wallet_id");
schemas.ScreenshotEdit.properties.wallet_id = uuid;
schemas.ScreenshotConfirm.properties.wallet_id = {
  ...uuid,
  description:
    "Optional destination account for all selected rows; omitted uses the saved draft account. Included in confirmation idempotency identity.",
};
const response = (n) => ({
  description: "Successful response",
  content: { "application/json": { schema: ref(n) } },
});
const errors = Object.fromEntries(
  [400, 404, 409, 410, 422, 503].map((c) => [
    c,
    {
      description: {
        400: "Invalid request",
        404: "Not found",
        409: "Version, balance or idempotency conflict",
        410: "Deleted transfer",
        422: "Validation error",
        503: "Service unavailable",
      }[c],
      content: { "application/json": { schema: ref("ErrorOut") } },
    },
  ]),
);
function operation(id, description, result, body, byId = false, status = 200) {
  return {
    tags: ["Capital"],
    operationId: id,
    summary: description,
    parameters: [
      { name: "p", in: "path", required: true, schema: uuid },
      ...(byId
        ? [{ name: "id", in: "path", required: true, schema: uuid }]
        : []),
    ],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref(body) } },
          },
        }
      : {}),
    responses: {
      [status]: result
        ? response(result)
        : { description: "Deleted; repeat is idempotent" },
      ...errors,
    },
  };
}
const base = "/api/v1/profiles/{p}";
spec.paths[base + "/accounts"] = {
  get: operation(
    "list_accounts",
    "All accounts including archives with exact balances",
    "Accounts",
  ),
  post: operation(
    "create_account",
    "Create a RUB account; same UUID and content retries return 200",
    "Account",
    "AccountCreate",
    false,
    201,
  ),
};
spec.paths[base + "/accounts"].post.responses[200] = response("Account");
spec.paths[base + "/accounts/{id}"] = {
  patch: operation(
    "patch_account",
    "Rename/archive account using optimistic version; primary account cannot be archived",
    "Account",
    "AccountPatch",
    true,
  ),
};
spec.paths[base + "/transfers"] = {
  get: operation(
    "list_transfers",
    "Latest 100 live transfers; excluded from income/expense budgets",
    "Transfers",
  ),
  post: operation(
    "create_transfer",
    "Atomically transfer between own accounts without changing total capital",
    "Transfer",
    "TransferCreate",
    false,
    201,
  ),
};
spec.paths[base + "/transfers"].post.responses[200] = response("Transfer");
const remove = operation(
  "delete_transfer",
  "Cancel transfer with version; repeats do not restore it",
  null,
  null,
  true,
  204,
);
remove.parameters.push({
  name: "version",
  in: "query",
  required: true,
  schema: version,
});
spec.paths[base + "/transfers/{id}"] = { delete: remove };
spec.paths[base + "/capital"] = {
  get: operation(
    "get_capital",
    "Exact total, cash/deposit and investment subtotals plus reconstructed daily history",
    "Capital",
  ),
};
spec.paths[base + "/accounts/{id}/valuations"] = {
  post: operation(
    "create_valuation",
    "Update investment value today. Expected balance detects concurrent money changes; revaluation never changes budgets",
    "Valuation",
    "ValuationCreate",
    true,
    201,
  ),
};
spec.paths[base + "/accounts/{id}/valuations"].post.responses[200] =
  response("Valuation");
await writeFile(path, JSON.stringify(spec, null, 2) + "\n");
console.log(
  "Capital contract updated: accounts, transfers, valuations, history and optional operation/import account.",
);
