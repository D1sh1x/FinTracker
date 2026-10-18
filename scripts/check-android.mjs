import { _android } from "../frontend/node_modules/playwright/index.mjs";
import { expect } from "../frontend/node_modules/@playwright/test/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const serial = process.env.ANDROID_TEST_SERIAL ?? "emulator-5556";
const api = "http://127.0.0.1:18091";
const devices = await _android.devices();
const android = devices.find((device) => device.serial() === serial);
if (!android || !serial.startsWith("emulator-"))
  throw new Error(
    "This test only targets an explicitly selected emulator and the isolated API on 18091.",
  );
let page = await (
  await android.webView({ pkg: "app.fintrack.personal" })
).page();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(".local/android/screenshots", { recursive: true });
try {
  await page.reload();
  await page
    .locator(".connection-card, .welcome-content, .stat-value")
    .first()
    .waitFor();
  if (
    !(await page
      .getByRole("heading", { name: "Подключим ваш сервер" })
      .isVisible())
  ) {
    if (await page.locator(".mobile-nav").isVisible())
      await page
        .locator(".mobile-nav")
        .getByRole("link", { name: "Настройки", exact: true })
        .click();
    await page.getByRole("button", { name: "Подключение к серверу" }).click();
  }
  await page
    .getByLabel("Адрес сервера", { exact: true })
    .fill("http://127.0.0.1:4900");
  await page.getByLabel("Логин общего входа").fill("owner");
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Проверьте логин");
  await page.getByLabel("Пароль", { exact: true }).fill("mobile-test");
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Создать профиль", exact: true }),
  ).toBeVisible();
  console.log(
    "PASS: native HTTP + simulation: 401, corrected login, profiles contract",
  );
  const encrypted = (
    await android.shell(
      "run-as app.fintrack.personal cat shared_prefs/fintrack_connection.xml",
    )
  ).toString();
  if (encrypted.includes("mobile-test") || encrypted.includes("127.0.0.1"))
    throw new Error("Connection stored in plaintext");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Создать профиль", exact: true }),
  ).toBeVisible();
  console.log("PASS: encrypted connection restored after WebView reload");

  const profileId = randomUUID();
  const seeded = await fetch(api + "/api/v1/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: profileId, name: "Android проверка" }),
  });
  if (seeded.status !== 201)
    throw new Error("Isolated API profile setup failed");
  await page.getByRole("button", { name: "Подключение к серверу" }).click();
  await page.getByLabel("Адрес сервера", { exact: true }).fill(api);
  await page.getByLabel("Логин общего входа").fill("");
  await page.getByLabel("Пароль", { exact: true }).fill("");
  await page.getByRole("button", { name: "Подключиться", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши финансы." }),
  ).toBeVisible();
  await page.evaluate(
    (id) => localStorage.setItem("fintrack-profile", id),
    profileId,
  );
  await page.reload();
  await expect(page.locator(".add-operation")).toBeEnabled();
  for (const [type, amount, note] of [
    ["Доход", "50000", "Доход Android"],
    ["Расход", "1250,50", "Расход Android"],
  ]) {
    await page.locator(".add-operation").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: type, exact: true }).click();
    await dialog.getByLabel("Сумма, ₽", { exact: true }).fill(amount);
    await dialog.getByLabel(/Комментарий/).fill(note);
    await dialog
      .getByRole("button", { name: "Добавить операцию", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(page.locator(".balance .stat-value")).toContainText("48 749,50");
  await page
    .getByRole("button", { name: "Задать бюджет", exact: true })
    .click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("20000");
  await page
    .getByRole("button", { name: "Сохранить бюджет", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const records = await (
    await fetch(api + `/api/v1/profiles/${profileId}/transactions`)
  ).json();
  const expense = records.items.find((item) => item.type === "expense");
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "Бюджет", exact: true })
    .click();
  const row = page.locator(
    `.category-budget-row[data-category-id="${expense.category_id}"]`,
  );
  await row.getByRole("button").click();
  await page.getByRole("dialog").getByLabel("Лимит расходов, ₽").fill("1000");
  await page
    .getByRole("button", { name: "Сохранить бюджет", exact: true })
    .click();
  await expect(row).toContainText("Перерасход 250,50");
  console.log(
    "PASS: native income/expense exact amounts and category overspending",
  );
  await page.screenshot({ path: ".local/android/screenshots/budget.png" });

  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "Капитал", exact: true })
    .click();
  await expect(page.getByTestId("capital-total")).toHaveText("48 749,50 ₽");
  await page
    .getByRole("button", { name: "Добавить счёт", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название счёта").fill("Подушка Android");
  await dialog.getByLabel("Тип счёта").selectOption("savings");
  await dialog
    .getByRole("button", { name: "Создать счёт", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const accounts = (
    await (await fetch(api + `/api/v1/profiles/${profileId}/accounts`)).json()
  ).items;
  await page
    .getByRole("button", { name: "Перевести между счетами", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Со счёта")
    .selectOption(accounts.find((account) => account.is_primary).id);
  await dialog
    .getByLabel("На счёт")
    .selectOption(
      accounts.find((account) => account.name === "Подушка Android").id,
    );
  await dialog.getByLabel("Сумма перевода, ₽").fill("2000");
  await dialog
    .getByRole("button", { name: "Сохранить перевод", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("capital-total")).toHaveText("48 749,50 ₽");
  console.log(
    "PASS: native capital account + transfer excluded from income/expense",
  );
  await page.screenshot({ path: ".local/android/screenshots/capital.png" });
  await android.shell("input keyevent KEYCODE_BACK");
  await expect(
    page.getByRole("heading", { name: "Ваши финансы." }),
  ).toBeVisible();
  await page.locator(".add-operation").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await android.shell("input keyevent KEYCODE_BACK");
  if (await page.getByRole("dialog").isVisible())
    await android.shell("input keyevent KEYCODE_BACK");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  console.log(
    "PASS: Android Back navigates to overview and closes an empty editor",
  );
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "Настройки", exact: true })
    .click();
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (
    !(await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ))
  )
    throw new Error("Android horizontal overflow");
  await page.screenshot({
    path: ".local/android/screenshots/settings-dark.png",
  });
  console.log("PASS: native dark theme, settings and mobile width");
  await writeFile(
    ".local/android/test-profile.json",
    JSON.stringify({ profileId }),
  );
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log("Android WebView checks passed without JavaScript errors");
} finally {
  await android.close();
}
