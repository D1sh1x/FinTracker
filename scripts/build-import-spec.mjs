import { readFile, writeFile } from "node:fs/promises";
const path = "api/openapi.json";
const spec = JSON.parse(await readFile(path, "utf8"));
const lab = JSON.parse(await readFile("api/import-lab.openapi.json", "utf8"));
const ref = (name) => ({ $ref: "#/components/schemas/" + name });
const str = { type: "string" },
  nullable = { anyOf: [str, { type: "null" }] },
  uuid = { type: "string", format: "uuid" };
const response = (name, description = "Successful response") => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const err = spec.paths["/api/v1/profiles"].get.responses;
const errors = Object.fromEntries(
  ["400", "404", "409", "410", "422", "503"].map((code) => [
    code,
    {
      ...(err[code] ?? err["422"]),
      description: {
        400: "Invalid request",
        404: "Not found",
        409: "Version, state or duplicate conflict",
        410: "Deleted resource",
        422: "Validation error",
        503: "Database unavailable",
      }[code],
    },
  ]),
);
const schemas = spec.components.schemas;
schemas.TransactionOut.properties.source = {
  type: "string",
  title: "Source",
  enum: ["manual", "screenshot"],
};
schemas.ScreenshotRow = lab.components.schemas.Row;
schemas.ScreenshotRow.properties.category_id = {
  type: "string",
  description:
    "Active category UUID of this profile, or empty until direction/category is chosen.",
};
schemas.ScreenshotResult = JSON.parse(
  JSON.stringify(lab.components.schemas.Result).replaceAll(
    "#/components/schemas/Row",
    "#/components/schemas/ScreenshotRow",
  ),
);
schemas.ScreenshotReceipt = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: ref("TransactionOut") } },
};
schemas.ScreenshotImport = {
  type: "object",
  required: [
    "id",
    "profile_id",
    "capture_date",
    "status",
    "version",
    "created_at",
    "updated_at",
    "result",
    "duplicates",
    "error",
    "receipt",
  ],
  properties: {
    id: uuid,
    profile_id: uuid,
    capture_date: { type: "string", format: "date" },
    status: {
      type: "string",
      enum: [
        "queued",
        "processing",
        "ready",
        "failed",
        "confirmed",
        "cancelled",
      ],
    },
    version: { type: "integer", minimum: 1 },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    result: ref("ScreenshotResult"),
    duplicates: {
      type: "object",
      additionalProperties: { type: "array", items: ref("TransactionOut") },
      description:
        "Possible matches by date/type/amount; not automatic duplicates.",
    },
    error: str,
    receipt: { anyOf: [ref("ScreenshotReceipt"), { type: "null" }] },
  },
};
schemas.ScreenshotImports = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: ref("ScreenshotImport") } },
};
schemas.ScreenshotEditRow = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "description",
    "type",
    "amount_minor",
    "date",
    "category_id",
  ],
  properties: {
    id: uuid,
    description: { type: "string", maxLength: 500 },
    type: { type: "string", enum: ["income", "expense", "unknown"] },
    amount_minor: nullable,
    date: nullable,
    category_id: str,
  },
};
schemas.ScreenshotEdit = {
  type: "object",
  additionalProperties: false,
  required: ["version", "rows"],
  properties: {
    version: { type: "integer", minimum: 1 },
    rows: { type: "array", maxItems: 30, items: ref("ScreenshotEditRow") },
  },
};
schemas.ScreenshotConfirm = {
  type: "object",
  additionalProperties: false,
  required: ["version", "rows"],
  properties: {
    version: { type: "integer", minimum: 1 },
    rows: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "allow_duplicate"],
        properties: { id: uuid, allow_duplicate: { type: "boolean" } },
      },
    },
  },
};
schemas.ScreenshotVersion = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: { version: { type: "integer", minimum: 1 } },
};
if (schemas.Account) {
  schemas.ScreenshotImport.properties.wallet_id = uuid;
  schemas.ScreenshotImport.required.push("wallet_id");
  schemas.ScreenshotEdit.properties.wallet_id = uuid;
  schemas.ScreenshotConfirm.properties.wallet_id = {
    type: "string",
    format: "uuid",
    description:
      "Optional destination account for selected operations; omitted uses the saved draft account. Included in confirmation identity.",
  };
}
const parameters = [{ name: "p", in: "path", required: true, schema: uuid }];
const operation = (operationId, summary, method, body) => ({
  tags: ["Screenshot imports"],
  operationId,
  summary,
  parameters:
    method === "list" || method === "upload"
      ? parameters
      : [
          ...parameters,
          { name: "id", in: "path", required: true, schema: uuid },
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
    200: response(
      method === "list"
        ? "ScreenshotImports"
        : method === "confirm"
          ? "ScreenshotReceipt"
          : "ScreenshotImport",
    ),
    ...errors,
  },
});
const root = "/api/v1/profiles/{p}/imports";
const upload = operation(
  "upload_screenshot",
  "Queue a PNG/JPEG screenshot",
  "upload",
);
upload.description =
  "Requires confirmed capture_date. Up to 10 MiB and 20 megapixels. Exact file SHA-256 is deduplicated per profile. Existing ready/confirmed batch is returned; failed/cancelled batch can be retried. Creates only a persistent draft, never financial operations. RUB is fixed. Original bytes are deleted after processing, failure, cancellation or confirmation; queued bytes can appear in database backups.";
upload.requestBody = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["image", "capture_date"],
        properties: {
          image: { type: "string", format: "binary" },
          capture_date: { type: "string", format: "date" },
        },
      },
    },
  },
};
upload.responses["202"] = response("ScreenshotImport", "Queued");
spec.paths[root] = {
  get: operation(
    "list_screenshot_imports",
    "Latest 20 imports for the profile",
    "list",
  ),
  post: upload,
};
spec.paths[root + "/{id}"] = {
  get: operation(
    "get_screenshot_import",
    "Read draft and possible duplicates",
    "get",
  ),
};
spec.paths[root + "/{id}/rows"] = {
  patch: operation(
    "edit_screenshot_rows",
    "Save corrected fields with optimistic version",
    "edit",
    "ScreenshotEdit",
  ),
};
const confirm = operation(
  "confirm_screenshot_import",
  "Atomically confirm selected rows",
  "confirm",
  "ScreenshotConfirm",
);
confirm.description =
  "Requires current version and explicit allow_duplicate for rows matching live operations by date/type/amount. Revalidates categories, wallet/date and amounts under the profile lock. Selected rows are committed atomically; unselected rows are skipped and the batch is closed. Same confirmed request returns the original receipt, even after operation edits/deletion. Changed confirmation returns 409. Deleting an imported operation does not allow silent recreation by this import.";
spec.paths[root + "/{id}/confirm"] = { post: confirm };
spec.paths[root + "/{id}/cancel"] = {
  post: operation(
    "cancel_screenshot_import",
    "Cancel processing/draft without financial writes",
    "cancel",
    "ScreenshotVersion",
  ),
};
await writeFile(path, JSON.stringify(spec, null, 2) + "\n");
