import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  Plus,
  ArrowUpRight,
  ArrowDownLeft,
  ShoppingBasket,
  Coffee,
  Car,
  House,
  Heart,
  ShoppingBag,
  Sparkles,
  Circle,
  BriefcaseBusiness,
  Wallet,
  Gift,
  Inbox,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Category, Transaction } from "./api";
import { ApiError } from "./api";
import { formatMoney } from "./money";

const icons = {
  shopping: ShoppingBasket,
  coffee: Coffee,
  car: Car,
  home: House,
  heart: Heart,
  bag: ShoppingBag,
  sparkles: Sparkles,
  circle: Circle,
  briefcase: BriefcaseBusiness,
  wallet: Wallet,
  gift: Gift,
};
export const iconNames = Object.keys(icons);

export function CategoryIcon({
  icon = "circle",
  color = "#69805D",
}: {
  icon?: string;
  color?: string;
}) {
  const Icon = icons[icon as keyof typeof icons] ?? Circle;
  return (
    <span
      className="category-icon"
      style={{ color, backgroundColor: color + "18" }}
    >
      <Icon size={20} strokeWidth={1.8} />
    </span>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  dirty = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  dirty?: boolean;
}) {
  const close = () => {
    if (
      !dirty ||
      window.confirm("Закрыть форму и потерять несохранённые изменения?")
    )
      onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content"
          aria-describedby="modal-description"
        >
          <div className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description id="modal-description">
                {description}
              </Dialog.Description>
            </div>
            <button
              className="icon-button"
              aria-label="Закрыть"
              onClick={close}
            >
              <X size={20} />
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function FormError({
  error,
  onRefresh,
}: {
  error: Error | null;
  onRefresh?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="form-error" role="alert">
      <p>{error.message}</p>
      {error instanceof ApiError && Object.keys(error.fields).length > 0 && (
        <ul>
          {Object.values(error.fields).map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}
      {error instanceof ApiError && error.status === 409 && onRefresh && (
        <button type="button" className="text-button" onClick={onRefresh}>
          Загрузить актуальные данные
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  text,
  action,
  onAction,
  compact = false,
}: {
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={"empty-state" + (compact ? " compact" : "")}>
      <span className="empty-icon">
        <Inbox size={26} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="button secondary" onClick={onAction}>
          <Plus size={17} />
          {action}
        </button>
      )}
    </div>
  );
}

export function Loading({
  text = "Загружаем ваши финансы…",
}: {
  text?: string;
}) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}

export function LoadError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div className="load-error" role="alert">
      <h3>Не удалось загрузить данные</h3>
      <p>{error.message}</p>
      <button className="button secondary" onClick={onRetry}>
        <RefreshCw size={17} />
        Повторить
      </button>
    </div>
  );
}

export function TransactionList({
  rows,
  categories,
  onEdit,
}: {
  rows: Transaction[];
  categories: Category[];
  onEdit: (row: Transaction) => void;
}) {
  const map = new Map(categories.map((category) => [category.id, category]));
  return (
    <div className="transaction-list">
      {rows.map((row) => {
        const category = map.get(row.category_id);
        return (
          <button
            className="transaction-row"
            key={row.id}
            onClick={() => onEdit(row)}
            aria-label={`${category?.name ?? "Операция"}, ${formatMoney(row.amount_minor)}, ${row.occurred_on}`}
          >
            <CategoryIcon icon={category?.icon} color={category?.color} />
            <span className="transaction-copy">
              <strong>{row.note || category?.name || "Операция"}</strong>
              <span>
                {category?.name} <i>·</i>{" "}
                {new Intl.DateTimeFormat("ru-RU", {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }).format(new Date(row.occurred_on + "T12:00:00Z"))}
              </span>
            </span>
            <span className={"transaction-amount " + row.type}>
              {row.type === "income" ? "+" : "−"}
              {formatMoney(row.amount_minor)}
              <span>
                {row.type === "income" ? (
                  <ArrowDownLeft size={13} />
                ) : (
                  <ArrowUpRight size={13} />
                )}
                {row.type === "income" ? "Доход" : "Расход"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
