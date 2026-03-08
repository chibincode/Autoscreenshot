import type { Page } from "playwright";
import type { WaitUntilState } from "../types.js";

export interface NavigationFallbackEvent {
  phase: string;
  url: string;
  from: WaitUntilState;
  to: WaitUntilState;
  errorMessage: string;
}

export interface GotoWithFallbackOptions {
  page: Page;
  url: string;
  waitUntil: WaitUntilState;
  timeoutMs: number;
  phase: string;
  fallbackWaitUntil?: WaitUntilState;
  onFallback?: (event: NavigationFallbackEvent) => void;
}

export function isNavigationTimeoutError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error ?? "");
  return /Timeout \d+ms exceeded|timeout/i.test(message);
}

export async function gotoWithFallback(options: GotoWithFallbackOptions): Promise<WaitUntilState> {
  const { page, url, waitUntil, timeoutMs, phase, fallbackWaitUntil, onFallback } = options;

  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    return waitUntil;
  } catch (error) {
    if (
      waitUntil !== "networkidle" ||
      !fallbackWaitUntil ||
      fallbackWaitUntil === waitUntil ||
      !isNavigationTimeoutError(error)
    ) {
      throw error;
    }

    onFallback?.({
      phase,
      url,
      from: waitUntil,
      to: fallbackWaitUntil,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    await page.goto(url, { waitUntil: fallbackWaitUntil, timeout: timeoutMs });
    return fallbackWaitUntil;
  }
}
