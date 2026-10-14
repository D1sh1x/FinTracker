import { useState } from "react";
import type { FormEvent } from "react";
import { Archive, Check, LoaderCircle, Trash2 } from "lucide-react";
import {
  request,
  send,
  type Category,
  type Profile,
  type Transaction,
  type Wallet,
  type Budget,
} from "./api";
import { CategoryIcon, FormError, iconNames, Modal } from "./components";
import { formatMoney, moneyInput, parseMoney, todayIn } from "./money";
import { newId } from "./id";

type Complete = () => Promise<void>;

export function ProfileEditor({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (profile: Profile) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [id] = useState(newId);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const profile = await send<Profile>("/profiles", "POST", {
        id,
        name: name.trim(),
      });
      await onCreated(profile);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Новый профиль"
      description="Только имя. У каждого профиля — свои операции и бюджет."
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={!!name}
    >
      <form onSubmit={submit}>
        <label>
          Как вас зовут?
          <input
            autoFocus
            required
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Алексей"
          />
        </label>
        <FormError error={error} />
        <button className="button primary full" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Check size={18} />
          )}
          Создать профиль
        </button>
      </form>
    </Modal>
  );
}

export function TransactionEditor({
  person,
  wallet,
  categories,
  existing,
  onClose,
  onComplete,
  onReload,
}: {
  person: Profile;
  wallet: Wallet;
  categories: Category[];
  existing: Transaction | null;
  onClose: () => void;
  onComplete: Complete;
  onReload: (row: Transaction) => void;
}) {
  const defaultCategory = (kind: "income" | "expense") => {
    const preferred = kind === "income" ? "Зарплата" : "Продукты";
    return (
      categories.find(
        (c) => c.type === kind && c.name === preferred && !c.is_archived,
      )?.id ??
      categories.find((c) => c.type === kind && !c.is_archived)?.id ??
      ""
    );
  };
  const [id] = useState(() => existing?.id ?? newId());
  const [type, setType] = useState<"income" | "expense">(
    existing?.type ?? "expense",
  );
  const [amount, setAmount] = useState(
    existing ? moneyInput(existing.amount_minor) : "",
  );
  const [category, setCategory] = useState(
    existing?.category_id ?? defaultCategory("expense"),
  );
  const [date, setDate] = useState(
    existing?.occurred_on ?? todayIn(person.timezone),
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [error, setError] = useState<Error | null>(null);
  const [amountError, setAmountError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const path = `/profiles/${person.id}/transactions`;
  const available = categories.filter(
    (c) =>
      c.type === type && (!c.is_archived || c.id === existing?.category_id),
  );
  const dirty = existing
    ? amount !== moneyInput(existing.amount_minor) ||
      type !== existing.type ||
      category !== existing.category_id ||
      date !== existing.occurred_on ||
      note !== existing.note
    : !!amount || !!note;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setAmountError("");
    let amount_minor: string;
    try {
      amount_minor = parseMoney(amount);
    } catch (e) {
      setAmountError((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const body = {
        type,
        amount_minor,
        category_id: category,
        occurred_on: date,
        note,
      };
      await send(
        existing ? `${path}/${id}` : path,
        existing ? "PATCH" : "POST",
        existing ? { ...body, version: existing.version } : { ...body, id },
      );
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await send(`${path}/${id}?version=${existing.version}`, "DELETE");
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? "Редактировать операцию" : "Новая операция"}
      description="Каждая запись делает картину ваших финансов яснее."
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={dirty && !busy}
    >
      <form onSubmit={submit}>
        <div className="segmented">
          <button
            type="button"
            className={type === "expense" ? "active" : ""}
            onClick={() => {
              if (type === "expense") return;
              setType("expense");
              setCategory(defaultCategory("expense"));
            }}
          >
            Расход
          </button>
          <button
            type="button"
            className={type === "income" ? "active" : ""}
            onClick={() => {
              if (type === "income") return;
              setType("income");
              setCategory(defaultCategory("income"));
            }}
          >
            Доход
          </button>
        </div>
        <label>
          Сумма, ₽
          <input
            className="amount-input"
            autoFocus
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountError("");
            }}
            placeholder="0,00"
            aria-invalid={!!amountError}
            aria-describedby={amountError ? "amount-error" : undefined}
          />
          {amountError && (
            <span id="amount-error" className="field-error">
              {amountError}
            </span>
          )}
        </label>
        <label>
          Категория
          <select
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="" disabled>
              Выберите категорию
            </option>
            {available.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
                {c.is_archived ? " (в архиве)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Дата
          <input
            type="date"
            required
            min={wallet.tracking_start_date}
            max={
              date === existing?.occurred_on && date > todayIn(person.timezone)
                ? undefined
                : todayIn(person.timezone)
            }
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          Комментарий <span className="optional">необязательно</span>
          <textarea
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="На что потратили или откуда получили?"
            rows={2}
          />
        </label>
        {type === "income" && (
          <p className="field-hint">
            Возврат как доход увеличит баланс, но не уменьшит расходы месячного
            бюджета.
          </p>
        )}
        <FormError
          error={error}
          onRefresh={async () => {
            try {
              onReload(await request<Transaction>(`${path}/${id}`));
            } catch (e) {
              setError(e as Error);
            }
          }}
        />
        {deleting ? (
          <div className="delete-confirm">
            <p>
              Удалить {formatMoney(existing!.amount_minor)} за{" "}
              {existing!.occurred_on}? Показатели будут пересчитаны.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={remove}
              >
                Да, удалить
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeleting(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            {existing && (
              <button
                type="button"
                className="icon-button danger-text"
                aria-label="Удалить операцию"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={20} />
              </button>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Check size={18} />
              )}
              {existing ? "Сохранить изменения" : "Добавить операцию"}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

export function CategoryEditor({
  person,
  existing,
  onClose,
  onComplete,
}: {
  person: Profile;
  existing: Category | null;
  onClose: () => void;
  onComplete: Complete;
}) {
  const [id] = useState(() => existing?.id ?? newId());
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<"income" | "expense">(
    existing?.type ?? "expense",
  );
  const [icon, setIcon] = useState(existing?.icon ?? "circle");
  const [color, setColor] = useState(existing?.color ?? "#69805D");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await send(
        `/profiles/${person.id}/categories${existing ? "/" + id : ""}`,
        existing ? "PATCH" : "POST",
        existing ? { name, icon, color } : { id, name, type, icon, color },
      );
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await send(`/profiles/${person.id}/categories/${id}`, "PATCH", {
        is_archived: !existing!.is_archived,
      });
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? "Редактировать категорию" : "Новая категория"}
      description="Создайте категории под свой образ жизни."
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={
        name !== (existing?.name ?? "") ||
        icon !== (existing?.icon ?? "circle") ||
        color !== (existing?.color ?? "#69805D")
      }
    >
      <form onSubmit={submit}>
        <label>
          Название
          <input
            autoFocus
            required
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Книги"
          />
        </label>
        {!existing && (
          <label>
            Тип
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "income" | "expense")}
            >
              <option value="expense">Расход</option>
              <option value="income">Доход</option>
            </select>
          </label>
        )}
        <fieldset>
          <legend>Значок</legend>
          <div className="icon-picker">
            {iconNames.map((value) => (
              <button
                type="button"
                aria-label={`Значок ${value}`}
                aria-pressed={icon === value}
                className={icon === value ? "selected" : ""}
                onClick={() => setIcon(value)}
                key={value}
              >
                <CategoryIcon icon={value} color={color} />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Цвет</legend>
          <div className="color-picker">
            {[
              "#69805D",
              "#BC8761",
              "#7398AE",
              "#9690AF",
              "#BD7D83",
              "#BEA067",
              "#8D9C79",
              "#91948E",
            ].map((value) => (
              <button
                type="button"
                style={{ background: value }}
                aria-label={`Цвет ${value}`}
                aria-pressed={color === value}
                className={color === value ? "selected" : ""}
                onClick={() => setColor(value)}
                key={value}
              />
            ))}
          </div>
        </fieldset>
        <FormError error={error} />
        <div className="form-actions">
          {existing && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={archive}
            >
              <Archive size={16} />
              {existing.is_archived ? "Восстановить" : "В архив"}
            </button>
          )}
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BudgetEditor({
  person,
  month,
  existing,
  onClose,
  onComplete,
  onRefresh,
  category,
}: {
  person: Profile;
  month: string;
  existing: Pick<Budget, "limit_minor" | "version"> | null;
  category?: { id: string; name: string };
  onClose: () => void;
  onComplete: Complete;
  onRefresh: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(
    existing ? moneyInput(existing.limit_minor) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const path = `/profiles/${person.id}/${category ? `category-budgets/${month}/${category.id}` : `budgets/${month}`}`;
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let limit_minor: string;
    try {
      limit_minor = parseMoney(amount);
    } catch (e) {
      setError(e as Error);
      return;
    }
    setBusy(true);
    try {
      await send(path, "PUT", {
        limit_minor,
        ...(existing ? { version: existing.version } : {}),
      });
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !existing ||
      !window.confirm(
        category
          ? `Убрать лимит категории «${category.name}»? Операции останутся.`
          : "Убрать лимит месяца? Операции останутся.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await send(`${path}?version=${existing.version}`, "DELETE");
      await onComplete();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        category
          ? `Бюджет: ${category.name}`
          : existing
            ? "Изменить бюджет"
            : "Бюджет на месяц"
      }
      description={
        category
          ? "Лимит этой категории на выбранный месяц. Общий бюджет задаётся отдельно."
          : "Лимит помогает планировать расходы. Его всегда можно изменить."
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={amount !== (existing ? moneyInput(existing.limit_minor) : "")}
    >
      <form onSubmit={save}>
        <label>
          Лимит расходов, ₽
          <input
            className="amount-input"
            autoFocus
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Например, 50000"
          />
        </label>
        <FormError
          error={error}
          onRefresh={async () => {
            try {
              await onRefresh();
              setError(null);
            } catch (error) {
              setError(error as Error);
            }
          }}
        />
        <div className="form-actions">
          {existing && (
            <button
              type="button"
              className="text-button danger-text"
              disabled={busy}
              onClick={remove}
            >
              Убрать лимит
            </button>
          )}
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}Сохранить
            бюджет
          </button>
        </div>
      </form>
    </Modal>
  );
}
