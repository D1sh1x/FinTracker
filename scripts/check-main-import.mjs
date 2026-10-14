import {
  chromium,
  expect,
} from "../frontend/node_modules/@playwright/test/index.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// This runner creates financial records. Use only the dedicated test stack.
const address = "http://127.0.0.1:5175";
if (process.env.FINTRACK_IMPORT_TEST_ALLOWED !== "1")
  throw Error(
    "Set FINTRACK_IMPORT_TEST_ALLOWED=1 after checking that port 5175 uses fintrack_e2e_test.",
  );
const imagePath = process.argv[2];
if (!imagePath)
  throw Error(
    "Pass the WB screenshot path; the private fixture is not stored in Git.",
  );
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const call = async (route, method = "GET", body) => {
    const response = await page.request.fetch(address + "/api/v1" + route, {
      method,
      ...(body ? { data: body } : {}),
    });
    if (!response.ok())
      throw Error(
        `${method} ${route}: ${response.status()} ${await response.text()}`,
      );
    return response.json();
  };
  const p = randomUUID();
  await call("/profiles", "POST", {
    id: p,
    name: "Проверка импорта " + p.slice(0, 8),
  });
  const prefix = "/profiles/" + p;
  const cats = (await call(prefix + "/categories")).items;
  const products = cats.find((c) => c.name === "Продукты");
  expect(cats).toHaveLength(13);
  const capture = "2026-10-14"; // Explicit test assumption, not the original capture date.
  const wallet = await call(prefix + "/wallet");
  await call(prefix + "/wallet", "PATCH", {
    tracking_start_date: "2026-10-01",
    version: wallet.version,
  });
  await call(prefix + "/category-budgets/2026-10/" + products.id, "PUT", {
    limit_minor: "20000",
  });
  await page.addInitScript((id) => {
    localStorage.setItem("fintrack-profile", id);
    localStorage.setItem("fintrack-theme", "light");
  }, p);
  await page.goto(address + "/#imports");
  await expect(
    page.getByRole("heading", { name: "Перенесём операции из банка" }),
  ).toBeVisible();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: address,
    });
  const bytes = await readFile(imagePath);
  await page.evaluate(async (data) => {
    const blob = await (await fetch("data:image/png;base64," + data)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, bytes.toString("base64"));
  await page.keyboard.press("Control+V");
  await expect(page.locator(".import-preview")).toBeVisible();
  await page.getByLabel("Дата съёмки скриншота").fill(capture);
  await page
    .getByRole("button", { name: "Распознать скриншот", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Готов к проверке", exact: true }),
  ).toBeVisible({ timeout: 300000 });
  let job = (await call(prefix + "/imports")).items[0];
  expect(job.result.rows).toHaveLength(8);
  expect(job.result.rows.map((row) => row.amount_minor)).toEqual([
    "18758",
    "50000",
    "2999",
    "10000",
    "51000",
    "500",
    "179900",
    "10000",
  ]);
  expect(job.result.rows.map((row) => row.description)).toEqual([
    "Красное&Белое",
    "Андрей Иядович А.",
    "Магнит",
    "Андрей Иядович А.",
    "Tori ramen",
    "KHUD TOVARY",
    "Digital Goods",
    "Континент",
  ]);
  expect(
    job.result.rows.every((row) =>
      cats.some((cat) => cat.id === row.category_id && cat.type === row.type),
    ),
  ).toBe(true);
  expect(
    job.result.rows.filter((row) => row.category_name === "Не определено"),
  ).toHaveLength(3);
  expect((await call(prefix + "/transactions")).items).toHaveLength(0);
  const row = page.locator(".import-row").first();
  await row.getByLabel("Название операции").fill("Продукты — проверено");
  // Native text paste must not be swallowed by the image handler.
  await page.evaluate(() =>
    navigator.clipboard.writeText("Продукты — проверено"),
  );
  await row.getByLabel("Название операции").fill("");
  await row.getByLabel("Название операции").focus();
  await page.keyboard.press("Control+V");
  await expect(row.getByLabel("Название операции")).toHaveValue(
    "Продукты — проверено",
  );
  await page
    .getByRole("button", { name: "Сохранить правки", exact: true })
    .click();
  await page.reload();
  await page.locator(".import-history button").first().click();
  await expect(
    page.locator(".import-row").first().getByLabel("Название операции"),
  ).toHaveValue("Продукты — проверено");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await mkdir(".local/main-import-check", { recursive: true });
  await page.screenshot({
    path: ".local/main-import-check/review.png",
    fullPage: true,
  });
  await page
    .getByLabel("Я сверил выбранные суммы, даты, направления и категории")
    .check();
  // Commit succeeds but the first response is lost: UI must resend the same body.
  let dropped = false;
  await page.route("**/imports/*/confirm", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Повторить подтверждение", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Повторить подтверждение", exact: true })
    .click();
  await expect(
    page.getByText("Сохранено операций: 8.", { exact: false }),
  ).toBeVisible();
  const summary = await call(prefix + "/summary?month=2026-10");
  expect(summary.expense_minor).toBe("263157");
  expect(summary.income_minor).toBe("60000");
  expect(summary.balance_minor).toBe("-203157");
  const budget = (await call(prefix + "/category-budgets/2026-10")).items.find(
    (c) => c.category_id === products.id,
  );
  expect(budget.spent_minor).toBe("21757");
  expect(budget.remaining_minor).toBe("-1757");
  expect(budget.overspent_minor).toBe("1757");
  expect(
    (await call(prefix + "/transactions")).items.every(
      (op) => op.source === "screenshot",
    ),
  ).toBe(true);
  await page.locator("input[type=file]").setInputFiles(imagePath);
  await page.getByLabel("Дата съёмки скриншота").fill(capture);
  await page
    .getByRole("button", { name: "Распознать скриншот", exact: true })
    .click();
  await expect(
    page.getByText("Сохранено операций: 8.", { exact: false }),
  ).toBeVisible();
  expect((await call(prefix + "/transactions")).items).toHaveLength(8);
  expect((await call(prefix + "/imports")).items).toHaveLength(1);
  expect(errors).toEqual([]);
  job = (await call(prefix + "/imports")).items[0];
  await writeFile(
    ".local/main-import-check/result.json",
    JSON.stringify(
      {
        profile_id: p,
        import_id: job.id,
        trusted_clipboard: true,
        text_paste: true,
        exact_amounts: true,
        readable_names: true,
        profile_categories: true,
        draft_persistence: true,
        lost_confirmation_replay: true,
        same_file_dedup: true,
        financial_totals: true,
        category_overspending: true,
        mobile: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Main import verified with real OCR/Qwen, Ctrl+V, saved edits, lost-response retry, deduplication and exact budget totals in the dedicated test database.",
  );
} finally {
  await browser.close();
}
