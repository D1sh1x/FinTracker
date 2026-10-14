import { describe, expect, it } from "vitest";
import {
  formatMoney,
  moneyInput,
  moveMonth,
  parseMoney,
  percent,
} from "./money";

describe("exact money", () => {
  it("accepts comma and dot without rounding", () => {
    expect(parseMoney("100")).toBe("10000");
    expect(parseMoney("100,5")).toBe("10050");
    expect(parseMoney("100.50")).toBe("10050");
    expect(parseMoney("0,01")).toBe("1");
    expect(parseMoney("-0,01", true)).toBe("-1");
    expect(parseMoney("0", true)).toBe("0");
  });
  it.each(["0", "-1", "1,234", "1e5", "1.2.3", "1 234", "9999999999", ""])(
    "rejects %s",
    (value) => {
      expect(() => parseMoney(value)).toThrow();
    },
  );
  it("formats above the JavaScript safe integer range exactly", () => {
    expect(moneyInput("9007199254740993")).toBe("90071992547409,93");
    expect(formatMoney("9007199254740993")).toContain(",93 ₽");
    expect(moneyInput("-125050")).toBe("-1250,50");
    expect(percent("600000", "500000")).toBe(120);
    expect(percent("1", "0")).toBe(0);
  });
  it("moves across year boundaries", () => {
    expect(moveMonth("2026-12", 1)).toBe("2027-01");
    expect(moveMonth("2026-01", -1)).toBe("2025-12");
  });
});
