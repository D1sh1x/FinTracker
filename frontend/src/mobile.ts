import {
  Capacitor,
  CapacitorHttp,
  SystemBars,
  SystemBarsStyle,
  registerPlugin,
} from "@capacitor/core";

export type Connection = { url: string; username: string; password: string };
export const defaultServer = "https://167.86.68.233:9443";

export const nativeApp = Capacitor.isNativePlatform();

export const device = registerPlugin<{
  readConnection(): Promise<Connection>;
  saveConnection(connection: Connection): Promise<void>;
  saveCsv(options: { name: string; text: string }): Promise<{ saved: boolean }>;
  setTheme(options: { theme: "light" | "dark" | "system" }): Promise<void>;
  pasteImage(): Promise<{ mimeType: string; base64: string }>;
}>("FintrackDevice");

let connection: Connection | undefined;

export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "Укажите полный адрес сервера, например https://finance.example.com.",
    );
  }
  const local = ["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "Укажите адрес HTTPS без пути, логина и пароля. HTTP разрешён только для локального туннеля.",
    );
  return url.origin;
}

export function applySystemTheme(
  theme: "light" | "dark" | "system",
  dark: boolean,
) {
  if (nativeApp)
    void device
      .setTheme({ theme })
      .then(() =>
        SystemBars.setStyle({
          style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
        }),
      )
      .catch(() => {});
}

export function setConnection(next: Connection) {
  connection = { ...next, url: normalizeServer(next.url) };
}

export function currentServer() {
  return connection?.url ?? "";
}

function authorization(config: Connection) {
  return (
    "Basic " +
    btoa(
      Array.from(
        new TextEncoder().encode(`${config.username}:${config.password}`),
        (byte) => String.fromCharCode(byte),
      ).join(""),
    )
  );
}

async function nativeBody(body: BodyInit | null | undefined) {
  if (!(body instanceof FormData))
    return body ? JSON.parse(String(body)) : undefined;
  const fields = [];
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") fields.push({ key, value, type: "string" });
    else {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () =>
          reject(new Error("Не удалось прочитать изображение."));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.readAsDataURL(value);
      });
      fields.push({
        key,
        value: base64,
        type: "base64File",
        fileName: value.name,
        contentType: value.type,
      });
    }
  }
  return fields;
}

export async function apiFetch(
  path: string,
  options: RequestInit = {},
  config = connection,
  timeout = 20_000,
): Promise<Response> {
  if (!nativeApp) return fetch(path, options);
  if (!config) throw new Error("Настройте подключение к серверу.");
  if (!path.startsWith("/api/v1/") && path !== "/health/ready")
    throw new Error("Недопустимый путь API.");
  options.signal?.throwIfAborted();
  const headers = new Headers(options.headers);
  if (config.username || config.password)
    headers.set("Authorization", authorization(config));
  const multipart = options.body instanceof FormData;
  if (multipart) headers.set("Content-Type", "multipart/form-data");
  const data = await nativeBody(options.body);
  options.signal?.throwIfAborted();
  const request = CapacitorHttp.request({
    url: normalizeServer(config.url) + path,
    method: options.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    data,
    ...(multipart ? { dataType: "formData" as const } : {}),
    responseType: "text",
    readTimeout: timeout,
    connectTimeout: Math.min(timeout, 10_000),
    disableRedirects: true,
  });
  let abort: (() => void) | undefined;
  try {
    const result = await (options.signal
      ? Promise.race([
          request,
          new Promise<never>((_, reject) => {
            abort = () => reject(options.signal!.reason);
            options.signal!.addEventListener("abort", abort, { once: true });
            if (options.signal!.aborted) abort();
          }),
        ])
      : request);
    return new Response(
      result.status === 204
        ? null
        : typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data),
      {
        status: result.status,
        headers: result.headers,
      },
    );
  } finally {
    if (abort) options.signal!.removeEventListener("abort", abort);
  }
}

export async function saveCsv(name: string, blob: Blob) {
  if (nativeApp) {
    await device.saveCsv({ name, text: await blob.text() });
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function clipboardImage(): Promise<File> {
  const result = await device.pasteImage();
  const bytes = Uint8Array.from(atob(result.base64), (char) =>
    char.charCodeAt(0),
  );
  return new File(
    [bytes],
    result.mimeType === "image/jpeg" ? "clipboard.jpg" : "clipboard.png",
    { type: result.mimeType },
  );
}
