declare const chrome: {
  runtime: {
    onInstalled: {
      addListener: (listener: () => void) => void;
    };
  };
};

chrome.runtime.onInstalled.addListener(() => {
  // Keep the background worker alive for future extension-side features.
});
