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
export const extractResultContent = (result: any): string => {
  if (!result) return '';
  if (typeof result.content === 'string') {
    return result.content;
  }
  if (result.content && typeof result.content === 'object') {
    if (result.content.text) {
      return result.content.text;
    }
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
        .join('\n');
    }
    return JSON.stringify(result.content, null, 2);
  }
  return '';
};
