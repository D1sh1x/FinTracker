import type { components } from "./generated/api";
import { apiFetch } from "./mobile";

export type Profile = components["schemas"]["ProfileOut"];
export type Wallet = components["schemas"]["WalletOut"];
export type Category = components["schemas"]["CategoryOut"];
export type Transaction = components["schemas"]["TransactionOut"];
export type Summary = components["schemas"]["SummaryOut"];
export type Budget = components["schemas"]["BudgetOut"];
export type CategoryBudgetItem = components["schemas"]["CategoryBudgetItem"];
export type CategoryBudgets = components["schemas"]["CategoryBudgetsOut"];
export type Page = components["schemas"]["TransactionsOut"];
export type ScreenshotImport = components["schemas"]["ScreenshotImport"];
export type ScreenshotReceipt = components["schemas"]["ScreenshotReceipt"];
export type Account = components["schemas"]["Account"];
export type Capital = components["schemas"]["Capital"];
export type Transfer = components["schemas"]["Transfer"];

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch("/api/v1" + path, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "network_error",
      "Нет связи с сервером. Проверьте подключение и повторите — введённые данные сохранены.",
    );
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      data?.error?.code ?? "http_error",
      data?.error?.message ?? "Не удалось выполнить действие",
      data?.error?.fields ?? {},
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function send<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function queryString(
  values: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}
