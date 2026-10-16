import { readFile, writeFile, mkdir } from "node:fs/promises";
const spec = JSON.parse(await readFile("api/openapi.json", "utf8"));
const root = "postman/collections/FinTrack API";
const base = "/api/v1/profiles/{p}";
const cases = [
  [
    "Create profile",
    "POST",
    "/api/v1/profiles",
    201,
    { id: "{{profile_id}}", name: "Проверка капитала" },
    "",
  ],
  [
    "Primary account",
    "GET",
    base + "/wallet",
    200,
    null,
    "pm.collectionVariables.set('primary_id',pm.response.json().id);",
  ],
  [
    "Opening money",
    "PATCH",
    base + "/wallet",
    200,
    { version: 1, opening_balance_minor: "1000000" },
  ],
  [
    "Savings account",
    "POST",
    base + "/accounts",
    201,
    {
      id: "{{savings_id}}",
      name: "Подушка",
      kind: "savings",
      opening_balance_minor: "0",
      tracking_start_date: "{{today}}",
    },
  ],
  [
    "Investment account",
    "POST",
    base + "/accounts",
    201,
    {
      id: "{{investment_id}}",
      name: "Портфель",
      kind: "investment",
      opening_balance_minor: "200000",
      tracking_start_date: "{{today}}",
    },
  ],
  [
    "Initial capital",
    "GET",
    base + "/capital",
    200,
    null,
    "const x=pm.response.json();pm.test('Exact initial capital',()=>{pm.expect(x.total_minor).to.equal('1200000');pm.expect(x.accounts).to.have.length(3);});",
  ],
  [
    "Transfer to investments",
    "POST",
    base + "/transfers",
    201,
    {
      id: "{{transfer_id}}",
      from_account_id: "{{primary_id}}",
      to_account_id: "{{investment_id}}",
      amount_minor: "50000",
      occurred_on: "{{today}}",
    },
  ],
  [
    "Repeat transfer",
    "POST",
    base + "/transfers",
    200,
    {
      id: "{{transfer_id}}",
      from_account_id: "{{primary_id}}",
      to_account_id: "{{investment_id}}",
      amount_minor: "50000",
      occurred_on: "{{today}}",
    },
  ],
  [
    "Value investment",
    "POST",
    base + "/accounts/{id}/valuations",
    201,
    {
      id: "{{valuation_id}}",
      amount_minor: "300000",
      expected_balance_minor: "250000",
      version: 1,
    },
  ],
  [
    "Repeat valuation",
    "POST",
    base + "/accounts/{id}/valuations",
    200,
    {
      id: "{{valuation_id}}",
      amount_minor: "300000",
      expected_balance_minor: "250000",
      version: 1,
    },
  ],
  [
    "Capital after valuation",
    "GET",
    base + "/capital",
    200,
    null,
    "const x=pm.response.json();pm.test('Transfer preserved capital; valuation changed it',()=>{pm.expect(x.total_minor).to.equal('1250000');pm.expect(x.cash_minor).to.equal('950000');pm.expect(x.investment_minor).to.equal('300000');pm.expect(x.history.at(-1).balance_minor).to.equal(x.total_minor);});",
  ],
  [
    "No spending or income",
    "GET",
    base + "/summary",
    200,
    null,
    "const x=pm.response.json();pm.test('Transfers and valuations excluded',()=>{pm.expect(x.income_minor).to.equal('0');pm.expect(x.expense_minor).to.equal('0');pm.expect(x.balance_minor).to.equal('950000');});",
  ],
  ["Cancel transfer", "DELETE", base + "/transfers/{id}", 204],
  ["Repeat cancellation", "DELETE", base + "/transfers/{id}", 204],
  [
    "Deleted transfer retry",
    "POST",
    base + "/transfers",
    410,
    {
      id: "{{transfer_id}}",
      from_account_id: "{{primary_id}}",
      to_account_id: "{{investment_id}}",
      amount_minor: "50000",
      occurred_on: "{{today}}",
    },
  ],
  [
    "Final capital",
    "GET",
    base + "/capital",
    200,
    null,
    "const x=pm.response.json();pm.test('Cancellation preserves total',()=>{pm.expect(x.total_minor).to.equal('1250000');pm.expect(x.cash_minor).to.equal('1000000');pm.expect(x.investment_minor).to.equal('250000');});",
  ],
  [
    "Stale valuation rejected",
    "POST",
    base + "/accounts/{id}/valuations",
    409,
    {
      id: "{{stale_valuation_id}}",
      amount_minor: "300000",
      expected_balance_minor: "0",
      version: 1,
    },
  ],
];
async function folder(name, description) {
  const path = root + "/" + name;
  await mkdir(path + "/.resources", { recursive: true });
  await writeFile(
    path + "/.resources/definition.yaml",
    JSON.stringify({ $kind: "collection", name, description }, null, 2) + "\n",
  );
  return path;
}
const smoke = await folder(
  "Capital smoke",
  "Financial lifecycle against a dedicated test database only; creates one profile and financial records. Contract: api/openapi.json.",
);
for (const [
  index,
  [name, method, route, status, body, assertion = ""],
] of cases.entries()) {
  if (!spec.paths[route]?.[method.toLowerCase()])
    throw Error("Missing API contract " + route);
  let url =
    "{{baseUrl}}" +
    route
      .replace("{p}", "{{profile_id}}")
      .replace(
        "{id}",
        route.includes("/transfers/") ? "{{transfer_id}}" : "{{investment_id}}",
      );
  if (method === "DELETE") url += "?version=1";
  if (route.endsWith("/summary")) url += "?month={{month}}";
  const scripts = [
    {
      type: "afterResponse",
      language: "text/javascript",
      code: `pm.test('HTTP ${status}',()=>pm.response.to.have.status(${status}));\n${status >= 400 ? "pm.test('Structured error',()=>pm.expect(pm.response.json().error.code).to.be.a('string'));" : ""}\n${assertion}`,
    },
  ];
  if (index === 0)
    scripts.unshift({
      type: "beforeRequest",
      language: "text/javascript",
      code: "['profile_id','savings_id','investment_id','transfer_id','valuation_id','stale_valuation_id'].forEach(k=>pm.collectionVariables.set(k,pm.variables.replaceIn('{{$guid}}')));const today=new Date(Date.now()+3*60*60*1000).toISOString().slice(0,10);pm.collectionVariables.set('today',today);pm.collectionVariables.set('month',today.slice(0,7));",
    });
  await writeFile(
    smoke + "/" + name + ".request.yaml",
    JSON.stringify(
      {
        $kind: "http-request",
        name,
        order: (index + 1) * 1000,
        method,
        url,
        scripts,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: { type: "json", content: JSON.stringify(body, null, 2) },
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
}
const manual = await folder(
  "Capital",
  "Eight capital/account/transfer methods from the authoritative OpenAPI. Set profile_id/account_id/transfer_id and current versions before executing writes.",
);
let index = 0;
for (const [route, path] of Object.entries(spec.paths))
  for (const [method, operation] of Object.entries(path)) {
    if (!operation.tags?.includes("Capital")) continue;
    const properties =
      operation.requestBody?.content?.["application/json"]?.schema;
    const schema = properties?.$ref
      ? spec.components.schemas[properties.$ref.split("/").at(-1)]
      : null;
    const body = schema
      ? Object.fromEntries(
          Object.entries(schema.properties).map(([k, v]) => [
            k,
            k === "id"
              ? "{{$guid}}"
              : k === "version"
                ? 1
                : k === "is_archived"
                  ? false
                  : k === "kind"
                    ? "cash"
                    : k === "occurred_on" || k === "tracking_start_date"
                      ? "{{today}}"
                      : k.includes("minor")
                        ? "0"
                        : k.endsWith("_id")
                          ? "{{" + k + "}}"
                          : "Название",
          ]),
        )
      : null;
    const url =
      "{{baseUrl}}" +
      route
        .replace("{p}", "{{profile_id}}")
        .replace(
          "{id}",
          route.includes("/transfers/") ? "{{transfer_id}}" : "{{account_id}}",
        ) +
      (method === "delete" ? "?version={{version}}" : "");
    await writeFile(
      manual + "/" + operation.operationId + ".request.yaml",
      JSON.stringify(
        {
          $kind: "http-request",
          name: operation.summary,
          description: operation.summary,
          order: ++index * 1000,
          method: method.toUpperCase(),
          url,
          ...(body
            ? {
                headers: { "Content-Type": "application/json" },
                body: { type: "json", content: JSON.stringify(body, null, 2) },
              }
            : {}),
        },
        null,
        2,
      ) + "\n",
    );
  }
console.log(
  `Generated ${cases.length} capital smoke checks and ${index} API requests.`,
);
