import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { todayIn } from "../src/money";

test("capital accounts, transfers, valuation and selected operation account", async ({
  page,
  request,
}) => {
  const id = randomUUID(),
    prefix = `/api/v1/profiles/${id}`,
    today = todayIn("Europe/Moscow");
  expect(
    (
      await request.post("/api/v1/profiles", {
        data: { id, name: "Капитал тест" },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.patch(prefix + "/wallet", {
        data: { version: 1, opening_balance_minor: "1000000" },
      })
    ).status(),
  ).toBe(200);
  await page.addInitScript((value) => {
    localStorage.setItem("fintrack-profile", value);
    localStorage.setItem("fintrack-theme", "light");
  }, id);
  await page.goto("/#capital");
  await expect(page.getByTestId("capital-total")).toHaveText("10 000,00 ₽");
  await page
    .getByRole("button", { name: "Добавить счёт", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название счёта").fill("Подушка");
  await dialog.getByLabel("Тип счёта").selectOption("savings");
  await dialog
    .getByRole("button", { name: "Создать счёт", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Добавить счёт", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название счёта").fill("Портфель");
  await dialog.getByLabel("Тип счёта").selectOption("investment");
  await dialog
    .getByRole("button", { name: "Создать счёт", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const accounts = (await (await request.get(prefix + "/accounts")).json())
    .items;
  const primary = accounts.find((a: { is_primary: boolean }) => a.is_primary),
    savings = accounts.find((a: { name: string }) => a.name === "Подушка"),
    portfolio = accounts.find((a: { name: string }) => a.name === "Портфель");
  await page.getByRole("button", { name: "Перевести между счетами" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Со счёта").selectOption(primary.id);
  await dialog.getByLabel("На счёт").selectOption(portfolio.id);
  await dialog.getByLabel("Сумма перевода, ₽").fill("2000");
  let lost = false;
  await page.route("**/transfers", async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Сохранить перевод", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Нет связи");
  await dialog
    .getByRole("button", { name: "Сохранить перевод", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("capital-total")).toHaveText("10 000,00 ₽");
  await expect(page.getByTestId("capital-cash")).toHaveText("8 000,00 ₽");
  await expect(page.getByTestId("capital-investments")).toHaveText(
    "2 000,00 ₽",
  );
  expect(
    (await (await request.get(prefix + "/transfers")).json()).items,
  ).toHaveLength(1);
  await page
    .locator(`[data-account-id="${portfolio.id}"]`)
    .getByRole("button", { name: "Обновить стоимость" })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Текущая стоимость, ₽").fill("2500");
  await dialog
    .getByRole("button", { name: "Сохранить стоимость", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("capital-total")).toHaveText("10 500,00 ₽");
  let summary = await (
    await request.get(prefix + `/summary?month=${today.slice(0, 7)}`)
  ).json();
  expect(summary.income_minor).toBe("0");
  expect(summary.expense_minor).toBe("0");
  await page.locator(".add-operation").click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Доход", exact: true }).click();
  await dialog.getByLabel("Счёт", { exact: true }).selectOption(savings.id);
  await dialog.getByLabel("Сумма, ₽", { exact: true }).fill("100");
  await dialog
    .getByRole("button", { name: "Добавить операцию", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("capital-total")).toHaveText("10 600,00 ₽");
  await expect(
    page.locator(`[data-account-id="${savings.id}"] .capital-account-balance`),
  ).toHaveText("100,00 ₽");
  await page.reload();
  await expect(page.getByTestId("capital-total")).toHaveText("10 600,00 ₽");
  await page
    .getByRole("button", { name: "Архивировать Подушка", exact: true })
    .click();
  await expect(page.locator(`[data-account-id="${savings.id}"]`)).toContainText(
    "архив",
  );
  await expect(page.getByTestId("capital-total")).toHaveText("10 600,00 ₽");
  await page
    .getByRole("button", { name: "Восстановить Подушка", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Архивировать Подушка", exact: true }),
  ).toBeVisible();
  mkdirSync("../.local/capital", { recursive: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../.local/capital/capital-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Переключить тему" }).click();
  await page.screenshot({
    path: "../.local/capital/capital-dark.png",
    fullPage: true,
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Отменить перевод", exact: true })
    .click();
  await expect(page.getByTestId("capital-total")).toHaveText("10 600,00 ₽");
  await expect(page.getByTestId("capital-cash")).toHaveText("10 100,00 ₽");
  await expect(page.getByTestId("capital-investments")).toHaveText("500,00 ₽");
  summary = await (
    await request.get(prefix + `/summary?month=${today.slice(0, 7)}`)
  ).json();
  expect(summary.income_minor).toBe("10000");
  expect(summary.expense_minor).toBe("0");
});
