const DEFAULT_SERVICE_BASE_URL = "http://127.0.0.1:8787";
const STORAGE_KEY = "serviceBaseUrl";

declare const chrome: {
  storage?: {
    sync?: {
      get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, callback?: () => void) => void;
    };
  };
};

export async function readServiceBaseUrl(): Promise<string> {
  if (!chrome.storage?.sync) {
    return DEFAULT_SERVICE_BASE_URL;
  }

  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY], (items) => {
      const value = items[STORAGE_KEY];
      resolve(typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SERVICE_BASE_URL);
    });
  });
}

export async function writeServiceBaseUrl(serviceBaseUrl: string): Promise<void> {
  if (!chrome.storage?.sync) {
    return;
  }

  await new Promise<void>((resolve) => {
    chrome.storage.sync?.set({ [STORAGE_KEY]: serviceBaseUrl.trim() || DEFAULT_SERVICE_BASE_URL }, resolve);
  });
}

export { DEFAULT_SERVICE_BASE_URL };
