import { Globe, Globe2 } from "lucide-react";
import { fireAndLog } from "@/lib/fireAndLog";
import type { AgentMessage } from "@/lib/api";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchFields {
  query: string;
  results: SearchResult[];
}

/**
 * Extract query + results list from an `item.web_search` notification.
 *
 * Wire shape (Codex):
 *   { method: "item.web_search", params: {
 *       query: string,
 *       results: Array<{ title?: string, url?: string, snippet?: string }>,
 *   } }
 *
 * Defensive: an empty/missing `results` array renders as an empty list
 * rather than throwing, so a malformed payload still produces a coherent
 * (if barren) card with the query visible.
 */
function extractSearch(payload: unknown): SearchFields {
  const empty: SearchFields = { query: "", results: [] };
  if (!payload || typeof payload !== "object") return empty;
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return empty;
  const p = params as { query?: unknown; results?: unknown };
  const query = typeof p.query === "string" ? p.query : "";
  const results: SearchResult[] = [];
  if (Array.isArray(p.results)) {
    for (const entry of p.results) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { title?: unknown; url?: unknown; snippet?: unknown };
      results.push({
        title: typeof e.title === "string" ? e.title : "",
        url: typeof e.url === "string" ? e.url : "",
        snippet: typeof e.snippet === "string" ? e.snippet : "",
      });
    }
  }
  return { query, results };
}

/**
 * Renders a Codex `item.web_search` notification as a query + result-list
 * card. Visually mirrors the Claude `WebSearchWidget` header — same Globe
 * icon, same muted "Web Search" tag — so cross-engine transcripts feel
 * consistent. Each result is a button that calls
 * `window.electronAPI.openExternal(url)` to open in the user's default
 * browser (the same path TerminalView's link addon uses).
 */
export function WebSearchItem({ message }: { message: AgentMessage }): JSX.Element {
  const { query, results } = extractSearch(message.payload);

  const openUrl = async (url: string): Promise<void> => {
    if (!url) return;
    await window.electronAPI.openExternal?.(url);
  };

  return (
    <div
      data-codex-item="item.web_search"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
        <Globe className="h-4 w-4 text-blue-500/70" />
        <span className="text-xs font-medium uppercase tracking-wider text-blue-600/70 dark:text-blue-400/70">
          Web Search
        </span>
        <span className="text-sm text-muted-foreground/80 flex-1 truncate">
          {query || <span className="italic">(no query)</span>}
        </span>
      </div>
      {results.length > 0 && (
        <div className="rounded-lg border bg-background/50 overflow-hidden">
          <div className="p-3 grid gap-1.5">
            {results.map((r, idx) => (
              <button
                key={idx}
                type="button"
                onClick={fireAndLog("codex-web-search:open", () => openUrl(r.url))}
                className="group flex flex-col gap-0.5 p-2.5 rounded-md border bg-card/30 hover:bg-card/50 hover:border-blue-500/30 transition-all text-left"
              >
                <div className="flex items-start gap-2">
                  <Globe2 className="h-3.5 w-3.5 text-blue-500/70 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium group-hover:text-blue-500 transition-colors line-clamp-2">
                      {r.title || r.url || "(untitled)"}
                    </div>
                    {r.url && (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {r.url}
                      </div>
                    )}
                    {r.snippet && (
                      <div className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">
                        {r.snippet}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
