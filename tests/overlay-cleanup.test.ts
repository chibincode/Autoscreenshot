import { describe, expect, it } from "vitest";
import {
  classifyOverlaySnapshot,
  type OverlaySnapshot,
} from "../src/browser/overlay-cleanup.js";

function makeSnapshot(partial: Partial<OverlaySnapshot>): OverlaySnapshot {
  return {
    overlayId: "overlay-test",
    tagName: "DIV",
    role: null,
    ariaLabel: null,
    id: "",
    className: "",
    text: "",
    position: "fixed",
    width: 360,
    height: 180,
    viewportWidth: 1920,
    viewportHeight: 1080,
    acceptActionCount: 0,
    rejectActionCount: 0,
    closeActionCount: 0,
    confirmActionCount: 0,
    checkboxLikeControlCount: 0,
    hostSignalCount: 0,
    ...partial,
  };
}

describe("overlay cleanup classification", () => {
  it("classifies verified compact fixed chat launchers without lowering generic overlay thresholds", () => {
    const launcher = { width: 48, height: 48, chatLauncherCount: 1 };
    expect(classifyOverlaySnapshot(makeSnapshot(launcher))).toEqual({ type: "promo", vendor: "generic" });
    expect(classifyOverlaySnapshot(makeSnapshot({ ...launcher, position: "static" }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...launcher, width: 400 }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ width: 48, height: 48, className: "chat" }))).toBeNull();
  });

  it("classifies compact dismissible booking widgets even below the normal overlay width", () => {
    expect(classifyOverlaySnapshot(makeSnapshot({
      position: "sticky", width: 160, height: 156,
      bookingActionCount: 1, closeActionCount: 1,
    }))).toEqual({ type: "promo", vendor: "generic" });
  });

  it("classifies dismissible viewport-covering booking modals but preserves large page content", () => {
    const modal = { position: "fixed", width: 1920, height: 1080,
      bookingActionCount: 1, closeActionCount: 1, viewportModal: true };
    expect(classifyOverlaySnapshot(makeSnapshot(modal))).toEqual({ type: "promo", vendor: "generic" });
    expect(classifyOverlaySnapshot(makeSnapshot({ ...modal, viewportModal: false }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...modal, closeActionCount: 0 }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...modal, bookingActionCount: 0 }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...modal, position: "sticky" }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...modal, tagName: "HEADER" }))).toBeNull();
  });

  it("preserves inline booking cards, large sticky sections, and undismissible CTAs", () => {
    const booking = { bookingActionCount: 1, closeActionCount: 1, text: "Book a demo Choose a time" };
    expect(classifyOverlaySnapshot(makeSnapshot({ ...booking, position: "static" }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...booking, position: "sticky", width: 1200, height: 700 }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...booking, closeActionCount: 0 }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...booking, tagName: "NAV" }))).toBeNull();
    expect(classifyOverlaySnapshot(makeSnapshot({ ...booking, role: "navigation" }))).toBeNull();
  });

  it("classifies Osano cookie banners as consent overlays", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        role: "dialog",
        ariaLabel: "Cookie Consent Banner",
        className: "osano-cm-window__dialog osano-cm-dialog",
        text: "Accept cookies and manage your privacy preferences",
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "osano" });
  });

  it("classifies generic cookie banners as consent overlays", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        id: "cookie-banner",
        text: "This site uses cookies to improve your experience",
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "generic" });
  });

  it("classifies inline consent cards when they expose accept and reject controls", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        position: "static",
        width: 420,
        height: 220,
        text: "Cookie Settings We use cookies to personalize content and analyze traffic.",
        acceptActionCount: 1,
        rejectActionCount: 1,
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "generic" });
  });

  it("classifies confirm-only consent cards when they expose cookie preferences", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        position: "fixed",
        width: 520,
        height: 260,
        text: "What can we use data collected by cookies for? Essential Functional Analytics Advertising",
        confirmActionCount: 1,
        checkboxLikeControlCount: 5,
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "generic" });
  });

  it("classifies consent manager hosts even when they expose no readable text", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        id: "transcend-consent-manager",
        width: 0,
        height: 0,
        text: "",
        hostSignalCount: 2,
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "transcend" });
  });

  it("classifies compact CookieScript settings launchers as consent overlays", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        role: "dialog",
        ariaLabel: "Cookie consent button",
        id: "cookiescript_badge",
        text: "Cookie settings",
        width: 46,
        height: 46,
        hostSignalCount: 1,
      }),
    );

    expect(result).toEqual({ type: "consent", vendor: "cookiescript" });
  });

  it("classifies newsletter modals as promo overlays", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        role: "dialog",
        className: "newsletter-modal popup",
        text: "Subscribe to our newsletter for special offers",
      }),
    );

    expect(result).toEqual({ type: "promo", vendor: "generic" });
  });

  it("does not classify normal in-flow content with cookie policy links", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        position: "static",
        width: 920,
        height: 420,
        className: "legal-footer",
        text: "Read our cookie policy and privacy terms",
      }),
    );

    expect(result).toBeNull();
  });

  it("does not classify generic settings forms that are not consent overlays", () => {
    const result = classifyOverlaySnapshot(
      makeSnapshot({
        position: "static",
        width: 620,
        height: 380,
        className: "settings-form",
        text: "Notification preferences Choose which account alerts you want to receive.",
        confirmActionCount: 1,
        checkboxLikeControlCount: 4,
      }),
    );

    expect(result).toBeNull();
  });
});
