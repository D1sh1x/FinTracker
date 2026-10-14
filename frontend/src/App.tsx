import { useEffect, useState } from "react";
import { CategoryBudgetsPanel } from "./CategoryBudgets";
import { ImportScreenshots } from "./ImportScreenshots";
import type { FormEvent } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  LayoutDashboard,
  ArrowLeftRight,
  PieChart,
  Settings2,
  Layers3,
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowRight,
  Sun,
  Moon,
  Download,
  Check,
  Wallet as WalletIcon,
  ChartColumnIncreasing,
  Search,
  SlidersHorizontal,
  ImagePlus,
} from "lucide-react";
import {
  ApiError,
  queryString,
  request,
  send,
  type Budget,
  type Category,
  type Profile,
  type Summary,
  type Transaction,
  type Wallet,
  type Page,
} from "./api";
import {
  CategoryIcon,
  Empty,
  FormError,
  LoadError,
  Loading,
  TransactionList,
} from "./components";
import {
  BudgetEditor,
  CategoryEditor,
  ProfileEditor,
  TransactionEditor,
} from "./forms";
import {
  formatMoney,
  moneyInput,
  monthLabel,
  moveMonth,
  parseMoney,
  percent,
  todayIn,
} from "./money";

type Theme = "light" | "dark" | "system";
type Section =
  | "overview"
  | "transactions"
  | "budget"
  | "categories"
  | "settings"
  | "imports";
const navigation = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "transactions", label: "Операции", icon: ArrowLeftRight },
  { id: "budget", label: "Бюджет", icon: PieChart },
  { id: "categories", label: "Категории", icon: Layers3 },
  { id: "imports", label: "Из скриншота", icon: ImagePlus },
  { id: "settings", label: "Настройки", icon: Settings2 },
] as const;

function sectionFromHash(): Section {
  const section = location.hash.slice(1);
  return navigation.some((item) => item.id === section)
    ? (section as Section)
    : "overview";
}

function Brand() {
  return (
    <a className="brand" href="#overview">
      <span className="brand-mark">
        <ChartColumnIncreasing size={25} strokeWidth={2} />
      </span>
      <span>
        ФинТрек<span className="brand-dot">.</span>
      </span>
    </a>
  );
}

function ThemeButton({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  return (
    <button
      className="icon-button theme-toggle"
      title="Переключить тему"
      aria-label="Переключить тему"
      onClick={() =>
        setTheme(
          document.documentElement.dataset.theme === "dark" ? "light" : "dark",
        )
      }
    >
      {theme === "dark" ||
      (theme === "system" &&
        document.documentElement.dataset.theme === "dark") ? (
        <Sun size={20} />
      ) : (
        <Moon size={20} />
      )}
    </button>
  );
}

export default function App() {
  const client = useQueryClient();
  const [selected, setSelected] = useState(
    localStorage.getItem("fintrack-profile") ?? "",
  );
  const [theme, setTheme] = useState<Theme>(
    (localStorage.getItem("fintrack-theme") as Theme) || "system",
  );
  const [newProfile, setNewProfile] = useState(false);
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: ({ signal }) =>
      request<{ items: Profile[] }>("/profiles", { signal }),
  });
  const person =
    profiles.data?.items.find((p) => p.id === selected) ??
    profiles.data?.items[0];
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("fintrack-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (person) localStorage.setItem("fintrack-profile", person.id);
  }, [person?.id]);
  async function created(profile: Profile) {
    await client.invalidateQueries({ queryKey: ["profiles"] });
    setSelected(profile.id);
    setNewProfile(false);
  }
  if (profiles.isPending)
    return (
      <div className="welcome-shell">
        <Brand />
        <Loading />
      </div>
    );
  if (profiles.isError)
    return (
      <div className="welcome-shell">
        <Brand />
        <LoadError error={profiles.error} onRetry={() => profiles.refetch()} />
      </div>
    );
  return (
    <>
      {person ? (
        <Workspace
          key={person.id}
          person={person}
          profiles={profiles.data.items}
          onSelect={setSelected}
          onNewProfile={() => setNewProfile(true)}
          theme={theme}
          setTheme={setTheme}
        />
      ) : (
        <div className="welcome-shell">
          <div className="welcome-top">
            <Brand />
            <ThemeButton theme={theme} setTheme={setTheme} />
          </div>
          <div className="welcome-content">
            <span className="eyebrow">МЕНЬШЕ ХАОСА. БОЛЬШЕ ЯСНОСТИ.</span>
            <h1>
              Ваши деньги.
              <br />
              <span>Всё под контролем.</span>
            </h1>
            <p>
              Доходы, расходы и бюджет — в одном спокойном месте. Начните с
              профиля и первой операции.
            </p>
            <button
              className="button primary"
              onClick={() => setNewProfile(true)}
            >
              <Plus size={20} />
              Создать профиль
            </button>
            <span className="welcome-note">Без регистрации и лишних шагов</span>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-wallet">
              <WalletIcon size={48} strokeWidth={1.4} />
              <span>
                Новый взгляд
                <br />
                на ваши финансы
              </span>
              <i />
              <i />
              <i />
            </div>
            <span className="art-chip chip-income">
              <ArrowDownLeft size={18} />
              Доходы
            </span>
            <span className="art-chip chip-budget">
              <PieChart size={18} />
              Ваш бюджет
            </span>
            <span className="art-chip chip-expense">
              <ArrowUpRight size={18} />
              Расходы
            </span>
          </div>
          <footer>ФинТрек · Пространство для личных финансов</footer>
        </div>
      )}
      {newProfile && (
        <ProfileEditor
          onClose={() => setNewProfile(false)}
          onCreated={created}
        />
      )}
    </>
  );
}

function Workspace({
  person,
  profiles,
  onSelect,
  onNewProfile,
  theme,
  setTheme,
}: {
  person: Profile;
  profiles: Profile[];
  onSelect: (id: string) => void;
  onNewProfile: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const client = useQueryClient();
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [month, setMonth] = useState(todayIn(person.timezone).slice(0, 7));
  const [editor, setEditor] = useState<Transaction | null | undefined>(
    undefined,
  );
  const [categoryEditor, setCategoryEditor] = useState<
    Category | null | undefined
  >(undefined);
  const [budgetEditor, setBudgetEditor] = useState(false);
  const [categoryBudgetEditor, setCategoryBudgetEditor] = useState<
    string | null
  >(null);
  const [toast, setToast] = useState("");
  const [downloadError, setDownloadError] = useState<Error | null>(null);
  const prefix = `/profiles/${person.id}`;
  const key = ["profile", person.id];
  const summary = useQuery({
    queryKey: [...key, "summary", month],
    queryFn: ({ signal }) =>
      request<Summary>(`${prefix}/summary?month=${month}`, { signal }),
  });
  const categories = useQuery({
    queryKey: [...key, "categories"],
    queryFn: ({ signal }) =>
      request<{ items: Category[] }>(
        `${prefix}/categories?include_archived=true`,
        { signal },
      ),
  });
  const wallet = useQuery({
    queryKey: [...key, "wallet"],
    queryFn: ({ signal }) => request<Wallet>(`${prefix}/wallet`, { signal }),
  });
  const budget = useQuery({
    queryKey: [...key, "budget", month],
    queryFn: async ({ signal }) => {
      try {
        return await request<Budget>(`${prefix}/budgets/${month}`, { signal });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const recent = useQuery({
    queryKey: [...key, "recent"],
    queryFn: ({ signal }) =>
      request<Page>(`${prefix}/transactions?limit=5`, { signal }),
    enabled: section === "overview",
  });
  useEffect(() => {
    const change = () => setSection(sectionFromHash());
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function updated() {
    await client.invalidateQueries({ queryKey: key });
    setToast("Готово. Ваши финансы обновлены");
  }
  async function download(filters: Record<string, string | undefined> = {}) {
    setDownloadError(null);
    try {
      const response = await fetch(
        `/api/v1${prefix}/exports/transactions.csv?${queryString(filters)}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? "Не удалось выгрузить операции",
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `fintrack-${person.name.replace(/[^\p{L}\p{N}-]/gu, "_")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(
        e instanceof TypeError
          ? new Error("Нет связи с сервером. Повторите экспорт позже.")
          : (e as Error),
      );
    }
  }
  const heading = {
    overview: "Ваши финансы",
    transactions: "История операций",
    budget: "Месячный бюджет",
    categories: "Ваши категории",
    settings: "Настройки",
    imports: "Импорт из скриншота",
  }[section];
  const editedCategoryBudget = summary.data?.category_budgets.items.find(
    (item) => item.category_id === categoryBudgetEditor,
  );
  const subheading = {
    overview: "Всё важное — перед глазами.",
    transactions: "Каждая операция на своём месте.",
    budget: "Небольшой план для больших спокойных дней.",
    categories: "Учёт, который подходит именно вам.",
    settings: "Ваше пространство, ваши правила.",
    imports: "Сначала проверка, затем запись в учёт.",
  }[section];
  const sharedError = summary.error ?? categories.error ?? wallet.error;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">ЛИЧНЫЕ ФИНАНСЫ</div>
        <nav aria-label="Основная навигация">
          {navigation.map((item) => (
            <a
              href={"#" + item.id}
              key={item.id}
              className={section === item.id ? "active" : ""}
              aria-current={section === item.id ? "page" : undefined}
            >
              <item.icon size={20} strokeWidth={1.7} />
              {item.label}
              {section === item.id && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-leaf">✳</span>
          <p>
            Маленькие привычки.
            <br />
            <strong>Большая ясность.</strong>
          </p>
          <span>
            Записывайте расходы сегодня,
            <br />
            чтобы легче планировать завтра.
          </span>
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Личное пространство<span>v1.0</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-caption">Финансы без лишнего</span>
          <div className="topbar-actions">
            <ThemeButton theme={theme} setTheme={setTheme} />
            <span className="topbar-divider" />
            <div className="profile-control">
              <span className="avatar">
                {person.name.slice(0, 1).toUpperCase()}
              </span>
              <select
                aria-label="Выбрать профиль"
                value={person.id}
                onChange={(e) => {
                  if (e.target.value === "__new") onNewProfile();
                  else onSelect(e.target.value);
                }}
              >
                <optgroup label="Ваши профили">
                  {profiles.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <option value="__new">＋ Создать профиль</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
        </header>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">ВАШЕ ЛИЧНОЕ ПРОСТРАНСТВО</span>
              <h1>
                {heading}
                <span className="heading-dot">.</span>
              </h1>
              <p>{subheading}</p>
            </div>
            <button
              className="button primary add-operation"
              disabled={!wallet.data || !categories.data}
              onClick={() => setEditor(null)}
            >
              <Plus size={19} />
              Добавить операцию
            </button>
          </div>
          {(section === "overview" || section === "budget") && (
            <div className="period-toolbar">
              <div className="month-switcher">
                <button
                  className="icon-button"
                  aria-label="Предыдущий месяц"
                  onClick={() => setMonth(moveMonth(month, -1))}
                >
                  <ChevronLeft size={17} />
                </button>
                <label className="month-label">
                  {monthLabel(month)}
                  <input
                    type="month"
                    value={month}
                    onChange={(e) => {
                      if (e.target.value) setMonth(e.target.value);
                    }}
                    aria-label="Выбрать месяц"
                  />
                </label>
                <button
                  className="icon-button"
                  aria-label="Следующий месяц"
                  onClick={() => setMonth(moveMonth(month, 1))}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <span className="period-caption">
                {month === todayIn(person.timezone).slice(0, 7)
                  ? "Текущий месяц"
                  : "Выбранный месяц"}
              </span>
            </div>
          )}
          <FormError error={downloadError} />
          {sharedError ? (
            <LoadError
              error={sharedError}
              onRetry={() => client.invalidateQueries({ queryKey: key })}
            />
          ) : !summary.data || !categories.data || !wallet.data ? (
            <Loading />
          ) : (
            <>
              {section === "imports" && (
                <ImportScreenshots
                  person={person}
                  wallet={wallet.data}
                  categories={categories.data.items}
                  onComplete={updated}
                />
              )}
              {section === "overview" && (
                <>
                  {wallet.data.opening_balance_minor === "0" &&
                    recent.data?.items.length === 0 && (
                      <div className="onboarding-tip">
                        <WalletIcon size={22} />
                        <div>
                          <strong>Начнём с вашего остатка</strong>
                          <p>
                            Укажите, сколько денег было в начале учёта. Можно
                            пропустить и сразу добавить операцию.
                          </p>
                        </div>
                        <a className="text-button" href="#settings">
                          Задать остаток
                          <ArrowRight size={16} />
                        </a>
                      </div>
                    )}
                  <div className="stats-grid">
                    <div className="stat-card balance">
                      <div className="stat-label">
                        <span>Общий баланс</span>
                        <WalletIcon size={19} />
                      </div>
                      <strong className="stat-value">
                        {formatMoney(summary.data.balance_minor, false)}
                      </strong>
                      <span className="stat-footnote">
                        За весь период учёта
                        <ArrowUpRight size={17} />
                      </span>
                      <div className="balance-decoration" aria-hidden="true" />
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">
                        <span>Доходы</span>
                        <span className="stat-icon income">
                          <ArrowDownLeft size={17} />
                        </span>
                      </div>
                      <strong className="stat-value">
                        {formatMoney(summary.data.income_minor, false)}
                      </strong>
                      <span className="stat-footnote">
                        За {monthLabel(month).toLowerCase()}
                      </span>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">
                        <span>Расходы</span>
                        <span className="stat-icon expense">
                          <ArrowUpRight size={17} />
                        </span>
                      </div>
                      <strong className="stat-value">
                        {formatMoney(summary.data.expense_minor, false)}
                      </strong>
                      <span className="stat-footnote">
                        За {monthLabel(month).toLowerCase()}
                      </span>
                    </div>
                  </div>
                  <div className="dashboard-grid">
                    <section className="panel categories-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>На что уходят деньги</h2>
                          <p>Расходы по категориям</p>
                        </div>
                        <span className="tag">
                          {summary.data.categories.length} категорий
                        </span>
                      </div>
                      <CategoryChart
                        summary={summary.data}
                        onAdd={() => setEditor(null)}
                      />
                    </section>
                    <section className="panel budget-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Бюджет месяца</h2>
                          <p>План, который помогает</p>
                        </div>
                        <span className="panel-icon">
                          <PieChart size={21} />
                        </span>
                      </div>
                      <BudgetCard
                        summary={summary.data}
                        onEdit={() => setBudgetEditor(true)}
                        disabled={budget.isPending || budget.isError}
                      />
                    </section>
                  </div>
                  <CategoryBudgetsPanel
                    data={summary.data.category_budgets}
                    onEdit={setCategoryBudgetEditor}
                    compact
                  />
                  <section className="panel recent-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Последние операции</h2>
                        <p>Ваши деньги в движении</p>
                      </div>
                      <a className="text-button" href="#transactions">
                        Все операции
                        <ArrowRight size={16} />
                      </a>
                    </div>
                    {recent.isPending ? (
                      <Loading text="Загружаем операции…" />
                    ) : recent.error ? (
                      <LoadError
                        error={recent.error}
                        onRetry={() => recent.refetch()}
                      />
                    ) : recent.data.items.length ? (
                      <TransactionList
                        rows={recent.data.items}
                        categories={categories.data.items}
                        onEdit={setEditor}
                      />
                    ) : (
                      <Empty
                        compact
                        title="Начнём с первой записи"
                        text="Добавьте доход или расход — и здесь появится ваша история."
                        action="Добавить операцию"
                        onAction={() => setEditor(null)}
                      />
                    )}
                  </section>
                </>
              )}
              {section === "transactions" && (
                <History
                  person={person}
                  categories={categories.data.items}
                  onEdit={setEditor}
                  onAdd={() => setEditor(null)}
                  onExport={download}
                />
              )}
              {section === "budget" && (
                <>
                  <div className="budget-page-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Ваш лимит расходов</h2>
                          <p>{monthLabel(month)}</p>
                        </div>
                        <PieChart size={24} />
                      </div>
                      <BudgetCard
                        summary={summary.data}
                        onEdit={() => setBudgetEditor(true)}
                        disabled={budget.isPending || budget.isError}
                        expanded
                      />
                      {budget.isError && (
                        <LoadError
                          error={budget.error}
                          onRetry={() => budget.refetch()}
                        />
                      )}
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Внутри этого месяца</h2>
                          <p>Доходы и расходы без смешения</p>
                        </div>
                      </div>
                      <div className="budget-info">
                        <div>
                          <span>Доходы</span>
                          <strong className="income-text">
                            {formatMoney(summary.data.income_minor)}
                          </strong>
                        </div>
                        <div>
                          <span>Расходы</span>
                          <strong>
                            {formatMoney(summary.data.expense_minor)}
                          </strong>
                        </div>
                        <div>
                          <span>Результат месяца</span>
                          <strong>{formatMoney(summary.data.net_minor)}</strong>
                        </div>
                      </div>
                      <p className="info-note">
                        Бюджет — это ваш лимит расходов. Он не равен остатку
                        денег и не увеличивается автоматически при поступлении
                        дохода.
                      </p>
                    </section>
                  </div>
                  <CategoryBudgetsPanel
                    data={summary.data.category_budgets}
                    onEdit={setCategoryBudgetEditor}
                  />
                </>
              )}
              {section === "categories" && (
                <Categories
                  categories={categories.data.items}
                  onEdit={setCategoryEditor}
                  onAdd={() => setCategoryEditor(null)}
                />
              )}
              {section === "settings" && (
                <Settings
                  person={person}
                  wallet={wallet.data}
                  theme={theme}
                  setTheme={setTheme}
                  onComplete={updated}
                  onExport={() => download()}
                  onNewProfile={onNewProfile}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>ФинТрек · Деньги любят ясность</span>
            <span>Ваши данные — на вашем сервере</span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Мобильная навигация">
        {navigation.map((item) => (
          <a
            key={item.id}
            href={"#" + item.id}
            className={section === item.id ? "active" : ""}
            aria-current={section === item.id ? "page" : undefined}
          >
            <item.icon size={21} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
      {editor !== undefined && wallet.data && categories.data && (
        <TransactionEditor
          key={editor ? `${editor.id}:${editor.version}` : "new"}
          person={person}
          wallet={wallet.data}
          categories={categories.data.items}
          existing={editor}
          onClose={() => setEditor(undefined)}
          onComplete={updated}
          onReload={setEditor}
        />
      )}
      {categoryEditor !== undefined && (
        <CategoryEditor
          key={categoryEditor?.id ?? "new"}
          person={person}
          existing={categoryEditor}
          onClose={() => setCategoryEditor(undefined)}
          onComplete={updated}
        />
      )}
      {editedCategoryBudget && (
        <BudgetEditor
          key={`${month}/${editedCategoryBudget.category_id}/${editedCategoryBudget.version ?? "new"}`}
          person={person}
          month={month}
          category={{
            id: editedCategoryBudget.category_id,
            name: editedCategoryBudget.name,
          }}
          existing={
            editedCategoryBudget.limit_minor !== null &&
            editedCategoryBudget.version !== null
              ? {
                  limit_minor: editedCategoryBudget.limit_minor,
                  version: editedCategoryBudget.version,
                }
              : null
          }
          onClose={() => setCategoryBudgetEditor(null)}
          onComplete={updated}
          onRefresh={async () => {
            await summary.refetch({ throwOnError: true });
          }}
        />
      )}
      {budgetEditor && budget.data !== undefined && (
        <BudgetEditor
          key={budget.data?.version ?? "new"}
          person={person}
          month={month}
          existing={budget.data}
          onClose={() => setBudgetEditor(false)}
          onComplete={updated}
          onRefresh={async () => {
            await budget.refetch({ throwOnError: true });
            await summary.refetch({ throwOnError: true });
          }}
        />
      )}
    </div>
  );
}

function CategoryChart({
  summary,
  onAdd,
}: {
  summary: Summary;
  onAdd: () => void;
}) {
  if (!summary.categories.length)
    return (
      <Empty
        compact
        title="Расходов пока нет"
        text="В этом месяце ещё нет расходов. Здесь появится понятная разбивка по категориям."
        onAction={onAdd}
      />
    );
  return (
    <div className="category-chart">
      {summary.categories.map((category) => (
        <div className="chart-row" key={category.category_id}>
          <CategoryIcon icon={category.icon} color={category.color} />
          <div className="chart-details">
            <div>
              <strong>{category.name}</strong>
              <span>{formatMoney(category.amount_minor, false)}</span>
            </div>
            <div className="bar-track">
              <div
                style={{
                  width: `${Math.max(percent(category.amount_minor, summary.expense_minor), 1)}%`,
                  background: category.color,
                }}
              />
            </div>
          </div>
          <span className="chart-percent">
            {percent(
              category.amount_minor,
              summary.expense_minor,
            ).toLocaleString("ru-RU")}
            %
          </span>
        </div>
      ))}
    </div>
  );
}

function BudgetCard({
  summary,
  onEdit,
  disabled,
  expanded = false,
}: {
  summary: Summary;
  onEdit: () => void;
  disabled: boolean;
  expanded?: boolean;
}) {
  const budget = summary.budget;
  if (!budget)
    return (
      <div className="budget-empty">
        <div className="budget-illustration">
          <PieChart size={43} strokeWidth={1.2} />
        </div>
        <h3>Планы начинаются с цифры</h3>
        <p>
          Задайте комфортный лимит на месяц.
          <br />
          Мы посчитаем всё остальное.
        </p>
        <button
          className="button secondary full"
          disabled={disabled}
          onClick={onEdit}
        >
          <Plus size={17} />
          Задать бюджет
        </button>
      </div>
    );
  const used = Number(budget.used_percent);
  const over = BigInt(budget.remaining_minor) < 0n;
  return (
    <div className={"budget-content" + (expanded ? " expanded" : "")}>
      <span className="budget-remaining-label">
        {over ? "Перерасход" : "Осталось в бюджете"}
      </span>
      <strong className={"budget-remaining" + (over ? " danger-text" : "")}>
        {formatMoney(budget.remaining_minor, false)}
      </strong>
      <div
        className="budget-track"
        role="progressbar"
        aria-label="Использовано бюджета"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(used, 100)}
        aria-valuetext={`${used.toLocaleString("ru-RU")} процентов`}
      >
        <span
          style={{ width: `${Math.min(used, 100)}%` }}
          className={over ? "over" : ""}
        />
      </div>
      <div className="budget-progress-label">
        <span>
          {formatMoney(budget.spent_minor, false)} из{" "}
          {formatMoney(budget.limit_minor, false)}
        </span>
        <strong>{used.toLocaleString("ru-RU")}%</strong>
      </div>
      {budget.daily_available_minor !== null && (
        <div className="daily-limit">
          <span>
            Ориентир на день
            <small>Осталось {budget.days_remaining} дн., включая сегодня</small>
          </span>
          <strong>{formatMoney(budget.daily_available_minor)}</strong>
        </div>
      )}
      <button className="text-button" disabled={disabled} onClick={onEdit}>
        Изменить бюджет
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

function History({
  person,
  categories,
  onEdit,
  onAdd,
  onExport,
}: {
  person: Profile;
  categories: Category[];
  onEdit: (row: Transaction) => void;
  onAdd: () => void;
  onExport: (filters: Record<string, string | undefined>) => void;
}) {
  const [month, setMonth] = useState(todayIn(person.timezone).slice(0, 7));
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const filters = {
    date_from: month ? month + "-01" : undefined,
    date_to: month ? moveMonth(month, 1) + "-01" : undefined,
    type,
    category_id: category,
    q,
  };
  const transactions = useInfiniteQuery({
    queryKey: ["profile", person.id, "history", filters],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      request<Page>(
        `/profiles/${person.id}/transactions?${queryString({ ...filters, cursor: pageParam })}`,
        { signal },
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const rows = transactions.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = new Map<string, Transaction[]>();
  rows.forEach((row) => {
    const list = groups.get(row.occurred_on) ?? [];
    list.push(row);
    groups.set(row.occurred_on, list);
  });
  return (
    <section className="panel history-panel">
      <div className="history-tools">
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="Поиск по комментарию"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по комментарию"
          />
        </label>
        <button
          className="button secondary small"
          onClick={() => onExport(filters)}
        >
          <Download size={16} />
          Экспорт CSV
        </button>
      </div>
      <div className="filters">
        <SlidersHorizontal size={17} />
        <label>
          Период
          <div className="period-filter">
            <input
              aria-label="Период истории"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
            <button className="text-button" onClick={() => setMonth("")}>
              Всё время
            </button>
          </div>
        </label>
        <label>
          Тип
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCategory("");
            }}
          >
            <option value="">Все операции</option>
            <option value="expense">Расходы</option>
            <option value="income">Доходы</option>
          </select>
        </label>
        <label>
          Категория
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Все категории</option>
            {categories
              .filter((c) => !type || c.type === type)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_archived ? " (архив)" : ""}
                </option>
              ))}
          </select>
        </label>
      </div>
      {transactions.isPending ? (
        <Loading />
      ) : transactions.isError ? (
        <LoadError
          error={transactions.error}
          onRetry={() => transactions.refetch()}
        />
      ) : !rows.length ? (
        <Empty
          title="Здесь пока пусто"
          text={
            q || type || category
              ? "По этим фильтрам ничего не найдено. Попробуйте изменить условия."
              : "Добавьте первую операцию или выберите другой период."
          }
          action="Добавить операцию"
          onAction={onAdd}
        />
      ) : (
        <>
          {Array.from(groups).map(([date, items]) => (
            <div className="day-group" key={date}>
              <h3>
                {new Intl.DateTimeFormat("ru-RU", {
                  day: "numeric",
                  month: "long",
                  weekday: "long",
                  timeZone: "UTC",
                }).format(new Date(date + "T12:00:00Z"))}
              </h3>
              <TransactionList
                rows={items}
                categories={categories}
                onEdit={onEdit}
              />
            </div>
          ))}
          {transactions.hasNextPage && (
            <div className="load-more">
              <button
                className="button secondary"
                disabled={transactions.isFetchingNextPage}
                onClick={() => transactions.fetchNextPage()}
              >
                {transactions.isFetchingNextPage
                  ? "Загружаем…"
                  : "Показать ещё"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Categories({
  categories,
  onEdit,
  onAdd,
}: {
  categories: Category[];
  onEdit: (category: Category) => void;
  onAdd: () => void;
}) {
  const [archive, setArchive] = useState(false);
  return (
    <>
      <div className="section-toolbar">
        <div className="segmented compact">
          <button
            className={!archive ? "active" : ""}
            onClick={() => setArchive(false)}
          >
            Активные
          </button>
          <button
            className={archive ? "active" : ""}
            onClick={() => setArchive(true)}
          >
            Архив
          </button>
        </div>
        <button className="button secondary" onClick={onAdd}>
          <Plus size={17} />
          Новая категория
        </button>
      </div>
      <div className="categories-grid">
        {(["expense", "income"] as const).map((type) => (
          <section className="panel" key={type}>
            <div className="panel-heading">
              <h2>
                {type === "expense"
                  ? "Категории расходов"
                  : "Категории доходов"}
              </h2>
              <span className="tag">
                {
                  categories.filter(
                    (c) => c.type === type && c.is_archived === archive,
                  ).length
                }
              </span>
            </div>
            {categories
              .filter((c) => c.type === type && c.is_archived === archive)
              .map((category) => (
                <button
                  className="category-item"
                  key={category.id}
                  onClick={() => onEdit(category)}
                >
                  <CategoryIcon icon={category.icon} color={category.color} />
                  <strong>{category.name}</strong>
                  <ChevronRight size={16} />
                </button>
              ))}
            {!categories.some(
              (c) => c.type === type && c.is_archived === archive,
            ) && (
              <Empty
                compact
                title={archive ? "Архив пуст" : "Нет категорий"}
                text={
                  archive
                    ? "Здесь появятся архивированные категории. Старые операции сохранятся."
                    : "Создайте свою первую категорию."
                }
              />
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function Settings({
  person,
  wallet,
  theme,
  setTheme,
  onComplete,
  onExport,
  onNewProfile,
}: {
  person: Profile;
  wallet: Wallet;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  onComplete: () => Promise<void>;
  onExport: () => void;
  onNewProfile: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(person.name);
  const [timezone, setTimezone] = useState(person.timezone);
  const [opening, setOpening] = useState(
    moneyInput(wallet.opening_balance_minor),
  );
  const [start, setStart] = useState(wallet.tracking_start_date);
  const [profileError, setProfileError] = useState<Error | null>(null);
  const [walletError, setWalletError] = useState<Error | null>(null);
  const [busy, setBusy] = useState("");
  const timezones = Array.from(
    new Set(["UTC", person.timezone, ...Intl.supportedValuesOf("timeZone")]),
  );
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy("profile");
    setProfileError(null);
    try {
      await send(`/profiles/${person.id}`, "PATCH", { name, timezone });
      await client.invalidateQueries({ queryKey: ["profiles"] });
      await onComplete();
    } catch (e) {
      setProfileError(e as Error);
    } finally {
      setBusy("");
    }
  }
  async function saveWallet(event: FormEvent) {
    event.preventDefault();
    setWalletError(null);
    let opening_balance_minor: string;
    try {
      opening_balance_minor = parseMoney(opening, true);
    } catch (e) {
      setWalletError(e as Error);
      return;
    }
    setBusy("wallet");
    try {
      await send(`/profiles/${person.id}/wallet`, "PATCH", {
        opening_balance_minor,
        tracking_start_date: start,
        version: wallet.version,
      });
      await onComplete();
    } catch (e) {
      setWalletError(e as Error);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Профиль</h2>
            <p>Отдельный набор ваших финансов</p>
          </div>
          <span className="avatar">
            {person.name.slice(0, 1).toUpperCase()}
          </span>
        </div>
        <form onSubmit={saveProfile}>
          <label>
            Имя
            <input
              required
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Часовой пояс
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {timezones.map((zone) => (
                <option value={zone} key={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <FormError error={profileError} />
          <button className="button primary" disabled={!!busy}>
            {busy === "profile" ? "Сохраняем…" : "Сохранить профиль"}
          </button>
        </form>
        <button className="text-button new-profile-link" onClick={onNewProfile}>
          <Plus size={16} />
          Создать ещё один профиль
        </button>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Начало учёта</h2>
            <p>Точка отсчёта для вашего баланса</p>
          </div>
          <WalletIcon size={22} />
        </div>
        <form onSubmit={saveWallet}>
          <label>
            Начальный остаток, ₽
            <input
              inputMode="decimal"
              required
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
            />
          </label>
          <label>
            Дата начала учёта
            <input
              type="date"
              required
              max={todayIn(person.timezone)}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <p className="field-hint">
            Остаток перед началом выбранной даты. Изменение пересчитает общий
            баланс и не станет доходом.
          </p>
          <FormError
            error={walletError}
            onRefresh={async () => {
              try {
                const fresh = await request<Wallet>(
                  `/profiles/${person.id}/wallet`,
                );
                setOpening(moneyInput(fresh.opening_balance_minor));
                setStart(fresh.tracking_start_date);
                await onComplete();
                setWalletError(null);
              } catch (error) {
                setWalletError(error as Error);
              }
            }}
          />
          <button className="button primary" disabled={!!busy}>
            {busy === "wallet" ? "Сохраняем…" : "Сохранить остаток"}
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Оформление</h2>
            <p>Выберите удобную тему</p>
          </div>
          <Sun size={22} />
        </div>
        <div className="theme-options">
          {(
            [
              { id: "light", name: "Светлая", icon: Sun },
              { id: "dark", name: "Тёмная", icon: Moon },
              { id: "system", name: "Системная", icon: Settings2 },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              className={theme === option.id ? "selected" : ""}
              aria-pressed={theme === option.id}
              onClick={() => setTheme(option.id)}
            >
              <option.icon size={23} />
              {option.name}
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Ваши данные</h2>
            <p>История всегда остаётся с вами</p>
          </div>
          <Download size={22} />
        </div>
        <p className="info-note">
          Выгрузите все операции этого профиля в CSV для таблиц. Резервные копии
          всей базы настраиваются на сервере.
        </p>
        <button className="button secondary" onClick={onExport}>
          <Download size={17} />
          Экспортировать операции
        </button>
      </section>
    </div>
  );
}
