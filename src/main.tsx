import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./assets/shimmer.css";
import "./styles.css";
import AppIcon from "../icons/icon.png";
import { logService } from "./lib/logService";
import { api } from "./lib/api";
import { logAndForget } from "@/lib/fireAndLog";
import { installRenderProfilerConsole } from "@/lib/renderProfilerConsole";
import { parsePrintHash } from "@/lib/costReportPrint";
import { CostReportPrintPage } from "@/components/cost-report/CostReportPrintPage";

// Initialize structured logging
logAndForget('main:initialize', logService.initialize());

// Render profiler — off unless explicitly enabled, including in packaged
// builds. `__omnifexProfile.on()` in the devtools console, then reload.
installRenderProfilerConsole(window as unknown as Record<string, unknown>);

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
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- navigator.userAgentData is not yet universally available; navigator.platform is the reliable cross-browser fallback.
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

// The PDF export boots a hidden second window into this same bundle, marked by
// a `#print=cost-report&…` hash. That window renders the report alone — no
// titlebar, no tabs, no scroll box — because the app shell is what makes the
// live document exactly one window tall. See electron/services/cost-report-pdf.ts.
const printFilters = parsePrintHash(window.location.hash);

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- document.getElementById("root") asserted at app entry.
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (printFilters) {
  // No StrictMode here: it double-invokes effects, and this window's whole job
  // is to fire one "I have drawn, here is my size" report to the main process.
  root.render(
    <ErrorBoundary>
      <CostReportPrintPage
        filters={printFilters}
        onReady={(m) => { logAndForget('cost-report:print-ready', api.costReportPrintReady(m)); }}
      />
    </ErrorBoundary>,
  );
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
