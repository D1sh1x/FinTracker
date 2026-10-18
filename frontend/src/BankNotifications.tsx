import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { registerPlugin } from "@capacitor/core";
import { request, type Account, type Profile } from "./api";
import { FormError } from "./components";
import { nativeApp } from "./mobile";

type BankStatus = {
  enabled: boolean; access: boolean; profile_id: string; profile_name: string;
  wallet_id: string; wallet_name: string; server: string; listener_error: string;
  pending?: number; sent?: number; review?: number;
  items: { id: string; text: string; posted_at: string; status: string; error: string; profile_id: string }[];
};

export const bankNotifications = registerPlugin<{
  status(): Promise<BankStatus>;
  configure(config: { enabled: boolean; profile_id?: string; profile_name?: string; wallet_id?: string; wallet_name?: string }): Promise<void>;
  openAccess(): Promise<void>;
  sync(): Promise<void>;
}>("BankNotifications");

export function BankNotifications({ person }: { person: Profile }) {
  if (!nativeApp) return null;
  return <BankSettings person={person} />;
}

function BankSettings({ person }: { person: Profile }) {
  const client = useQueryClient();
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const status = useQuery({ queryKey: ["bank-notifications"], queryFn: () => bankNotifications.status(), refetchInterval: 4000 });
  const accounts = useQuery({ queryKey: ["profile", person.id, "accounts"], queryFn: ({ signal }) => request<{ items: Account[] }>(`/profiles/${person.id}/accounts`, { signal }) });
  const active = accounts.data?.items.filter(account => !account.is_archived && account.kind !== "investment") ?? [];
  const selected = active.find(account => account.id === wallet) ?? active.find(account => account.id === status.data?.wallet_id) ?? active.find(account => account.is_primary) ?? active[0];
  useEffect(() => {
    if (status.data?.sent) void client.invalidateQueries({ queryKey: ["profile"] });
  }, [client, status.data?.sent]);
  async function action(run: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await run(); await status.refetch(); }
    catch (failure) { setError(failure as Error); }
    finally { setBusy(false); }
  }
  const data = status.data;
  return <section className="panel bank-settings">
    <div className="panel-heading"><div><h2>Покупки из WB Банка</h2><p>Одна карта · автоматический учёт по пушам</p></div></div>
    <p className="field-hint">Обрабатываем только покупки из приложения WB Банка. Mir Pay и другие приложения игнорируем. Нераспознанные покупки остаются в журнале для ручной проверки; неизвестная категория — «Не определено».</p>
    {data && <p role="status">{data.enabled ? `Включено: ${data.profile_name} → ${data.wallet_name}` : "Автоимпорт выключен"}. Доступ к уведомлениям: {data.access ? "разрешён" : "не разрешён"}.</p>}
    <button className="button secondary" disabled={busy} onClick={() => void action(() => bankNotifications.openAccess())}>Разрешить доступ к уведомлениям</button>
    <label>Счёт для покупок профиля «{person.name}»<select value={selected?.id ?? ""} onChange={event => setWallet(event.target.value)} disabled={busy}>
      {active.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select></label>
    <p className="field-hint">Выбор другого профиля в приложении сам по себе не меняет получателя пушей. Для новой привязки нажмите «Включить для этого профиля». Ожидающие отправки покупки сохраняют исходный профиль и счёт.</p>
    <div className="button-row">
      <button className="button primary" disabled={busy || !data?.access || !selected} onClick={() => void action(() => bankNotifications.configure({ enabled: true, profile_id: person.id, profile_name: person.name, wallet_id: selected!.id, wallet_name: selected!.name }))}>Включить для этого профиля</button>
      <button className="button secondary" disabled={busy || !data?.enabled} onClick={() => void action(() => bankNotifications.configure({ enabled: false }))}>Выключить</button>
      <button className="button subtle" disabled={busy || !data?.enabled} onClick={() => void action(() => bankNotifications.sync())}>Отправить сейчас</button>
    </div>
    <p className="field-hint">После включения учитываются новые уведомления. Без интернета пуш сохраняется на телефоне; Android отправит его, когда разрешит фоновую работу. В настройках телефона может потребоваться разрешить фоновую активность. При установке APK вручную Android иногда требует сначала разрешить «Ограниченные настройки».</p>
    <FormError error={error ?? status.error ?? accounts.error} />
    {data?.listener_error && <p role="alert">{data.listener_error}</p>}
    {data && <><h3>Журнал на этом телефоне</h3><p>Ожидают: {data.pending ?? 0} · Добавлены: {data.sent ?? 0} · Проверить: {data.review ?? 0}</p>
      {data.items.length === 0 && <p className="field-hint">Здесь появятся покупки, полученные после включения.</p>}
      <ul className="bank-events">{data.items.map(event => <li key={event.id}>
        <strong>{event.status === "sent" ? "Добавлено" : event.status === "review" ? "Проверьте вручную" : "Ожидает отправки"}</strong>
        <time dateTime={event.posted_at}>{new Date(event.posted_at).toLocaleString("ru-RU")}</time>
        <p>{event.text}</p>{event.error && <p role="alert">{event.error}</p>}
        {event.profile_id !== person.id && <small>Относится к другому профилю: {event.profile_id}</small>}
      </li>)}</ul></>}
  </section>;
}
