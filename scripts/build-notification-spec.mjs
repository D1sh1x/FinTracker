import { readFile, writeFile } from "node:fs/promises";
const path = "api/openapi.json";
const spec = JSON.parse(await readFile(path, "utf8"));
const ref = name => ({ $ref: "#/components/schemas/" + name });
const uuid = { type: "string", format: "uuid" };
spec.components.schemas.NotificationImportCreate = {
  type: "object", additionalProperties: false,
  required: ["id", "wallet_id", "package_name", "text", "posted_at"],
  properties: { id: uuid, wallet_id: uuid, package_name: { type: "string", const: "ru.wildberries.bank" }, text: { type: "string", maxLength: 2000 }, posted_at: { type: "string", format: "date-time" } },
};
spec.components.schemas.NotificationReceipt = {
  type: "object", additionalProperties: false, required: ["id", "transaction_id", "status"],
  properties: { id: uuid, transaction_id: uuid, status: { type: "string", const: "imported" } },
};
const response = { description: "Purchase imported. Replays return the original receipt, even after editing/deleting the transaction.", content: { "application/json": { schema: ref("NotificationReceipt") } } };
spec.paths["/api/v1/profiles/{p}/notification-imports"] = { post: {
  operationId: "import_wb_notification", tags: ["Notifications"],
  summary: "Import a WB Bank purchase notification exactly once",
  description: "Android filters the sender package. Server accepts only a strict RUB purchase format. id is a durable device event UUID; the same id with changed payload/profile conflicts. Different event IDs with equal amounts remain distinct. posted_at is converted to the profile timezone. Unknown categories fall back to Не определено. No raw text is persisted on the server. Existing screenshot/manual duplicates require manual reconciliation.",
  parameters: [{ name: "p", in: "path", required: true, schema: uuid }],
  requestBody: { required: true, content: { "application/json": { schema: ref("NotificationImportCreate") } } },
  responses: { 200: response, 201: response, ...Object.fromEntries([400,404,409,422,503].map(code => [code, { description: "Request rejected", content: { "application/json": { schema: ref("ErrorOut") } } }])) },
} };
const source = spec.components.schemas.TransactionOut.properties.source;
if (!source.enum.includes("notification")) source.enum.push("notification");
await writeFile(path, JSON.stringify(spec, null, 2) + "\n");
console.log("Notification import contract updated");
