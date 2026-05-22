import { describe, expect, it } from "vitest";
import {
  buildFeedbackContext,
  buildAssetLookupIndex,
  buildJobStatusHint,
  canFocusDebugAsset,
  findAssetForRoute,
  findAssetForRouteFromIndex,
  formatPendingImportLabel,
  getCoreRoutePreviewState,
} from "../web/src/asset-feedback.js";

const thumbnailFields = {
  thumbnailUrl: "/api/assets/thumbnail",
  thumbnailWidth: 360,
  thumbnailHeight: 225,
};

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
          selectedForImport: true,
          importStatus: "imported",
          importOk: true,
          importError: null,
          eagleId: "abc",
          previewUrl: "/api/assets/1/file",
          ...thumbnailFields,
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
          selectedForImport: true,
          importStatus: "imported",
          importOk: true,
          importError: null,
          eagleId: "def",
          previewUrl: "/api/assets/2/file",
          ...thumbnailFields,
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

  it("builds a reusable asset lookup index for repeated route matching", () => {
    const assets = [
      {
        id: 11,
        kind: "section" as const,
        sectionType: "hero",
        label: "hero",
        fileName: "hero.jpg",
        quality: 92,
        dpr: 2,
        capturedAt: "2026-03-07T10:00:00.000Z",
        selectedForImport: true,
        importStatus: "pending_confirmation" as const,
        importOk: false,
        importError: null,
        eagleId: null,
        previewUrl: "/api/assets/11/file",
        thumbnailUrl: "/api/assets/11/thumbnail?w=360&q=42",
        thumbnailWidth: 360,
        thumbnailHeight: 225,
        sourceUrl: "https://example.com/pricing",
      },
      {
        id: 12,
        kind: "fullPage" as const,
        sectionType: null,
        label: "full_page",
        fileName: "pricing.jpg",
        quality: 92,
        dpr: 2,
        capturedAt: "2026-03-07T10:01:00.000Z",
        selectedForImport: true,
        importStatus: "imported" as const,
        importOk: true,
        importError: null,
        eagleId: "def",
        previewUrl: "/api/assets/12/file",
        thumbnailUrl: "/api/assets/12/thumbnail?w=360&q=42",
        thumbnailWidth: 360,
        thumbnailHeight: 225,
        sourceUrl: "https://example.com/pricing",
      },
    ];

    const index = buildAssetLookupIndex(assets);
    const matched = findAssetForRouteFromIndex({ url: "https://example.com/pricing" }, index);

    expect(index.assetById.get(11)?.label).toBe("hero");
    expect(index.assetsBySourceUrl.get("https://example.com/pricing")?.length).toBe(2);
    expect(matched?.id).toBe(12);
  });

  it("only allows explicit debug focus for section assets with sectionDebug", () => {
    expect(canFocusDebugAsset({ kind: "section", sectionType: "hero" }, true)).toBe(true);
    expect(canFocusDebugAsset({ kind: "fullPage", sectionType: null }, true)).toBe(false);
    expect(canFocusDebugAsset({ kind: "section", sectionType: "unknown" }, true)).toBe(false);
    expect(canFocusDebugAsset({ kind: "section", sectionType: "hero" }, false)).toBe(false);
  });

  it("describes pending imports as preselected instead of already imported", () => {
    expect(formatPendingImportLabel(true)).toBe("Selected, pending import");
    expect(formatPendingImportLabel(false)).toBe("Not selected for import");
  });

  it("explains that core-routes Needs review is about route execution, not Eagle import", () => {
    expect(
      buildJobStatusHint({
        id: "job_123",
        mode: "core-routes",
        status: "partial_success",
      }),
    ).toContain("does not mean Eagle import has already happened");
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
        selectedForImport: true,
        importStatus: "failed",
        importOk: false,
        importError: "upload failed",
        eagleId: null,
        previewUrl: "/api/assets/22/file",
        ...thumbnailFields,
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
    expect(context).toContain("job_status_hint=For core-routes jobs, Needs review means route capture completed with one or more failed or skipped routes. It does not mean Eagle import has already happened.");
    expect(context).toContain("asset_id=22");
    expect(context).toContain("asset_preview_url=http://127.0.0.1:5173/api/assets/22/file");
    expect(context).toContain("asset_selected_for_import=yes");
    expect(context).toContain("asset_import_display=Selected, pending import");
    expect(context).toContain("asset_import_started=yes");
    expect(context).toContain("asset_import_status=failed");
    expect(context).toContain("route_path=/pricing");
    expect(context).toContain("route_error=timeout");
    expect(context).toContain("User feedback:");
  });
});
