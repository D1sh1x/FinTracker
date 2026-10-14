const MAX = 99_999_999_999n;

export function parseMoney(input: string, signed = false): string {
  const value = input.trim();
  const pattern = signed ? /^-?\d+([.,]\d{1,2})?$/ : /^\d+([.,]\d{1,2})?$/;
  if (!pattern.test(value))
    throw new Error("Введите сумму в рублях, например 1250,50");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(/[.,]/);
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > MAX || (!signed && amount === 0n))
    throw new Error("Сумма должна быть от 0,01 до 999 999 999,99 ₽");
  return String(negative ? -amount : amount);
}

export function moneyInput(minor: string): string {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n},${String(abs % 100n).padStart(2, "0")}`;
}

export function formatMoney(minor: string, decimals = true): string {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  const whole = (abs / 100n).toLocaleString("ru-RU");
  const fraction = abs % 100n;
  return `${value < 0n ? "−" : ""}${whole}${decimals || fraction ? "," + String(fraction).padStart(2, "0") : ""} ₽`;
}

export function todayIn(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function moveMonth(month: string, offset: number): string {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(month + "-01T12:00:00Z"))
    .replace(" г.", "");
}

export function percent(part: string, total: string): number {
  return BigInt(total) > 0n
    ? Number((BigInt(part) * 1000n) / BigInt(total)) / 10
    : 0;
}
