import { describe, expect, it, vi } from "vitest";
import {
  gotoWithFallback,
  isNavigationTimeoutError,
  isRecoverableNavigationError,
} from "../src/browser/navigation.js";

describe("navigation fallback", () => {
  it("retries with domcontentloaded after networkidle timeout", async () => {
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error('page.goto: Timeout 60000ms exceeded. waiting until "networkidle"'))
      .mockResolvedValueOnce(null);
    const page = { goto } as unknown as Parameters<typeof gotoWithFallback>[0]["page"];
    const onFallback = vi.fn();

    const waitUntil = await gotoWithFallback({
      page,
      url: "https://example.com/pricing",
      waitUntil: "networkidle",
      timeoutMs: 60_000,
      phase: "capture",
      fallbackWaitUntil: "domcontentloaded",
      onFallback,
    });

    expect(waitUntil).toBe("domcontentloaded");
    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto.mock.calls[0][1]).toMatchObject({ waitUntil: "networkidle", timeout: 60_000 });
    expect(goto.mock.calls[1][1]).toMatchObject({ waitUntil: "domcontentloaded", timeout: 60_000 });
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "capture",
        url: "https://example.com/pricing",
        from: "networkidle",
        to: "domcontentloaded",
      }),
    );
  });

  it("does not fallback for non-timeout errors", async () => {
    const goto = vi.fn().mockRejectedValueOnce(new Error("net::ERR_ABORTED"));
    const page = { goto } as unknown as Parameters<typeof gotoWithFallback>[0]["page"];

    await expect(
      gotoWithFallback({
        page,
        url: "https://example.com/pricing",
        waitUntil: "networkidle",
        timeoutMs: 60_000,
        phase: "probe",
        fallbackWaitUntil: "domcontentloaded",
      }),
    ).rejects.toThrow("ERR_ABORTED");

    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("retries with domcontentloaded after recoverable connection errors", async () => {
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_CLOSED at https://example.com"))
      .mockResolvedValueOnce(null);
    const page = { goto } as unknown as Parameters<typeof gotoWithFallback>[0]["page"];

    const waitUntil = await gotoWithFallback({
      page,
      url: "https://example.com/blog",
      waitUntil: "networkidle",
      timeoutMs: 60_000,
      phase: "capture",
      fallbackWaitUntil: "domcontentloaded",
    });

    expect(waitUntil).toBe("domcontentloaded");
    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto.mock.calls[1][1]).toMatchObject({ waitUntil: "domcontentloaded", timeout: 60_000 });
  });

  it("identifies page.goto timeout errors", () => {
    expect(isNavigationTimeoutError(new Error("page.goto: Timeout 15000ms exceeded."))).toBe(true);
    expect(isNavigationTimeoutError(new Error("navigation timeout"))).toBe(true);
    expect(isNavigationTimeoutError(new Error("Target crashed"))).toBe(false);
  });

  it("identifies recoverable page.goto connection errors", () => {
    expect(isRecoverableNavigationError(new Error("page.goto: net::ERR_CONNECTION_CLOSED"))).toBe(
      true,
    );
    expect(isRecoverableNavigationError(new Error("page.goto: net::ERR_CONNECTION_RESET"))).toBe(
      true,
    );
    expect(
      isRecoverableNavigationError(new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR")),
    ).toBe(true);
    expect(isRecoverableNavigationError(new Error("page.goto: net::ERR_ABORTED"))).toBe(false);
  });
});
