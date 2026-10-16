export type InterfaceVersion = "classic" | "new";

export const INTERFACE_VERSION_STORAGE_KEY = "autoscreenshot.interfaceVersion.v1";

export function readInterfaceVersion(storage: Pick<Storage, "getItem">): InterfaceVersion {
  try {
    return storage.getItem(INTERFACE_VERSION_STORAGE_KEY) === "new" ? "new" : "classic";
  } catch {
    return "classic";
  }
}

export function rememberInterfaceVersion(storage: Pick<Storage, "setItem">, version: InterfaceVersion): void {
  try {
    storage.setItem(INTERFACE_VERSION_STORAGE_KEY, version);
  } catch {
    // The current session can still switch when browser storage is unavailable.
  }
}

export function siteLabel(sourceUrl: string | null): string {
  try {
    return new URL(sourceUrl ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "Screenshot task";
  }
}

export function shortTaskDate(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
