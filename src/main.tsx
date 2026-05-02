import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./assets/shimmer.css";
import "./styles.css";
import AppIcon from "./assets/nfo/asterisk-logo.png";
import { logService } from "./lib/logService";
import { api } from "./lib/api";

// Initialize structured logging
logService.initialize();

// Check log count and warn if excessive
api.logCount().then((count) => {
  if (count > 5000) {
    console.warn(
      `You have ${count.toLocaleString()} log entries. Review and prune old records in Settings → Log.`
    );
  }
}).catch(() => {
  // Ignore — DB may not be ready yet
});

// Add a macOS-specific class to the <html> element to enable platform-specific styling.
(() => {
  const isMacLike = typeof navigator !== "undefined" &&
    (navigator.platform?.toLowerCase().includes("mac") ||
      navigator.userAgent?.toLowerCase().includes("mac os x"));
  if (isMacLike) {
    document.documentElement.classList.add("is-macos");
  }
})();

// Set favicon to the new app icon (avoids needing /public)
(() => {
  try {
    const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const link = existing ?? document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.href = AppIcon;
    if (!existing) {
      document.head.appendChild(link);
    }
  } catch (_) {
    // Non-fatal if document/head is not available
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
