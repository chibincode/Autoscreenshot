import type { AuthPageIntent } from "../types.js";
import { normalizePathname, stripLocalePrefix } from "./url-normalization.js";

const LOGIN = /\b(?:log[\s-]?in|sign[\s-]?in|welcome back)\b|\u767b\u5f55|\u767b\u5165/i;
const SIGNUP = /\b(?:sign[\s-]?up|register|registration|create\s+(?:(?:your|an?|a new)\s+)?account)\b|\u6ce8\u518c|\u521b\u5efa(?:\u65b0)?(?:\u8d26\u53f7|\u8d26\u6237)/i;
const COMBINED = /\b(?:sign[\s-]?in|log[\s-]?in)\s*(?:or|\/|and)\s*(?:sign[\s-]?up|register|create\s+(?:(?:your|an?|a new)\s+)?account)\b|\b(?:sign[\s-]?up|register)\s*(?:or|\/)\s*(?:sign[\s-]?in|log[\s-]?in)\b|\u767b\u5f55(?:\u6216|\/|\u5373)\u6ce8\u518c/i;

export function isAuthEntryPath(pathname: string): boolean {
  const normalized = stripLocalePrefix(normalizePathname(pathname));
  return /^\/(?:auth|authenticate|authentication)(?:\/(?:login|log-in|signin|sign-in|signup|sign-up|register))?$/i.test(normalized);
}

export function inferAuthPageIntent(signals: {
  pageTitle?: string | null;
  headings?: string[];
  actions?: string[];
  text?: string;
}): AuthPageIntent | undefined {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (COMBINED.test(normalize(signals.text ?? ""))) {
    return "combined";
  }
  // Form headings outrank provider buttons and secondary sign-in/sign-up links.
  for (const group of [signals.headings ?? [], signals.actions ?? [], [signals.pageTitle ?? ""]]) {
    const labels = group.map(normalize);
    if (labels.some(label => COMBINED.test(label))) return "combined";
    const login = labels.some(label => LOGIN.test(label));
    const signup = labels.some(label => SIGNUP.test(label));
    if (login && signup) return undefined;
    if (signup) return "signup";
    if (login) return "login";
  }
  return undefined;
}
