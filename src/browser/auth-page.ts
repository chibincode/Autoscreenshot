import type { Page } from "playwright";
import type { AuthPageIntent } from "../types.js";
import { inferAuthPageIntent, isAuthEntryPath } from "../core/auth-page.js";

export async function readAuthPageIntent(page: Page, sourceUrl: string): Promise<AuthPageIntent | undefined> {
  if (!isAuthEntryPath(new URL(sourceUrl).pathname)) return undefined;
  try {
    const signals = await page.evaluate(() => {
      const root = document.querySelector("main, [role='main']") ?? document.body;
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return element.getClientRects().length > 0 && style.visibility !== "hidden" &&
          style.display !== "none" && !element.closest("nav, header, footer, [hidden], [aria-hidden='true']");
      };
      const label = (element: Element) => (element instanceof HTMLElement ? element.innerText : element.textContent ?? "").slice(0, 300);
      const headings = Array.from(root.querySelectorAll("h1, h2, h3, [role='heading']")).filter(visible).map(label);
      const actions = Array.from(root.querySelectorAll("button, input[type='submit']"))
        .filter(visible).map(element => element instanceof HTMLInputElement ? element.value : label(element));
      const text = Array.from(root.querySelectorAll("h1, h2, h3, p, form, [role='form']"))
        .filter(visible).map(label).join(" ").slice(0, 6000);
      return { pageTitle: document.title, headings, actions, text };
    });
    return inferAuthPageIntent(signals);
  } catch {
    // Classification must not make an otherwise valid screenshot fail.
    return undefined;
  }
}
