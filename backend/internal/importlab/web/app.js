const $ = (id) => document.getElementById(id);
const state = {
  rows: [],
  result: null,
  controller: null,
  imageURL: null,
  imageFile: null,
  categories: [],
};
const dateParts = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(new Date());
$("captured").value = ["year", "month", "day"]
  .map((key) => dateParts.find((p) => p.type === key).value)
  .join("-");

function money(value) {
  if (value === null) return "";
  try {
    const amount = BigInt(value);
    return `${amount / 100n},${String(amount % 100n).padStart(2, "0")}`;
  } catch {
    return "";
  }
}
function minor(value) {
  if (!/^\d+([,.]\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(/[,.]/);
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return result > 0n && result <= 99999999999n ? String(result) : null;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function busy(value) {
  for (const id of [
    "analyze",
    "text-test",
    "sample",
    "reclassify",
    "add-row",
    "image",
    "text",
    "captured",
  ])
    $(id).disabled = value;
  for (const el of $("rows").querySelectorAll("input,select"))
    el.disabled = value;
  $("download").disabled = value || !state.result;
  $("cancel").hidden = !value;
}
function showError(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}

async function status() {
  try {
    const response = await fetch("/api/lab/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error();
    const data = await response.json();
    state.categories = data.categories;
    $("status").textContent = data.message;
    $("mode").textContent = data.mode === "gpu" ? "NVIDIA GPU" : "CPU";
    $("ready-dot").classList.toggle("ready", data.ready);
  } catch {
    $("status").textContent = "Нет связи со стендом";
    $("ready-dot").classList.remove("ready");
  }
}
status();
setInterval(status, 15000);

function renderRows() {
  $("rows").replaceChildren();
  $("empty").hidden = state.rows.length > 0;
  $("download").disabled = !state.result;
  const unknown = state.rows.filter(
    (row) => row.category_id === "unknown",
  ).length;
  $("count").textContent =
    `Строк: ${state.rows.length} · Не определено: ${unknown}`;
  state.rows.forEach((row, index) => {
    const article = element("article", "row");
    article.dataset.rowId = row.id;
    const top = element("div", "row-top");
    top.append(
      element("span", "row-index", `#${index + 1}`),
      element(
        "span",
        `category${row.category_id === "unknown" ? " unknown" : ""}`,
        row.category_name,
      ),
    );
    article.append(top);
    const description = element("label", "description", "Описание операции");
    const input = element("input");
    input.value = row.description;
    input.maxLength = 500;
    input.addEventListener("input", () => (row.description = input.value));
    description.append(input);
    article.append(description);
    if (row.bank_category)
      article.append(element("p", "reason", `Категория банка: ${row.bank_category}`));
    const grid = element("div", "row-grid");
    const typeLabel = element("label", "", "Направление");
    const select = element("select");
    for (const [value, label] of [
      ["expense", "Расход"],
      ["income", "Доход"],
      ["unknown", "Не распознано"],
    ]) {
      const option = element("option", "", label);
      option.value = value;
      select.append(option);
    }
    select.value = row.type;
    select.addEventListener("change", () => {
      row.type = select.value;
    });
    typeLabel.append(select);
    const amountLabel = element("label", "", "Сумма, ₽");
    const amount = element("input");
    amount.inputMode = "decimal";
    amount.value = money(row.amount_minor);
    amount.placeholder = "Не распознано";
    amount.addEventListener(
      "input",
      () => (row.amount_minor = minor(amount.value)),
    );
    amountLabel.append(amount);
    const dateLabel = element("label", "", "Дата операции");
    const date = element("input");
    date.type = "date";
    date.value = row.date ?? "";
    date.addEventListener("input", () => (row.date = date.value || null));
    dateLabel.append(date);
    grid.append(typeLabel, amountLabel, dateLabel);
    article.append(grid);
    article.append(element("p", "reason", row.reason));
    if (row.issues?.length) {
      const list = element("ul", "issues");
      for (const issue of row.issues) list.append(element("li", "", issue));
      article.append(list);
    }
    if (row.source) {
      const original = element("details", "source");
      original.append(element("summary", "", "Исходная строка"));
      original.append(element("div", "", row.source));
      article.append(original);
    }
    $("rows").append(article);
  });
}

async function test(path, options) {
  if (state.controller) return;
  showError("");
  state.controller = new AbortController();
  busy(true);
  try {
    const response = await fetch(path, {
      ...options,
      signal: AbortSignal.any([
        state.controller.signal,
        AbortSignal.timeout(305000),
      ]),
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(data.error?.message || "Не удалось выполнить тест");
    state.result = data;
    state.rows = data.rows;
    if (data.text) $("text").value = data.text;
    const sec = (ms) =>
      `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с`;
    $("total-time").textContent = sec(data.metrics.total_ms);
    $("ocr-time").textContent = data.ocr ? sec(data.metrics.ocr_ms) : "—";
    $("model-time").textContent = sec(data.metrics.model_ms);
    $("speed").textContent =
      data.metrics.tokens_per_second > 0
        ? `${data.metrics.tokens_per_second.toFixed(1)} ток/с`
        : "—";
    $("warnings").replaceChildren();
    for (const text of data.warnings)
      $("warnings").append(element("p", "warning", text));
    renderRows();
  } catch (error) {
    showError(
      error.name === "AbortError"
        ? "Тест отменён"
        : error.name === "TimeoutError"
          ? "Время теста истекло"
          : error.message || "Нет связи со стендом",
    );
  } finally {
    state.controller = null;
    busy(false);
  }
}

function selectImage(file, pasted = false) {
  if (state.controller) {
    showError("Скриншот не заменён: текущий тест ещё выполняется.");
    return;
  }
  if (file && !["image/png", "image/jpeg"].includes(file.type)) {
    showError("Выбери или вставь изображение PNG/JPEG.");
    $("image").value = "";
    return;
  }
  if (file && file.size > 10 * 1024 * 1024) {
    showError("Файл больше 10 МБ");
    $("image").value = "";
    return;
  }
  showError("");
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  state.imageFile = file ?? null;
  state.imageURL = file ? URL.createObjectURL(file) : null;
  $("file-name").textContent = file
    ? pasted ? "Скриншот вставлен из буфера обмена" : file.name
    : "";
  $("preview").hidden = !file;
  if (file) $("preview").src = state.imageURL;
  else $("preview").removeAttribute("src");
  if (pasted) $("image").value = "";
}

$("image").addEventListener("change", () => selectImage($("image").files[0]));
document.addEventListener("paste", (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const item = Array.from(clipboard.items).find(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  const file = item?.getAsFile() ?? Array.from(clipboard.files).find(
    (file) => file.type.startsWith("image/"),
  );
  if (!file) return;
  event.preventDefault();
  selectImage(file, true);
});

$("analyze").addEventListener("click", () => {
  const file = state.imageFile;
  if (!file) {
    showError("Сначала выбери скриншот или вставь его через Ctrl+V");
    return;
  }
  const body = new FormData();
  body.append("image", file);
  body.append("capture_date", $("captured").value);
  test("/api/lab/analyze", { method: "POST", body });
});
$("text-test").addEventListener("click", () =>
  test("/api/lab/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: $("text").value,
      capture_date: $("captured").value,
    }),
  }),
);
$("sample").addEventListener("click", () => {
  $("text").value =
    `${$("captured").value}\nПятёрочка продукты −1 250,50 ₽\nКофе и завтрак в кафе −650 ₽\nАренда квартиры −40 000 ₽\nWildberries −2 400 ₽\nПеревод СБП Ивану −5 000 ₽\nЗарплата ООО Пример +45 000 ₽`;
  $("text-details").open = true;
});
$("reclassify").addEventListener("click", () =>
  test("/api/lab/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: state.rows }),
  }),
);
$("add-row").addEventListener("click", () => {
  if (state.rows.length >= 30) {
    showError("Максимум 30 строк");
    return;
  }
  state.rows.push({
    id: crypto.randomUUID(),
    description: "",
    type: "expense",
    amount_minor: null,
    date: $("captured").value || null,
    source: "",
    category_id: "unknown",
    category_name: "Не определено",
    reason: "Добавленная вручную строка",
    issues: [],
  });
  renderRows();
});
$("cancel").addEventListener("click", () => state.controller?.abort());
$("download").addEventListener("click", () => {
  if (!state.result) return;
  const payload = { ...state.result, rows: state.rows };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
  );
  const link = element("a");
  link.href = url;
  link.download = "fintrack-qwen-test.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme").setAttribute("aria-pressed", String(dark));
  $("theme").textContent = dark ? "Светлая тема" : "Тёмная тема";
});
