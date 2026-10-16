import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  ApiError,
  request,
  send,
  type Category,
  type Profile,
  type Wallet,
  type ScreenshotImport,
  type ScreenshotReceipt,
  type Account,
} from "./api";
import { FormError, Loading, LoadError } from "./components";
import { formatMoney, moneyInput, parseMoney, todayIn } from "./money";
import { newId } from "./id";
import "./imports.css";

type ReviewRow = {
  id: string;
  description: string;
  type: "income" | "expense" | "unknown";
  amount: string;
  date: string;
  category_id: string;
  selected: boolean;
  allowDuplicate: boolean;
};
type Confirmation = {
  wallet_id?: string;
  version: number;
  rows: { id: string; allow_duplicate: boolean }[];
};
const labels: Record<ScreenshotImport["status"], string> = {
  queued: "Ожидает распознавания",
  processing: "Распознаём скриншот…",
  ready: "Готов к проверке",
  failed: "Не удалось распознать",
  confirmed: "Сохранён",
  cancelled: "Отменён",
};

export function ImportScreenshots({
  person,
  wallet,
  accounts,
  categories,
  onComplete,
}: {
  person: Profile;
  wallet: Wallet;
  accounts: Account[];
  categories: Category[];
  onComplete: () => Promise<void>;
}) {
  const client = useQueryClient();
  const prefix = `/profiles/${person.id}/imports`;
  const queryKey = ["profile", person.id, "imports"];
  const [id, setId] = useState("");
  const [accountId, setAccountId] = useState(wallet.id);
  const account = accounts.find((item) => item.id === accountId);
  const startDate = account?.tracking_start_date ?? wallet.tracking_start_date;
  const [file, setFile] = useState<File | null>(null);
  const [capture, setCapture] = useState("");
  const [preview, setPreview] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<Confirmation | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadedVersion = useRef("");
  const active = useRef(true);
  const history = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<{ items: ScreenshotImport[] }>(prefix, { signal }),
    refetchInterval: 5000,
  });
  const draft = useQuery({
    queryKey: [...queryKey, id],
    queryFn: ({ signal }) =>
      request<ScreenshotImport>(`${prefix}/${id}`, { signal }),
    enabled: !!id,
    refetchInterval: (query) =>
      ["queued", "processing"].includes(query.state.data?.status ?? "")
        ? 1000
        : false,
  });
  const job = draft.data;
  const processing = job?.status === "queued" || job?.status === "processing";
  const editable = job?.status === "ready";
  const locked = busy || !!pending;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!job || dirty || loadedVersion.current === `${job.id}:${job.version}`)
      return;
    loadedVersion.current = `${job.id}:${job.version}`;
    setAccountId(job.wallet_id);
    setRows(
      job.result.rows.map((row) => ({
        id: row.id,
        description: row.description,
        type: row.type as ReviewRow["type"],
        amount: row.amount_minor ? moneyInput(row.amount_minor) : "",
        date: row.date ?? "",
        category_id: row.category_id,
        selected:
          !!row.amount_minor &&
          !!row.date &&
          row.type !== "unknown" &&
          !job.duplicates[row.id]?.length,
        allowDuplicate: false,
      })),
    );
  }, [job, dirty]);
  const choose = (next: File | null) => {
    if (busy || pending || processing) {
      setError(
        new Error(
          "Дождитесь завершения текущего действия или отмените распознавание.",
        ),
      );
      return;
    }
    if (next && !["image/png", "image/jpeg"].includes(next.type)) {
      setError(new Error("Поддерживаются PNG и JPEG."));
      return;
    }
    if (next && next.size > 10 * 1024 * 1024) {
      setError(new Error("Скриншот не должен превышать 10 МБ."));
      return;
    }
    setFile(next);
    setError(null);
  };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      const image =
        item?.getAsFile() ??
        Array.from(event.clipboardData?.files ?? []).find((file) =>
          file.type.startsWith("image/"),
        );
      if (!image) return;
      event.preventDefault();
      choose(image);
      if (fileInput.current) fileInput.current.value = "";
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [busy, pending, processing]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, pending]);
  const showJob = (next: ScreenshotImport) => {
    client.setQueryData([...queryKey, next.id], next);
    setId(next.id);
    client.invalidateQueries({ queryKey, exact: true });
  };
  const update = (
    index: number,
    changes: Partial<ReviewRow>,
    fieldChange = true,
  ) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...changes } : row)),
    );
    if (fieldChange) {
      setDirty(true);
      setChecked(false);
    }
  };
  async function upload() {
    if (!file) {
      setError(new Error("Выберите скриншот или вставьте его через Ctrl+V."));
      return;
    }
    if (!capture) {
      setError(
        new Error("Укажите дату съёмки: она нужна для «Сегодня» и «Вчера»."),
      );
      return;
    }
    if (
      dirty &&
      !window.confirm("Заменить несохранённые правки другим скриншотом?")
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("capture_date", capture);
      const next = await request<ScreenshotImport>(prefix, {
        method: "POST",
        body,
      });
      if (active.current) {
        setDirty(false);
        setChecked(false);
        setPending(null);
        loadedVersion.current = "";
        showJob(next);
      }
    } catch (error) {
      if (active.current) setError(error as Error);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  function editedRows() {
    return rows.map((row) => ({
      id: row.id,
      description: row.description.trim(),
      type: row.type,
      amount_minor: row.amount.trim() ? parseMoney(row.amount) : null,
      date: row.date || null,
      category_id: row.category_id,
    }));
  }
  async function save() {
    if (!job) throw new Error("Черновик не загружен.");
    const next = await send<ScreenshotImport>(
      `${prefix}/${job.id}/rows`,
      "PATCH",
      { version: job.version, rows: editedRows(), wallet_id: accountId },
    );
    if (active.current) {
      setDirty(false);
      loadedVersion.current = `${next.id}:${next.version}`;
      showJob(next);
    }
    return next;
  }
  async function saveClick() {
    setBusy(true);
    setError(null);
    try {
      await save();
    } catch (error) {
      if (active.current) setError(error as Error);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!job || (!checked && !pending)) return;
    setBusy(true);
    setError(null);
    try {
      let body = pending;
      if (!body) {
        const selection = rows
          .filter((row) => row.selected)
          .map((row) => ({ id: row.id, allow_duplicate: row.allowDuplicate }));
        if (!selection.length)
          throw new Error("Выберите операции для сохранения.");
        const current = dirty ? await save() : job;
        body = {
          version: current.version,
          rows: selection,
          ...(accountId !== wallet.id ? { wallet_id: accountId } : {}),
        };
        setPending(body);
      }
      const receipt = await send<ScreenshotReceipt>(
        `${prefix}/${job.id}/confirm`,
        "POST",
        body,
      );
      await client.invalidateQueries({ queryKey: ["profile", person.id] });
      if (active.current) {
        setPending(null);
        setDirty(false);
        setChecked(false);
        client.setQueryData([...queryKey, job.id], {
          ...job,
          status: "confirmed",
          receipt,
          version: body.version + 1,
        });
        await draft.refetch();
        await onComplete();
        await history.refetch();
      }
    } catch (error) {
      if (active.current) {
        setError(error as Error);
        if (
          error instanceof ApiError &&
          error.status > 0 &&
          error.status < 500
        ) {
          setPending(null);
          if (error instanceof ApiError && error.status === 409)
            await draft.refetch();
        }
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const next = await send<ScreenshotImport>(
        `${prefix}/${job.id}/cancel`,
        "POST",
        { version: job.version },
      );
      if (active.current) {
        setDirty(false);
        setChecked(false);
        showJob(next);
      }
    } catch (error) {
      if (active.current) setError(error as Error);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const selected = rows.filter((row) => row.selected);
  let expenses = 0n,
    incomes = 0n;
  for (const row of selected) {
    try {
      const value = BigInt(parseMoney(row.amount));
      if (row.type === "expense") expenses += value;
      else if (row.type === "income") incomes += value;
    } catch {}
  }
  return (
    <div className="import-page">
      <section className="panel import-upload">
        <div>
          <span className="eyebrow">СКРИНШОТ → ПРОВЕРКА → ОПЕРАЦИИ</span>
          <h2>Перенесём операции из банка</h2>
          <p>
            Загрузите PNG/JPEG или вставьте изображение через Ctrl+V. Все суммы
            — в рублях. Проверьте результат перед сохранением.
          </p>
        </div>
        <label className="import-file">
          <ImagePlus size={25} />
          <span>Выбрать скриншот</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            disabled={locked || processing}
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
          <small>Или Ctrl+V · до 10 МБ / 20 Мп</small>
        </label>
        {preview && (
          <img
            className="import-preview"
            src={preview}
            alt="Скриншот для сверки операций"
          />
        )}
        <label>
          Дата съёмки скриншота
          <input
            type="date"
            value={capture}
            max={todayIn(person.timezone)}
            disabled={locked || processing}
            onChange={(event) => setCapture(event.target.value)}
          />
        </label>
        <p className="info-note">
          Укажите день, когда сделан снимок: дата загрузки не заменяет «Сегодня»
          и «Вчера». Изображение хранится на сервере только до завершения
          распознавания; для сверки после перезагрузки вставьте его снова.
        </p>
        <button
          className="button primary"
          onClick={upload}
          disabled={locked || processing}
        >
          <ImagePlus size={18} />
          Распознать скриншот
        </button>
      </section>
      <div className="import-content">
        <FormError
          error={error}
          onRefresh={() => {
            setDirty(false);
            loadedVersion.current = "";
            draft.refetch();
          }}
        />
        {draft.isError && (
          <LoadError error={draft.error} onRetry={() => draft.refetch()} />
        )}
        {id && draft.isPending && <Loading text="Загружаем черновик…" />}
        {job && (
          <section className="panel import-review">
            <div className="panel-heading">
              <div>
                <h2>{labels[job.status]}</h2>
                <p>
                  Дата съёмки: {job.capture_date} · Профиль: {person.name}
                </p>
              </div>
              {processing ? <LoaderCircle className="spin" /> : <Check />}
            </div>
            {processing && (
              <p role="status">
                Обработка выполняется в фоне. Можно закрыть страницу и вернуться
                к черновику позже. На CPU это может занять несколько минут.
              </p>
            )}
            {job.error && (
              <div className="form-error" role="alert">
                {job.error}
              </div>
            )}
            {job.status === "confirmed" && (
              <div className="import-success" role="status">
                Сохранено операций: {job.receipt?.items.length ?? 0}. Баланс и
                бюджеты обновлены. Повторная загрузка этого файла не создаёт
                новых записей.
              </div>
            )}
            {job.status === "cancelled" && (
              <p>Импорт отменён. Финансовые операции из него не создавались.</p>
            )}
            {job.result.warnings.map((warning, index) => (
              <p key={index} className="info-note">
                {warning}
              </p>
            ))}
            {editable && (
              <>
                <label>
                  Счёт для операций
                  <select
                    aria-label="Счёт для операций"
                    value={accountId}
                    disabled={locked}
                    onChange={(event) => {
                      setAccountId(event.target.value);
                      setChecked(false);
                      setDirty(true);
                    }}
                  >
                    {accounts
                      .filter(
                        (item) => !item.is_archived || item.id === accountId,
                      )
                      .map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={item.is_archived}
                        >
                          {item.name}
                          {item.is_archived ? " (архив)" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="info-note">
                  Исправьте поля и выберите строки. «Не определено» можно
                  сохранить и разобрать позже. Два перевода между собственными
                  счетами не являются доходом и расходом — пропустите такие
                  строки.
                </p>
                {!rows.length && (
                  <p>Операции не выделены. Добавьте строку вручную.</p>
                )}
                <div className="import-rows">
                  {rows.map((row, index) => {
                    const original = job.result.rows.find(
                      (item) => item.id === row.id,
                    );
                    const duplicates = job.duplicates[row.id] ?? [];
                    const invalid =
                      !row.description.trim() ||
                      !row.date ||
                      row.date < startDate ||
                      row.date > todayIn(person.timezone) ||
                      row.type === "unknown";
                    return (
                      <article key={row.id} className="import-row">
                        <div className="import-row-header">
                          <label className="import-check">
                            <input
                              type="checkbox"
                              checked={row.selected}
                              disabled={locked}
                              onChange={(event) =>
                                update(
                                  index,
                                  { selected: event.target.checked },
                                  false,
                                )
                              }
                            />
                            Сохранить строку {index + 1}
                          </label>
                          <button
                            className="icon-button"
                            aria-label={`Убрать строку ${index + 1}`}
                            disabled={locked}
                            onClick={() => {
                              setRows((current) =>
                                current.filter((item) => item.id !== row.id),
                              );
                              setDirty(true);
                              setChecked(false);
                            }}
                          >
                            <X size={17} />
                          </button>
                        </div>
                        <label>
                          Название операции
                          <input
                            value={row.description}
                            maxLength={500}
                            disabled={locked}
                            onChange={(event) =>
                              update(index, { description: event.target.value })
                            }
                          />
                        </label>
                        {original?.bank_category && (
                          <p className="import-bank-label">
                            Категория банка: {original.bank_category}
                          </p>
                        )}
                        <div className="import-row-fields">
                          <label>
                            Направление
                            <select
                              value={row.type}
                              disabled={locked}
                              onChange={(event) =>
                                update(index, {
                                  type: event.target.value as ReviewRow["type"],
                                  category_id: "",
                                })
                              }
                            >
                              <option value="unknown">Не определено</option>
                              <option value="expense">Расход</option>
                              <option value="income">Доход</option>
                            </select>
                          </label>
                          <label>
                            Сумма, ₽
                            <input
                              inputMode="decimal"
                              value={row.amount}
                              disabled={locked}
                              onChange={(event) =>
                                update(index, { amount: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            Дата операции
                            <input
                              type="date"
                              min={startDate}
                              max={todayIn(person.timezone)}
                              value={row.date}
                              disabled={locked}
                              onChange={(event) =>
                                update(index, { date: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            Категория
                            <select
                              value={row.category_id}
                              disabled={locked || row.type === "unknown"}
                              onChange={(event) =>
                                update(index, {
                                  category_id: event.target.value,
                                })
                              }
                            >
                              <option value="">Не определено</option>
                              {categories
                                .filter(
                                  (category) =>
                                    category.type === row.type &&
                                    (!category.is_archived ||
                                      category.id === row.category_id),
                                )
                                .map((category) => (
                                  <option
                                    key={category.id}
                                    value={category.id}
                                    disabled={category.is_archived}
                                  >
                                    {category.name}
                                    {category.is_archived ? " (архив)" : ""}
                                  </option>
                                ))}
                            </select>
                          </label>
                        </div>
                        {original?.reason && (
                          <p className="import-bank-label">{original.reason}</p>
                        )}
                        {!dirty && original && original.issues.length > 0 && (
                          <ul className="import-issues">
                            {original.issues.map((issue, i) => (
                              <li key={i}>{issue}</li>
                            ))}
                          </ul>
                        )}
                        {invalid && (
                          <p className="import-issues">
                            Проверьте название, направление и дату. Начало
                            учёта: {startDate}.
                          </p>
                        )}
                        {!!duplicates.length && (
                          <div className="import-duplicate">
                            <strong>Есть похожие операции</strong>
                            {duplicates.map((op) => (
                              <p key={op.id}>
                                {op.occurred_on} ·{" "}
                                {op.note || "Без комментария"} ·{" "}
                                {formatMoney(op.amount_minor)}
                              </p>
                            ))}
                            <label className="import-check">
                              <input
                                type="checkbox"
                                checked={row.allowDuplicate}
                                disabled={locked}
                                onChange={(event) =>
                                  update(
                                    index,
                                    { allowDuplicate: event.target.checked },
                                    false,
                                  )
                                }
                              />
                              Это отдельная операция, сохранить ещё одну
                            </label>
                          </div>
                        )}
                        {original?.source && (
                          <details className="import-source">
                            <summary>Исходная строка</summary>
                            {original.source}
                          </details>
                        )}
                      </article>
                    );
                  })}
                </div>
                <div className="import-actions">
                  <button
                    className="button secondary"
                    disabled={locked || rows.length >= 30}
                    onClick={() => {
                      setRows((current) => [
                        ...current,
                        {
                          id: newId(),
                          description: "",
                          type: "expense",
                          amount: "",
                          date: job.capture_date,
                          category_id: "",
                          selected: false,
                          allowDuplicate: false,
                        },
                      ]);
                      setDirty(true);
                      setChecked(false);
                    }}
                  >
                    <Plus size={16} />
                    Добавить строку
                  </button>
                  <button
                    className="button secondary"
                    disabled={locked || !dirty}
                    onClick={saveClick}
                  >
                    Сохранить правки
                  </button>
                  <button
                    className="button secondary"
                    disabled={locked}
                    onClick={() => {
                      if (
                        !dirty ||
                        window.confirm("Отменить несохранённые правки?")
                      ) {
                        setDirty(false);
                        loadedVersion.current = "";
                        draft.refetch();
                      }
                    }}
                  >
                    <RefreshCw size={16} />
                    Обновить черновик
                  </button>
                </div>
                <div className="import-confirm">
                  <strong>
                    Выбрано: {pending?.rows.length ?? selected.length}
                  </strong>
                  <p>
                    Расходы: {formatMoney(String(expenses))} · Поступления:{" "}
                    {formatMoney(String(incomes))}
                  </p>
                  <p>
                    После подтверждения выбранные строки попадут в учёт,
                    остальные будут пропущены. Каждый импорт подтверждается один
                    раз.
                  </p>
                  <label className="import-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(event) => setChecked(event.target.checked)}
                    />
                    Я сверил выбранные суммы, даты, направления и категории, а
                    также счёт
                  </label>
                  <button
                    className="button primary"
                    onClick={confirm}
                    disabled={
                      busy || (!pending && (!checked || !selected.length))
                    }
                  >
                    {busy ? (
                      <LoaderCircle size={18} className="spin" />
                    ) : (
                      <Check size={18} />
                    )}{" "}
                    {pending
                      ? "Повторить подтверждение"
                      : "Подтвердить и сохранить"}
                  </button>
                  {pending && (
                    <p>
                      Результат предыдущего запроса неизвестен. Повтор отправит
                      тот же набор строк и не создаст их второй раз.
                    </p>
                  )}
                </div>
              </>
            )}
            {!["confirmed", "cancelled"].includes(job.status) && (
              <button
                className="button secondary"
                disabled={locked}
                onClick={cancel}
              >
                Отменить импорт
              </button>
            )}
          </section>
        )}
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Последние импорты</h2>
              <p>Черновики сохраняются для этого профиля.</p>
            </div>
          </div>
          {history.isError ? (
            <LoadError
              error={history.error}
              onRetry={() => history.refetch()}
            />
          ) : history.isPending ? (
            <Loading />
          ) : !history.data.items.length ? (
            <p>Пока нет загруженных скриншотов.</p>
          ) : (
            <div className="import-history">
              {history.data.items.map((item) => (
                <button
                  className="button secondary"
                  key={item.id}
                  disabled={locked || id === item.id}
                  onClick={() => {
                    if (
                      dirty &&
                      !window.confirm(
                        "Открыть другой черновик и потерять несохранённые правки?",
                      )
                    )
                      return;
                    setDirty(false);
                    setChecked(false);
                    setPending(null);
                    setError(null);
                    setFile(null);
                    loadedVersion.current = "";
                    setId(item.id);
                  }}
                >
                  <span>
                    {item.capture_date} · {labels[item.status]} ·{" "}
                    {item.result.rows.length} строк
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
