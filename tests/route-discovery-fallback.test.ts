import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  gotoMock,
  evaluateMock,
  closePageMock,
  closeContextMock,
  closeBrowserMock,
  newPageMock,
  newContextMock,
  launchMock,
  requestHeadMock,
  requestGetMock,
} =
  vi.hoisted(() => {
    const gotoMock = vi.fn();
    const evaluateMock = vi.fn();
    const closePageMock = vi.fn();
    const closeContextMock = vi.fn();
    const closeBrowserMock = vi.fn();
    const newPageMock = vi.fn();
    const newContextMock = vi.fn();
    const launchMock = vi.fn();
    const requestHeadMock = vi.fn();
    const requestGetMock = vi.fn();

    return {
      gotoMock,
      evaluateMock,
      closePageMock,
      closeContextMock,
      closeBrowserMock,
      newPageMock,
      newContextMock,
      launchMock,
      requestHeadMock,
      requestGetMock,
    };
  });

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock,
  },
}));

import { discoverCoreRoutes } from "../src/core/route-discovery.js";

describe("route discovery navigation fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const page = {
      goto: gotoMock,
      evaluate: evaluateMock,
      close: closePageMock,
    };
    const context = {
      newPage: newPageMock.mockResolvedValue(page),
      request: {
        head: requestHeadMock,
        get: requestGetMock,
      },
      close: closeContextMock.mockResolvedValue(undefined),
    };
    const browser = {
      newContext: newContextMock.mockResolvedValue(context),
      close: closeBrowserMock.mockResolvedValue(undefined),
    };

    launchMock.mockResolvedValue(browser);
    gotoMock
      .mockRejectedValueOnce(new Error('page.goto: Timeout 75000ms exceeded. waiting until "networkidle"'))
      .mockResolvedValueOnce(null);
    requestHeadMock.mockReset();
    requestGetMock.mockReset();
    evaluateMock.mockResolvedValue([
      {
        href: "https://example.com/pricing",
        title: "Pricing",
        source: "nav",
        depth: 0,
      },
      {
        href: "https://example.com/blog/post-1",
        title: "Post",
        source: "link",
        depth: 1,
      },
    ]);
  });

  it("falls back to domcontentloaded when discovery navigation times out on networkidle", async () => {
    const onNavigationFallback = vi.fn();

    const result = await discoverCoreRoutes({
      entryUrl: "https://example.com/",
      maxRoutes: 5,
      waitUntil: "networkidle",
      onNavigationFallback,
    });

    expect(gotoMock).toHaveBeenCalledTimes(2);
    expect(gotoMock.mock.calls[0][1]).toMatchObject({ waitUntil: "networkidle", timeout: 75_000 });
    expect(gotoMock.mock.calls[1][1]).toMatchObject({ waitUntil: "domcontentloaded", timeout: 75_000 });
    expect(onNavigationFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "discovery",
        from: "networkidle",
        to: "domcontentloaded",
        url: "https://example.com/",
      }),
    );
    expect(result.routes.map((route) => route.path)).toEqual(["/", "/pricing", "/blog/post-1"]);
    expect(requestHeadMock).not.toHaveBeenCalled();
  });

  it("keeps same-domain query links and resolves brand redirectors into core routes", async () => {
    evaluateMock.mockResolvedValue([
      {
        href: "https://example.com/pricing?plan=pro",
        title: "Pricing",
        source: "nav",
        depth: 0,
      },
      {
        href: "https://example.io/redirect?n=about-us",
        title: "About",
        source: "nav",
        depth: 0,
      },
      {
        href: "https://github.com/example/project",
        title: "GitHub",
        source: "nav",
        depth: 0,
      },
    ]);
    requestHeadMock.mockResolvedValueOnce({
      url: () => "https://example.com/about-us?campaign=brand",
    });

    const onRedirectResolved = vi.fn();

    const result = await discoverCoreRoutes({
      entryUrl: "https://example.com/",
      maxRoutes: 5,
      waitUntil: "networkidle",
      onRedirectResolved,
    });

    expect(result.routes.map((route) => route.path)).toEqual(["/", "/pricing", "/about-us"]);
    expect(requestHeadMock).toHaveBeenCalledTimes(1);
    expect(requestHeadMock).toHaveBeenCalledWith("https://example.io/redirect?n=about-us", {
      failOnStatusCode: false,
      maxRedirects: 10,
      timeout: 10_000,
    });
    expect(requestGetMock).not.toHaveBeenCalled();
    expect(onRedirectResolved).toHaveBeenCalledWith({
      from: "https://example.io/redirect?n=about-us",
      to: "https://example.com/about-us",
    });
  });
});
