import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App as AndroidApp } from "@capacitor/app";
import { Server, Wallet, ArrowLeft } from "lucide-react";
import { FormError, Loading } from "./components";
import {
  apiFetch,
  currentServer,
  defaultServer,
  device,
  nativeApp,
  normalizeServer,
  setConnection,
} from "./mobile";
import type { Connection } from "./mobile";

export function MobileServerButton() {
  if (!nativeApp) return null;
  return (
    <button
      className="button subtle mobile-server-button"
      onClick={() => window.dispatchEvent(new Event("fintrack:connection"))}
    >
      <Server size={18} />
      Подключение к серверу
    </button>
  );
}

export function MobileRoot({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [loading, setLoading] = useState(nativeApp);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<Connection>();
  const [url, setUrl] = useState(defaultServer);
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nativeApp) return;
    let active = true;
    device
      .readConnection()
      .then((config) => {
        if (!active) return;
        setUrl(config.url || defaultServer);
        setUsername(config.url ? config.username : "owner");
        setPassword(config.password);
        if (config.url) {
          setConnection(config);
          setSaved(config);
        } else setEditing(true);
      })
      .catch(() => {
        if (active) {
          setError(
            new Error("Не удалось прочитать подключение. Укажите его заново."),
          );
          setEditing(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const edit = () => {
      setError(null);
      setEditing(true);
    };
    window.addEventListener("fintrack:connection", edit);
    return () => {
      active = false;
      window.removeEventListener("fintrack:connection", edit);
    };
  }, []);

  useEffect(() => {
    if (!nativeApp) return;
    const listener = AndroidApp.addListener("backButton", () => {
      if (editing) {
        if (saved && !busy) {
          setEditing(false);
          setUrl(saved.url);
          setUsername(saved.username);
          setPassword(saved.password);
        }
        return;
      }
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        dialog.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        );
      } else if (location.hash && location.hash !== "#overview")
        location.hash = "overview";
      else AndroidApp.minimizeApp();
    });
    return () => {
      listener.then((handle) => handle.remove());
    };
  }, [editing, saved, busy]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = {
        url: normalizeServer(url),
        username: username.trim(),
        password,
      };
      const response = await apiFetch(
        "/api/v1/profiles",
        { signal: AbortSignal.timeout(15_000) },
        next,
        15_000,
      );
      if (response.status === 401)
        throw new Error("Проверьте логин и пароль общего входа.");
      if (!response.ok)
        throw new Error(
          "Сервер недоступен. Проверьте адрес и попробуйте снова.",
        );
      const data = await response.json();
      if (!Array.isArray(data.items))
        throw new Error("По этому адресу не найден API ФинТрека.");
      await device.saveConnection(next);
      const changed = currentServer() !== next.url;
      await client.cancelQueries();
      client.clear();
      if (changed) {
        localStorage.removeItem("fintrack-profile");
        location.hash = "overview";
      }
      setConnection(next);
      setSaved(next);
      setUrl(next.url);
      setUsername(next.username);
      setEditing(false);
    } catch (failure) {
      setError(
        failure instanceof TypeError || failure instanceof DOMException
          ? new Error("Нет связи с сервером. Проверьте интернет, VPN и адрес.")
          : (failure as Error),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!nativeApp) return children;
  if (loading)
    return (
      <div className="connection-shell">
        <Loading />
      </div>
    );
  if (!editing) return <>{children}</>;
  return (
    <main className="connection-shell">
      <div className="connection-brand">
        <span className="brand-mark">
          <Wallet size={25} />
        </span>
        <strong>ФинТрек.</strong>
      </div>
      <section className="panel connection-card">
        {saved && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setUrl(saved.url);
              setUsername(saved.username);
              setPassword(saved.password);
            }}
          >
            <ArrowLeft size={16} />
            Назад
          </button>
        )}
        <span className="eyebrow">ВАШИ ФИНАНСЫ ВСЕГДА РЯДОМ</span>
        <h1>Подключим ваш сервер</h1>
        <p>Сайт и приложение используют одни данные. Введите адрес ФинТрека.</p>
        <form onSubmit={connect}>
          <label>
            Адрес сервера
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://finance.example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <p className="field-hint">
            Адрес, доступный с телефона. Туннель на ПК требует отдельного
            подключения телефона.
          </p>
          <label>
            Логин общего входа
            <input
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <p className="field-hint">
            Если на сервере нет общего входа, оставьте логин и пароль пустыми.
          </p>
          <FormError error={error} />
          <button className="button primary" disabled={busy}>
            {busy ? "Подключаемся…" : "Подключиться"}
          </button>
        </form>
      </section>
    </main>
  );
}
