import { describe, expect, it } from "vitest";
import {
  buildFeedbackContext,
  canFocusDebugAsset,
  findAssetForRoute,
  getCoreRoutePreviewState,
} from "../web/src/asset-feedback.js";

describe("asset feedback ui helpers", () => {
  it("matches a core route to its full-page asset by sourceUrl", () => {
    const matched = findAssetForRoute(
      { url: "https://example.com/pricing" },
      [
        {
          id: 1,
          kind: "section",
          sectionType: "hero",
          label: "hero",
          fileName: "hero.jpg",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-03-07T10:00:00.000Z",
          importOk: true,
          importError: null,
          eagleId: "abc",
          previewUrl: "/api/assets/1/file",
          sourceUrl: "https://example.com/pricing",
        },
        {
          id: 2,
          kind: "fullPage",
          sectionType: null,
          label: "full_page",
          fileName: "pricing.jpg",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-03-07T10:01:00.000Z",
          importOk: true,
          importError: null,
          eagleId: "def",
          previewUrl: "/api/assets/2/file",
          sourceUrl: "https://example.com/pricing",
        },
      ],
    );

    expect(matched?.id).toBe(2);
  });

  it("reports pending, failed, and empty preview states", () => {
    expect(getCoreRoutePreviewState("queued", null)).toBe("pending");
    expect(getCoreRoutePreviewState("running", null)).toBe("pending");
    expect(getCoreRoutePreviewState("failed", null)).toBe("failed");
    expect(getCoreRoutePreviewState("success", null)).toBe("empty");
  });

  it("only allows explicit debug focus for section assets with sectionDebug", () => {
    expect(canFocusDebugAsset({ kind: "section", sectionType: "hero" }, true)).toBe(true);
    expect(canFocusDebugAsset({ kind: "fullPage", sectionType: null }, true)).toBe(false);
    expect(canFocusDebugAsset({ kind: "section", sectionType: "unknown" }, true)).toBe(false);
    expect(canFocusDebugAsset({ kind: "section", sectionType: "hero" }, false)).toBe(false);
  });

  it("builds a copyable feedback payload with route and asset context", () => {
    const context = buildFeedbackContext({
      job: {
        id: "job_123",
        mode: "core-routes",
        status: "partial_success",
      },
      asset: {
        id: 22,
        kind: "fullPage",
        sectionType: null,
        label: "full_page",
        fileName: "pricing.jpg",
        quality: 92,
        dpr: 2,
        capturedAt: "2026-03-07T10:01:00.000Z",
        importOk: false,
        importError: "upload failed",
        eagleId: null,
        previewUrl: "/api/assets/22/file",
        sourceUrl: "https://example.com/pricing",
      },
      assetUrl: "http://127.0.0.1:5173/api/assets/22/file",
      route: {
        id: 4,
        path: "/pricing",
        url: "https://example.com/pricing",
        status: "failed",
        error: "timeout",
        attemptCount: 2,
        assetCount: 0,
      },
    });

    expect(context).toContain("job_id=job_123");
    expect(context).toContain("job_mode=core-routes");
    expect(context).toContain("asset_id=22");
    expect(context).toContain("asset_preview_url=http://127.0.0.1:5173/api/assets/22/file");
    expect(context).toContain("route_path=/pricing");
    expect(context).toContain("route_error=timeout");
    expect(context).toContain("User feedback:");
  });
});
