import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { todayIn } from "../src/money";

async function seed(request: APIRequestContext, name = "Мой профиль") {
  const id = randomUUID();
  const response = await request.post("/api/v1/profiles", {
    data: { id, name },
  });
  expect(response.status()).toBe(201);
  const categories = (
    await (await request.get(`/api/v1/profiles/${id}/categories`)).json()
  ).items;
  return { id, categories };
}

async function choose(page: Page, id: string) {
  await page.addInitScript((value) => {
    localStorage.setItem("fintrack-profile", value);
    localStorage.setItem("fintrack-theme", "light");
  }, id);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваши финансы." }),
  ).toBeVisible();
  await expect(page.locator(".add-operation")).toBeEnabled();
}

test("full financial lifecycle in the interface", async ({ page, request }) => {
  const { id } = await seed(request, "Проверка сценария");
  await choose(page, id);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Настройки", exact: true })
    .click();
  await page.getByLabel("Начальный остаток, ₽").fill("10000");
  await page.getByRole("button", { name: "Сохранить остаток" }).click();
  await expect(page.getByRole("status")).toContainText("Готово");
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Обзор", exact: true })
    .click();
  await page.locator(".add-operation").click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Доход", exact: true }).click();
  await dialog.getByLabel("Сумма, ₽").fill("30000");
  await dialog
    .getByRole("button", { name: "Добавить операцию", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".add-operation").click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Сумма, ₽").fill("1250,50");
  await dialog.getByLabel(/Комментарий/).fill("Продукты на неделю");
  await dialog
    .getByRole("button", { name: "Добавить операцию", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".balance .stat-value")).toContainText("38");
  await expect(page.locator(".balance .stat-value")).toContainText("749,50");
  await page.getByRole("button", { name: "Задать бюджет" }).click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("20000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.locator(".budget-remaining")).toContainText("749,50");
  await page
    .locator(".transaction-row")
    .filter({ hasText: "Продукты на неделю" })
    .click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("1000");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.locator(".balance .stat-value")).toContainText("39");
  await page
    .locator(".transaction-row")
    .filter({ hasText: "Продукты на неделю" })
    .click();
  await page.getByRole("button", { name: "Удалить операцию" }).click();
  await page.getByRole("button", { name: "Да, удалить" }).click();
  await expect(page.locator(".balance .stat-value")).toContainText("40");
  await expect(page.locator(".transaction-row")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".balance .stat-value")).toContainText("40");
});

test("create profile and category, archive and restore", async ({
  page,
  request,
}) => {
  const { id } = await seed(request);
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await choose(page, id);
  await page.getByLabel("Выбрать профиль").selectOption("__new");
  const name = "Новый профиль " + randomUUID().slice(0, 8);
  await page.getByRole("dialog").getByLabel("Как вас зовут?").fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать профиль" })
    .click();
  await expect(page.getByLabel("Выбрать профиль")).not.toHaveValue(id);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Категории", exact: true })
    .click();
  await page.getByRole("button", { name: "Новая категория" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Название")
    .fill("Книги и обучение");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await page.getByRole("button", { name: "Книги и обучение" }).click();
  await page.getByRole("button", { name: "В архив" }).click();
  await expect(
    page.getByRole("button", { name: "Книги и обучение" }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await page.getByRole("button", { name: "Книги и обучение" }).click();
  await page.getByRole("button", { name: "Восстановить" }).click();
  await page.getByRole("button", { name: "Активные", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Книги и обучение" }),
  ).toBeVisible();
});

test("network failure preserves form and retries without duplication", async ({
  page,
  request,
}) => {
  const { id } = await seed(request);
  await choose(page, id);
  await page.locator(".add-operation").click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("321,09");
  await page.route("**/api/v1/profiles/*/transactions", (route) =>
    route.abort(),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Добавить операцию", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Нет связи");
  await expect(page.getByRole("dialog").getByLabel("Сумма, ₽")).toHaveValue(
    "321,09",
  );
  await page.unroute("**/api/v1/profiles/*/transactions");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Добавить операцию", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const rows = (
    await (await request.get(`/api/v1/profiles/${id}/transactions`)).json()
  ).items;
  expect(rows).toHaveLength(1);
  expect(rows[0].amount_minor).toBe("32109");
});

test("late response from previous profile does not mix finances", async ({
  page,
  request,
}) => {
  const first = await seed(request, "Первый");
  const second = await seed(request, "Второй");
  await request.patch(`/api/v1/profiles/${first.id}/wallet`, {
    data: { opening_balance_minor: "11100", version: 1 },
  });
  await request.patch(`/api/v1/profiles/${second.id}/wallet`, {
    data: { opening_balance_minor: "22200", version: 1 },
  });
  await choose(page, first.id);
  let markSeen!: () => void;
  let release!: () => void;
  let markFinished!: () => void;
  const seen = new Promise<void>((resolve) => {
    markSeen = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  await page.route(
    `**/api/v1/profiles/${first.id}/summary**`,
    async (route) => {
      const response = await route.fetch();
      markSeen();
      await held;
      try {
        await route.fulfill({ response });
      } finally {
        markFinished();
      }
    },
  );
  await page.reload();
  await seen;
  await page.getByLabel("Выбрать профиль").selectOption(second.id);
  await expect(page.locator(".balance .stat-value")).toContainText("222");
  release();
  await finished;
  await expect(page.locator(".balance .stat-value")).not.toContainText("111");
});

test("budget conflict reloads actual version and can be recreated", async ({
  page,
  request,
}) => {
  const { id } = await seed(request);
  const month = todayIn("Europe/Moscow").slice(0, 7);
  const path = `/api/v1/profiles/${id}/budgets/${month}`;
  expect(
    (await request.put(path, { data: { limit_minor: "1000000" } })).status(),
  ).toBe(201);
  await choose(page, id);
  await page.getByRole("button", { name: "Изменить бюджет" }).click();
  expect(
    (
      await request.put(path, { data: { limit_minor: "2000000", version: 1 } })
    ).status(),
  ).toBe(200);
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("30000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.getByRole("alert")).toContainText("Запись изменилась");
  await page
    .getByRole("button", { name: "Загрузить актуальные данные" })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Лимит расходов, ₽"),
  ).toHaveValue("20000,00");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Убрать лимит" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Задать бюджет" }).click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("15000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await (await request.get(path)).json()).version).toBe(4);
});

test("category budgets track remaining money and overspending independently", async ({
  page,
  request,
}) => {
  const { id, categories } = await seed(request, "Категорийный бюджет");
  const date = todayIn("Europe/Moscow");
  const month = date.slice(0, 7);
  const cafe = categories.find((c: { name: string }) => c.name === "Кафе");
  const home = categories.find((c: { name: string }) => c.name === "Дом");
  const base = `/api/v1/profiles/${id}`;
  await choose(page, id);
  await page.goto("/#budget");
  const row = page.locator(
    `.category-budget-row[data-category-id="${cafe.id}"]`,
  );
  await expect(row).toContainText("Не задан");
  await row.getByRole("button", { name: "Задать лимит: Кафе" }).click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("5000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row).toContainText("5 000,00");
  const expenseId = randomUUID();
  for (const [operationId, amount, category_id, note] of [
    [randomUUID(), "120000", cafe.id, "Обед"],
    [expenseId, "400000", cafe.id, "Ужин"],
    [randomUUID(), "750000", home.id, "Аренда"],
  ]) {
    expect(
      (
        await request.post(base + "/transactions", {
          data: {
            id: operationId,
            type: "expense",
            amount_minor: amount,
            category_id,
            occurred_on: date,
            note,
          },
        })
      ).status(),
    ).toBe(201);
  }
  await request.put(`${base}/budgets/${month}`, {
    data: { limit_minor: "1000000" },
  });
  await request.put(`${base}/category-budgets/${month}/${home.id}`, {
    data: { limit_minor: "4000000" },
  });
  await page.reload();
  await expect(row).toContainText("Перерасход 200,00");
  await expect(row).toContainText("−200,00");
  await expect(page.locator(".budget-warning")).toContainText(
    "превышает общий бюджет",
  );
  const summary = await (
    await request.get(`${base}/summary?month=${month}`)
  ).json();
  expect(summary.expense_minor).toBe("1270000");
  expect(summary.budget.remaining_minor).toBe("-270000");
  await page.goto("/#overview");
  await page.locator(".transaction-row").filter({ hasText: "Ужин" }).click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("1000");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row).toContainText("2 800,00");
  await expect(row).not.toContainText("Перерасход");
  await page.goto("/#budget");
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    mkdirSync("../.local/screenshots", { recursive: true });
    await page.screenshot({
      path: `../.local/screenshots/category-budgets-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Следующий месяц" }).click();
  await expect(row).toContainText("Не задан");
});

test("category budget conflicts, recreation and archive on mobile", async ({
  page,
  request,
}) => {
  const { id, categories } = await seed(request, "Версии лимитов");
  const date = todayIn("Europe/Moscow"),
    month = date.slice(0, 7);
  const cafe = categories.find((c: { name: string }) => c.name === "Кафе");
  const base = `/api/v1/profiles/${id}`;
  const path = `${base}/category-budgets/${month}/${cafe.id}`;
  await request.put(path, { data: { limit_minor: "1000000" } });
  await request.post(base + "/transactions", {
    data: {
      id: randomUUID(),
      type: "expense",
      amount_minor: "100",
      category_id: cafe.id,
      occurred_on: date,
      note: "Кофе",
    },
  });
  await choose(page, id);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/#budget");
  const row = page.locator(
    `.category-budget-row[data-category-id="${cafe.id}"]`,
  );
  await row.getByRole("button", { name: "Изменить лимит: Кафе" }).click();
  await request.put(path, { data: { limit_minor: "2000000", version: 1 } });
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("15000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.getByRole("alert")).toContainText("Запись изменилась");
  await page
    .getByRole("button", { name: "Загрузить актуальные данные" })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Лимит расходов, ₽"),
  ).toHaveValue("20000,00");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Убрать лимит" }).click();
  await expect(row).toContainText("Не задан");
  await row.getByRole("button", { name: "Задать лимит: Кафе" }).click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("5000");
  await page.getByRole("button", { name: "Сохранить бюджет" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (
      await request.put(path, { data: { limit_minor: "1", version: 1 } })
    ).status(),
  ).toBe(409);
  await request.patch(`${base}/categories/${cafe.id}`, {
    data: { is_archived: true },
  });
  await page.reload();
  await expect(row).toContainText("В архиве");
  await expect(row).toContainText("4 999,00");
  await page.getByRole("button", { name: "Переключить тему" }).click();
  await page.screenshot({
    path: "../.local/screenshots/category-budgets-dark-mobile.png",
    fullPage: true,
  });
  await row.getByRole("button", { name: "Изменить лимит: Кафе" }).click();
  await page.getByRole("button", { name: "Убрать лимит" }).click();
  await expect(
    row.getByRole("button", { name: "Задать лимит: Кафе" }),
  ).toBeDisabled();
  const other = await seed(request, "Другой бюджет");
  await page.reload();
  await page.getByLabel("Выбрать профиль").selectOption(other.id);
  await expect(page.locator(".category-allocation")).toContainText("0,00");
  await expect(
    page.locator(`.category-budget-row[data-category-id="${cafe.id}"]`),
  ).toHaveCount(0);
});

test("responsive layout, dark theme, large sums and CSV download", async ({
  page,
  request,
}) => {
  const { id, categories } = await seed(request, "Алексей");
  const date = todayIn("Europe/Moscow");
  for (const [type, amount, label] of [
    ["income", "9500000", "Зарплата"],
    ["expense", "425050", "Продукты на неделю"],
    ["expense", "189000", "Кафе с друзьями"],
    ["expense", "95000", "Поездки по городу"],
  ] as const) {
    const category = categories.find(
      (c: { name: string; type: string }) =>
        c.name ===
        (label.startsWith("Продукты")
          ? "Продукты"
          : label.startsWith("Кафе")
            ? "Кафе"
            : type === "income"
              ? "Зарплата"
              : "Транспорт"),
    );
    expect(
      (
        await request.post(`/api/v1/profiles/${id}/transactions`, {
          data: {
            id: randomUUID(),
            type,
            amount_minor: amount,
            category_id: category.id,
            occurred_on: date,
            note: label,
          },
        })
      ).status(),
    ).toBe(201);
  }
  await request.put(`/api/v1/profiles/${id}/budgets/${date.slice(0, 7)}`, {
    data: { limit_minor: "5000000" },
  });
  await choose(page, id);
  mkdirSync("../.local/screenshots", { recursive: true });
  for (const width of [360, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(".balance .stat-value")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../.local/screenshots/overview-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("button", { name: "Переключить тему" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "../.local/screenshots/overview-dark.png",
    fullPage: true,
  });
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "Операции", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт CSV" }).click();
  expect((await download).suggestedFilename()).toContain("fintrack");
  await page.locator(".add-operation").click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("999999999,99");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../.local/screenshots/editor-mobile.png",
    fullPage: true,
  });
});
