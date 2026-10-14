import { ArrowRight, Pencil, Plus } from "lucide-react";
import type { CategoryBudgets, CategoryBudgetItem } from "./api";
import { CategoryIcon } from "./components";
import { formatMoney } from "./money";

export function CategoryBudgetsPanel({
  data,
  onEdit,
  compact = false,
}: {
  data: CategoryBudgets;
  onEdit: (id: string) => void;
  compact?: boolean;
}) {
  const limited = data.items.filter((item) => item.limit_minor !== null);
  const items = compact ? limited.slice(0, 3) : data.items;
  return (
    <section className="panel category-budgets-panel">
      <div className="panel-heading">
        <div>
          <h2>Бюджеты категорий</h2>
          <p>Лимиты на то, что важно вам</p>
        </div>
        {compact && (
          <a className="text-button" href="#budget">
            Все лимиты
            <ArrowRight size={16} />
          </a>
        )}
      </div>
      {!compact && (
        <p className="category-allocation">
          Задано по категориям:{" "}
          <strong>{formatMoney(data.allocated_minor)}</strong>
          {data.overall_limit_minor !== null && (
            <> · Общий лимит: {formatMoney(data.overall_limit_minor)}</>
          )}
        </p>
      )}
      {data.exceeds_overall && (
        <p className="budget-warning" role="status">
          Сумма лимитов категорий превышает общий бюджет. Общий лимит не
          изменён.
        </p>
      )}
      {items.length ? (
        <div className="category-budget-list">
          {items.map((item) => (
            <CategoryBudgetRow
              key={item.category_id}
              item={item}
              onEdit={onEdit}
            />
          ))}
        </div>
      ) : (
        <p className="info-note">
          {compact
            ? "Задайте отдельные лимиты, например на рестораны и квартиру."
            : "Создайте категорию расходов, чтобы задать её бюджет."}
        </p>
      )}
      {compact && limited.length > items.length && (
        <p className="info-note">
          Ещё {limited.length - items.length} лимитов на странице бюджета.
        </p>
      )}
      {!compact && (
        <p className="info-note">
          Категория без лимита не ограничивает расходы. Все операции входят в
          общий бюджет один раз. Доходы не увеличивают лимиты; следующий месяц
          начинается без них.
        </p>
      )}
    </section>
  );
}

function CategoryBudgetRow({
  item,
  onEdit,
}: {
  item: CategoryBudgetItem;
  onEdit: (id: string) => void;
}) {
  const over = BigInt(item.overspent_minor) > 0n;
  const used = Number(item.used_percent ?? "0");
  return (
    <article
      className="category-budget-row"
      aria-label={item.name}
      data-category-id={item.category_id}
    >
      <div className="category-budget-heading">
        <CategoryIcon icon={item.icon} color={item.color} />
        <div className="category-budget-name">
          <h3>{item.name}</h3>
          {item.is_archived && <span className="tag">В архиве</span>}
        </div>
        <button
          type="button"
          className="text-button"
          disabled={item.is_archived && item.limit_minor === null}
          aria-label={`${item.limit_minor === null ? "Задать" : "Изменить"} лимит: ${item.name}`}
          onClick={() => onEdit(item.category_id)}
        >
          {item.limit_minor === null ? (
            <Plus size={16} />
          ) : (
            <Pencil size={15} />
          )}
          <span>{item.limit_minor === null ? "Задать лимит" : "Изменить"}</span>
        </button>
      </div>
      <div className="category-budget-values">
        <div>
          <span>Потрачено</span>
          <strong>{formatMoney(item.spent_minor)}</strong>
        </div>
        <div>
          <span>Лимит</span>
          <strong>
            {item.limit_minor === null
              ? "Не задан"
              : formatMoney(item.limit_minor)}
          </strong>
        </div>
        <div>
          <span>Остаток</span>
          <strong className={over ? "danger-text" : ""}>
            {item.remaining_minor === null
              ? "—"
              : formatMoney(item.remaining_minor)}
          </strong>
        </div>
      </div>
      {item.limit_minor !== null && (
        <>
          <div
            className="budget-track"
            role="progressbar"
            aria-label={`Использовано бюджета: ${item.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(used, 100)}
            aria-valuetext={`${used.toLocaleString("ru-RU")}%`}
          >
            <span
              className={over ? "over" : ""}
              style={{ width: `${Math.min(used, 100)}%` }}
            />
          </div>
          <p
            className={
              over
                ? "category-budget-status danger-text"
                : "category-budget-status"
            }
          >
            {over
              ? `Перерасход ${formatMoney(item.overspent_minor)}`
              : `${used.toLocaleString("ru-RU")}% бюджета использовано`}
          </p>
        </>
      )}
    </article>
  );
}
