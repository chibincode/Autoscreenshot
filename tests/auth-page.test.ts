import { describe, expect, it } from "vitest";
import { inferAuthPageIntent, isAuthEntryPath } from "../src/core/auth-page.js";

describe("auth page evidence", () => {
  it.each(["/auth", "/en/auth/", "/authentication", "/auth/sign-in", "/auth/signup"])("recognizes the entry path %s", pathname => {
    expect(isAuthEntryPath(pathname)).toBe(true);
  });
  it.each(["/", "/account", "/docs/auth", "/api/auth", "/auth/callback", "/auth/reset-password", "/blog/auth"])("does not guess from %s", pathname => {
    expect(isAuthEntryPath(pathname)).toBe(false);
  });
  it("recognizes CoTrain's combined entry without relying on its brand title", () => {
    expect(inferAuthPageIntent({ pageTitle: "CoTrain | Hire vetted experts", headings: ["One place to Train"],
      actions: ["Continue with Google", "Continue"], text: "Sign in or create your account" })).toBe("combined");
  });
  it("does not mistake an alternate signup link for the active login form", () => {
    expect(inferAuthPageIntent({ headings: ["Welcome back"], actions: ["Sign in"],
      text: "Don't have an account? Create an account" })).toBe("login");
  });
  it("prefers the signup heading over social-provider sign-in button labels", () => {
    expect(inferAuthPageIntent({ headings: ["Create your account"], actions: ["Sign in with Google", "Continue"],
      text: "Already have an account? Sign in" })).toBe("signup");
  });
  it("supports localized form headings", () => {
    expect(inferAuthPageIntent({ headings: ["\u6ce8\u518c\u8d26\u53f7"] })).toBe("signup");
    expect(inferAuthPageIntent({ headings: ["\u767b\u5f55"] })).toBe("login");
    expect(inferAuthPageIntent({ text: "\u767b\u5f55\u6216\u6ce8\u518c" })).toBe("combined");
  });
  it("uses a clear title for old screenshots and leaves ambiguous evidence unknown", () => {
    expect(inferAuthPageIntent({ pageTitle: "Sign in | Example" })).toBe("login");
    expect(inferAuthPageIntent({ pageTitle: "Example", actions: ["Continue with Google", "Continue"] })).toBeUndefined();
    expect(inferAuthPageIntent({ headings: ["Sign in", "Sign up"] })).toBeUndefined();
  });
});
