import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedTask } from "../src/types.js";

const {
  gotoMock,
  addStyleTagMock,
  evaluateMock,
  waitForTimeoutMock,
  titleMock,
  closeContextMock,
  closeBrowserMock,
  newPageMock,
  newContextMock,
  launchMock,
  cleanupCaptureOverlaysMock,
} = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  addStyleTagMock: vi.fn(),
  evaluateMock: vi.fn(),
  waitForTimeoutMock: vi.fn(),
  titleMock: vi.fn(),
  closeContextMock: vi.fn(),
  closeBrowserMock: vi.fn(),
  newPageMock: vi.fn(),
  newContextMock: vi.fn(),
  launchMock: vi.fn(),
  cleanupCaptureOverlaysMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock,
  },
}));

vi.mock("../src/browser/overlay-cleanup.js", () => ({
  cleanupCaptureOverlays: cleanupCaptureOverlaysMock,
}));

import { captureTask } from "../src/browser/capture.js";

const task: ParsedTask = {
  url: "https://example.com",
  waitUntil: "networkidle",
  captures: [],
  image: {
    format: "jpg",
    quality: 92,
    dpr: 2,
  },
  viewport: {
    width: 1920,
    height: 1080,
  },
  tags: [],
  eagle: {},
};

describe("captureTask recoverable navigation retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const page = {
      goto: gotoMock,
      addStyleTag: addStyleTagMock,
      evaluate: evaluateMock,
      waitForTimeout: waitForTimeoutMock,
      title: titleMock,
    };
    const context = {
      newPage: newPageMock.mockResolvedValue(page),
      close: closeContextMock.mockResolvedValue(undefined),
    };
    const browser = {
      newContext: newContextMock.mockResolvedValue(context),
      close: closeBrowserMock.mockResolvedValue(undefined),
    };

    launchMock.mockResolvedValue(browser);
    cleanupCaptureOverlaysMock.mockResolvedValue(undefined);
    addStyleTagMock.mockResolvedValue({
      evaluate: vi.fn().mockResolvedValue(undefined),
    });
    waitForTimeoutMock.mockResolvedValue(undefined);
    titleMock.mockResolvedValue("Example");
    evaluateMock.mockImplementation(async (fn: unknown) => {
      const source = String(fn);
      if (source.includes("document.documentElement.scrollHeight || 0")) {
        return 0;
      }
      if (source.includes("body?.scrollWidth") && source.includes("body?.scrollHeight")) {
        return { width: 1280, height: 2400 };
      }
      if (source.includes("__autosnapBackgroundImageReady")) {
        return { total: 0, loaded: 0, failed: 0, timedOut: 0 };
      }
      if (source.includes("document.getAnimations")) {
        return {
          animationsFound: 0,
          animationsFinished: 0,
          animationsPaused: 0,
          mediaFound: 0,
          mediaPaused: 0,
          videoFramesSeeked: 0,
        };
      }
      return undefined;
    });
  });

  it("retries capture once in a fresh browser session after recoverable navigation failure", async () => {
    gotoMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_CLOSED at https://example.com"))
      .mockResolvedValueOnce(null);
    const onRecoverableNavigationRetry = vi.fn();

    const result = await captureTask(task, {
      outputDir: "/tmp/autoscreenshot-test",
      sectionScope: "classic",
      classicMaxSections: 10,
      onRecoverableNavigationRetry,
    });

    expect(result.assets).toEqual([]);
    expect(result.fallbackToDpr1).toBe(false);
    expect(launchMock).toHaveBeenCalledTimes(3);
    expect(gotoMock).toHaveBeenCalledTimes(3);
    expect(onRecoverableNavigationRetry).toHaveBeenCalledWith({
      url: "https://example.com",
      reason: "page.goto: net::ERR_CONNECTION_CLOSED at https://example.com",
    });
  });

  it("stops after one fresh-session retry when the recoverable navigation failure persists", async () => {
    gotoMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_CLOSED at https://example.com"))
      .mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_CLOSED at https://example.com"));

    await expect(
      captureTask(task, {
        outputDir: "/tmp/autoscreenshot-test",
        sectionScope: "classic",
        classicMaxSections: 10,
      }),
    ).rejects.toThrow("ERR_CONNECTION_CLOSED");

    expect(launchMock).toHaveBeenCalledTimes(3);
    expect(gotoMock).toHaveBeenCalledTimes(3);
  });
});
