import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createEndpoint, copyTextWithFeedback, fetchEndpointRequests } from "./utils";

describe("createEndpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates endpoint with trimmed name and returns secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "ep_123", secret: "sec_abc" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEndpoint("  My Endpoint  ");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/endpoints"), expect.objectContaining({
      method: "POST",
    }));
    expect(result.endpoint.id).toBe("ep_123");
    expect(result.endpoint.name).toBe("My Endpoint");
    expect(result.secret).toBe("sec_abc");
  });

  it("falls back to Untitled and empty secret when missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "ep_untitled" }),
    }));

    const result = await createEndpoint("   ");

    expect(result.endpoint.name).toBe("Untitled");
    expect(result.secret).toBe("");
  });

  it("throws when endpoint response is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ secret: "sec_no_id" }),
    }));

    await expect(createEndpoint("bad")).rejects.toThrow("Invalid endpoint response");
  });
});

describe("copyTextWithFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sets copied true immediately and false after delay", async () => {
    const setCopied = vi.fn();

    await copyTextWithFeedback("https://example.com", setCopied, 2000);
    expect(setCopied).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(2000);
    expect(setCopied).toHaveBeenCalledWith(false);
  });
});

describe("fetchEndpointRequests", () => {
  it("surfaces API response body when loading fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Endpoint not found"),
    }));

    await expect(fetchEndpointRequests("missing")).rejects.toThrow("Endpoint not found");
  });
});
