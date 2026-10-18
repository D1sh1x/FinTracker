import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ request: vi.fn(), saveCsv: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { request: native.request },
  registerPlugin: () => ({ saveCsv: native.saveCsv }),
  SystemBars: { setStyle: vi.fn() },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
}));

import { apiFetch, normalizeServer, saveCsv, setConnection } from "./mobile";

beforeEach(() => {
  vi.clearAllMocks();
  setConnection({
    url: "https://finance.example.com:9443",
    username: "owner",
    password: "тест",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Android connection", () => {
  it("normalizes HTTPS addresses and local test tunnels", () => {
    expect(normalizeServer(" https://finance.example.com:9443/ ")).toBe(
      "https://finance.example.com:9443",
    );
    expect(normalizeServer("http://127.0.0.1:18088/")).toBe(
      "http://127.0.0.1:18088",
    );
    expect(normalizeServer("https://167.86.68.233:9443")).toBe(
      "https://167.86.68.233:9443",
    );
  });
  it.each([
    "",
    "finance.example.com",
    "http://finance.example.com",
    "https://owner:secret@example.com",
    "https://example.com/api",
    "https://example.com?secret=1",
    "https://example.com#overview",
    "file:///tmp/data",
  ])("rejects unsafe or ambiguous server %s", (value) => {
    expect(() => normalizeServer(value)).toThrow();
  });
  it("sends exact JSON money, UTF-8 auth, bounded timeouts and disables redirects", async () => {
    native.request.mockResolvedValueOnce({
      status: 201,
      headers: { "Content-Type": "application/json" },
      data: { amount_minor: "9007199254740993" },
    });
    const response = await apiFetch("/api/v1/profiles/example/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_minor: "9007199254740993" }),
    });
    const input = native.request.mock.calls[0][0];
    expect(input.url).toBe(
      "https://finance.example.com:9443/api/v1/profiles/example/transactions",
    );
    expect(input.data).toEqual({ amount_minor: "9007199254740993" });
    expect(input.readTimeout).toBe(20_000);
    expect(input.connectTimeout).toBe(10_000);
    expect(input.disableRedirects).toBe(true);
    expect(
      Buffer.from(input.headers.authorization.slice(6), "base64").toString(
        "utf8",
      ),
    ).toBe("owner:тест");
    expect(await response.json()).toEqual({ amount_minor: "9007199254740993" });
  });
  it("preserves 401 and 204 API responses", async () => {
    native.request.mockResolvedValueOnce({
      status: 401,
      headers: {},
      data: "Unauthorized",
    });
    expect((await apiFetch("/api/v1/profiles")).status).toBe(401);
    native.request.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: "",
    });
    expect(
      await (await apiFetch("/api/v1/profiles/example/budget")).text(),
    ).toBe("");
  });
  it("does not dispatch a request that was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiFetch("/api/v1/profiles", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(native.request).not.toHaveBeenCalled();
  });
  it("releases abort listeners and ignores late native results", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    let finish!: (value: unknown) => void;
    native.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const response = apiFetch("/api/v1/profiles", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    finish({ status: 200, headers: {}, data: { items: [] } });
  });
  it("rejects paths outside the application API before attaching credentials", async () => {
    await expect(apiFetch("https://other.example.com/")).rejects.toThrow();
    expect(native.request).not.toHaveBeenCalled();
  });
  it("transports screenshot bytes and capture date as native multipart", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result = "data:image/png;base64,iVBORw==";
        onload!: () => void;
        readAsDataURL() {
          this.onload();
        }
      },
    );
    native.request.mockResolvedValueOnce({
      status: 202,
      headers: {},
      data: { status: "queued" },
    });
    const body = new FormData();
    body.append(
      "image",
      new File([new Uint8Array([137, 80, 78, 71])], "bank.png", {
        type: "image/png",
      }),
    );
    body.append("capture_date", "2026-10-16");
    await apiFetch("/api/v1/profiles/example/imports", {
      method: "POST",
      body,
    });
    expect(native.request.mock.calls[0][0]).toMatchObject({
      dataType: "formData",
      headers: { "content-type": "multipart/form-data" },
      data: [
        {
          key: "image",
          type: "base64File",
          value: "iVBORw==",
          fileName: "bank.png",
          contentType: "image/png",
        },
        { key: "capture_date", type: "string", value: "2026-10-16" },
      ],
    });
  });
  it("exports CSV through the Android save dialog without losing Cyrillic", async () => {
    native.saveCsv.mockResolvedValueOnce({ saved: true });
    await saveCsv("fintrack.csv", new Blob(["Описание;Сумма\nКофе;100,50"]));
    expect(native.saveCsv).toHaveBeenCalledWith({
      name: "fintrack.csv",
      text: "Описание;Сумма\nКофе;100,50",
    });
  });
});
