import React, { useState } from "react";
import {
  FileText,
  ChevronRight,
  Info,
  AlertCircle,
  Globe,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { extractResultContent } from "@/components/tools/shared";

/**
 * Widget for WebFetch tool - displays URL fetching with optional prompts
 */
export const WebFetchWidget: React.FC<{
  url: string;
  prompt?: string;
  result?: any;
}> = ({ url, prompt, result }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);

  // Extract result content if available
  let fetchedContent = '';
  let isLoading = !result;
  let hasError = false;

  if (result) {
    fetchedContent = extractResultContent(result);

    // Check if there's an error
    hasError = result.is_error ||
               fetchedContent.toLowerCase().includes('error') ||
               fetchedContent.toLowerCase().includes('failed');
  }

  // Truncate content for preview
  const maxPreviewLength = 500;
  const isTruncated = fetchedContent.length > maxPreviewLength;
  const previewContent = isTruncated && !showFullContent
    ? fetchedContent.substring(0, maxPreviewLength) + '...'
    : fetchedContent;

  // Extract domain from URL for display
  const getDomain = (urlString: string) => {
    try {
      const urlObj = new URL(urlString);
      return urlObj.hostname;
    } catch {
      return urlString;
    }
  };

  const handleUrlClick = async () => {
    try {
      await window.electronAPI.openExternal(url);
    } catch (error) {
      console.error('Failed to open URL:', error);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Header with URL and optional prompt */}
      <div className="space-y-2">
        {/* URL Display */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/5 border border-purple-500/10">
          <Globe className="h-4 w-4 text-purple-500/70" />
          <span className="text-xs font-medium uppercase tracking-wider text-purple-600/70 dark:text-purple-400/70">Fetching</span>
          <button
            onClick={handleUrlClick}
            className="text-sm text-foreground/80 hover:text-foreground flex-1 truncate text-left hover:underline decoration-purple-500/50"
          >
            {url}
          </button>
        </div>

        {/* Prompt Display */}
        {prompt && (
          <div className="ml-6 space-y-1">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")} />
              <Info className="h-3 w-3" />
              <span>Analysis Prompt</span>
            </button>

            {isExpanded && (
              <div className="rounded-lg border bg-muted/30 p-3 ml-4">
                <p className="text-sm text-foreground/90">
                  {prompt}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      {isLoading ? (
        <div className="rounded-lg border bg-background/50 backdrop-blur-sm overflow-hidden">
          <div className="px-3 py-2 flex items-center gap-2 text-muted-foreground">
            <div className="animate-pulse flex items-center gap-1">
              <div className="h-1 w-1 bg-purple-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
              <div className="h-1 w-1 bg-purple-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
              <div className="h-1 w-1 bg-purple-500 rounded-full animate-bounce"></div>
            </div>
            <span className="text-sm">Fetching content from {getDomain(url)}...</span>
          </div>
        </div>
      ) : fetchedContent ? (
        <div className="rounded-lg border bg-background/50 backdrop-blur-sm overflow-hidden">
          {hasError ? (
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Failed to fetch content</span>
              </div>
              <pre className="mt-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                {fetchedContent}
              </pre>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {/* Content Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  <span>Content from {getDomain(url)}</span>
                </div>
                {isTruncated && (
                  <button
                    onClick={() => setShowFullContent(!showFullContent)}
                    className="text-xs text-purple-500 hover:text-purple-600 transition-colors flex items-center gap-1"
                  >
                    {showFullContent ? (
                      <>
                        <ChevronUp className="h-3 w-3" />
                        Show less
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3" />
                        Show full content
                      </>
                    )}
                  </button>
                )}
              </div>

              {/* Fetched Content */}
              <div className="relative">
                <div className={cn(
                  "rounded-lg bg-muted/30 p-3 overflow-hidden",
                  !showFullContent && isTruncated && "max-h-[300px]"
                )}>
                  <pre className="text-sm font-mono text-foreground/90 whitespace-pre-wrap">
                    {previewContent}
                  </pre>
                  {!showFullContent && isTruncated && (
                    <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-muted/30 to-transparent pointer-events-none" />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border bg-background/50 backdrop-blur-sm overflow-hidden">
          <div className="px-3 py-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Info className="h-4 w-4" />
              <span className="text-sm">No content returned</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
