import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Plus,
  Landmark,
  TrendingUp,
  Archive,
  Check,
  LoaderCircle,
} from "lucide-react";
import {
  request,
  send,
  type Account,
  type Capital,
  type Profile,
  type Transfer,
} from "./api";
import { FormError, LoadError, Loading, Modal } from "./components";
import { formatMoney, moneyInput, parseMoney, todayIn } from "./money";
import { newId } from "./id";
import "./capital.css";

const kindNames: Record<Account["kind"], string> = {
  cash: "Счёт / наличные",
  savings: "Накопительный счёт",
  deposit: "Вклад",
  investment: "Инвестиции",
};
type Editor =
  | { kind: "account"; account?: Account }
  | { kind: "transfer" }
  | { kind: "valuation"; account: Account };

export function CapitalPage({
  person,
  onComplete,
}: {
  person: Profile;
  onComplete: () => Promise<void>;
}) {
  const prefix = `/profiles/${person.id}`;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const capital = useQuery({
    queryKey: ["profile", person.id, "capital"],
    queryFn: ({ signal }) => request<Capital>(prefix + "/capital", { signal }),
  });
  const transfers = useQuery({
    queryKey: ["profile", person.id, "transfers"],
    queryFn: ({ signal }) =>
      request<{ items: Transfer[] }>(prefix + "/transfers", { signal }),
  });
  if (capital.isPending) return <Loading />;
  if (capital.isError)
    return (
      <LoadError error={capital.error} onRetry={() => capital.refetch()} />
    );
  const data = capital.data;
  const active = data.accounts.filter((account) => !account.is_archived);
  const accountName = (id: string) =>
    data.accounts.find((account) => account.id === id)?.name ?? "Счёт";
  async function archive(account: Account) {
    setBusy(true);
    setError(null);
    try {
      await send(prefix + "/accounts/" + account.id, "PATCH", {
        version: account.version,
        is_archived: !account.is_archived,
      });
      await onComplete();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove(transfer: Transfer) {
    if (
      !window.confirm(
        "Отменить перевод? Остатки обоих счетов будут пересчитаны.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await send(
        prefix + `/transfers/${transfer.id}?version=${transfer.version}`,
        "DELETE",
      );
      await onComplete();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="capital-page">
      <div className="capital-toolbar">
        <p>Счета, накопления и стоимость портфеля — в рублях.</p>
        <div className="button-row">
          <button
            className="button secondary"
            disabled={active.length < 2}
            onClick={() => setEditor({ kind: "transfer" })}
          >
            <ArrowLeftRight size={17} />
            Перевести между счетами
          </button>
          <button
            className="button primary"
            onClick={() => setEditor({ kind: "account" })}
          >
            <Plus size={17} />
            Добавить счёт
          </button>
        </div>
      </div>
      <FormError
        error={error}
        onRefresh={() => {
          capital.refetch();
          transfers.refetch();
        }}
      />
      <div className="stats-grid capital-stats">
        <div className="stat-card balance">
          <span className="stat-label">
            Общий капитал
            <Landmark size={19} />
          </span>
          <strong className="stat-value" data-testid="capital-total">
            {formatMoney(data.total_minor)}
          </strong>
          <span className="stat-footnote">Все счета, включая инвестиции</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Деньги на счетах</span>
          <strong className="stat-value" data-testid="capital-cash">
            {formatMoney(data.cash_minor)}
          </strong>
          <span className="stat-footnote">
            Карты, наличные, накопления и вклады
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">
            Инвестиции
            <TrendingUp size={19} />
          </span>
          <strong className="stat-value" data-testid="capital-investments">
            {formatMoney(data.investment_minor)}
          </strong>
          <span className="stat-footnote">Стоимость обновляется вручную</span>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Мои счета</h2>
            <p>Переводы между ними сохраняют общий капитал.</p>
          </div>
        </div>
        <div className="capital-accounts">
          {data.accounts.map((account) => (
            <article
              key={account.id}
              className={
                "capital-account" +
                (account.is_archived ? " capital-archived" : "")
              }
              data-account-id={account.id}
            >
              <div className="capital-account-heading">
                <span className="capital-account-icon">
                  {account.kind === "investment" ? (
                    <TrendingUp size={21} />
                  ) : (
                    <Landmark size={21} />
                  )}
                </span>
                <div>
                  <h3>{account.name}</h3>
                  <p>
                    {kindNames[account.kind]}
                    {account.is_primary ? " · основной" : ""}
                    {account.is_archived ? " · архив" : ""}
                  </p>
                </div>
              </div>
              <strong className="capital-account-balance">
                {formatMoney(account.balance_minor)}
              </strong>
              <div className="capital-account-actions">
                <button
                  className="text-button"
                  onClick={() => setEditor({ kind: "account", account })}
                >
                  Переименовать
                </button>
                {account.kind === "investment" && !account.is_archived && (
                  <button
                    className="button secondary"
                    onClick={() => setEditor({ kind: "valuation", account })}
                  >
                    Обновить стоимость
                  </button>
                )}
                {!account.is_primary && (
                  <button
                    className="icon-button"
                    aria-label={
                      (account.is_archived
                        ? "Восстановить "
                        : "Архивировать ") + account.name
                    }
                    disabled={busy}
                    onClick={() => archive(account)}
                  >
                    <Archive size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <p className="info-note">
          Начальный остаток основного счёта задаётся в настройках. Архивные
          счета остаются в капитале и истории. Покупку активов отражайте
          переводом на инвестиционный счёт.
        </p>
      </section>
      <CapitalHistory points={data.history} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Переводы между счетами</h2>
            <p>
              Не влияют на доходы, расходы и бюджеты. Последние 100 переводов.
            </p>
          </div>
        </div>
        {transfers.isPending ? (
          <Loading />
        ) : transfers.isError ? (
          <LoadError
            error={transfers.error}
            onRetry={() => transfers.refetch()}
          />
        ) : !transfers.data.items.length ? (
          <p className="capital-muted">
            Пока нет переводов. Добавьте второй счёт, чтобы перемещать деньги
            между счетами.
          </p>
        ) : (
          <div className="capital-ledger">
            {transfers.data.items.map((transfer) => (
              <div className="capital-ledger-row" key={transfer.id}>
                <div>
                  <strong>
                    {accountName(transfer.from_account_id)} →{" "}
                    {accountName(transfer.to_account_id)}
                  </strong>
                  <p>
                    {transfer.occurred_on}
                    {transfer.note ? " · " + transfer.note : ""}
                  </p>
                </div>
                <strong>{formatMoney(transfer.amount_minor)}</strong>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => remove(transfer)}
                >
                  Отменить перевод
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {!!data.valuations.length && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Обновления стоимости</h2>
              <p>
                Последние 50 переоценок. Они не являются доходами или расходами.
              </p>
            </div>
          </div>
          <div className="capital-ledger">
            {data.valuations.map((item) => (
              <div className="capital-ledger-row" key={item.id}>
                <div>
                  <strong>{accountName(item.account_id)}</strong>
                  <p>
                    {item.occurred_on} · изменение{" "}
                    {formatMoney(item.delta_minor)}
                  </p>
                </div>
                <strong>{formatMoney(item.amount_minor)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {editor && (
        <CapitalEditor
          key={
            editor.kind +
            ("account" in editor ? (editor.account?.id ?? "") : "")
          }
          editor={editor}
          person={person}
          accounts={data.accounts}
          onClose={() => setEditor(null)}
          onComplete={onComplete}
        />
      )}
    </div>
  );
}

function CapitalHistory({ points }: { points: Capital["history"] }) {
  const recent = points.slice(-90);
  const values = recent.map((point) => BigInt(point.balance_minor));
  let low = values[0] ?? 0n,
    high = low;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high - low;
  const dates = recent.map((point) => Date.parse(point.date + "T00:00:00Z"));
  const duration = dates.length > 1 ? dates.at(-1)! - dates[0] : 0;
  const line = values
    .map(
      (value, index) =>
        `${20 + (duration ? ((dates[index] - dates[0]) * 760) / duration : 0)},${span ? 200 - Number(((value - low) * 180n) / span) : 110}`,
    )
    .join(" ");
  return (
    <section className="panel capital-history">
      <div className="panel-heading">
        <div>
          <h2>Как менялся капитал</h2>
          <p>По текущей истории операций. Последние 90 дат с записями.</p>
        </div>
      </div>
      {recent.length > 1 ? (
        <svg
          viewBox="0 0 800 225"
          role="img"
          aria-label="История общей суммы капитала"
        >
          <line x1="20" y1="210" x2="780" y2="210" className="capital-axis" />
          <polyline points={line} className="capital-line" />
        </svg>
      ) : (
        <p className="capital-muted">
          История начнёт расти вместе с вашими операциями.
        </p>
      )}
      {!!recent.length && (
        <div className="capital-history-range">
          <span>
            {recent[0].date}
            <strong>{formatMoney(recent[0].balance_minor)}</strong>
          </span>
          <span>
            {recent.at(-1)!.date}
            <strong>{formatMoney(recent.at(-1)!.balance_minor)}</strong>
          </span>
        </div>
      )}
      <details>
        <summary>Посмотреть суммы по датам</summary>
        <div className="capital-ledger">
          {[...recent].reverse().map((point) => (
            <div className="capital-ledger-row" key={point.date}>
              <span>{point.date}</span>
              <strong>{formatMoney(point.balance_minor)}</strong>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function CapitalEditor({
  editor,
  person,
  accounts,
  onClose,
  onComplete,
}: {
  editor: Editor;
  person: Profile;
  accounts: Account[];
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const account = "account" in editor ? editor.account : undefined;
  const active = accounts.filter((item) => !item.is_archived);
  const [id] = useState(newId);
  const [name, setName] = useState(account?.name ?? "");
  const [kind, setKind] = useState<Account["kind"]>("cash");
  const [amount, setAmount] = useState(
    editor.kind === "valuation"
      ? moneyInput(account!.balance_minor)
      : editor.kind === "account"
        ? "0"
        : "",
  );
  const [date, setDate] = useState(
    editor.kind === "account"
      ? todayIn(person.timezone).slice(0, 7) + "-01"
      : todayIn(person.timezone),
  );
  const [from, setFrom] = useState(active[0]?.id ?? "");
  const [to, setTo] = useState(active[1]?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const prefix = `/profiles/${person.id}`;
  const title =
    editor.kind === "transfer"
      ? "Перевод между счетами"
      : editor.kind === "valuation"
        ? "Стоимость портфеля"
        : account
          ? "Название счёта"
          : "Новый счёт";
  const initialDate =
    editor.kind === "account"
      ? todayIn(person.timezone).slice(0, 7) + "-01"
      : todayIn(person.timezone);
  const dirty =
    editor.kind === "account"
      ? account
        ? name !== account.name
        : !!name || kind !== "cash" || amount !== "0" || date !== initialDate
      : editor.kind === "valuation"
        ? amount !== moneyInput(account!.balance_minor)
        : !!amount ||
          !!note ||
          from !== (active[0]?.id ?? "") ||
          to !== (active[1]?.id ?? "") ||
          date !== initialDate;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editor.kind === "account") {
        if (account)
          await send(prefix + "/accounts/" + account.id, "PATCH", {
            name: name.trim(),
            version: account.version,
          });
        else
          await send(prefix + "/accounts", "POST", {
            id,
            name: name.trim(),
            kind,
            opening_balance_minor: parseMoney(amount, true),
            tracking_start_date: date,
          });
      } else if (editor.kind === "transfer")
        await send(prefix + "/transfers", "POST", {
          id,
          from_account_id: from,
          to_account_id: to,
          amount_minor: parseMoney(amount),
          occurred_on: date,
          note,
        });
      else
        await send(prefix + `/accounts/${account!.id}/valuations`, "POST", {
          id,
          amount_minor: parseMoney(amount, true),
          expected_balance_minor: account!.balance_minor,
          version: account!.version,
        });
      await onComplete();
      onClose();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  const fromAccount = accounts.find((item) => item.id === from),
    toAccount = accounts.find((item) => item.id === to);
  return (
    <Modal
      title={title}
      description={
        editor.kind === "transfer"
          ? "Одна сумма уйдёт с одного счёта и поступит на другой."
          : editor.kind === "valuation"
            ? "Введите текущую общую стоимость портфеля. Сумма не попадёт в доходы и расходы."
            : "Счёт принадлежит выбранному профилю. Валюта — рубли."
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={!busy && dirty}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="capital-fieldset">
          {editor.kind === "account" && (
            <>
              <label>
                Название счёта
                <input
                  required
                  maxLength={50}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Например, подушка или брокерский счёт"
                  autoFocus
                />
              </label>
              {!account && (
                <>
                  <label>
                    Тип счёта
                    <select
                      value={kind}
                      onChange={(event) =>
                        setKind(event.target.value as Account["kind"])
                      }
                    >
                      {Object.entries(kindNames).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="info-note">
                    Если деньги уже учтены на другом счёте, оставьте здесь 0 ₽ и
                    оформите перевод. Так капитал не увеличится дважды.
                  </p>
                </>
              )}
            </>
          )}
          {editor.kind === "transfer" && (
            <>
              <label>
                Со счёта
                <select
                  required
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                >
                  {active.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                На счёт
                <select
                  required
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                >
                  {active.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={item.id === from}
                    >
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {!(editor.kind === "account" && account) && (
            <label>
              {editor.kind === "account"
                ? "Начальный остаток, ₽"
                : editor.kind === "valuation"
                  ? "Текущая стоимость, ₽"
                  : "Сумма перевода, ₽"}
              <input
                inputMode="decimal"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          )}
          {editor.kind === "account" && !account && (
            <label>
              Начало учёта
              <input
                type="date"
                required
                max={todayIn(person.timezone)}
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          )}
          {editor.kind === "transfer" && (
            <>
              <label>
                Дата перевода
                <input
                  type="date"
                  required
                  min={[
                    fromAccount?.tracking_start_date ?? "",
                    toAccount?.tracking_start_date ?? "",
                  ]
                    .sort()
                    .at(-1)}
                  max={todayIn(person.timezone)}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              <label>
                Комментарий
                <textarea
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                />
              </label>
            </>
          )}
          {editor.kind === "valuation" && (
            <p className="info-note">
              {account!.name}: сейчас учтено{" "}
              {formatMoney(account!.balance_minor)}. Новая стоимость будет
              зафиксирована за {todayIn(person.timezone)}. Будущие переводы и
              операции изменят остаток отдельно.
            </p>
          )}
          <FormError
            error={error}
            onRefresh={async () => {
              await onComplete();
              onClose();
            }}
          />
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Check size={17} />
            )}{" "}
            {editor.kind === "transfer"
              ? "Сохранить перевод"
              : editor.kind === "valuation"
                ? "Сохранить стоимость"
                : account
                  ? "Сохранить название"
                  : "Создать счёт"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
