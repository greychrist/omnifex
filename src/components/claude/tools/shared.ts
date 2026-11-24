/**
 * Shared utilities and types for tool widget components
 */

/**
 * Extract the programming language from a file path for syntax highlighting
 */
export const getLanguage = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    sql: "sql",
    md: "markdown",
    toml: "ini",
    ini: "ini",
    dockerfile: "dockerfile",
    makefile: "makefile"
  };
  return languageMap[ext || ""] || "text";
};

/**
 * Extract text content from a tool result object.
 * Handles the various shapes that result.content can take.
 */
export const extractResultContent = (result: unknown): string => {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (text) {
      return text as string;
    }
    if (Array.isArray(content)) {
      // Image blocks are drawn as images beneath the widget (StreamMessage,
      // extractToolResultImages). Stringified, a screenshot's base64 became
      // one unbreakable line WebKit spent seconds per layout measuring.
      return (content as unknown[])
        .filter((c) => !(c && typeof c === 'object' && (c as { type?: unknown }).type === 'image'))
        .map((c) => {
          if (typeof c === 'string') return c;
          const t = (c as { text?: unknown }).text;
          return t ? (t as string) : JSON.stringify(c);
        })
        .join('\n');
    }
    return JSON.stringify(content, null, 2);
  }
  return '';
};
