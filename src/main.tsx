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
import { installRemoteBridge } from "@/lib/remote/bootstrap";
import { installStallWatchdog } from "@/lib/stallWatchdog";

// Everything below talks to `window.electronAPI`: install the shim first.
void installRemoteBridge()
  .catch((err: unknown) => { console.warn('[remote] bootstrap failed', err); })
  .then(() => { boot(); });

function boot(): void {
logAndForget('main:initialize', logService.initialize());

installRenderProfilerConsole(window as unknown as Record<string, unknown>);

installStallWatchdog();

api.logCount().then((count) => {
  if (count > 5000) {
    console.warn(
      `You have ${count.toLocaleString()} log entries. Review and prune old records in Settings → Log.`
    );
  }
}).catch(() => {
  // Ignore — DB may not be ready yet
});

(() => {
  const isMacLike = typeof navigator !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- navigator.userAgentData is not yet universally available; navigator.platform is the reliable cross-browser fallback.
    (navigator.platform?.toLowerCase().includes("mac") ||
      navigator.userAgent?.toLowerCase().includes("mac os x"));
  if (isMacLike) {
    document.documentElement.classList.add("is-macos");
  }
})();

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

// The PDF export's hidden window renders the report without the app shell, which clips the document to one window tall.
const printFilters = parsePrintHash(window.location.hash);

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- document.getElementById("root") asserted at app entry.
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (printFilters) {
  // No StrictMode: double-invoked effects would send the one size report twice.
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
}
