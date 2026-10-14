import { mkdir, readFile, writeFile } from "node:fs/promises";
const spec = JSON.parse(await readFile("api/openapi.json", "utf8"));
const root = "postman/collections/FinTrack API";
const prefix = "/api/v1/profiles/{p}/imports";
const variables = (route) =>
  "{{baseUrl}}" +
  route.replace("{p}", "{{profile_id}}").replace("{id}", "{{import_id}}");
async function folder(name, description) {
  const path = root + "/" + name;
  await mkdir(path + "/.resources", { recursive: true });
  await writeFile(
    path + "/.resources/definition.yaml",
    JSON.stringify({ $kind: "collection", name, description }, null, 2) + "\n",
  );
  return path;
}
async function save(
  path,
  index,
  name,
  method,
  route,
  body,
  status,
  assertion = "",
) {
  const operation = spec.paths[route]?.[method.toLowerCase()];
  if (!operation) throw Error("Missing authoritative API operation: " + route);
  const request = {
    $kind: "http-request",
    name,
    description: operation.description ?? operation.summary,
    order: (index + 1) * 1000,
    method,
    url: variables(route),
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: {
            type: "json",
            content:
              typeof body === "string" ? body : JSON.stringify(body, null, 2),
          },
        }
      : {}),
    ...(status
      ? {
          scripts: [
            {
              type: "afterResponse",
              language: "text/javascript",
              code: `pm.test('HTTP ${status}',()=>pm.response.to.have.status(${status}));\n${status >= 400 ? "pm.test('Structured error',()=>pm.expect(pm.response.json().error.code).to.be.a('string'));" : ""}\n${assertion}`,
            },
          ],
        }
      : {}),
  };
  await writeFile(
    path + "/" + name + ".request.yaml",
    JSON.stringify(request, null, 2) + "\n",
  );
}
const manual = await folder(
  "Screenshot imports",
  "Six operations from api/openapi.json. Set profile_id/import_id/current version. Upload and confirmation create drafts/financial records; use a dedicated test database for experiments.",
);
await save(manual, 0, "List imports", "GET", prefix);
await save(manual, 1, "Read import", "GET", prefix + "/{id}");
await save(
  manual,
  2,
  "Edit rows",
  "PATCH",
  prefix + "/{id}/rows",
  '{"version":{{import_version}},"rows":{{edited_rows}}}',
);
await save(
  manual,
  3,
  "Confirm selected rows",
  "POST",
  prefix + "/{id}/confirm",
  '{"version":{{import_version}},"rows":{{confirm_rows}}}',
);
await save(
  manual,
  4,
  "Cancel import",
  "POST",
  prefix + "/{id}/cancel",
  '{"version":{{import_version}}}',
);
const upload = {
  $kind: "http-request",
  name: "Upload screenshot",
  description: spec.paths[prefix].post.description,
  order: 6000,
  method: "POST",
  url: variables(prefix),
  headers: { Accept: "application/json" },
  body: {
    type: "formdata",
    content: [
      {
        type: "file",
        key: "image",
        src: "",
        description: "Choose a local PNG/JPEG, up to 10 MiB and 20 MP",
      },
      {
        type: "text",
        key: "capture_date",
        value: "{{capture_date}}",
        description: "Required YYYY-MM-DD: actual screenshot capture day",
      },
    ],
  },
};
await writeFile(
  manual + "/Upload screenshot.request.yaml",
  JSON.stringify(upload, null, 2) + "\n",
);
const smoke = await folder(
  "Import smoke",
  "Run against the confirmed eight-row WB sample in the dedicated test database after check-main-import.mjs. Values come from its ignored local report. Does not create another set of operations.",
);
const body = '{"version":{{import_version}},"rows":{{confirm_rows}}}';
await save(
  smoke,
  0,
  "List history",
  "GET",
  prefix,
  null,
  200,
  "pm.test('Batch in history',()=>pm.expect(pm.response.json().items.some(x=>x.id===pm.variables.get('import_id'))).to.be.true);",
);
await save(
  smoke,
  1,
  "Confirmed receipt",
  "GET",
  prefix + "/{id}",
  null,
  200,
  "const x=pm.response.json(); pm.test('Confirmed with eight rows',()=>{pm.expect(x.status).to.equal('confirmed');pm.expect(x.receipt.items).to.have.length(8);pm.expect(x.result.rows).to.have.length(8);});",
);
await save(
  smoke,
  2,
  "Confirmation replay",
  "POST",
  prefix + "/{id}/confirm",
  body,
  200,
  "const x=pm.response.json().items; pm.test('Original receipt and exact kopecks',()=>{pm.expect(x).to.have.length(8);pm.expect(x.every(t=>t.source==='screenshot')).to.be.true;pm.expect(x.filter(t=>t.type==='expense').reduce((n,t)=>n+BigInt(t.amount_minor),0n).toString()).to.equal('263157');pm.expect(x.filter(t=>t.type==='income').reduce((n,t)=>n+BigInt(t.amount_minor),0n).toString()).to.equal('60000');});",
);
await save(
  smoke,
  3,
  "Confirmed edit rejected",
  "PATCH",
  prefix + "/{id}/rows",
  '{"version":{{final_version}},"rows":[]}',
  409,
);
await save(
  smoke,
  4,
  "Confirmed cancel rejected",
  "POST",
  prefix + "/{id}/cancel",
  '{"version":{{final_version}}}',
  409,
);
await save(
  smoke,
  5,
  "Changed replay rejected",
  "POST",
  prefix + "/{id}/confirm",
  '{"version":{{final_version}},"rows":{{confirm_rows}}}',
  409,
);
await save(smoke, 6, "Missing multipart rejected", "POST", prefix, {}, 422);
console.log(
  "Generated six import requests and seven contract-based smoke checks.",
);
