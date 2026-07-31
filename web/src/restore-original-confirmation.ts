export interface RestoreOriginalConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "danger";
  onConfirm: () => Promise<void>;
}

export function buildRestoreOriginalConfirmation(
  assetId: number,
  restoreOriginal: (assetId: number) => Promise<unknown>,
): RestoreOriginalConfirmation {
  return {
    title: "恢复这张图片的原图？",
    description:
      "当前裁切结果会被原图替换，刚才的裁切位置无法自动恢复；如有需要，你之后仍可重新裁切。",
    confirmLabel: "恢复原图",
    cancelLabel: "保留裁切",
    tone: "danger",
    onConfirm: async () => {
      await restoreOriginal(assetId);
    },
  };
}
