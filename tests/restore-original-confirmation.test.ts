import { describe, expect, it, vi } from "vitest";
import { buildRestoreOriginalConfirmation } from "../web/src/restore-original-confirmation.js";

describe("restore original confirmation", () => {
  it("does not restore until the user confirms", async () => {
    const restoreOriginal = vi.fn(async () => true);
    const confirmation = buildRestoreOriginalConfirmation(1312, restoreOriginal);

    expect(restoreOriginal).not.toHaveBeenCalled();
    expect(confirmation).toMatchObject({
      title: "恢复这张图片的原图？",
      confirmLabel: "恢复原图",
      cancelLabel: "保留裁切",
      tone: "danger",
    });

    await confirmation.onConfirm();

    expect(restoreOriginal).toHaveBeenCalledOnce();
    expect(restoreOriginal).toHaveBeenCalledWith(1312);
  });
});
