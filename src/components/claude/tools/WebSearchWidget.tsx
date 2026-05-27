import React, { useState } from "react";
import {
  ChevronRight,
  AlertCircle,
  Globe,
  ChevronDown,
  Globe2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { extractResultContent } from "@/components/claude/tools/shared";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";

/**
 * Widget for WebSearch tool - displays web search query and results
 */
export const WebSearchWidget: React.FC<{
  query: string;
  result?: any;
}> = ({ query, result }) => {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());

  // Parse the result to extract all links sections and build a structured representation
  const parseSearchResult = (resultContent: string) => {
    const sections: {
      type: 'text' | 'links';
      content: string | { title: string; url: string }[];
    }[] = [];

    // Split by "Links: [" to find all link sections
    const parts = resultContent.split(/Links:\s*\[/);

    // First part is always text (or empty)
    if (parts[0]) {
      sections.push({ type: 'text', content: parts[0].trim() });
    }

    // Process each links section
    parts.slice(1).forEach(part => {
      try {
        // Find the closing bracket
        const closingIndex = part.indexOf(']');
        if (closingIndex === -1) return;

        const linksJson = '[' + part.substring(0, closingIndex + 1);
        const remainingText = part.substring(closingIndex + 1).trim();

        // Parse the JSON array
        const links = JSON.parse(linksJson);
        sections.push({ type: 'links', content: links });

        // Add any remaining text
        if (remainingText) {
          sections.push({ type: 'text', content: remainingText });
        }
      } catch {
        // If parsing fails, treat it as text
        sections.push({ type: 'text', content: 'Links: [' + part });
      }
    });

    return sections;
  };

  const toggleSection = (index: number) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedSections(newExpanded);
  };

  // Extract result content if available
  const searchResults: {
    sections: {
      type: 'text' | 'links';
      content: string | { title: string; url: string }[];
    }[];
    noResults: boolean;
  } = { sections: [], noResults: false };

  if (result) {
    const resultContent = extractResultContent(result);

    searchResults.noResults = resultContent.toLowerCase().includes('no links found') ||
                               resultContent.toLowerCase().includes('no results');
    searchResults.sections = parseSearchResult(resultContent);
  }

  const handleLinkClick = async (url: string) => {
    try {
      await window.electronAPI.openExternal(url);
    } catch (error) {
      console.error('Failed to open URL:', error);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Subtle Search Query Header */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
        <Globe className="h-4 w-4 text-blue-500/70" />
        <span className="text-xs font-medium uppercase tracking-wider text-blue-600/70 dark:text-blue-400/70">Web Search</span>
        <span className="text-sm text-muted-foreground/80 flex-1 truncate">{query}</span>
      </div>

      {/* Results */}
      {result && (
        <div className="rounded-lg border bg-background/50 backdrop-blur-sm overflow-hidden">
          {!searchResults.sections.length ? (
            <div className="px-3 py-2 flex items-center gap-2 text-muted-foreground">
              <div className="animate-pulse flex items-center gap-1">
                <div className="h-1 w-1 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                <div className="h-1 w-1 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                <div className="h-1 w-1 bg-blue-500 rounded-full animate-bounce"></div>
              </div>
              <span className="text-sm">Searching...</span>
            </div>
          ) : searchResults.noResults ? (
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm">No results found</span>
              </div>
            </div>
          ) : (
            <div className="p-3 space-y-3">
              {searchResults.sections.map((section, idx) => {
                if (section.type === 'text') {
                  return (
                    <div key={idx} className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown>{section.content as string}</ReactMarkdown>
                    </div>
                  );
                } else if (section.type === 'links' && Array.isArray(section.content)) {
                  const links = section.content;
                  const isExpanded = expandedSections.has(idx);

                  return (
                    <div key={idx} className="space-y-1.5">
                      {/* Toggle Button */}
                      <button
                        onClick={() => { toggleSection(idx); }}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <span>{links.length} result{links.length !== 1 ? 's' : ''}</span>
                      </button>

                      {/* Links Display */}
                      {isExpanded ? (
                        /* Expanded Card View */
                        <div className="grid gap-1.5 ml-4">
                          {links.map((link, linkIdx) => (
                            <button
                              key={linkIdx}
                              onClick={fireAndLog('web-search-widget:click', () => handleLinkClick(link.url))}
                              className="group flex flex-col gap-0.5 p-2.5 rounded-md border bg-card/30 hover:bg-card/50 hover:border-blue-500/30 transition-all text-left"
                            >
                              <div className="flex items-start gap-2">
                                <Globe2 className="h-3.5 w-3.5 text-blue-500/70 mt-0.5 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium group-hover:text-blue-500 transition-colors line-clamp-2">
                                    {link.title}
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                                    {link.url}
                                  </div>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        /* Collapsed Pills View */
                        <div className="flex flex-wrap gap-1.5 ml-4">
                          {links.map((link, linkIdx) => (
                            <button
                              key={linkIdx}
                              onClick={(e) => {
                                e.stopPropagation();
                                logAndForget('web-search-widget:handle-link-click', handleLinkClick(link.url));
                              }}
                              className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/5 hover:bg-blue-500/10 border border-blue-500/10 hover:border-blue-500/20 transition-all"
                            >
                              <Globe2 className="h-3 w-3 text-blue-500/70" />
                              <span className="truncate max-w-[180px] text-foreground/70 group-hover:text-foreground/90">
                                {link.title}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
