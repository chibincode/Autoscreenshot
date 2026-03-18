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
    ...partial,
  };
}

describe("overlay cleanup classification", () => {
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
});
